import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityReport,
  AppState,
  Job,
  PlanningTrigger,
  TwinDayVersion,
} from "../domain/types.ts";
import { PlanningValidationProblem, validatePlannerOutput } from "../domain/planner.ts";
import { addLocalDays, localDateInZone, localTimeInZone } from "../domain/time.ts";
import { createDayPlan, ProviderProblem } from "../integrations/openai.ts";
import { decryptSecret } from "../integrations/secrets.ts";
import { selectPlanningContext, type PlanningContext } from "../storage/context.ts";
import type { Store } from "../storage/store.ts";

export interface DayPlanningRequest {
  userId: string;
  trigger: PlanningTrigger;
  targetLocalDate: string;
  idempotencyKey: string;
  actualReport?: string;
  instruction?: string;
  conversationId?: string;
  now?: Date;
}

export interface DayPlanningResult {
  status: "updated" | "no_change";
  trigger: PlanningTrigger;
  message: string;
  day?: TwinDayVersion;
  model: string;
  reason_source_ids: string[];
  report?: ActivityReport;
}

type ProposePlan = (
  apiKey: string,
  context: PlanningContext,
) => Promise<{ proposal: unknown; requestId?: string; model: string }>;

interface PlanningRunRecord {
  user_id: string;
  status: "running" | "complete";
  claim_token: string;
  request_hash: string;
  started_at: string;
  result?: DayPlanningResult;
}

