import type { ActivityReport, AppState, PlanningTrigger, TwinActivity } from "../domain/types.ts";
import {
  addLocalDays,
  ceilToMinute,
  localDateInZone,
  localDateTimeToUtc,
  localTimeInZone,
  overlaps,
} from "../domain/time.ts";
// Bounded, user-scoped retrieval. The SQL-backed store remains authoritative.
export function selectTalkContext(
  state: AppState,
  userId: string,
  conversationId: string,
  text: string,
  now = new Date(),
) {
  const words = new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const score = (statement: string) =>
    [...new Set(statement.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((word) =>
      words.has(word),
    ).length;
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString(),
    end = new Date(now.getTime() + 7 * 86400000).toISOString();
  return {
    memory: state.facts
      .filter((f) => f.user_id === userId && f.status === "active")
      .sort(
        (a, b) =>
          score(b.statement) - score(a.statement) || b.updated_at.localeCompare(a.updated_at),
      )
      .slice(0, 8)
      .map((f) => f.statement.slice(0, 600)),
    recent: state.messages
      .filter((m) => m.user_id === userId && m.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-6),
    checkIns: state.activity_reports
      .filter(
        (r) => r.user_id === userId && r.created_at >= cutoff && r.created_at <= now.toISOString(),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((r) => ({ date: r.local_date, statement: r.statement.slice(0, 600) })),
    events: state.calendar_events
      .filter(
        (e) =>
          e.user_id === userId &&
          !e.deleted &&
          (e.start_at ?? e.start_date ?? "") >= now.toISOString().slice(0, e.all_day ? 10 : 24) &&
          (e.start_at ?? e.start_date ?? "") <= end,
      )
      .sort((a, b) =>
        (a.start_at ?? a.start_date ?? "").localeCompare(b.start_at ?? b.start_date ?? ""),
      )
      .slice(0, 8)
      .map((e) => ({
        title: e.title.slice(0, 300),
        start: e.start_at ?? e.start_date,
        end: e.end_at ?? e.end_date,
        all_day: e.all_day,
      })),
  };
}

export interface PlanningContext {
  current_timestamp: string;
  target_local_date: string;
  timezone: string;
  trigger: PlanningTrigger;
  manual_instruction: string | null;
  repair_request: {
    validation_code: string;
    validation_message: string;
  } | null;
  citation_id_allowlist: {
    fact_ids: string[];
    calendar_event_ids: string[];
    activity_report_ids: string[];
    conversation_message_ids: string[];
    existing_activity_ids: string[];
  };
  revision_window: {
    mode: "full_day" | "initial_day" | "remaining_day" | "catch_up";
    earliest_new_activity_start_local: string | null;
    current_activity_required_at_local: string | null;
    day_end_local: string;
    preserve_activity_ids: string[];
    adjustable_in_progress_activity_id: string | null;
  };
  memory: Array<{
    id: string;
    kind: string;
    statement: string;
    status: string;
    authority: string;
    certainty: string;
    source_type: string;
    updated_at: string;
  }>;
  calendar: {
    data_state: "available" | "empty" | "stale" | "unavailable";
    connection_status: string;
    last_successful_sync_at: string | null;
    selected_calendar_count: number;
    matching_event_count: number;
    truncated: boolean;
    fixed_commitment_overflow: boolean;
    events: Array<{
      id: string;
      title: string;
      start_at?: string;
      end_at?: string;
      start_date?: string;
      end_date?: string;
      all_day: boolean;
      status: "active" | "cancelled";
      availability: "busy" | "free";
      self_response_status?: string;
      source_timezone: string;
    }>;
  };
  existing_schedule: AppState["twin_days"][number] | null;
  recent_conversation: Array<{
    id: string;
    conversation_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>;
  memory_changes: Array<{
    id: string;
    fact_key: string;
    action: "edit" | "remove";
    replacement?: string;
    recorded_at: string;
  }>;
  actual_activity_reports: Array<{
    id: string;
    local_date: string;
    approximate_time?: string;
    activity_key: string;
    statement: string;
    created_at: string;
    correction_of_id?: string;
  }>;
}

export function selectPlanningContext(
  state: AppState,
  userId: string,
  input: {
    targetLocalDate: string;
    trigger: PlanningTrigger;
    now: Date;
    instruction?: string;
    conversationId?: string;
    manualReport?: ActivityReport;
  },
): PlanningContext {
  const settings = state.settings.find((item) => item.user_id === userId);
  if (!settings) throw new Error("PLANNING_SETTINGS_MISSING");
  const authorityRank: Record<string, number> = {
    user_edit: 0,
    talk_user_stated: 1,
    onboarding_user_stated: 2,
    model_inferred: 3,
    gmail_cue: 4,
  };
  const rankedFacts = state.facts
    .filter((fact) => fact.user_id === userId && fact.status !== "suppressed")
    .sort(
      (left, right) =>
        Number(left.status === "tentative") - Number(right.status === "tentative") ||
        (authorityRank[left.authority] ?? 9) - (authorityRank[right.authority] ?? 9) ||
        right.updated_at.localeCompare(left.updated_at) ||
        left.id.localeCompare(right.id),
    );
  const categoryRepresentatives = [
    "commitment",
    "routine",
    "sleep",
    "goal",
    "boundary",
    "energy_cue",
    "wellbeing_cue",
    "distraction",
  ].flatMap((kind) => rankedFacts.filter((fact) => fact.kind === kind).slice(0, 2));
  const selectedFactIds = new Set<string>();
  const selectedFacts = [...categoryRepresentatives, ...rankedFacts]
    .filter((fact) => {
      if (selectedFactIds.has(fact.id)) return false;
      selectedFactIds.add(fact.id);
      return true;
    })
    .slice(0, 32);
  const memory = selectedFacts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    statement: fact.statement.slice(0, 600),
    status: fact.status,
    authority: fact.authority,
    certainty: fact.certainty,
    source_type: fact.source_type,
    updated_at: fact.updated_at,
  }));
  const startAt = localDateTimeToUtc(input.targetLocalDate, "00:00", settings.timezone);
  const nextDate = addLocalDays(input.targetLocalDate, 1);
  const endAt = localDateTimeToUtc(nextDate, "00:00", settings.timezone);
  const matchingEvents = state.calendar_events
    .filter((event) => {
      if (event.user_id !== userId) return false;
      if (event.all_day)
        return Boolean(
          event.start_date &&
          event.end_date &&
          event.start_date < nextDate &&
          event.end_date > input.targetLocalDate,
        );
      return Boolean(
        event.start_at && event.end_at && overlaps(event.start_at, event.end_at, startAt, endAt),
      );
    })
    .sort((left, right) =>
      (left.start_at ?? left.start_date ?? "").localeCompare(
        right.start_at ?? right.start_date ?? "",
      ),
    );
  const fixedCommitments = matchingEvents.filter(
    (event) =>
      !event.deleted &&
      !event.all_day &&
      event.availability !== "free" &&
      event.self_response_status !== "declined" &&
      Boolean(event.start_at && event.end_at),
  );
  const fixedCommitmentIds = new Set(fixedCommitments.map((event) => event.id));
  const relevantEvents = [
    ...fixedCommitments,
    ...matchingEvents.filter((event) => !fixedCommitmentIds.has(event.id)),
  ].slice(0, 40);
  const connection = state.integrations.find(
    (item) => item.user_id === userId && item.provider === "google_calendar",
  );
  const selectedCount =
    connection?.selected_calendars?.filter((calendar) => calendar.selected).length ?? 0;
  let dataState: PlanningContext["calendar"]["data_state"] = "unavailable";
  if (
    connection &&
    (connection.status === "connected" ||
      connection.status === "demo" ||
      connection.status === "imported")
  ) {
    const lastSync = connection.last_successful_sync_at
      ? new Date(connection.last_successful_sync_at)
      : null;
    const targetInsidePrototypeWindow =
      connection.mode !== "prototype" ||
      Boolean(
        connection.source_window_start_date &&
        connection.source_window_end_date &&
        input.targetLocalDate >= connection.source_window_start_date &&
        input.targetLocalDate <= connection.source_window_end_date,
      );
    const stale =
      !lastSync ||
      !Number.isFinite(lastSync.getTime()) ||
      !targetInsidePrototypeWindow ||
      (connection.mode !== "prototype" &&
        input.now.getTime() - lastSync.getTime() > 6 * 60 * 60 * 1000);
    if (connection.mode === "live" && selectedCount === 0) dataState = "unavailable";
    else if (stale) dataState = "stale";
    else dataState = relevantEvents.some((event) => !event.deleted) ? "available" : "empty";
  } else if (
    connection?.last_successful_sync_at &&
    (connection.status === "syncing" ||
      connection.status === "failed" ||
      connection.status === "expired")
  ) {
    dataState = "stale";
  }
  const existingSchedule = state.twin_days
    .filter(
      (day) =>
        day.user_id === userId &&
        day.local_date === input.targetLocalDate &&
        day.status === "ready",
    )
    .sort((left, right) => right.version - left.version)[0];
  const targetIsToday = input.targetLocalDate === localDateInZone(input.now, settings.timezone);
  const catchUp = targetIsToday && input.trigger === "manual" && Boolean(input.manualReport);
  const initialDay = targetIsToday && !existingSchedule && !catchUp;
  const remainingDay =
    input.trigger !== "morning" && targetIsToday && Boolean(existingSchedule) && !catchUp;
  const revisionBoundary = ceilToMinute(input.now);
  const hardProtected = (activity: TwinActivity) =>
    Boolean(
      activity.locked ||
      activity.user_edited ||
      activity.supporting_report_ids?.length ||
      activity.source_event_ids.length,
    );
  const catchUpProtected = (activity: TwinActivity) =>
    Boolean(activity.locked || activity.user_edited);
  const preserveActivityIds = (existingSchedule?.activities ?? [])
    .filter(
      (activity) =>
        (catchUp ? catchUpProtected(activity) : hardProtected(activity)) ||
        (remainingDay && new Date(activity.end_at).getTime() <= input.now.getTime()),
    )
    .map((activity) => activity.id);
  const adjustableInProgress = remainingDay
    ? (existingSchedule?.activities ?? []).find(
        (activity) =>
          new Date(activity.start_at) < input.now &&
          input.now < new Date(activity.end_at) &&
          !hardProtected(activity),
      )
    : undefined;
  const recentConversation =
    input.trigger === "after_conversation" && input.conversationId
      ? state.messages
          .filter(
            (message) =>
              message.user_id === userId &&
              message.status === "saved" &&
              message.conversation_id === input.conversationId,
          )
          .sort((left, right) => left.created_at.localeCompare(right.created_at))
          .slice(-10)
          .map((message) => ({
            id: message.id,
            conversation_id: message.conversation_id,
            role: message.role,
            content: message.content.slice(0, 1200),
            created_at: message.created_at,
          }))
      : [];
  // A catch-up report is the only direct evidence authorized to reconstruct this
  // run's elapsed time. Older reports remain stored (and prior report-backed
  // activities remain protected), but exposing their IDs here would contradict
  // the catch-up validator and invite unsupported cross-day citations.
  const reports = catchUp
    ? [input.manualReport!]
    : input.manualReport
      ? [
          input.manualReport,
          ...state.activity_reports.filter((report) => report.id !== input.manualReport?.id),
        ]
      : state.activity_reports;
  const actualActivityReports = reports
    .filter((report) => report.user_id === userId)
    .sort(
      (left, right) =>
        Number(right.id === input.manualReport?.id) - Number(left.id === input.manualReport?.id) ||
        right.created_at.localeCompare(left.created_at),
    )
    .slice(0, 12)
    .map((report) => ({
      id: report.id,
      local_date: report.local_date,
      approximate_time: report.approximate_time,
      activity_key: report.activity_key,
      statement: report.statement.slice(0, 600),
      created_at: report.created_at,
      correction_of_id: report.correction_of_id,
    }));
  return {
    current_timestamp: input.now.toISOString(),
    target_local_date: input.targetLocalDate,
    timezone: settings.timezone,
    trigger: input.trigger,
    manual_instruction:
      input.trigger === "manual" ? input.instruction?.trim().slice(0, 500) || null : null,
    repair_request: null,
    citation_id_allowlist: {
      fact_ids: memory.map((item) => item.id),
      calendar_event_ids: relevantEvents.map((item) => item.id),
      activity_report_ids: actualActivityReports.map((item) => item.id),
      conversation_message_ids: recentConversation.map((item) => item.id),
      existing_activity_ids: existingSchedule?.activities.map((item) => item.id) ?? [],
    },
    revision_window: {
      mode: catchUp
        ? "catch_up"
        : initialDay
          ? "initial_day"
          : remainingDay
            ? "remaining_day"
            : "full_day",
      earliest_new_activity_start_local:
        remainingDay &&
        localDateInZone(revisionBoundary, settings.timezone) === input.targetLocalDate
          ? `${input.targetLocalDate}T${localTimeInZone(revisionBoundary, settings.timezone)}`
          : null,
      current_activity_required_at_local:
        initialDay || catchUp
          ? `${input.targetLocalDate}T${localTimeInZone(input.now, settings.timezone)}`
          : null,
      day_end_local: `${nextDate}T00:00`,
      preserve_activity_ids: preserveActivityIds,
      adjustable_in_progress_activity_id: adjustableInProgress?.id ?? null,
    },
    memory,
    calendar: {
      data_state: dataState,
      connection_status: connection?.status ?? "disconnected",
      last_successful_sync_at: connection?.last_successful_sync_at ?? null,
      selected_calendar_count: selectedCount,
      matching_event_count: matchingEvents.length,
      truncated: matchingEvents.length > relevantEvents.length,
      fixed_commitment_overflow: fixedCommitments.length > 40,
      events: relevantEvents.map((event) => ({
        id: event.id,
        title: event.title.slice(0, 300),
        start_at: event.start_at,
        end_at: event.end_at,
        start_date: event.start_date,
        end_date: event.end_date,
        all_day: event.all_day,
        status: event.deleted ? "cancelled" : "active",
        availability: event.availability ?? "busy",
        self_response_status: event.self_response_status,
        source_timezone: event.source_timezone,
      })),
    },
    existing_schedule: existingSchedule ? structuredClone(existingSchedule) : null,
    recent_conversation: recentConversation,
    memory_changes: state.memory_overrides
      .filter((change) => change.user_id === userId)
      .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))
      .slice(0, 12)
      .map((change) => ({
        id: change.id,
        fact_key: change.fact_key,
        action: change.action,
        replacement: change.replacement?.slice(0, 600),
        recorded_at: change.recorded_at,
      })),
    actual_activity_reports: actualActivityReports,
  };
}
