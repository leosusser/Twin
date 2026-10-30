import { randomUUID } from "node:crypto";
import type {
  ActivityKey,
  ActivityReport,
  CalendarEvent,
  GmailCue,
  PlanningConflict,
  PlanningTrigger,
  ProfileFact,
  Settings,
  TwinActivity,
  TwinDayVersion,
} from "./types.ts";
import {
  addLocalDays,
  addMinutes,
  ceilToMinute,
  localDateInZone,
  localDateTimeToUtc,
  localTimeInZone,
  overlaps,
} from "./time.ts";

const activityKeys = new Set<ActivityKey>([
  "generic",
  "studying",
  "working",
  "walking",
  "running",
  "eating",
  "sleeping",
  "resting",
  "commuting",
  "bathroom",
]);
const conflictKinds = new Set<PlanningConflict["kind"]>([
  "calendar_overlap",
  "protected_activity",
  "uncertain_timing",
  "other",
]);

export class PlanningValidationProblem extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PlanningValidationInput {
  userId: string;
  targetLocalDate: string;
  timezone: string;
  trigger: PlanningTrigger;
  revisionMode: "full_day" | "initial_day" | "remaining_day" | "catch_up";
  manualReportId?: string;
  now: Date;
  previous?: TwinDayVersion;
  facts: ProfileFact[];
  events: CalendarEvent[];
  reports: ActivityReport[];
  messageIds: string[];
}

export type ValidatedPlannerResult =
  | { outcome: "no_change"; reason: string; reasonSourceIds: string[] }
  | {
      outcome: "schedule";
      changeSummary: string;
      reasonSourceIds: string[];
      activities: TwinActivity[];
      conflicts: PlanningConflict[];
    };

