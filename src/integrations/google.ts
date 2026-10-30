import { randomUUID } from "node:crypto";
import type { CalendarEvent, GmailCue, IntegrationConnection } from "../domain/types.ts";
import {
  asNonEmptyProviderString,
  asProviderObject,
  asProviderObjects,
  asProviderString,
  type ProviderObject,
} from "./provider-json.ts";
import { decryptSecret } from "./secrets.ts";
import { normalizeCalendarEvent } from "./calendar-event.ts";
export class GoogleProblem extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
async function accessToken(connection: IntegrationConnection) {
  if (!connection.encrypted_token)
    throw new GoogleProblem("GOOGLE_TOKEN_MISSING", "Google credentials are missing.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: decryptSecret(connection.encrypted_token),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = asProviderObject(await response.json().catch(() => ({})));
  const token = asNonEmptyProviderString(payload.access_token);
  if (!response.ok || !token)
    throw new GoogleProblem(
      response.status === 401 || payload.error === "invalid_grant"
        ? "GOOGLE_AUTH_EXPIRED"
        : "GOOGLE_TOKEN_FAILED",
      "Google authorization needs attention.",
      response.status >= 500 || response.status === 429,
    );
  return token;
}
async function googleGet(url: URL, token: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = asProviderObject(await response.json().catch(() => ({})));
  return { response, payload };
}
export async function syncCalendar(connection: IntegrationConnection, userId: string) {
  const token = await accessToken(connection);
  const previousSelections = connection.selected_calendars ?? [];
  const selections: Array<{ id: string; name: string; selected: boolean }> = [];
  const previousById = new Map(previousSelections.map((calendar) => [calendar.id, calendar]));
  let calendarPage: string | undefined;
  let calendarPages = 0;
  do {
    const listUrl = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
    );
    if (calendarPage) listUrl.searchParams.set("pageToken", calendarPage);
    const { response, payload } = await googleGet(listUrl, token);
    if (!response.ok)
      throw new GoogleProblem(
        "CALENDAR_LIST_FAILED",
        "Could not list calendars.",
        response.status >= 500 || response.status === 429,
      );
    selections.push(
      ...asProviderObjects(payload.items).flatMap((item) => {
        const id = asNonEmptyProviderString(item.id);
        const previous = id ? previousById.get(id) : undefined;
        return id
          ? [
              {
                id,
                name: asProviderString(item.summary) ?? id,
                selected: previous
                  ? previous.selected
                  : previousSelections.length === 0 && item.primary === true,
              },
            ]
          : [];
      }),
    );
    calendarPage = asNonEmptyProviderString(payload.nextPageToken);
    calendarPages += 1;
    if (calendarPage && calendarPages >= 20)
      throw new GoogleProblem("CALENDAR_LIST_TOO_LARGE", "Calendar list is too large.");
  } while (calendarPage);
  const cursors = parseCalendarCursors(connection.cursor);
  const events: CalendarEvent[] = [];
  const nextCursors: Record<string, string> = {};
  const fullSyncCalendarIds: string[] = [];
  for (const calendar of selections.filter((item) => item.selected)) {
    const collected = await fetchCalendar(calendar.id, cursors[calendar.id], token);
    nextCursors[calendar.id] = collected.cursor;
    if (collected.fullSync) fullSyncCalendarIds.push(calendar.id);
    for (const item of collected.items) {
      const externalId = asNonEmptyProviderString(item.id);
      if (!externalId) continue;
      const start = asProviderObject(item.start);
      const end = asProviderObject(item.end);
      const selfResponse = asProviderObjects(item.attendees).find(
        (attendee) => attendee.self === true,
      )?.responseStatus;
      const selfResponseStatus = ["accepted", "declined", "tentative", "needsAction"].includes(
        String(selfResponse),
      )
        ? String(selfResponse) === "needsAction"
          ? "needs_action"
          : (String(selfResponse) as "accepted" | "declined" | "tentative")
        : undefined;
      events.push(
        normalizeCalendarEvent(userId, {
          externalId,
          calendarId: calendar.id,
          title: asProviderString(item.summary) ?? "Untitled event",
          startAt: asProviderString(start.dateTime),
          endAt: asProviderString(end.dateTime),
          startDate: asProviderString(start.date),
          endDate: asProviderString(end.date),
          sourceTimezone: asProviderString(start.timeZone) ?? "UTC",
          deleted: item.status === "cancelled",
          availability: item.transparency === "transparent" ? "free" : "busy",
          selfResponseStatus,
          recurringEventId: asProviderString(item.recurringEventId),
          sourceType: "google_api",
        }),
      );
    }
  }
  return {
    events,
    selections,
    cursor: JSON.stringify(nextCursors),
    fullSyncCalendarIds,
  };
}

