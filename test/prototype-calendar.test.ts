import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrototypeCalendarConfig } from "../src/config/prototype-calendar.ts";
import { parsePrototypeCalendar } from "../src/integrations/prototype-calendar.ts";
import {
  importPrototypeCalendarFeed,
  importSharedPrototypeCalendarForAllUsers,
} from "../src/services/prototype-calendar.ts";
import { selectPlanningContext } from "../src/storage/context.ts";
import { initializeLocalProfile } from "../src/storage/store.ts";
import { MemoryStore } from "./memory-store.ts";

const feedUrl = "https://mywharton2.wharton.upenn.edu/api/v2/events/calendars/ical/test-feed-id/";

function calendar(summary = "Class planning") {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Twin Test//EN",
    "BEGIN:VEVENT",
    "UID:timed-event",
    "DTSTAMP:20261020T120000Z",
    "DTSTART:20261027T130000Z",
    "DTEND:20261027T140000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:all-day-event",
    "DTSTAMP:20261020T120000Z",
    "DTSTART;VALUE=DATE:20261028",
    "DTEND;VALUE=DATE:20261029",
    "SUMMARY:Academic deadline",
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

test("prototype iCalendar normalizes into the Google Calendar event contract", () => {
  const events = parsePrototypeCalendar(calendar(), "user_demo", {
    calendarId: "prototype:test",
    windowStart: new Date("2026-10-26T00:00:00Z"),
    windowEnd: new Date("2026-11-26T00:00:00Z"),
    syncRevision: 42,
  });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => ({
      external_id: event.external_id,
      calendar_id: event.calendar_id,
      start_at: event.start_at,
      end_at: event.end_at,
      start_date: event.start_date,
      end_date: event.end_date,
      all_day: event.all_day,
      availability: event.availability,
      source_type: event.source_type,
      sync_revision: event.sync_revision,
    })),
    [
      {
        external_id: "timed-event",
        calendar_id: "prototype:test",
        start_at: "2026-10-27T13:00:00.000Z",
        end_at: "2026-10-27T14:00:00.000Z",
        start_date: undefined,
        end_date: undefined,
        all_day: false,
        availability: "busy",
        source_type: "prototype_ical",
        sync_revision: 42,
      },
      {
        external_id: "all-day-event",
        calendar_id: "prototype:test",
        start_at: undefined,
        end_at: undefined,
        start_date: "2026-10-28",
        end_date: "2026-10-29",
        all_day: true,
        availability: "free",
        source_type: "prototype_ical",
        sync_revision: 42,
      },
    ],
  );
});

test("prototype feed import replaces demo data and feeds normal planning context", async () => {
  const store = await new MemoryStore("prototype-calendar-import").init();
  const fetchImpl = async () =>
    new Response(calendar(), { headers: { "content-type": "text/calendar" } });
  const result = await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-26T12:00:00Z"),
    fetchImpl,
  });
  assert.deepEqual(result, {
    status: "imported",
    event_count: 2,
    window_start: "2026-10-24",
    window_end: "2026-11-26",
  });
  let state = await store.snapshot();
  const connection = state.integrations.find((item) => item.provider === "google_calendar")!;
  assert.equal(connection.mode, "prototype");
  assert.equal(connection.status, "imported");
  assert.equal(connection.encrypted_token, undefined);
  assert.equal(connection.source_event_count, 2);
  assert.equal(state.calendar_events.length, 2);
  const context = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-27",
    trigger: "morning",
    now: new Date("2026-10-26T12:00:00Z"),
  });
  assert.equal(context.calendar.data_state, "available");
  assert.equal(context.calendar.connection_status, "imported");
  assert.deepEqual(
    context.calendar.events.map((event) => event.id),
    [state.calendar_events[0].id],
  );

  const originalIds = state.calendar_events.map((event) => event.id);
  const duplicate = await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-26T12:00:00Z"),
    fetchImpl,
  });
  assert.equal(duplicate.status, "unchanged");
  state = await store.snapshot();
  assert.deepEqual(
    state.calendar_events.map((event) => event.id),
    originalIds,
  );

  const shiftedWindow = await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-27T12:00:00Z"),
    fetchImpl,
  });
  assert.equal(shiftedWindow.status, "imported");
  assert.equal(shiftedWindow.window_start, "2026-10-25");
  assert.equal(shiftedWindow.window_end, "2026-11-27");
});