export function validatePlannerOutput(
  value: unknown,
  input: PlanningValidationInput,
): ValidatedPlannerResult {
  const root = objectValue(value, "PLANNER_OUTPUT_INVALID", "Planner output must be an object.");
  const outcome = stringValue(root.outcome, "outcome", 30);
  if (outcome !== "no_change" && outcome !== "schedule")
    throw invalid("Planner output used an unsupported outcome.");
  const changeSummary = optionalString(root.change_summary, "change_summary", 600);
  const noChangeReason = optionalString(root.no_change_reason, "no_change_reason", 600);
  const reasonSourceIds = stringArray(root.reason_source_ids, "reason_source_ids", 16);
  const requestedPreserveIds = stringArray(root.preserve_activity_ids, "preserve_activity_ids", 64);
  const rawActivities = arrayValue(root.activities, "activities", 48);
  const rawConflicts = arrayValue(root.unresolved_conflicts, "unresolved_conflicts", 12);
  if (outcome === "no_change") {
    if (input.revisionMode === "catch_up")
      throw invalid("A manual catch-up must return a replacement schedule.");
    if (!input.previous)
      throw invalid("The planner cannot return no change when no saved day exists.");
    if (!noChangeReason) throw invalid("A no-change result needs a concrete reason.");
    if (requestedPreserveIds.length || rawActivities.length || rawConflicts.length)
      throw invalid("A no-change result cannot include schedule mutations.");
    requireKnown(
      reasonSourceIds,
      new Set([
        ...input.facts.map((fact) => fact.id),
        ...input.events.map((event) => event.id),
        ...input.reports.map((report) => report.id),
        ...input.messageIds,
      ]),
      "planning",
    );
    return { outcome, reason: noChangeReason, reasonSourceIds };
  }
  if (!changeSummary) throw invalid("A schedule result needs a change summary.");

  const previousById = new Map(
    (input.previous?.activities ?? []).map((activity) => [activity.id, activity]),
  );
  const initialDay = input.revisionMode === "initial_day";
  const remainingDay = input.revisionMode === "remaining_day";
  const catchUp = input.revisionMode === "catch_up";
  const hardProtected = (activity: TwinActivity) =>
    Boolean(
      activity.locked ||
      activity.user_edited ||
      activity.supporting_report_ids?.length ||
      activity.source_event_ids.length,
    );
  const catchUpProtected = (activity: TwinActivity) =>
    Boolean(activity.locked || activity.user_edited);
  const preserveSet = new Set(
    requestedPreserveIds.filter((id) => {
      const activity = previousById.get(id);
      return Boolean(activity && (!catchUp || catchUpProtected(activity)));
    }),
  );
  const protectedActivities = (input.previous?.activities ?? []).filter(
    (activity) =>
      (catchUp ? catchUpProtected(activity) : hardProtected(activity)) ||
      (remainingDay && new Date(activity.end_at).getTime() <= input.now.getTime()),
  );
  for (const activity of protectedActivities) preserveSet.add(activity.id);
  const preserveIds = [...preserveSet];

  const factIds = new Set(input.facts.map((fact) => fact.id));
  const eventById = new Map(input.events.map((event) => [event.id, event]));
  const reportIds = new Set(input.reports.map((report) => report.id));
  const messageIds = new Set(input.messageIds);
  requireKnown(
    reasonSourceIds,
    new Set([...factIds, ...eventById.keys(), ...reportIds, ...messageIds]),
    "planning",
  );
  let activities = preserveIds.map((id) => structuredClone(previousById.get(id)!));
  const immutableActivityIds = new Set(activities.map((activity) => activity.id));
  const adjustableInProgress = remainingDay
    ? (input.previous?.activities ?? []).find(
        (activity) =>
          new Date(activity.start_at) < input.now &&
          input.now < new Date(activity.end_at) &&
          !hardProtected(activity),
      )
    : undefined;
  if (adjustableInProgress && !preserveSet.has(adjustableInProgress.id)) {
    activities.push({
      ...structuredClone(adjustableInProgress),
      end_at: input.now.toISOString(),
    });
    immutableActivityIds.add(adjustableInProgress.id);
  }
  const earliestNewActivity = remainingDay ? ceilToMinute(input.now) : null;
  for (const raw of rawActivities) {
    const proposal = objectValue(raw, "PLANNER_OUTPUT_INVALID", "Each activity must be an object.");
    const activityKey = stringValue(proposal.activity_key, "activity_key", 40);
    if (!activityKeys.has(activityKey as ActivityKey))
      throw invalid("The planner used an unsupported activity type.");
    const startLocal = stringValue(proposal.start_local, "start_local", 16);
    const match = startLocal.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match || match[1] !== input.targetLocalDate)
      throw invalid("Activity start_local must be on the target local date.");
    const duration = numberValue(proposal.duration_minutes, "duration_minutes");
    if (!Number.isInteger(duration) || duration < 5 || duration > 960)
      throw invalid("Activity duration must be a positive whole number of 5–960 minutes.");
    const supportingFactIds = stringArray(proposal.supporting_fact_ids, "supporting_fact_ids", 16);
    const sourceEventIds = stringArray(proposal.source_event_ids, "source_event_ids", 16);
    const supportingReportIds = stringArray(
      proposal.supporting_report_ids,
      "supporting_report_ids",
      16,
    );
    const sourceMessageIds = stringArray(proposal.source_message_ids, "source_message_ids", 16);
    requireKnown(supportingFactIds, factIds, "fact");
    requireKnown(sourceEventIds, new Set(eventById.keys()), "Calendar event");
    requireKnown(supportingReportIds, reportIds, "activity report");
    requireKnown(sourceMessageIds, messageIds, "conversation message");
    let startAt = localDateTimeToUtc(
      input.targetLocalDate,
      `${match[2]}:${match[3]}`,
      input.timezone,
    );
    if (
      localDateInZone(new Date(startAt), input.timezone) !== input.targetLocalDate ||
      localTimeInZone(new Date(startAt), input.timezone) !== `${match[2]}:${match[3]}`
    )
      throw invalid("Activity start_local is not a real local time in the saved time zone.");
    let endAt = addMinutes(startAt, duration);
    const fixedSourceEvents = sourceEventIds
      .map((eventId) => eventById.get(eventId)!)
      .filter(isFixedTimedCommitment);
    if (fixedSourceEvents.length) {
      const canonicalStart = fixedSourceEvents[0].start_at!;
      const canonicalEnd = fixedSourceEvents[0].end_at!;
      if (
        fixedSourceEvents.some(
          (event) => event.start_at !== canonicalStart || event.end_at !== canonicalEnd,
        )
      )
        throw new PlanningValidationProblem(
          "PLANNER_COMMITMENT_AMBIGUOUS",
          "One proposed activity cannot represent Calendar commitments with different times.",
        );
      startAt = canonicalStart;
      endAt = canonicalEnd;
    }
    if (earliestNewActivity && new Date(startAt) < earliestNewActivity)
      throw new PlanningValidationProblem(
        "PLANNER_REWROTE_ELAPSED_HISTORY",
        `A remaining-day revision cannot add a new activity before ${input.targetLocalDate}T${localTimeInZone(earliestNewActivity, input.timezone)} local time.`,
      );
    const windowStart = localDateTimeToUtc(input.targetLocalDate, "00:00", input.timezone);
    const windowEnd = localDateTimeToUtc(
      addLocalDays(input.targetLocalDate, 1),
      "00:00",
      input.timezone,
    );
    const immutableProposal = Boolean(fixedSourceEvents.length || supportingReportIds.length);
    if (new Date(startAt) < new Date(windowStart) || new Date(endAt) > new Date(windowEnd)) {
      if (immutableProposal || new Date(startAt) < new Date(windowStart))
        throw invalid("An activity falls outside the target local day.");
      endAt = windowEnd;
    }
    const proposedConfidence = stringValue(proposal.confidence, "confidence", 20);
    if (proposedConfidence !== "grounded" && proposedConfidence !== "possible")
      throw invalid("Activity confidence must be grounded or possible.");
    let confidence: TwinActivity["confidence"] = proposedConfidence;
    const supportedByCurrentCatchUpReport = Boolean(
      input.manualReportId && supportingReportIds.includes(input.manualReportId),
    );
    if (
      catchUp &&
      new Date(startAt) < input.now &&
      !fixedSourceEvents.length &&
      supportingReportIds.some((reportId) => reportId !== input.manualReportId)
    )
      throw new PlanningValidationProblem(
        "PLANNER_CATCH_UP_REPORT_MISMATCH",
        "Reconstructed elapsed activity may cite only the report entered for this rebuild.",
      );
    if (catchUp && new Date(startAt) < input.now) {
      if (supportedByCurrentCatchUpReport) confidence = "grounded";
      else if (!fixedSourceEvents.length) confidence = "possible";
    }
    if (typeof proposal.is_experiment !== "boolean")
      throw invalid("Activity is_experiment must be a boolean.");
    const sourceTypes: TwinActivity["source_types"] = [];
    if (supportingFactIds.length) sourceTypes.push("memory");
    if (sourceEventIds.length) sourceTypes.push("calendar");
    if (supportingReportIds.length) sourceTypes.push("report");
    if (sourceMessageIds.length) sourceTypes.push("conversation");
    const activity: TwinActivity = {
      id: randomUUID(),
      user_id: input.userId,
      activity_key: activityKey as ActivityKey,
      start_at: startAt,
      end_at: endAt,
      title: stringValue(proposal.title, "title", 120),
      narrative: stringValue(proposal.narrative, "narrative", 600),
      reason: stringValue(proposal.reason, "reason", 600),
      supporting_fact_ids: supportingFactIds,
      source_event_ids: sourceEventIds,
      supporting_report_ids: supportingReportIds,
      source_message_ids: sourceMessageIds,
      source_types: sourceTypes,
      confidence,
      is_experiment: proposal.is_experiment,
    };
    if (new Date(activity.end_at).getTime() - new Date(activity.start_at).getTime() < 5 * 60_000)
      continue;
    activities.push(activity);
    if (immutableProposal) immutableActivityIds.add(activity.id);
  }
  if (!activities.length) throw invalid("A schedule result must contain at least one activity.");
  for (const activity of activities)
    if (
      activity.user_id !== input.userId ||
      !Number.isFinite(new Date(activity.start_at).getTime()) ||
      !Number.isFinite(new Date(activity.end_at).getTime()) ||
      new Date(activity.start_at) >= new Date(activity.end_at)
    )
      throw invalid("The schedule contains an invalid activity interval or owner.");
  const conflicts = rawConflicts.map((raw) => {
    const conflict = objectValue(raw, "PLANNER_OUTPUT_INVALID", "Each conflict must be an object.");
    const kind = stringValue(conflict.kind, "conflict.kind", 40);
    if (!conflictKinds.has(kind as PlanningConflict["kind"]))
      throw invalid("The planner used an unsupported conflict type.");
    const sourceEventIds = stringArray(conflict.source_event_ids, "conflict.source_event_ids", 16);
    requireKnown(sourceEventIds, new Set(eventById.keys()), "Calendar event");
    return {
      kind: kind as PlanningConflict["kind"],
      description: stringValue(conflict.description, "conflict.description", 500),
      source_event_ids: sourceEventIds,
    };
  });
  if (catchUp) {
    const normalized = normalizeCatchUpCalendarConflicts(
      activities,
      immutableActivityIds,
      conflicts,
      input.now,
    );
    activities = normalized.activities;
    immutableActivityIds.clear();
    for (const id of normalized.immutableActivityIds) immutableActivityIds.add(id);
  }
  activities = repairFlexibleActivityIntervals(
    activities,
    immutableActivityIds,
    input.now,
    initialDay,
  );
  if (initialDay && !activities.some((activity) => intervalCovers(activity, input.now.getTime()))) {
    const currentPlaceholder = createCurrentPlaceholder(activities, input);
    if (currentPlaceholder)
      activities = [...activities, currentPlaceholder].sort(compareActivities);
  }
  if (!activities.length) throw invalid("A schedule result must contain at least one activity.");
  for (let index = 1; index < activities.length; index += 1)
    if (
      overlaps(
        activities[index - 1].start_at,
        activities[index - 1].end_at,
        activities[index].start_at,
        activities[index].end_at,
      )
    )
      throw new PlanningValidationProblem(
        "PLANNER_ACTIVITY_OVERLAP",
        "The proposed schedule contains overlapping activities.",
      );
  if (
    (initialDay || catchUp) &&
    !activities.some(
      (activity) =>
        new Date(activity.start_at) <= input.now && input.now < new Date(activity.end_at),
    )
  )
    throw new PlanningValidationProblem(
      "PLANNER_CURRENT_ACTIVITY_MISSING",
      `${catchUp ? "A manual catch-up" : "A first schedule for today"} must include an activity covering the current time.`,
    );

  const conflictedEvents = new Set(conflicts.flatMap((conflict) => conflict.source_event_ids));
  const dayStart = localDateTimeToUtc(input.targetLocalDate, "00:00", input.timezone);
  const dayEnd = localDateTimeToUtc(
    addLocalDays(input.targetLocalDate, 1),
    "00:00",
    input.timezone,
  );
  const commitments = input.events.filter(
    (event) =>
      isFixedTimedCommitment(event) &&
      overlaps(event.start_at, event.end_at, dayStart, dayEnd) &&
      (!remainingDay || new Date(event.end_at) > input.now) &&
      (!catchUp || new Date(event.start_at) >= input.now),
  );
  for (const event of commitments) {
    const represented = activities.some(
      (activity) =>
        activity.source_event_ids.includes(event.id) &&
        activity.start_at === event.start_at &&
        activity.end_at === event.end_at,
    );
    if (!represented && !conflictedEvents.has(event.id))
      throw new PlanningValidationProblem(
        "PLANNER_COMMITMENT_MISSING",
        "The proposed schedule omitted a fixed Calendar commitment without identifying a conflict.",
      );
  }
  return { outcome, changeSummary, reasonSourceIds, activities, conflicts };
}

