import { randomUUID } from "node:crypto";
import type { CalendarEvent } from "../domain/types.ts";

export interface NormalizedCalendarEventInput {
  externalId: string;
  calendarId: string;
  title: string;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  sourceTimezone: string;
  deleted?: boolean;
  availability?: "busy" | "free";
  selfResponseStatus?: CalendarEvent["self_response_status"];
  recurringEventId?: string;
  sourceType: NonNullable<CalendarEvent["source_type"]>;
}

export function normalizeCalendarEvent(
  userId: string,
  input: NormalizedCalendarEventInput,
  syncRevision = Date.now(),
): CalendarEvent {
  const externalId = input.externalId.trim();
  const calendarId = input.calendarId.trim();
  if (!externalId || !calendarId) throw new Error("CALENDAR_EVENT_ID_MISSING");
  const timed = Boolean(input.startAt && input.endAt);
  const allDay = Boolean(input.startDate && input.endDate);
  if (timed === allDay) throw new Error("CALENDAR_EVENT_TIME_INVALID");
  if (timed) {
    const start = new Date(input.startAt!);
    const end = new Date(input.endAt!);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
      throw new Error("CALENDAR_EVENT_TIME_INVALID");
  } else if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate!) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate!) ||
    input.startDate! >= input.endDate!
  ) {
    throw new Error("CALENDAR_EVENT_DATE_INVALID");
  }
  return {
    id: randomUUID(),
    user_id: userId,
    external_id: externalId.slice(0, 500),
    calendar_id: calendarId.slice(0, 500),
    title: (input.title.trim() || "Untitled event").slice(0, 300),
    start_at: timed ? new Date(input.startAt!).toISOString() : undefined,
    end_at: timed ? new Date(input.endAt!).toISOString() : undefined,
    start_date: allDay ? input.startDate : undefined,
    end_date: allDay ? input.endDate : undefined,
    source_timezone: input.sourceTimezone.trim().slice(0, 200) || "UTC",
    all_day: allDay,
    deleted: input.deleted ?? false,
    availability: input.availability ?? "busy",
    self_response_status: input.selfResponseStatus,
    recurring_event_id: input.recurringEventId?.slice(0, 500),
    source_type: input.sourceType,
    sync_revision: syncRevision,
  };
}