export async function planTwinDay(
  store: Store,
  request: DayPlanningRequest,
  dependencies: { propose?: ProposePlan } = {},
): Promise<DayPlanningResult> {
  if (!validLocalDate(request.targetLocalDate))
    throw new ProviderProblem(
      "INVALID_PLANNING_DATE",
      "Choose a valid local date to plan.",
      422,
      false,
    );
  const now = request.now ?? new Date();
  const runKey = planningRunKey(request.userId, request.idempotencyKey);
  const requestHash = planningRequestHash(request);
  const claimToken = randomUUID();
  const claim = await store.transaction((draft) => {
    const existing = draft.idempotency[runKey] as PlanningRunRecord | undefined;
    if (existing?.user_id === request.userId && existing.request_hash !== requestHash)
      throw new ProviderProblem(
        "IDEMPOTENCY_KEY_REUSED",
        "That planning request key was already used for different input. Submit again with a new key.",
        409,
        false,
      );
    if (existing?.user_id === request.userId && existing.status === "complete" && existing.result)
      return { replay: existing.result };
    if (
      existing?.user_id === request.userId &&
      existing.status === "running" &&
      now.getTime() - new Date(existing.started_at).getTime() < 2 * 60_000
    )
      throw new ProviderProblem(
        "PLANNING_ALREADY_RUNNING",
        "Twin is already rebuilding this day. Wait for that request to finish.",
        409,
        true,
      );
    draft.idempotency[runKey] = {
      user_id: request.userId,
      status: "running",
      claim_token: claimToken,
      request_hash: requestHash,
      started_at: now.toISOString(),
    } satisfies PlanningRunRecord;
    return { replay: null };
  });
  if (claim.replay) return claim.replay;

  try {
    const state = await store.snapshot();
    const settings = state.settings.find((item) => item.user_id === request.userId);
    if (!settings)
      throw new ProviderProblem(
        "PLANNING_SETTINGS_MISSING",
        "Twin settings were not found.",
        404,
        false,
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: settings.timezone }).format(now);
    } catch {
      throw new ProviderProblem(
        "PLANNING_TIMEZONE_INVALID",
        "Save a valid IANA time zone before planning the day.",
        422,
        false,
      );
    }
    const connection = state.model_connections.find((item) => item.user_id === request.userId);
    if (!connection?.encrypted_key)
      throw new ProviderProblem(
        "OPENAI_KEY_MISSING",
        "Add an OpenAI API key in Settings before rebuilding the day.",
        409,
        false,
      );
    const actualReport = request.actualReport?.trim();
    const manualReport: ActivityReport | undefined =
      request.trigger === "manual" &&
      request.targetLocalDate === localDateInZone(now, settings.timezone) &&
      actualReport
        ? {
            id: randomUUID(),
            user_id: request.userId,
            local_date: request.targetLocalDate,
            activity_key: "generic",
            statement: actualReport.slice(0, 500),
            source: "manual_rebuild_report",
            created_at: now.toISOString(),
          }
        : undefined;
    const context = selectPlanningContext(state, request.userId, {
      targetLocalDate: request.targetLocalDate,
      trigger: request.trigger,
      now,
      instruction: request.instruction,
      conversationId: request.conversationId,
      manualReport,
    });
    if (context.calendar.fixed_commitment_overflow)
      throw new ProviderProblem(
        "PLANNING_CALENDAR_OVERFLOW",
        "More than 40 fixed Calendar commitments overlap this day. The existing schedule was kept; reduce the selected Calendar scope before rebuilding.",
        409,
        false,
      );
    const inputRevision = planningInputRevision(state, request.userId, context);
    const propose = dependencies.propose ?? createDayPlan;
    const apiKey = decryptSecret(connection.encrypted_key);
    let response = await propose(apiKey, context);
    const sourceFactIds = new Set(context.memory.map((item) => item.id));
    const sourceEventIds = new Set(context.calendar.events.map((item) => item.id));
    const sourceReportIds = new Set(context.actual_activity_reports.map((item) => item.id));
    const sourceMessageIds = new Set(context.recent_conversation.map((item) => item.id));
    const validationInput = {
      userId: request.userId,
      targetLocalDate: request.targetLocalDate,
      timezone: settings.timezone,
      trigger: request.trigger,
      revisionMode: context.revision_window.mode,
      manualReportId: manualReport?.id,
      now,
      previous: context.existing_schedule ?? undefined,
      facts: state.facts.filter(
        (item) => item.user_id === request.userId && sourceFactIds.has(item.id),
      ),
      events: state.calendar_events.filter(
        (item) => item.user_id === request.userId && sourceEventIds.has(item.id),
      ),
      reports: [
        ...state.activity_reports.filter(
          (item) => item.user_id === request.userId && sourceReportIds.has(item.id),
        ),
        ...(manualReport ? [manualReport] : []),
      ],
      messageIds: state.messages
        .filter((item) => item.user_id === request.userId && sourceMessageIds.has(item.id))
        .map((item) => item.id),
    };
    let validated: ReturnType<typeof validatePlannerOutput>;
    try {
      validated = validatePlannerOutput(response.proposal, validationInput);
    } catch (error) {
      if (
        !(error instanceof PlanningValidationProblem) ||
        context.revision_window.mode !== "catch_up"
      )
        throw error;
      response = await propose(apiKey, {
        ...context,
        repair_request: {
          validation_code: error.code,
          validation_message: error.message,
        },
      });
      validated = validatePlannerOutput(response.proposal, validationInput);
    }
    const saved = await store.transaction((draft) => {
      const currentRun = draft.idempotency[runKey] as PlanningRunRecord | undefined;
      if (currentRun?.claim_token !== claimToken || currentRun.status !== "running")
        return { stale: true as const };
      const currentContext = selectPlanningContext(draft, request.userId, {
        targetLocalDate: request.targetLocalDate,
        trigger: request.trigger,
        now,
        instruction: request.instruction,
        conversationId: request.conversationId,
        manualReport,
      });
      if (planningInputRevision(draft, request.userId, currentContext) !== inputRevision)
        return { stale: true as const };
      let result: DayPlanningResult;
      if (validated.outcome === "no_change") {
        result = {
          status: "no_change",
          trigger: request.trigger,
          message: validated.reason,
          day: currentContext.existing_schedule ?? undefined,
          model: response.model,
          reason_source_ids: validated.reasonSourceIds,
        };
      } else {
        if (manualReport && !draft.activity_reports.some((item) => item.id === manualReport.id))
          draft.activity_reports.push(manualReport);
        const previous = currentContext.existing_schedule ?? undefined;
        const priorVersions = draft.twin_days.filter(
          (item) => item.user_id === request.userId && item.local_date === request.targetLocalDate,
        );
        const latestStored = [...priorVersions].sort(
          (left, right) => right.version - left.version,
        )[0];
        for (const prior of priorVersions) prior.status = "superseded";
        const facts = draft.facts.filter((item) => item.user_id === request.userId);
        const events = draft.calendar_events.filter((item) => item.user_id === request.userId);
        const reports = draft.activity_reports.filter((item) => item.user_id === request.userId);
        const day: TwinDayVersion = {
          id: randomUUID(),
          user_id: request.userId,
          local_date: request.targetLocalDate,
          timezone: settings.timezone,
          version: Math.max(0, ...priorVersions.map((item) => item.version)) + 1,
          status: "ready",
          generated_at: now.toISOString(),
          reason: validated.changeSummary,
          memory_revision: Math.max(0, ...facts.map((fact) => fact.version)),
          calendar_revision: Math.max(0, ...events.map((event) => event.sync_revision)),
          report_revision: reports.length,
          limited_context: planningLimitations(currentContext),
          tomorrow_may_change_because: [validated.changeSummary],
          activities: validated.activities,
          parent_version_id: previous?.id ?? latestStored?.id,
          planning_trigger: request.trigger,
          planner_model: response.model,
          input_revision: inputRevision,
          change_summary: validated.changeSummary,
          reason_source_ids: validated.reasonSourceIds,
          unresolved_conflicts: validated.conflicts,
        };
        draft.twin_days.push(day);
        result = {
          status: "updated",
          trigger: request.trigger,
          message: validated.changeSummary,
          day,
          model: response.model,
          reason_source_ids: validated.reasonSourceIds,
          report: manualReport,
        };
      }
      draft.idempotency[runKey] = {
        user_id: request.userId,
        status: "complete",
        claim_token: claimToken,
        request_hash: requestHash,
        started_at: now.toISOString(),
        result,
      } satisfies PlanningRunRecord;
      return { stale: false as const, result };
    });
    if (saved.stale)
      throw new ProviderProblem(
        "PLANNING_INPUT_STALE",
        "The day changed while Twin was planning. The older result was not saved; try again.",
        409,
        true,
      );
    return saved.result;
  } catch (error) {
    await releasePlanningClaim(store, runKey, claimToken);
    if (error instanceof PlanningValidationProblem)
      throw new ProviderProblem(
        error.code,
        `${error.message} Twin tried twice, but neither generated day passed validation. Your existing day is unchanged.`,
        502,
        true,
      );
    throw error;
  }
}