test("prototype feed URL is restricted and live Google credentials cannot be replaced", async () => {
  const store = await new MemoryStore("prototype-calendar-guard").init();
  await assert.rejects(
    importPrototypeCalendarFeed(store, "user_demo", "https://example.com/calendar.ics", {
      now: new Date("2026-10-26T12:00:00Z"),
      fetchImpl: async () => new Response(calendar()),
    }),
    (error: any) => error?.code === "PROTOTYPE_CALENDAR_URL_INVALID",
  );
  await store.transaction((draft) => {
    const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
    connection.mode = "live";
    connection.status = "connected";
    connection.encrypted_token = { iv: "iv", tag: "tag", ciphertext: "secret" };
  });
  await assert.rejects(
    importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
      now: new Date("2026-10-26T12:00:00Z"),
      fetchImpl: async () => new Response(calendar()),
    }),
    /LIVE_CALENDAR_ALREADY_CONNECTED/,
  );
});

test("prototype feed window follows the owner's local date near a UTC rollover", async () => {
  const store = await new MemoryStore("prototype-calendar-local-window").init();
  await store.transaction((draft) => {
    const settings = draft.settings.find((item) => item.user_id === "user_demo");
    assert.ok(settings);
    settings.timezone = "America/New_York";
  });

  const result = await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-27T03:30:00.000Z"),
    fetchImpl: async () => new Response(calendar()),
  });

  assert.equal(result.window_start, "2026-10-24");
  assert.equal(result.window_end, "2026-11-26");
});

test("shared prototype config stays server-side and can be disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twin-prototype-calendar-"));
  const path = join(directory, "calendar.json");
  try {
    await writeFile(path, JSON.stringify({ enabled: true, source_url: feedUrl }));
    assert.deepEqual(await loadPrototypeCalendarConfig(path), {
      enabled: true,
      sourceUrl: feedUrl,
    });
    await writeFile(path, JSON.stringify({ enabled: false, source_url: feedUrl }));
    assert.equal(await loadPrototypeCalendarConfig(path), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared prototype feed creates separate owner-scoped snapshots for every user", async () => {
  const store = await new MemoryStore("prototype-calendar-all-users").init();
  await store.transaction((draft) => {
    initializeLocalProfile(draft, "second_user", "America/New_York");
  });
  let fetchCount = 0;
  const results = await importSharedPrototypeCalendarForAllUsers(store, feedUrl, {
    now: new Date("2026-10-26T12:00:00Z"),
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(calendar());
    },
  });
  assert.equal(results.length, 2);
  assert.equal(fetchCount, 2);
  const state = await store.snapshot();
  assert.equal(state.calendar_events.filter((item) => item.user_id === "user_demo").length, 2);
  assert.equal(state.calendar_events.filter((item) => item.user_id === "second_user").length, 2);
  assert.equal(
    state.integrations.some((item) => item.source_url_hash !== undefined),
    false,
  );
  assert.deepEqual(
    new Set(state.calendar_events.map((item) => item.user_id)),
    new Set(["user_demo", "second_user"]),
  );
});

test("shared refresh removes legacy per-user source identity", async () => {
  const store = await new MemoryStore("prototype-calendar-legacy-source").init();
  const fetchImpl = async () => new Response(calendar());
  await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-26T12:00:00Z"),
    fetchImpl,
  });
  await store.transaction((draft) => {
    const connection = draft.integrations.find(
      (item) => item.user_id === "user_demo" && item.provider === "google_calendar",
    )!;
    connection.source_url_hash = "legacy-user-source-hash";
    connection.selected_calendars = [
      { id: "prototype:legacy-url-hash", name: "Legacy snapshot", selected: true },
    ];
  });
  const refreshed = await importPrototypeCalendarFeed(store, "user_demo", feedUrl, {
    now: new Date("2026-10-26T12:00:00Z"),
    fetchImpl,
  });
  assert.equal(refreshed.status, "imported");
  const state = await store.snapshot();
  const connection = state.integrations.find((item) => item.provider === "google_calendar")!;
  assert.equal(connection.source_url_hash, undefined);
  assert.equal(connection.selected_calendars?.[0].id, "prototype:shared-calendar");
  assert.equal(
    state.calendar_events.every((item) => item.calendar_id === "prototype:shared-calendar"),
    true,
  );
});