function normalizeCatchUpCalendarConflicts(
  activities: TwinActivity[],
  immutableActivityIds: Set<string>,
  conflicts: PlanningConflict[],
  now: Date,
) {
  const immutable = activities.filter((activity) => immutableActivityIds.has(activity.id));
  const flexible = activities.filter((activity) => !immutableActivityIds.has(activity.id));
  const calendarOnly = (activity: TwinActivity) =>
    Boolean(
      activity.source_event_ids.length &&
      !activity.supporting_report_ids?.length &&
      !activity.locked &&
      !activity.user_edited,
    );
  const authority = (activity: TwinActivity) => {
    if (activity.locked || activity.user_edited) return 3;
    if (activity.supporting_report_ids?.length) return 2;
    return 1;
  };
  const elapsedCalendarOnly = immutable.filter(
    (activity) => calendarOnly(activity) && new Date(activity.start_at) < now,
  );
  const candidates = immutable
    .filter((activity) => !elapsedCalendarOnly.includes(activity))
    .sort((left, right) => authority(right) - authority(left) || compareActivities(left, right));
  for (const activity of elapsedCalendarOnly) {
    if (
      activities.some(
        (candidate) =>
          candidate.id !== activity.id &&
          !calendarOnly(candidate) &&
          activitiesOverlap(activity, candidate),
      )
    )
      appendCalendarConflict(
        conflicts,
        activity.source_event_ids,
        "An elapsed Calendar commitment conflicts with reported or protected history; Calendar does not prove attendance.",
      );
  }

  const accepted: TwinActivity[] = [];
  for (const activity of candidates) {
    const blockers = accepted.filter((candidate) => activitiesOverlap(activity, candidate));
    if (!blockers.length) {
      accepted.push(activity);
      continue;
    }
    if (calendarOnly(activity)) {
      appendCalendarConflict(
        conflicts,
        activity.source_event_ids,
        "A Calendar commitment overlaps another protected item and cannot share the single schedule lane.",
      );
      continue;
    }
    if (blockers.every(calendarOnly)) {
      for (const blocker of blockers) {
        accepted.splice(accepted.indexOf(blocker), 1);
        appendCalendarConflict(
          conflicts,
          blocker.source_event_ids,
          "A Calendar commitment overlaps another protected item and cannot share the single schedule lane.",
        );
      }
      accepted.push(activity);
      continue;
    }
    throw new PlanningValidationProblem(
      "PLANNER_ACTIVITY_OVERLAP",
      "The proposed schedule contains overlapping reported, locked, or directly edited activities.",
    );
  }

  return {
    activities: [...accepted, ...flexible].sort(compareActivities),
    immutableActivityIds: new Set(accepted.map((activity) => activity.id)),
  };
}

