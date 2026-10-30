import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationConnection, Job } from "../src/domain/types.ts";
import { syncCalendar } from "../src/integrations/google.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";
import { executeCalendar, processJobs } from "../src/worker.ts";
import { MemoryStore } from "./memory-store.ts";

function liveConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "calendar-test",
    user_id: "user_demo",
    provider: "google_calendar",
    mode: "live",
    status: "connected",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    encrypted_token: encryptSecret("refresh-token"),
    credential_version: 3,
    selected_calendars: [],
    ...overrides,
  };
}

test("Calendar discovery and events paginate while preserving primary selection", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  const eventPages: string[] = [];
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "access-token" });
      if (url.pathname.endsWith("/calendarList")) {
        if (!url.searchParams.get("pageToken"))
          return Response.json({
            items: [{ id: "primary", summary: "My calendar", primary: true }],
            nextPageToken: "calendar-page-2",
          });
        return Response.json({ items: [{ id: "shared", summary: "Shared" }] });
      }
      eventPages.push(url.searchParams.get("pageToken") ?? "first");
      if (!url.searchParams.get("pageToken"))
        return Response.json({
          items: [
            {
              id: "event-1",
              summary: "Planning",
              start: { dateTime: "2026-10-27T13:00:00Z" },
              end: { dateTime: "2026-10-27T14:00:00Z" },
              transparency: "transparent",
              attendees: [
                { email: "someone@example.com", responseStatus: "accepted" },
                { self: true, responseStatus: "needsAction" },
              ],
            },
          ],
          nextPageToken: "event-page-2",
        });
      return Response.json({
        items: [
          {
            id: "event-2",
            summary: "Offsite",
            start: { date: "2026-10-28" },
            end: { date: "2026-10-29" },
          },
        ],
        nextSyncToken: "next-primary",
      });
    };

    const result = await syncCalendar(liveConnection(), "user_demo");
    assert.deepEqual(result.selections, [
      { id: "primary", name: "My calendar", selected: true },
      { id: "shared", name: "Shared", selected: false },
    ]);
    assert.deepEqual(eventPages, ["first", "event-page-2"]);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].availability, "free");
    assert.equal(result.events[0].self_response_status, "needs_action");
    assert.equal(result.events[0].source_type, "google_api");
    assert.equal(result.events[1].all_day, true);
    assert.deepEqual(result.fullSyncCalendarIds, ["primary"]);
    assert.deepEqual(JSON.parse(result.cursor), { primary: "next-primary" });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Calendar HTTP 410 discards the incremental attempt and performs a clean full sync", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  const eventQueries: string[] = [];
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "access-token" });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({
          items: [{ id: "primary", summary: "My calendar", primary: true }],
        });
      eventQueries.push(url.search);
      if (url.searchParams.get("syncToken"))
        return Response.json({ error: { code: 410 } }, { status: 410 });
      return Response.json({
        items: [
          {
            id: "replacement",
            summary: "Replacement",
            start: { dateTime: "2026-10-27T15:00:00Z" },
            end: { dateTime: "2026-10-27T16:00:00Z" },
          },
        ],
        nextSyncToken: "fresh-cursor",
      });
    };

    const result = await syncCalendar(
      liveConnection({
        selected_calendars: [{ id: "primary", name: "My calendar", selected: true }],
        cursor: JSON.stringify({ primary: "expired-cursor" }),
      }),
      "user_demo",
    );
    assert.equal(eventQueries.length, 2);
    assert.match(eventQueries[0], /syncToken=expired-cursor/);
    assert.doesNotMatch(eventQueries[1], /syncToken=/);
    assert.deepEqual(result.fullSyncCalendarIds, ["primary"]);
    assert.deepEqual(
      result.events.map((event) => event.external_id),
      ["replacement"],
    );
    assert.deepEqual(JSON.parse(result.cursor), { primary: "fresh-cursor" });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Calendar maps a revoked refresh token to an expired authorization", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await assert.rejects(
      syncCalendar(liveConnection(), "user_demo"),
      (error: any) => error?.code === "GOOGLE_AUTH_EXPIRED" && error?.retryable === false,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Calendar worker replaces full-sync events and ignores a stale credential generation", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const store = await new MemoryStore("calendar-worker").init();
    await store.transaction((draft) => {
      const connection = draft.integrations.find(
        (item) => item.user_id === "user_demo" && item.provider === "google_calendar",
      )!;
      Object.assign(connection, liveConnection({ id: connection.id }));
      draft.calendar_events = [
        {
          id: "old-local",
          user_id: "user_demo",
          external_id: "old-provider",
          calendar_id: "primary",
          title: "Old event",
          start_at: "2026-10-27T10:00:00Z",
          end_at: "2026-10-27T11:00:00Z",
          source_timezone: "UTC",
          all_day: false,
          deleted: false,
          sync_revision: 1,
        },
      ];
    });
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "access-token" });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({
          items: [{ id: "primary", summary: "My calendar", primary: true }],
        });
      return Response.json({
        items: [
          {
            id: "new-provider",
            summary: "New event",
            start: { dateTime: "2026-10-27T12:00:00Z" },
            end: { dateTime: "2026-10-27T13:00:00Z" },
          },
        ],
        nextSyncToken: "worker-cursor",
      });
    };
    const job: Job = {
      id: "calendar-job",
      user_id: "user_demo",
      type: "calendar_sync",
      dedupe_key: "calendar-worker-test",
      status: "running",
      attempts: 1,
      run_after: new Date().toISOString(),
      payload: { credential_version: 3 },
    };
    await executeCalendar(job, store);
    let state = await store.snapshot();
    assert.deepEqual(
      state.calendar_events.map((event) => event.external_id),
      ["new-provider"],
    );
    assert.equal(
      state.integrations.find((item) => item.provider === "google_calendar")?.status,
      "connected",
    );
    const before = structuredClone(state.calendar_events);
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      connection.credential_version = 4;
    });
    globalThis.fetch = async () => {
      throw new Error("stale job must not call Google");
    };
    await executeCalendar(job, store);
    state = await store.snapshot();
    assert.deepEqual(state.calendar_events, before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Calendar worker cannot restore events after disconnect during provider I/O", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const store = await new MemoryStore("calendar-disconnect-race").init();
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      Object.assign(connection, liveConnection({ id: connection.id }));
      draft.calendar_events = [];
    });
    let releaseEvents!: () => void;
    let eventRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      eventRequestStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "access-token" });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({
          items: [{ id: "primary", summary: "My calendar", primary: true }],
        });
      eventRequestStarted();
      await release;
      return Response.json({
        items: [
          {
            id: "late-event",
            summary: "Late event",
            start: { dateTime: "2026-10-27T12:00:00Z" },
            end: { dateTime: "2026-10-27T13:00:00Z" },
          },
        ],
        nextSyncToken: "late-cursor",
      });
    };
    const job: Job = {
      id: "race-job",
      user_id: "user_demo",
      type: "calendar_sync",
      dedupe_key: "calendar-race",
      status: "running",
      attempts: 1,
      run_after: new Date().toISOString(),
      payload: { credential_version: 3 },
    };
    const running = executeCalendar(job, store);
    await started;
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      delete connection.encrypted_token;
      connection.status = "disconnected";
      connection.credential_version = 4;
    });
    releaseEvents();
    await running;
    const state = await store.snapshot();
    assert.equal(state.calendar_events.length, 0);
    assert.equal(
      state.integrations.find((item) => item.provider === "google_calendar")?.status,
      "disconnected",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Calendar worker cannot restore a deselected calendar after provider I/O", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const store = await new MemoryStore("calendar-selection-race").init();
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      Object.assign(
        connection,
        liveConnection({
          id: connection.id,
          selected_calendars: [
            { id: "primary", name: "Primary", selected: true },
            { id: "shared", name: "Shared", selected: true },
          ],
        }),
      );
      draft.calendar_events = [];
    });
    let releaseEvents!: () => void;
    let eventRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      eventRequestStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "access-token" });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({
          items: [
            { id: "primary", summary: "Primary", primary: true },
            { id: "shared", summary: "Shared" },
          ],
        });
      eventRequestStarted();
      await release;
      return Response.json({
        items: [
          {
            id: "late-event",
            summary: "Late event",
            start: { dateTime: "2026-10-27T12:00:00Z" },
            end: { dateTime: "2026-10-27T13:00:00Z" },
          },
        ],
        nextSyncToken: "late-cursor",
      });
    };
    const job: Job = {
      id: "selection-race-job",
      user_id: "user_demo",
      type: "calendar_sync",
      dedupe_key: "calendar-selection-race",
      status: "running",
      attempts: 1,
      run_after: new Date().toISOString(),
      payload: { credential_version: 3 },
    };
    const running = executeCalendar(job, store);
    await started;
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      connection.selected_calendars = connection.selected_calendars?.map((calendar) => ({
        ...calendar,
        selected: calendar.id === "primary",
      }));
      connection.credential_version = 4;
    });
    releaseEvents();
    await running;
    const state = await store.snapshot();
    const connection = state.integrations.find((item) => item.provider === "google_calendar")!;
    assert.deepEqual(
      connection.selected_calendars?.filter((calendar) => calendar.selected).map((item) => item.id),
      ["primary"],
    );
    assert.equal(state.calendar_events.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("obsolete Calendar failures cannot overwrite a reconnected authorization", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const store = await new MemoryStore("calendar-failure-race").init();
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      Object.assign(connection, liveConnection({ id: connection.id }));
      draft.jobs.push({
        id: "failing-calendar-job",
        user_id: "user_demo",
        type: "calendar_sync",
        dedupe_key: "failing-calendar-job",
        status: "queued",
        attempts: 0,
        run_after: new Date(0).toISOString(),
        payload: { credential_version: 3 },
      });
    });
    let releaseToken!: () => void;
    let tokenRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      tokenRequestStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    globalThis.fetch = async () => {
      tokenRequestStarted();
      await release;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const running = processJobs(store);
    await started;
    await store.transaction((draft) => {
      const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
      connection.credential_version = 4;
      connection.status = "syncing";
      delete connection.failure_code;
    });
    releaseToken();
    await running;
    const state = await store.snapshot();
    const connection = state.integrations.find((item) => item.provider === "google_calendar")!;
    assert.equal(connection.status, "syncing");
    assert.equal(connection.failure_code, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("worker reclaims a running job after its lock expires", async () => {
  const store = await new MemoryStore("calendar-expired-lock").init();
  await store.transaction((draft) => {
    const connection = draft.integrations.find((item) => item.provider === "google_calendar")!;
    connection.credential_version = 4;
    draft.jobs.push({
      id: "expired-lock-job",
      user_id: "user_demo",
      type: "calendar_sync",
      dedupe_key: "expired-lock-job",
      status: "running",
      attempts: 1,
      run_after: new Date(0).toISOString(),
      locked_until: new Date(0).toISOString(),
      payload: { credential_version: 3 },
    });
  });
  await processJobs(store);
  const job = (await store.snapshot()).jobs.find((item) => item.id === "expired-lock-job")!;
  assert.equal(job.status, "complete");
  assert.equal(job.attempts, 2);
  assert.equal(job.locked_until, undefined);
});
