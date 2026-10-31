import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { routeApi, type RouterDependencies } from "../src/api/router.ts";
import { MemoryStore } from "./memory-store.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";
import {
  configuredModels,
  PLANNER_CITATION_CONTRACT,
  PLANNER_REVISION_CONTRACT,
  PLANNER_SYSTEM_PROMPT,
} from "../src/integrations/openai.ts";

class MockResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  end(value?: string | Buffer) {
    if (value) this.body += value.toString();
    return this;
  }
}
function request(method: string, url: string, body = "", headers: Record<string, string> = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : ([] as Buffer[])) as any;
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}
async function call(
  store: MemoryStore,
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
  dependencies: RouterDependencies = {},
) {
  const response = new MockResponse();
  await routeApi(request(method, url, body, headers), response as any, store, dependencies);
  return {
    status: response.status,
    headers: response.headers,
    payload: response.body
      ? String(response.headers["content-type"] ?? "").includes("json")
        ? JSON.parse(response.body)
        : response.body
      : null,
  };
}

test("Home and Schedule expose only the active ready day version", async () => {
  const store = await new MemoryStore(`active-day-read-${randomUUID()}`).init();
  const initialHome = await call(store, "GET", "/api/home");
  const localDate = initialHome.payload.localDate;
  await store.transaction((draft) => {
    const base = draft.twin_days[0];
    draft.twin_days = [
      {
        ...base,
        id: "active-lower-version",
        local_date: localDate,
        version: 4,
        status: "ready",
      },
      {
        ...base,
        id: "superseded-higher-version",
        local_date: localDate,
        version: 5,
        status: "superseded",
      },
    ];
  });

  const home = await call(store, "GET", "/api/home");
  assert.equal(home.payload.twinDayVersion.id, "active-lower-version");
  const schedule = await call(store, "GET", `/api/twin-days?date=${localDate}`);
  assert.equal(schedule.payload.id, "active-lower-version");
});

const sharedPrototypeDate = new Date(Date.now() + 86_400_000)
  .toISOString()
  .slice(0, 10)
  .replaceAll("-", "");
const sharedPrototypeCalendar = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:shared-profile-event",
  `DTSTART:${sharedPrototypeDate}T130000Z`,
  `DTEND:${sharedPrototypeDate}T140000Z`,
  "SUMMARY:Shared prototype event",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

test("new profiles receive the configured shared prototype Calendar", async () => {
  const store = await new MemoryStore("shared-prototype-profile").init();
  await store.transaction((draft) => {
    for (const key of Object.keys(draft)) {
      if (Array.isArray((draft as any)[key])) (draft as any)[key] = [];
    }
    draft.idempotency = {};
  });
  const initialized = await call(
    store,
    "POST",
    "/api/profile/initialize",
    JSON.stringify({ timezone: "America/New_York" }),
    {},
    {
      prototypeCalendarSourceUrl:
        "https://mywharton2.wharton.upenn.edu/api/v2/events/calendars/ical/test-feed-id/",
      prototypeCalendarFetch: async () => new Response(sharedPrototypeCalendar),
    },
  );
  assert.equal(initialized.status, 201);
  const state = await store.snapshot();
  assert.equal(state.calendar_events.length, 1);
  assert.equal(state.calendar_events[0].user_id, "user_demo");
  assert.equal(state.calendar_events[0].source_type, "prototype_ical");
  assert.equal(state.integrations[0].mode, "prototype");
  assert.equal(state.integrations[0].source_url_hash, undefined);
});