function activitiesOverlap(left: TwinActivity, right: TwinActivity) {
  return overlaps(left.start_at, left.end_at, right.start_at, right.end_at);
}

function appendCalendarConflict(
  conflicts: PlanningConflict[],
  sourceEventIds: string[],
  description: string,
) {
  const unknownIds = sourceEventIds.filter(
    (eventId) => !conflicts.some((conflict) => conflict.source_event_ids.includes(eventId)),
  );
  if (!unknownIds.length) return;
  const compatible = conflicts.find(
    (conflict) =>
      conflict.kind === "calendar_overlap" &&
      conflict.description === description &&
      conflict.source_event_ids.length + unknownIds.length <= 16,
  );
  if (compatible) {
    compatible.source_event_ids.push(...unknownIds);
    return;
  }
  if (conflicts.length >= 12)
    throw new PlanningValidationProblem(
      "PLANNER_CONFLICT_OVERFLOW",
      "The proposed schedule contains too many unresolved Calendar conflicts.",
    );
  conflicts.push({ kind: "calendar_overlap", description, source_event_ids: unknownIds });
}

function repairFlexibleActivityIntervals(
  activities: TwinActivity[],
  immutableActivityIds: Set<string>,
  now: Date,
  preferCurrent: boolean,
) {
  const immutable = activities
    .filter((activity) => immutableActivityIds.has(activity.id))
    .sort(compareActivities);
  assertNoOverlap(immutable);

  const nowMs = now.getTime();
  const flexible = activities
    .filter((activity) => !immutableActivityIds.has(activity.id))
    .sort((left, right) => {
      if (preferCurrent) {
        const leftCoversNow = intervalCovers(left, nowMs);
        const rightCoversNow = intervalCovers(right, nowMs);
        if (leftCoversNow !== rightCoversNow) return leftCoversNow ? -1 : 1;
      }
      return compareActivities(left, right);
    });
  const accepted = [...immutable];
  for (const activity of flexible) {
    const originalStart = new Date(activity.start_at).getTime();
    const originalEnd = new Date(activity.end_at).getTime();
    let segments = [{ start: originalStart, end: originalEnd }];
    for (const blocker of accepted) {
      const blockerStart = new Date(blocker.start_at).getTime();
      const blockerEnd = new Date(blocker.end_at).getTime();
      segments = segments.flatMap((segment) => {
        if (blockerEnd <= segment.start || blockerStart >= segment.end) return [segment];
        const remaining: Array<{ start: number; end: number }> = [];
        if (blockerStart > segment.start)
          remaining.push({ start: segment.start, end: blockerStart });
        if (blockerEnd < segment.end) remaining.push({ start: blockerEnd, end: segment.end });
        return remaining;
      });
    }
    const candidates = segments.filter((segment) => segment.end - segment.start >= 5 * 60_000);
    const currentCandidate =
      preferCurrent && intervalCovers(activity, nowMs)
        ? candidates.find((segment) => segment.start <= nowMs && nowMs < segment.end)
        : undefined;
    const chosen =
      currentCandidate ??
      candidates.sort(
        (left, right) =>
          right.end - right.start - (left.end - left.start) || left.start - right.start,
      )[0];
    if (!chosen) continue;
    accepted.push({
      ...activity,
      start_at: new Date(chosen.start).toISOString(),
      end_at: new Date(chosen.end).toISOString(),
    });
  }
  accepted.sort(compareActivities);
  assertNoOverlap(accepted);
  return accepted;
}

