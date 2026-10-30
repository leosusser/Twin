import type { Store } from "../storage/store.ts";
import { fetchPrototypeCalendar } from "../integrations/prototype-calendar.ts";

export interface SharedPrototypeCalendarResult {
  user_id: string;
  status: "imported" | "unchanged" | "skipped_live";
  event_count: number;
  window_start?: string;
  window_end?: string;
}

export async function importPrototypeCalendarFeed(
  store: Store,
  userId: string,
  sourceUrl: string,
  dependencies: { now?: Date; fetchImpl?: typeof fetch } = {},
) {
  const now = dependencies.now ?? new Date();
  const state = await store.snapshot();
  const timezone = state.settings.find((item) => item.user_id === userId)?.timezone ?? "UTC";
  const snapshot = await fetchPrototypeCalendar(
    sourceUrl,
    userId,
    now,
    dependencies.fetchImpl,
    timezone,
  );
  return store.transaction((draft) => {
    const connection = draft.integrations.find(
      (item) => item.user_id === userId && item.provider === "google_calendar",
    );
    if (!connection) throw new Error("CALENDAR_CONNECTION_MISSING");
    if (connection.mode === "live" && connection.encrypted_token)
      throw new Error("LIVE_CALENDAR_ALREADY_CONNECTED");
    let existingFeedHash: string | undefined;
    try {
      existingFeedHash = JSON.parse(connection.cursor ?? "{}").feed_sha256;
    } catch {
      existingFeedHash = undefined;
    }
    if (
      connection.mode === "prototype" &&
      existingFeedHash === snapshot.feedHash &&
      connection.source_window_start_date === snapshot.windowStart &&
      connection.source_window_end_date === snapshot.windowEnd &&
      connection.selected_calendars?.some(
        (calendar) => calendar.selected && calendar.id === snapshot.calendarId,
      )
    )
      return {
        status: "unchanged" as const,
        event_count: connection.source_event_count ?? snapshot.events.length,
        window_start: connection.source_window_start_date ?? snapshot.windowStart,
        window_end: connection.source_window_end_date ?? snapshot.windowEnd,
      };
    const priorIds = new Map(
      draft.calendar_events
        .filter((event) => event.user_id === userId && event.source_type === "prototype_ical")
        .map((event) => [`${event.calendar_id}\0${event.external_id}`, event.id]),
    );
    for (const event of snapshot.events) {
      const priorId = priorIds.get(`${event.calendar_id}\0${event.external_id}`);
      if (priorId) event.id = priorId;
    }
    draft.calendar_events = [
      ...draft.calendar_events.filter((event) => event.user_id !== userId),
      ...snapshot.events,
    ];
    delete connection.encrypted_token;
    delete connection.failure_code;
    connection.mode = "prototype";
    connection.status = "imported";
    connection.scopes = ["prototype.calendar.snapshot"];
    connection.credential_version = (connection.credential_version ?? 0) + 1;
    connection.last_successful_sync_at = now.toISOString();
    connection.cursor = JSON.stringify({
      source: "prototype_ical",
      feed_sha256: snapshot.feedHash,
    });
    connection.selected_calendars = [
      { id: snapshot.calendarId, name: "Wharton prototype snapshot", selected: true },
    ];
    delete connection.source_url_hash;
    connection.source_window_start_date = snapshot.windowStart;
    connection.source_window_end_date = snapshot.windowEnd;
    connection.source_event_count = snapshot.events.length;
    return {
      status: "imported" as const,
      event_count: snapshot.events.length,
      window_start: snapshot.windowStart,
      window_end: snapshot.windowEnd,
    };
  });
}

export async function importSharedPrototypeCalendarForAllUsers(
  store: Store,
  sourceUrl: string,
  dependencies: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<SharedPrototypeCalendarResult[]> {
  const userIds = (await store.snapshot()).users.map((user) => user.id);
  const results: SharedPrototypeCalendarResult[] = [];
  for (const userId of userIds) {
    try {
      const result = await importPrototypeCalendarFeed(store, userId, sourceUrl, dependencies);
      results.push({ user_id: userId, ...result });
    } catch (error) {
      if (error instanceof Error && error.message === "LIVE_CALENDAR_ALREADY_CONNECTED") {
        results.push({ user_id: userId, status: "skipped_live", event_count: 0 });
        continue;
      }
      throw error;
    }
  }
  return results;
}