test("settings, schedule and chat/check-in routes retain their contracts", async () => {
  const store = await new MemoryStore("feature-contracts").init();
  const settings = await call(store, "GET", "/api/settings");
  assert.equal(settings.status, 200);
  const changed = await call(
    store,
    "PATCH",
    "/api/settings",
    JSON.stringify({ version: settings.payload.version, wake_time: "08:00" }),
  );
  assert.equal(changed.payload.wake_time, "08:00");
  assert.equal((await call(store, "GET", "/api/home")).status, 200);
  assert.equal((await call(store, "GET", "/api/twin-days")).status, 200);
  const conversation = await call(store, "POST", "/api/talk/conversations");
  assert.equal(conversation.status, 201);
  const previousKey = process.env.TWIN_ENCRYPTION_KEY,
    previousFetch = globalThis.fetch;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    await store.transaction((d) => {
      d.model_connections[0].encrypted_key = encryptSecret("test-provider-key");
    });
    let supplied: any;
    let talkCalls = 0;
    globalThis.fetch = async (_url, options) => {
      talkCalls += 1;
      supplied = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ output_text: "Thanks for sharing." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const sent = await call(
      store,
      "POST",
      `/api/talk/conversations/${conversation.payload.id}/messages`,
      JSON.stringify({ message: "I actually studied for an hour." }),
      { "idempotency-key": "chat-test" },
    );
    assert.equal(sent.status, 201);
    assert.equal(sent.payload.reportStatus, "saved_as_actual_activity");
    assert.equal(sent.payload.planningStatus, "queued");
    assert.ok(supplied.input.includes("recent_check_ins"));
    assert.ok(supplied.input.includes("upcoming_events"));
    const afterTalk = await store.snapshot();
    const planningJobs = afterTalk.jobs.filter(
      (job) => job.type === "twin_day_generation" && job.status === "queued",
    );
    assert.equal(planningJobs.length, 1);
    assert.equal(planningJobs[0].payload.trigger, "after_conversation");
    assert.equal(planningJobs[0].payload.conversation_id, conversation.payload.id);
    const replay = await call(
      store,
      "POST",
      `/api/talk/conversations/${conversation.payload.id}/messages`,
      JSON.stringify({ message: "I actually studied for an hour." }),
      { "idempotency-key": "chat-test" },
    );
    assert.equal(replay.status, 200);
    assert.equal(talkCalls, 1);
    assert.equal(
      (await store.snapshot()).jobs.filter((job) => job.type === "twin_day_generation").length,
      1,
    );
    const history = await call(
      store,
      "GET",
      `/api/talk/conversations/${conversation.payload.id}/messages`,
    );
    assert.equal(history.payload.length, 2);
    const futureSent = await call(
      store,
      "POST",
      `/api/talk/conversations/${conversation.payload.id}/messages`,
      JSON.stringify({ message: "Tomorrow afternoon needs to be lighter." }),
      { "idempotency-key": "chat-future-date-test" },
    );
    assert.equal(futureSent.status, 201);
    const futureJobs = (await store.snapshot()).jobs.filter(
      (job) => job.type === "twin_day_generation" && job.status === "queued",
    );
    assert.equal(futureJobs.length, 2);
    const todayTarget = String(planningJobs[0].payload.local_date);
    const tomorrow = new Date(`${todayTarget}T12:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    assert.equal(futureJobs[1].payload.local_date, tomorrow.toISOString().slice(0, 10));
    assert.equal(
      (await call(store, "GET", "/api/settings")).payload.openai.encrypted_key,
      undefined,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("manual rebuild uses the shared planner and replays without another provider call", async () => {
  const store = await new MemoryStore(`manual-rebuild-${randomUUID()}`).init();
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let supplied: any;
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    await store.transaction((draft) => {
      const model = draft.model_connections[0];
      model.encrypted_key = encryptSecret("test-provider-key");
      model.credential_version = 1;
      draft.twin_days = draft.twin_days.filter((day) => day.local_date !== "2099-01-02");
      draft.idempotency = {};
    });
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      supplied = JSON.parse(String(options?.body));
      return Response.json({
        output_text: JSON.stringify({
          outcome: "schedule",
          change_summary: "Made the afternoon lighter.",
          no_change_reason: "",
          reason_source_ids: [],
          preserve_activity_ids: [],
          activities: [
            {
              activity_key: "resting",
              start_local: "2099-01-02T14:10",
              duration_minutes: 35,
              title: "Open afternoon reset",
              narrative: "The Twin leaves a lighter reset window.",
              reason: "This follows the manual instruction without inventing a commitment.",
              supporting_fact_ids: [],
              source_event_ids: [],
              supporting_report_ids: [],
              source_message_ids: [],
              confidence: "possible",
              is_experiment: false,
            },
          ],
          unresolved_conflicts: [],
        }),
      });
    };
    const requestBody = JSON.stringify({
      local_date: "2099-01-02",
      instruction: "Make the afternoon lighter.",
    });
    const first = await call(store, "POST", "/api/twin-days/rebuild", requestBody, {
      "idempotency-key": "manual-rebuild-key",
    });
    assert.equal(first.status, 200);
    assert.equal(first.payload.status, "updated");
    assert.equal(first.payload.trigger, "manual");
    assert.equal(first.payload.day.local_date, "2099-01-02");
    assert.equal(supplied.model, configuredModels().plannerModel);
    assert.equal(
      supplied.instructions,
      `${PLANNER_SYSTEM_PROMPT}\n\n${PLANNER_CITATION_CONTRACT}\n\n${PLANNER_REVISION_CONTRACT}`,
    );
    assert.match(supplied.input, /"manual_instruction":"Make the afternoon lighter\."/);
    assert.match(supplied.input, /"citation_id_allowlist":/);
    assert.match(
      supplied.text.format.schema.properties.activities.items.properties.supporting_fact_ids
        .description,
      /citation_id_allowlist\.fact_ids/,
    );
    assert.equal(supplied.store, false);
    assert.equal(supplied.text.format.type, "json_schema");
    assert.equal(supplied.text.format.strict, true);
    assert.equal(supplied.input.includes("test-provider-key"), false);
    const replay = await call(store, "POST", "/api/twin-days/rebuild", requestBody, {
      "idempotency-key": "manual-rebuild-key",
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.payload, first.payload);
    assert.equal(calls, 1);
    const saved = await store.snapshot();
    assert.equal(saved.twin_days.filter((day) => day.local_date === "2099-01-02").length, 1);
    assert.equal(
      saved.activity_reports.filter((report) => report.source === "manual_rebuild_report").length,
      0,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("a future-day rebuild rejects an actual-activity report", async () => {
  const store = await new MemoryStore(`future-actual-report-${randomUUID()}`).init();
  const response = await call(
    store,
    "POST",
    "/api/twin-days/rebuild",
    JSON.stringify({
      local_date: "2099-01-02",
      actual_report: "I already finished the morning work.",
      future_instruction: "Keep the afternoon open.",
    }),
    { "idempotency-key": "future-actual-report" },
  );

  assert.equal(response.status, 422);
  assert.equal(response.payload.code, "ACTUAL_REPORT_DATE_INVALID");
  assert.match(response.payload.field_errors.actual_report, /Choose today/);
});

test("API import applies memory atomically and duplicate retry reuses the result", async () => {
  const path = `./data/router-test-${process.pid}.json`;
  const store = await new MemoryStore(path).init();
  try {
    const handoff = {
      schema_version: 1,
      source: "chatgpt_voice_onboarding",
      session_id: "api-session",
      created_at: "2026-10-18T20:00:00Z",
      timezone: "America/New_York",
      observations: [
        {
          id: "walk",
          kind: "wellbeing_cue",
          statement: "Walking after lunch helps me reset.",
          source_excerpt: "Walking helps.",
          confidence: "user_stated",
        },
        {
          id: "focus",
          kind: "energy_cue",
          statement: "A break may help afternoon focus.",
          source_excerpt: "Maybe a break helps.",
          confidence: "inferred",
        },
      ],
    };
    const before = await call(store, "GET", "/api/bootstrap");
    assert.equal(before.payload.setup_required, true);
    const first = await call(store, "POST", "/api/imports", JSON.stringify(handoff));
    assert.equal(first.status, 201);
    assert.equal(first.payload.applied_counts.active, 1);
    assert.equal(first.payload.applied_counts.tentative, 1);
    const after = await call(store, "GET", "/api/bootstrap");
    assert.equal(after.payload.setup_required, true);
    const duplicate = await call(store, "POST", "/api/imports", JSON.stringify(handoff));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.id, first.payload.id);
    assert.equal(duplicate.payload.duplicate, true);
    const facts = await call(store, "GET", "/api/profile/facts");
    assert.equal(
      facts.payload.filter((item: any) => item.source_type === "chatgpt_voice_onboarding").length,
      2,
    );
  } finally {
    await unlink(path).catch(() => {});
  }
});

test("API rejects malformed JSON without adding memory", async () => {
  const path = `./data/router-invalid-${process.pid}.json`;
  const store = await new MemoryStore(path).init();
  try {
    const before = (await store.snapshot()).facts.length;
    const result = await call(store, "POST", "/api/imports", '{"schema_version":1');
    assert.equal(result.status, 400);
    assert.equal(result.payload.code, "INVALID_JSON");
    assert.equal((await store.snapshot()).facts.length, before);
  } finally {
    await unlink(path).catch(() => {});
  }
});

test("fresh local profile initializes without demo data and survives onboarding", async () => {
  const store = await new MemoryStore("fresh-onboarding").init();
  await store.transaction((draft) => {
    for (const key of Object.keys(draft)) {
      if (Array.isArray((draft as any)[key])) (draft as any)[key] = [];
    }
    draft.idempotency = {};
  });
  const empty = await call(store, "GET", "/api/bootstrap");
  assert.equal(empty.status, 200);
  assert.equal(empty.payload.profile_exists, false);
  assert.equal(empty.payload.setup_required, true);
  const initialized = await call(
    store,
    "POST",
    "/api/profile/initialize",
    JSON.stringify({ timezone: "America/New_York" }),
  );
  assert.equal(initialized.status, 201);
  assert.equal(initialized.payload.profile_exists, true);
  assert.equal(initialized.payload.settings.name, "");
  const initialState = await store.snapshot();
  assert.equal(initialState.facts.length, 0);
  assert.equal(initialState.calendar_events.length, 0);
  assert.equal(initialState.gmail_cues.length, 0);
  assert.equal(initialState.twin_days.length, 0);
  assert.equal(initialState.avatar_assets.length, 0);
  const settings = await call(
    store,
    "PATCH",
    "/api/settings",
    JSON.stringify({
      version: initialized.payload.settings.version,
      name: "Ada",
      timezone: "America/New_York",
    }),
  );
  assert.equal(settings.status, 200);
  assert.equal(settings.payload.name, "Ada");
  assert.equal((await store.snapshot()).jobs.length, 0);
  const missingImport = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(missingImport.status, 409);
  assert.equal(missingImport.payload.code, "ONBOARDING_IMPORT_REQUIRED");
  const resumed = await call(
    store,
    "POST",
    "/api/profile/initialize",
    JSON.stringify({ timezone: "UTC" }),
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.payload.created, false);
  assert.equal(resumed.payload.settings.name, "Ada");
  const handoff = {
    schema_version: 1,
    source: "chatgpt_voice_onboarding",
    session_id: "fresh-profile",
    created_at: "2026-10-26T12:00:00Z",
    timezone: "America/New_York",
    observations: [
      {
        id: "routine",
        kind: "routine",
        statement: "On typical weekdays I start work at about 9 AM.",
        source_excerpt: "I start around nine.",
        confidence: "user_stated",
      },
    ],
  };
  const imported = await call(store, "POST", "/api/imports", JSON.stringify(handoff));
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.twin_day_status, "openai_key_required");
  assert.equal((await call(store, "GET", "/api/bootstrap")).payload.setup_required, true);
  assert.equal((await store.snapshot()).twin_days.length, 0);
  assert.equal(
    (await store.snapshot()).jobs.some((job) => job.type === "twin_day_generation"),
    false,
  );
  const missingKey = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(missingKey.status, 409);
  assert.equal(missingKey.payload.code, "OPENAI_KEY_MISSING");
  await store.transaction((draft) => {
    draft.model_connections[0].encrypted_key = {
      iv: "onboarding-test",
      tag: "onboarding-test",
      ciphertext: "onboarding-test",
    };
    draft.model_connections[0].status = "connected";
  });
  const untestedKey = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(untestedKey.status, 409);
  assert.equal(untestedKey.payload.code, "OPENAI_KEY_NOT_READY");
  await store.transaction((draft) => {
    draft.model_connections[0].text_capability = "available";
  });
  const home = await call(store, "GET", "/api/home");
  await store.transaction((draft) => {
    draft.twin_days.push({
      id: "stale-onboarding-day",
      user_id: "user_demo",
      local_date: home.payload.localDate,
      timezone: "America/New_York",
      version: 1,
      status: "ready",
      generated_at: "2000-01-01T00:00:00.000Z",
      reason: "Stale test plan",
      memory_revision: 0,
      calendar_revision: 0,
      report_revision: 0,
      limited_context: [],
      tomorrow_may_change_because: [],
      activities: [],
    });
  });
  const missingDay = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(missingDay.status, 409);
  assert.equal(missingDay.payload.code, "TWIN_DAY_REQUIRED");
  await store.transaction((draft) => {
    draft.twin_days[0].status = "superseded";
    draft.twin_days.push({
      id: "onboarding-day",
      user_id: "user_demo",
      local_date: home.payload.localDate,
      timezone: "America/New_York",
      version: 2,
      status: "ready",
      generated_at: new Date().toISOString(),
      reason: "Test onboarding plan",
      memory_revision: 1,
      calendar_revision: 0,
      report_revision: 0,
      limited_context: [],
      tomorrow_may_change_because: [],
      activities: [
        {
          id: "onboarding-activity",
          user_id: "user_demo",
          activity_key: "resting",
          start_at: new Date().toISOString(),
          end_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          title: "Open time",
          narrative: "The Twin keeps the remaining day open.",
          reason: "Test schedule",
          supporting_fact_ids: [],
          source_event_ids: [],
          source_types: [],
          confidence: "possible",
          is_experiment: false,
        },
      ],
    });
  });
  const completed = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(completed.status, 200);
  assert.equal(completed.payload.setup_required, false);
  const replayedCompletion = await call(store, "POST", "/api/onboarding/complete", "{}");
  assert.equal(replayedCompletion.status, 200);
  assert.equal(replayedCompletion.payload.settings.version, completed.payload.settings.version);
  const deleted = await call(
    store,
    "DELETE",
    "/api/account",
    JSON.stringify({ confirmation: "DELETE MY TWIN" }),
  );
  assert.equal(deleted.status, 200);
  assert.equal((await call(store, "GET", "/api/bootstrap")).payload.profile_exists, false);
  const deletedState = await store.snapshot();
  assert.equal(deletedState.users.length, 0);
  for (const [key, value] of Object.entries(deletedState)) {
    if (key !== "idempotency" && Array.isArray(value)) assert.equal(value.length, 0, key);
  }
  const recreated = await call(
    store,
    "POST",
    "/api/profile/initialize",
    JSON.stringify({ timezone: "America/New_York" }),
  );
  assert.equal(recreated.status, 201);
  assert.equal(recreated.payload.settings.version, 1);
  const renamed = await call(
    store,
    "PATCH",
    "/api/settings",
    JSON.stringify({ version: recreated.payload.settings.version, name: "Leo" }),
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.name, "Leo");
});

test("profile initialization repairs an orphaned local user", async () => {
  const store = await new MemoryStore("orphaned-onboarding").init();
  await store.transaction((draft) => {
    for (const key of Object.keys(draft)) {
      if (Array.isArray((draft as any)[key])) (draft as any)[key] = [];
    }
    draft.users.push({
      id: "user_demo",
      email: "local@local.twin",
      created_at: new Date().toISOString(),
    });
    draft.idempotency = {};
  });
  const repaired = await call(
    store,
    "POST",
    "/api/profile/initialize",
    JSON.stringify({ timezone: "America/New_York" }),
  );
  assert.equal(repaired.status, 201);
  assert.equal(repaired.payload.created, true);
  assert.equal(repaired.payload.profile_exists, true);
  assert.equal(repaired.payload.settings.version, 1);
  const state = await store.snapshot();
  assert.equal(state.users.length, 1);
  assert.equal(state.settings.length, 1);
  assert.equal(state.integrations.length, 2);
  assert.equal(state.model_connections.length, 1);
  assert.equal(state.avatar_designs.length, 1);
  assert.equal(state.conversations.length, 1);
});

test("Google Calendar OAuth queues initial sync and selection/disconnect remove stale events", async () => {
  const store = await new MemoryStore("calendar-oauth").init();
  const previous = {
    key: process.env.TWIN_ENCRYPTION_KEY,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirect: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
    fetch: globalThis.fetch,
  };
  let tokenRequests = 0;
  let verifier = "";
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    process.env.GOOGLE_CLIENT_ID = "calendar-client";
    process.env.GOOGLE_CLIENT_SECRET = "calendar-secret";
    process.env.GOOGLE_CALENDAR_REDIRECT_URI =
      "http://127.0.0.1:4173/api/integrations/calendar/callback";
    const connect = await call(store, "GET", "/api/integrations/calendar/connect");
    assert.equal(connect.status, 200);
    const authorization = new URL(connect.payload.authorization_url);
    const state = authorization.searchParams.get("state")!;
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      authorization.searchParams.get("scope"),
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    globalThis.fetch = async (_input, options) => {
      tokenRequests += 1;
      const body = new URLSearchParams(String(options?.body));
      verifier = body.get("code_verifier") ?? "";
      return Response.json({
        refresh_token: "calendar-refresh-token",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
      });
    };
    const callback = await call(
      store,
      "GET",
      `/api/integrations/calendar/callback?code=calendar-code&state=${state}`,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, "/#settings");
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    let snapshot = await store.snapshot();
    let connection = snapshot.integrations.find((item) => item.provider === "google_calendar")!;
    assert.equal(connection.status, "syncing");
    assert.ok(connection.encrypted_token);
    assert.equal(connection.credential_version, 1);
    assert.equal(snapshot.calendar_events.length, 0);
    assert.equal(
      snapshot.jobs.filter((job) => job.type === "calendar_sync" && job.status === "queued").length,
      1,
    );
    const replay = await call(
      store,
      "GET",
      `/api/integrations/calendar/callback?code=replay&state=${state}`,
    );
    assert.equal(replay.status, 400);
    assert.equal(replay.payload.code, "OAUTH_STATE_INVALID");
    assert.equal(tokenRequests, 1);
    const deniedConnect = await call(store, "GET", "/api/integrations/calendar/connect");
    const deniedState = new URL(deniedConnect.payload.authorization_url).searchParams.get("state")!;
    const denied = await call(
      store,
      "GET",
      `/api/integrations/calendar/callback?error=access_denied&state=${deniedState}`,
    );
    assert.equal(denied.status, 400);
    assert.equal(denied.payload.code, "OAUTH_DENIED");
    assert.equal((await store.snapshot()).idempotency[`oauth:${deniedState}`], undefined);

    await store.transaction((draft) => {
      const item = draft.integrations.find((candidate) => candidate.id === connection.id)!;
      item.status = "connected";
      item.selected_calendars = [
        { id: "primary", name: "Primary", selected: true },
        { id: "shared", name: "Shared", selected: true },
      ];
      item.cursor = JSON.stringify({ primary: "primary-cursor", shared: "shared-cursor" });
      draft.calendar_events.push(
        {
          id: "primary-event",
          user_id: "user_demo",
          external_id: "primary-provider",
          calendar_id: "primary",
          title: "Primary event",
          start_at: "2026-10-27T10:00:00Z",
          end_at: "2026-10-27T11:00:00Z",
          source_timezone: "UTC",
          all_day: false,
          deleted: false,
          sync_revision: 1,
        },
        {
          id: "shared-event",
          user_id: "user_demo",
          external_id: "shared-provider",
          calendar_id: "shared",
          title: "Shared event",
          start_at: "2026-10-27T12:00:00Z",
          end_at: "2026-10-27T13:00:00Z",
          source_timezone: "UTC",
          all_day: false,
          deleted: false,
          sync_revision: 1,
        },
      );
    });
    const unknownSelection = await call(
      store,
      "PATCH",
      "/api/integrations/calendar/calendars",
      JSON.stringify({ selected_ids: ["not-a-calendar"] }),
      { "idempotency-key": "unknown-calendar" },
    );
    assert.equal(unknownSelection.status, 422);
    assert.equal(unknownSelection.payload.code, "UNKNOWN_CALENDAR");
    const selection = await call(
      store,
      "PATCH",
      "/api/integrations/calendar/calendars",
      JSON.stringify({ selected_ids: ["primary"] }),
      { "idempotency-key": "calendar-selection" },
    );
    assert.equal(selection.status, 202);
    assert.deepEqual(
      selection.payload.calendars
        .filter((calendar: any) => calendar.selected)
        .map((item: any) => item.id),
      ["primary"],
    );
    snapshot = await store.snapshot();
    assert.deepEqual(
      snapshot.calendar_events.map((event) => event.calendar_id),
      ["primary"],
    );
    connection = snapshot.integrations.find((item) => item.provider === "google_calendar")!;
    assert.equal(connection.credential_version, 2);
    assert.deepEqual(JSON.parse(connection.cursor!), { primary: "primary-cursor" });
    assert.equal(
      snapshot.jobs.some((job) => job.type === "twin_day_generation" && job.status === "queued"),
      false,
    );

    const disconnected = await call(store, "DELETE", "/api/integrations/calendar");
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.payload.status, "disconnected");
    assert.equal(disconnected.payload.has_credentials, false);
    snapshot = await store.snapshot();
    connection = snapshot.integrations.find((item) => item.provider === "google_calendar")!;
    assert.equal(connection.encrypted_token, undefined);
    assert.equal(connection.selected_calendars?.length, 0);
    assert.equal(snapshot.calendar_events.length, 0);
    assert.equal(
      snapshot.jobs.some(
        (job) =>
          job.type === "calendar_sync" && (job.status === "queued" || job.status === "running"),
      ),
      false,
    );
    const syncAfterDisconnect = await call(store, "POST", "/api/integrations/calendar/sync", "{}", {
      "idempotency-key": "disconnected-sync",
    });
    assert.equal(syncAfterDisconnect.status, 409);
    assert.equal(syncAfterDisconnect.payload.code, "INTEGRATION_NOT_CONNECTED");
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["TWIN_ENCRYPTION_KEY", previous.key],
      ["GOOGLE_CLIENT_ID", previous.clientId],
      ["GOOGLE_CLIENT_SECRET", previous.clientSecret],
      ["GOOGLE_CALENDAR_REDIRECT_URI", previous.redirect],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("private avatar photo and cached activity images survive reload without regenerating", async () => {
  const path = `./data/router-avatar-${process.pid}.json`;
  const store = await new MemoryStore(path).init();
  const files: string[] = [];
  try {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=";
    const uploaded = await call(
      store,
      "POST",
      "/api/character/photo",
      JSON.stringify({ filename: "me.png", data_url: `data:image/png;base64,${png}` }),
    );
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.payload.asset.kind, "source_photo");
    assert.equal(uploaded.payload.asset.storage_key, undefined);
    assert.match(uploaded.payload.asset.assetUrl, /^\/api\/assets\//);
    const now = new Date().toISOString();
    const baselineId = randomUUID();
    const candidateId = randomUUID();
    const studyId = randomUUID();
    const runId = randomUUID();
    const baselinePath = `./data/assets/${baselineId}.png`;
    const candidatePath = `./data/assets/${candidateId}.png`;
    const studyPath = `./data/assets/${studyId}.png`;
    const runPath = `./data/assets/${runId}.png`;
    files.push(baselinePath, candidatePath, studyPath, runPath);
    await mkdir(dirname(baselinePath), { recursive: true });
    for (const file of files) await writeFile(file, Buffer.from(png, "base64"));
    await store.transaction((draft) => {
      const design = draft.avatar_designs.find(
        (item) => item.user_id === "user_demo" && item.is_active,
      )!;
      design.baseline_asset_id = baselineId;
      draft.avatar_assets.push(
        {
          id: baselineId,
          user_id: "user_demo",
          design_version: design.version,
          parent_asset_ids: [design.source_photo_asset_id!],
          kind: "base",
          prompt_version: 2,
          model: "test",
          storage_key: baselinePath,
          mime: "image/png",
          status: "ready",
          selected_at: now,
          approved_at: now,
          created_at: now,
        },
        {
          id: candidateId,
          user_id: "user_demo",
          design_version: design.version,
          parent_asset_ids: [design.source_photo_asset_id!],
          kind: "base",
          prompt_version: 4,
          model: "test",
          storage_key: candidatePath,
          mime: "image/png",
          status: "ready",
          created_at: now,
        },
        {
          id: studyId,
          user_id: "user_demo",
          design_version: design.version,
          parent_asset_ids: [baselineId],
          kind: "activity",
          activity_key: "studying",
          prompt_version: 2,
          model: "test",
          storage_key: studyPath,
          mime: "image/png",
          status: "ready",
          selected_at: now,
          created_at: now,
        },
        {
          id: runId,
          user_id: "user_demo",
          design_version: design.version,
          parent_asset_ids: [baselineId],
          kind: "activity",
          activity_key: "running",
          prompt_version: 2,
          model: "test",
          storage_key: runPath,
          mime: "image/png",
          status: "ready",
          selected_at: now,
          created_at: now,
        },
      );
    });
    const studyFirst = await call(
      store,
      "POST",
      "/api/character/scenes/ensure",
      JSON.stringify({ activity_key: "studying" }),
    );
    assert.equal(studyFirst.status, 200);
    assert.equal(studyFirst.payload.cache_hit, true);
    const running = await call(
      store,
      "POST",
      "/api/character/scenes/ensure",
      JSON.stringify({ activity_key: "running" }),
    );
    assert.equal(running.status, 200);
    assert.equal(running.payload.asset.id, runId);
    const studyAgain = await call(
      store,
      "POST",
      "/api/character/scenes/ensure",
      JSON.stringify({ activity_key: "studying" }),
    );
    assert.equal(studyAgain.payload.asset.id, studyId);
    assert.equal(
      (await store.snapshot()).jobs.filter((job) => job.type === "avatar_generation").length,
      0,
    );
    const character = await call(store, "GET", "/api/character");
    assert.equal(character.payload.baseline.id, baselineId);
    assert.equal(character.payload.baseline_candidates[0].id, candidateId);
    assert.equal(
      character.payload.assets.find((asset: any) => asset.id === studyId).storage_key,
      undefined,
    );
    const currentDelete = await call(store, "DELETE", `/api/character/baseline/${baselineId}`);
    assert.equal(currentDelete.status, 409);
    assert.equal(currentDelete.payload.code, "BASELINE_IN_USE");
    const candidateDelete = await call(store, "DELETE", `/api/character/baseline/${candidateId}`);
    assert.equal(candidateDelete.status, 200);
    assert.equal(candidateDelete.payload.deleted, true);
    assert.equal(candidateDelete.payload.character.baseline_candidates.length, 0);
    assert.equal(
      (await store.snapshot()).avatar_assets.some((asset) => asset.id === candidateId),
      false,
    );
    await assert.rejects(access(candidatePath));
    await store.transaction((draft) => {
      draft.avatar_requests.push({
        id: "cancelled-baseline-request",
        user_id: "user_demo",
        source: "studio",
        purpose: "baseline",
        requested_change: "Create another baseline avatar.",
        reference_design_version: draft.avatar_designs.find(
          (item) => item.user_id === "user_demo" && item.is_active,
        )!.version,
        reference_asset_ids: [uploaded.payload.asset.id],
        idempotency_key: "cancel-baseline-test",
        status: "queued",
        created_at: now,
        updated_at: now,
      });
      draft.jobs.push({
        id: "cancelled-baseline-job",
        user_id: "user_demo",
        type: "avatar_generation",
        dedupe_key: "avatar:cancel-baseline-test",
        status: "queued",
        attempts: 0,
        run_after: now,
        payload: { request_id: "cancelled-baseline-request" },
      });
    });
    const stopped = await call(
      store,
      "POST",
      "/api/character/baseline/cancelled-baseline-request/cancel",
      "{}",
    );
    assert.equal(stopped.status, 200);
    assert.equal(stopped.payload.cancelled, true);
    assert.equal(stopped.payload.was_in_flight, false);
    const stoppedState = await store.snapshot();
    assert.equal(
      stoppedState.avatar_requests.find((item) => item.id === "cancelled-baseline-request")
        ?.failure_code,
      "AVATAR_CANCELLED",
    );
    assert.equal(
      stoppedState.jobs.find((item) => item.id === "cancelled-baseline-job")?.status,
      "failed",
    );
    const reloaded = await new MemoryStore(path).init();
    assert.equal(
      (await reloaded.snapshot()).avatar_assets.some((asset) => asset.id === studyId),
      true,
    );
    assert.equal(
      (await reloaded.snapshot()).avatar_assets.some((asset) => asset.id === runId),
      true,
    );
  } finally {
    for (const file of files) await unlink(file).catch(() => {});
    const snapshot = await store.snapshot();
    for (const asset of snapshot.avatar_assets)
      if (asset.kind === "source_photo" && asset.storage_key)
        await unlink(asset.storage_key).catch(() => {});
    await unlink(path).catch(() => {});
  }
});

test("activity images are reused by face, activity, and outfit across design versions", async () => {
  const path = `./data/router-outfits-${process.pid}.json`;
  const store = await new MemoryStore(path).init();
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const files: string[] = [];
  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=";
    const now = new Date().toISOString();
    const baselineId = randomUUID();
    const runId = randomUUID();
    for (const id of [baselineId, runId]) files.push(`./data/assets/${id}.png`);
    await mkdir("./data/assets", { recursive: true });
    for (const file of files) await writeFile(file, Buffer.from(png, "base64"));
    let startVersion = 0;
    await store.transaction((draft) => {
      draft.model_connections[0].encrypted_key = encryptSecret("test-provider-key");
      const design = draft.avatar_designs.find(
        (item) => item.user_id === "user_demo" && item.is_active,
      )!;
      startVersion = design.version;
      design.baseline_asset_id = baselineId;
      draft.avatar_assets.push(
        {
          id: baselineId,
          user_id: "user_demo",
          design_version: design.version,
          parent_asset_ids: [],
          kind: "base",
          prompt_version: 5,
          model: "test",
          storage_key: files[0],
          mime: "image/png",
          status: "ready",
          selected_at: now,
          approved_at: now,
          created_at: now,
        },
        {
          // Made under an older design version with the default outfit.
          id: runId,
          user_id: "user_demo",
          design_version: design.version - 1,
          parent_asset_ids: [baselineId],
          kind: "activity",
          activity_key: "running",
          prompt_version: 5,
          model: "test",
          storage_key: files[1],
          mime: "image/png",
          status: "ready",
          created_at: now,
        },
      );
    });
    const ensure = (key: string) =>
      call(store, "POST", "/api/character/scenes/ensure", JSON.stringify({ activity_key: key }));
    const reused = await ensure("running");
    assert.equal(reused.status, 200);
    assert.equal(reused.payload.cache_hit, true);
    assert.equal(reused.payload.asset.id, runId);

    const invalid = await call(
      store,
      "PUT",
      "/api/character/outfits",
      JSON.stringify({ outfits: { swimming: "trunks" } }),
    );
    assert.equal(invalid.status, 422);
    const tooLong = await call(
      store,
      "PUT",
      "/api/character/outfits",
      JSON.stringify({ outfits: { running: "x".repeat(161) } }),
    );
    assert.equal(tooLong.status, 422);
    const saved = await call(
      store,
      "PUT",
      "/api/character/outfits",
      JSON.stringify({ outfits: { running: "  red shorts\nand a white tee ", studying: "" } }),
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.payload.design.outfits, { running: "red shorts and a white tee" });
    assert.equal(saved.payload.design.version, startVersion);

    const changed = await ensure("running");
    assert.equal(changed.status, 202);
    assert.equal(changed.payload.generation_request.requested_outfit, "red shorts and a white tee");
    const again = await ensure("running");
    assert.equal(again.payload.generation_request.id, changed.payload.generation_request.id);

    await call(store, "PUT", "/api/character/outfits", JSON.stringify({ outfits: {} }));
    const back = await ensure("running");
    assert.equal(back.status, 200);
    assert.equal(back.payload.asset.id, runId);
    assert.equal(
      (await store.snapshot()).jobs.filter((job) => job.type === "avatar_generation").length,
      1,
    );
  } finally {
    for (const file of files) await unlink(file).catch(() => {});
    await unlink(path).catch(() => {});
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});