async function releasePlanningClaim(store: Store, runKey: string, claimToken: string) {
  await store.transaction((draft) => {
    const current = draft.idempotency[runKey] as PlanningRunRecord | undefined;
    if (current?.status === "running" && current.claim_token === claimToken)
      delete draft.idempotency[runKey];
  });
}

function planningRunKey(userId: string, idempotencyKey: string) {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex");
  return `planning:${userId}:${hash}`;
}

function planningRequestHash(request: DayPlanningRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        user_id: request.userId,
        trigger: request.trigger,
        target_local_date: request.targetLocalDate,
        actual_report: request.actualReport?.trim() || null,
        instruction: request.instruction?.trim() || null,
        conversation_id: request.conversationId ?? null,
      }),
    )
    .digest("hex");
}

function validLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function planningTargetDateFromConversation(text: string, today: string) {
  const explicitDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate && validLocalDate(explicitDate) && explicitDate >= today) return explicitDate;
  const inDays = text.match(/\bin\s+(\d{1,2})\s+days?\b/i)?.[1];
  if (inDays && Number(inDays) > 0 && Number(inDays) <= 30)
    return addLocalDays(today, Number(inDays));
  if (/\b(tomorrow|next day)\b/i.test(text)) return addLocalDays(today, 1);
  if (/\bnext week\b/i.test(text)) return addLocalDays(today, 7);
  const weekdayMatch = text.match(
    /\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  if (weekdayMatch) {
    const targetWeekday = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ].indexOf(weekdayMatch[1].toLowerCase());
    const currentWeekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
    return addLocalDays(today, ((targetWeekday - currentWeekday + 6) % 7) + 1);
  }
  return today;
}

