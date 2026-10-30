import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { CalendarEvent } from "../domain/types.ts";
import { addLocalDays, localDateInZone, localDateTimeToUtc } from "../domain/time.ts";
import { normalizeCalendarEvent } from "./calendar-event.ts";

const maxFeedBytes = 1_000_000;
const maxComponents = 5_000;
const maxOccurrences = 5_000;
const allowedHost = "mywharton2.wharton.upenn.edu";
const allowedPath = /^\/api\/v2\/events\/calendars\/ical\/[A-Za-z0-9-]+\/$/;

export class PrototypeCalendarProblem extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PrototypeCalendarSnapshot {
  events: CalendarEvent[];
  calendarId: string;
  feedHash: string;
  windowStart: string;
  windowEnd: string;
}

export async function fetchPrototypeCalendar(
  sourceUrl: string,
  userId: string,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  timezone = "UTC",
): Promise<PrototypeCalendarSnapshot> {
  const url = validatePrototypeCalendarUrl(sourceUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/calendar" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_FETCH_FAILED",
      "The prototype Calendar feed could not be reached.",
    );
  }
  if (!response.ok)
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_FETCH_FAILED",
      "The prototype Calendar feed returned an error.",
    );
  const text = await readBoundedText(response, maxFeedBytes);
  const localToday = localDateInZone(now, timezone);
  const windowStart = addLocalDays(localToday, -2);
  const windowEnd = addLocalDays(localToday, 31);
  const windowStartDate = new Date(localDateTimeToUtc(windowStart, "00:00", timezone));
  const windowEndDate = new Date(localDateTimeToUtc(addLocalDays(windowEnd, 1), "00:00", timezone));
  const calendarId = "prototype:shared-calendar";
  return {
    events: parsePrototypeCalendar(text, userId, {
      calendarId,
      windowStart: windowStartDate,
      windowEnd: windowEndDate,
      syncRevision: now.getTime(),
    }),
    calendarId,
    feedHash: createHash("sha256").update(text).digest("hex"),
    windowStart,
    windowEnd,
  };
}

export function parsePrototypeCalendar(
  text: string,
  userId: string,
  input: {
    calendarId: string;
    windowStart: Date;
    windowEnd: Date;
    syncRevision?: number;
  },
) {
  if (!text.trim() || text.length > maxFeedBytes)
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_INVALID",
      "The prototype Calendar feed is empty or too large.",
    );
  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_INVALID",
      "The prototype Calendar feed is not valid iCalendar data.",
    );
  }
  if (root.name !== "vcalendar")
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_INVALID",
      "The prototype Calendar feed is missing VCALENDAR.",
    );
  const components = root.getAllSubcomponents("vevent");
  if (components.length > maxComponents)
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_TOO_LARGE",
      "The prototype Calendar contains too many events.",
    );
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  const masters = components.filter((component) => !component.hasProperty("recurrence-id"));
  for (const component of masters) {
    const event = new ICAL.Event(component);
    if (!event.uid || !event.startDate)
      throw new PrototypeCalendarProblem(
        "PROTOTYPE_CALENDAR_INVALID",
        "Every prototype Calendar event needs a UID and start time.",
      );
    if (event.isRecurring()) {
      const iterator = event.iterator(ICAL.Time.fromJSDate(input.windowStart, true));
      for (let count = 0; count < maxOccurrences; count += 1) {
        const occurrence = iterator.next();
        if (!occurrence) break;
        const details = event.getOccurrenceDetails(occurrence);
        const start = details.startDate.toJSDate();
        const end = details.endDate.toJSDate();
        if (start >= input.windowEnd) break;
        if (end <= input.windowStart) continue;
        pushOccurrence(
          events,
          seen,
          userId,
          input,
          details.item,
          details.startDate,
          details.endDate,
          event.uid,
        );
        if (count === maxOccurrences - 1)
          throw new PrototypeCalendarProblem(
            "PROTOTYPE_CALENDAR_TOO_LARGE",
            "The prototype Calendar recurrence expands to too many events.",
          );
      }
    } else {
      const start = event.startDate.toJSDate();
      const end = event.endDate.toJSDate();
      if (start < input.windowEnd && end > input.windowStart)
        pushOccurrence(events, seen, userId, input, event, event.startDate, event.endDate);
    }
  }
  return events.sort((left, right) =>
    (left.start_at ?? left.start_date ?? "").localeCompare(
      right.start_at ?? right.start_date ?? "",
    ),
  );
}

function pushOccurrence(
  events: CalendarEvent[],
  seen: Set<string>,
  userId: string,
  input: {
    calendarId: string;
    windowStart: Date;
    windowEnd: Date;
    syncRevision?: number;
  },
  event: InstanceType<typeof ICAL.Event>,
  start: InstanceType<typeof ICAL.Time>,
  end: InstanceType<typeof ICAL.Time>,
  recurringEventId?: string,
) {
  const occurrenceKey = start.isDate ? start.toString() : start.toJSDate().toISOString();
  const externalId = recurringEventId ? `${event.uid}:${occurrenceKey}` : event.uid;
  if (seen.has(externalId)) return;
  seen.add(externalId);
  const status = String(event.component.getFirstPropertyValue("status") ?? "").toUpperCase();
  const transparency = String(event.component.getFirstPropertyValue("transp") ?? "").toUpperCase();
  events.push(
    normalizeCalendarEvent(
      userId,
      {
        externalId,
        calendarId: input.calendarId,
        title: event.summary || "Untitled event",
        startAt: start.isDate ? undefined : start.toJSDate().toISOString(),
        endAt: end.isDate ? undefined : end.toJSDate().toISOString(),
        startDate: start.isDate ? start.toString().slice(0, 10) : undefined,
        endDate: end.isDate ? end.toString().slice(0, 10) : undefined,
        sourceTimezone: start.zone?.tzid || "UTC",
        deleted: status === "CANCELLED",
        availability: transparency === "TRANSPARENT" ? "free" : "busy",
        recurringEventId,
        sourceType: "prototype_ical",
      },
      input.syncRevision,
    ),
  );
}

function validatePrototypeCalendarUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_URL_INVALID",
      "Use a valid Wharton iCalendar feed URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== allowedHost ||
    !allowedPath.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_URL_INVALID",
      "Use the private Wharton iCalendar feed URL for this prototype.",
    );
  return url;
}

async function readBoundedText(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new PrototypeCalendarProblem(
      "PROTOTYPE_CALENDAR_TOO_LARGE",
      "The prototype Calendar feed is too large.",
    );
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new PrototypeCalendarProblem(
        "PROTOTYPE_CALENDAR_TOO_LARGE",
        "The prototype Calendar feed is too large.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