function compareActivities(left: TwinActivity, right: TwinActivity) {
  return left.start_at.localeCompare(right.start_at) || left.end_at.localeCompare(right.end_at);
}

function createCurrentPlaceholder(
  activities: TwinActivity[],
  input: PlanningValidationInput,
): TwinActivity | undefined {
  const nowMs = input.now.getTime();
  const dayStart = new Date(
    localDateTimeToUtc(input.targetLocalDate, "00:00", input.timezone),
  ).getTime();
  const dayEnd = new Date(
    localDateTimeToUtc(addLocalDays(input.targetLocalDate, 1), "00:00", input.timezone),
  ).getTime();
  if (nowMs < dayStart || nowMs >= dayEnd) return undefined;
  const freeStart = activities.reduce((latest, activity) => {
    const end = new Date(activity.end_at).getTime();
    return end <= nowMs ? Math.max(latest, end) : latest;
  }, dayStart);
  const freeEnd = activities.reduce((earliest, activity) => {
    const start = new Date(activity.start_at).getTime();
    return start > nowMs ? Math.min(earliest, start) : earliest;
  }, dayEnd);
  if (freeEnd - freeStart < 5 * 60_000) return undefined;
  const start = Math.max(freeStart, Math.min(nowMs, freeEnd - 5 * 60_000));
  const end = Math.min(freeEnd, Math.max(nowMs + 30 * 60_000, start + 5 * 60_000));
  return {
    id: randomUUID(),
    user_id: input.userId,
    activity_key: "generic",
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    title: "Open time",
    narrative: "The Twin is in an unscheduled, imagined stretch of the day.",
    reason:
      "Twin added a neutral current-time placeholder because the proposed first day left this moment open.",
    supporting_fact_ids: [],
    source_event_ids: [],
    supporting_report_ids: [],
    source_message_ids: [],
    source_types: [],
    confidence: "possible",
    is_experiment: false,
  };
}