function parseCalendarCursors(value: string | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

async function fetchCalendar(calendarId: string, cursor: string | undefined, token: string) {
  const attempts = cursor ? [cursor, undefined] : [undefined];
  for (const syncToken of attempts) {
    const items: ProviderObject[] = [];
    let page: string | undefined;
    let nextSync = "";
    let expired = false;
    let pages = 0;
    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "2500");
      if (syncToken) url.searchParams.set("syncToken", syncToken);
      else {
        url.searchParams.set("timeMin", new Date(Date.now() - 30 * 86_400_000).toISOString());
        url.searchParams.set("timeMax", new Date(Date.now() + 180 * 86_400_000).toISOString());
      }
      if (page) url.searchParams.set("pageToken", page);
      const { response, payload } = await googleGet(url, token);
      if (response.status === 410 && syncToken) {
        expired = true;
        break;
      }
      if (!response.ok)
        throw new GoogleProblem(
          "CALENDAR_SYNC_FAILED",
          "Calendar sync failed.",
          response.status >= 500 || response.status === 429,
        );
      items.push(...asProviderObjects(payload.items));
      page = asNonEmptyProviderString(payload.nextPageToken);
      nextSync = asNonEmptyProviderString(payload.nextSyncToken) ?? nextSync;
      pages += 1;
      if (page && pages >= 100)
        throw new GoogleProblem("CALENDAR_TOO_LARGE", "Calendar contains too many event pages.");
    } while (page);
    if (expired) continue;
    return { items, cursor: nextSync || syncToken || "", fullSync: !syncToken };
  }
  throw new GoogleProblem("CALENDAR_SYNC_TOKEN_FAILED", "Calendar sync token could not recover.");
}

function uniqueMessageIds(items: unknown, readId: (item: ProviderObject) => unknown): string[] {
  const ids = new Set<string>();
  for (const item of asProviderObjects(items)) {
    const id = asNonEmptyProviderString(readId(item));
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function syncGmail(connection: IntegrationConnection, userId: string) {
  const token = await accessToken(connection);
  let ids: string[] = [];
  let nextCursor = connection.cursor;
  if (connection.cursor) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", connection.cursor);
    url.searchParams.set("maxResults", "200");
    const { response, payload } = await googleGet(url, token);
    if (response.status === 404) nextCursor = undefined;
    else if (!response.ok)
      throw new GoogleProblem(
        "GMAIL_SYNC_FAILED",
        "Gmail sync failed.",
        response.status >= 500 || response.status === 429,
      );
    else {
      const additions = asProviderObjects(payload.history).flatMap((history) =>
        Array.isArray(history.messagesAdded) ? history.messagesAdded : [],
      );
      ids = uniqueMessageIds(additions, (entry) => asProviderObject(entry.message).id);
      nextCursor = asNonEmptyProviderString(payload.historyId) ?? connection.cursor;
    }
  }
  if (!nextCursor) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("q", "newer_than:30d");
    const { response, payload } = await googleGet(url, token);
    if (!response.ok)
      throw new GoogleProblem(
        "GMAIL_FULL_SYNC_FAILED",
        "Gmail full sync failed.",
        response.status >= 500,
      );
    ids = uniqueMessageIds(payload.messages, (item) => item.id);
  }
  const cues: GmailCue[] = [];
  for (const id of ids.slice(0, 50)) {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
    );
    url.searchParams.set("format", "metadata");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "Date");
    const { response, payload } = await googleGet(url, token);
    if (!response.ok) continue;
    nextCursor = asNonEmptyProviderString(payload.historyId) ?? nextCursor;
    const messagePayload = asProviderObject(payload.payload);
    const subject =
      asProviderString(
        asProviderObjects(messagePayload.headers).find(
          (header) => asProviderString(header.name)?.toLowerCase() === "subject",
        )?.value,
      ) ?? "";
    if (!/schedule|class|meeting|deadline|cancel|changed|rescheduled/i.test(subject)) continue;
    const rawCapturedAt =
      typeof payload.internalDate === "string" || typeof payload.internalDate === "number"
        ? Number(payload.internalDate)
        : Date.now();
    const capturedAt = Number.isFinite(rawCapturedAt) ? rawCapturedAt : Date.now();
    cues.push({
      id: randomUUID(),
      user_id: userId,
      source_message_id: id,
      kind: /cancel|changed|rescheduled/i.test(subject) ? "change_notice" : "dated_obligation",
      statement: `Mail may contain timing context: ${subject.slice(0, 180)}`,
      source_excerpt: subject.slice(0, 180),
      captured_at: new Date(capturedAt).toISOString(),
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      confidence: "possible",
      status: "active",
    });
  }
  return { cues, cursor: nextCursor ?? String(Date.now()) };
}