export function planningInputRevision(state: AppState, userId: string, context: PlanningContext) {
  const settings = state.settings.find((item) => item.user_id === userId);
  const model = state.model_connections.find((item) => item.user_id === userId);
  return createHash("sha256")
    .update(
      JSON.stringify({
        settings,
        model_credential_version: model?.credential_version ?? 0,
        model_status: model?.status,
        context,
      }),
    )
    .digest("hex");
}

function planningLimitations(context: PlanningContext) {
  const limitations: string[] = [];
  if (context.calendar.connection_status === "demo")
    limitations.push("Calendar context is labeled demo data, not a connected Google Calendar.");
  else if (context.calendar.connection_status === "imported")
    limitations.push(
      "Calendar context is a manually refreshed prototype snapshot, not a live Google connection.",
    );
  else if (context.calendar.data_state === "unavailable")
    limitations.push(
      "Google Calendar is unavailable or no calendar is selected; this plan uses saved context.",
    );
  else if (context.calendar.data_state === "stale")
    limitations.push(
      `Calendar data may be stale; last successful sync was ${context.calendar.last_successful_sync_at ?? "unknown"}.`,
    );
  else if (context.calendar.data_state === "empty")
    limitations.push(
      "Google Calendar synced successfully and had no events in this planning window.",
    );
  if (context.calendar.truncated)
    limitations.push(
      `Calendar context was bounded to 40 of ${context.calendar.matching_event_count} matching events; fixed commitments were prioritized.`,
    );
  return limitations;
}

export function queueDayPlanningJob(
  state: AppState,
  input: {
    userId: string;
    trigger: Exclude<PlanningTrigger, "manual">;
    targetLocalDate: string;
    sourceId: string;
    conversationId?: string;
    runAfter?: string;
  },
) {
  const dedupeKey = `plan:${input.userId}:${input.trigger}:${input.sourceId}`;
  const existing = state.jobs.find(
    (job) => job.user_id === input.userId && job.dedupe_key === dedupeKey,
  );
  if (existing) return existing;
  const job: Job = {
    id: randomUUID(),
    user_id: input.userId,
    type: "twin_day_generation",
    dedupe_key: dedupeKey,
    status: "queued",
    attempts: 0,
    run_after: input.runAfter ?? new Date().toISOString(),
    payload: {
      trigger: input.trigger,
      local_date: input.targetLocalDate,
      conversation_id: input.conversationId,
    },
  };
  state.jobs.push(job);
  return job;
}

export function queueDueMorningPlans(state: AppState, now = new Date()) {
  const queued: Job[] = [];
  for (const settings of state.settings) {
    if (!settings.onboarding_complete) continue;
    const model = state.model_connections.find((item) => item.user_id === settings.user_id);
    if (!model?.encrypted_key) continue;
    const localDate = localDateInZone(now, settings.timezone);
    if (localTimeInZone(now, settings.timezone) < settings.wake_time) continue;
    const dedupeKey = `plan:${settings.user_id}:morning:${localDate}`;
    if (state.jobs.some((job) => job.user_id === settings.user_id && job.dedupe_key === dedupeKey))
      continue;
    const job = queueDayPlanningJob(state, {
      userId: settings.user_id,
      trigger: "morning",
      targetLocalDate: localDate,
      sourceId: localDate,
      runAfter: now.toISOString(),
    });
    if (job.status === "queued" && !queued.includes(job)) queued.push(job);
  }
  return queued;
}

export function calendarNeedsPlanningRefresh(state: AppState, userId: string, now = new Date()) {
  const connection = state.integrations.find(
    (item) => item.user_id === userId && item.provider === "google_calendar",
  );
  if (
    !connection ||
    connection.mode !== "live" ||
    !connection.encrypted_token ||
    connection.status === "expired" ||
    connection.status === "syncing" ||
    !(connection.selected_calendars ?? []).some((calendar) => calendar.selected)
  )
    return false;
  const lastSync = connection.last_successful_sync_at
    ? new Date(connection.last_successful_sync_at)
    : null;
  return (
    !lastSync ||
    !Number.isFinite(lastSync.getTime()) ||
    now.getTime() - lastSync.getTime() > 6 * 60 * 60 * 1000
  );
}