function intervalCovers(activity: TwinActivity, instantMs: number) {
  return (
    new Date(activity.start_at).getTime() <= instantMs &&
    instantMs < new Date(activity.end_at).getTime()
  );
}

function assertNoOverlap(activities: TwinActivity[]) {
  for (let index = 1; index < activities.length; index += 1)
    if (
      overlaps(
        activities[index - 1].start_at,
        activities[index - 1].end_at,
        activities[index].start_at,
        activities[index].end_at,
      )
    )
      throw new PlanningValidationProblem(
        "PLANNER_ACTIVITY_OVERLAP",
        "The proposed schedule contains overlapping protected or Calendar activities.",
      );
}

function invalid(message: string) {
  return new PlanningValidationProblem("PLANNER_OUTPUT_INVALID", message);
}

function objectValue(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlanningValidationProblem(code, message);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw invalid(`Planner field ${field} must contain 1–${max} characters.`);
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number) {
  if (value === "" || value === null || value === undefined) return "";
  return stringValue(value, field, max);
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw invalid(`Planner field ${field} must be a number.`);
  return value;
}

function arrayValue(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw invalid(`Planner field ${field} must be an array with at most ${max} entries.`);
  return value;
}

function stringArray(value: unknown, field: string, max: number) {
  const values = arrayValue(value, field, max);
  if (values.some((item) => typeof item !== "string" || !item.trim() || item.length > 200))
    throw invalid(`Planner field ${field} contains an invalid ID.`);
  return [...new Set(values.map((item) => String(item)))];
}

function requireKnown(values: string[], known: Set<string>, label: string) {
  if (values.some((value) => !known.has(value)))
    throw new PlanningValidationProblem(
      "PLANNER_UNKNOWN_SOURCE",
      `The planner referenced an unknown ${label} source.`,
    );
}

function isFixedTimedCommitment(
  event: CalendarEvent,
): event is CalendarEvent & { start_at: string; end_at: string } {
  return Boolean(
    !event.deleted &&
    event.availability !== "free" &&
    event.self_response_status !== "declined" &&
    !event.all_day &&
    event.start_at &&
    event.end_at,
  );
}

// Demo-only fixture generation. Production planning never calls this or falls back to it.
export interface DemoTwinDayInput {
  userId: string;
  localDate: string;
  settings: Settings;
  events: CalendarEvent[];
  facts: ProfileFact[];
  gmailCues: GmailCue[];
  reports: ActivityReport[];
  previous?: TwinDayVersion;
  reason?: string;
}

export function generateDemoTwinDay(input: DemoTwinDayInput): TwinDayVersion {
  const activeFacts = input.facts.filter((fact) => fact.status === "active");
  const activities: TwinActivity[] = [];
  const add = (
    time: string,
    minutes: number,
    key: ActivityKey,
    title: string,
    narrative: string,
    reason: string,
    supporting: string[] = [],
  ) => {
    const start = localDateTimeToUtc(input.localDate, time, input.settings.timezone);
    const end = addMinutes(start, minutes);
    if (!activities.some((item) => overlaps(start, end, item.start_at, item.end_at)))
      activities.push({
        id: randomUUID(),
        user_id: input.userId,
        activity_key: key,
        start_at: start,
        end_at: end,
        title,
        narrative,
        reason,
        supporting_fact_ids: supporting,
        source_event_ids: [],
        source_types: supporting.length ? ["memory"] : [],
        confidence: supporting.length ? "grounded" : "possible",
        is_experiment: false,
      });
  };
  add(
    input.settings.wake_time,
    45,
    "generic",
    "A quiet start",
    "The demo twin takes the morning slowly and gets oriented.",
    "Demo fixture built around the saved wake window.",
  );
  add(
    "09:00",
    120,
    "working",
    "Focused work",
    "The demo twin settles into a calm work stretch.",
    "Static demo fixture, not production planning.",
  );
  add(
    "12:00",
    40,
    "eating",
    "Lunch away from the screen",
    "The demo twin stops for something simple.",
    "Static demo fixture, not production planning.",
  );
  const walkFact = activeFacts.find((fact) => /walk|outside|fresh air/i.test(fact.statement));
  if (walkFact)
    add(
      "12:45",
      20,
      "walking",
      "A short reset walk",
      "The demo twin steps outside after lunch.",
      `Demo context: ${walkFact.statement}`,
      [walkFact.id],
    );
  add(
    "15:30",
    55,
    "studying",
    "Curiosity hour",
    "The demo twin follows one thread without trying to finish everything.",
    "Static demo fixture, not production planning.",
  );
  add(
    "18:30",
    50,
    "eating",
    "Dinner",
    "The demo twin makes dinner and lets work stay finished.",
    "Static demo fixture, not production planning.",
  );
  add(
    input.settings.sleep_time,
    30,
    "sleeping",
    "Winding down",
    "The demo twin puts the day away.",
    "Demo fixture built around the saved sleep window.",
  );
  activities.sort((left, right) => left.start_at.localeCompare(right.start_at));
  return {
    id: randomUUID(),
    user_id: input.userId,
    local_date: input.localDate,
    timezone: input.settings.timezone,
    version: (input.previous?.version ?? 0) + 1,
    status: "ready",
    generated_at: new Date().toISOString(),
    reason: input.reason ?? "Static demo fixture",
    memory_revision: Math.max(0, ...input.facts.map((fact) => fact.version)),
    calendar_revision: Math.max(0, ...input.events.map((event) => event.sync_revision)),
    report_revision: input.reports.length,
    limited_context: ["Demo data: no live model planning call was made."],
    tomorrow_may_change_because: ["Live planning uses current saved context when configured."],
    activities,
  };
}

export function activityAt(day: TwinDayVersion, now = new Date()) {
  return (
    day.activities.find(
      (activity) => new Date(activity.start_at) <= now && now < new Date(activity.end_at),
    ) ??
    day.activities.find((activity) => new Date(activity.start_at) > now) ??
    day.activities.at(-1)
  );
}

export function activityLabel(key: ActivityKey) {
  return (
    {
      generic: "Getting ready",
      studying: "Studying",
      working: "Working",
      walking: "Walking",
      running: "Running",
      eating: "Eating",
      sleeping: "Sleeping",
      resting: "Resting",
      commuting: "Commuting",
      bathroom: "Bathroom break",
    } as Record<ActivityKey, string>
  )[key];
}
