import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { routeApi } from "../src/api/router.ts";
import {
  activeCheckinBrief,
  findUnknownWindows,
  morningCheckinStatus,
} from "../src/domain/morning-checkin.ts";
import type { AppState, TwinActivity, TwinDayVersion } from "../src/domain/types.ts";
import { addLocalDays, localDateInZone, localTimeInZone } from "../src/domain/time.ts";
import { buildVoiceInstructions, selectVoiceContext } from "../src/integrations/openai-realtime.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";
import { planTwinDay, queueDueMorningPlans } from "../src/services/day-planning.ts";
import { selectPlanningContext } from "../src/storage/context.ts";
import { MemoryStore } from "./memory-store.ts";

const NOW = new Date("2026-11-03T13:00:00.000Z"); // 08:00 in New York
const DATE = "2026-11-03";
const previousKey = process.env.TWIN_ENCRYPTION_KEY;
test.before(() => {
  process.env.TWIN_ENCRYPTION_KEY = "morning-checkin-test-key-not-a-real-secret";
});
test.after(() => {
  if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
  else process.env.TWIN_ENCRYPTION_KEY = previousKey;
});

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

async function call(
  store: MemoryStore,
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
) {
  const stream = Readable.from(body ? [Buffer.from(body)] : ([] as Buffer[])) as any;
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  const response = new MockResponse();
  await routeApi(stream, response as any, store, {});
  return { status: response.status, payload: response.body ? JSON.parse(response.body) : null };
}

// The router reads the real clock, so choose a zone where it is 08:00 right now.
function zoneAtEightAm() {
  for (let offset = -14; offset <= 12; offset += 1) {
    const zone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "+" : ""}${offset}`;
    if (localTimeInZone(new Date(), zone).startsWith("08:")) return zone;
  }
  throw new Error("NO_ZONE");
}

async function morningStore(timezone = zoneAtEightAm()) {
  const store = await new MemoryStore(`morning-${randomUUID()}`).init();
  await store.transaction((draft) => {
    const settings = draft.settings[0];
    Object.assign(settings, {
      timezone,
      wake_time: "07:00",
      sleep_time: "23:00",
      onboarding_complete: true,
    });
    Object.assign(draft, {
      twin_days: [],
      jobs: [],
      idempotency: {},
      facts: [],
      memory_overrides: [],
      calendar_events: [],
      activity_reports: [],
      messages: [],
      conversations: [],
    });
    const model = draft.model_connections[0];
    model.encrypted_key = encryptSecret("test-provider-key");
    model.status = "connected";
  });
  return store;
}

function activity(
  id: string,
  start: string,
  end: string,
  extras: Partial<TwinActivity> = {},
): TwinActivity {
  return {
    id,
    user_id: "user_demo",
    activity_key: "generic",
    start_at: start,
    end_at: end,
    title: id,
    narrative: "",
    reason: "",
    supporting_fact_ids: [],
    source_event_ids: [],
    source_types: [],
    confidence: "possible",
    is_experiment: false,
    ...extras,
  };
}

function readyDay(activities: TwinActivity[]) {
  return {
    id: randomUUID(),
    user_id: "user_demo",
    local_date: DATE,
    timezone: "America/New_York",
    version: 1,
    status: "ready",
    generated_at: NOW.toISOString(),
    reason: "",
    memory_revision: 0,
    calendar_revision: 0,
    report_revision: 0,
    limited_context: [],
    tomorrow_may_change_because: [],
    activities,
  } as TwinDayVersion;
}

function addCheckin(
  draft: AppState,
  status: "active" | "complete",
  answer?: string,
  id = "morning",
) {
  draft.conversations.push({
    id,
    user_id: "user_demo",
    title: "Morning check-in",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    morning_checkin: { local_date: DATE, status },
  });
  if (answer)
    draft.messages.push({
      id: `${id}-answer`,
      user_id: "user_demo",
      conversation_id: id,
      role: "user",
      content: answer,
      status: "saved",
      created_at: NOW.toISOString(),
    });
}

const talkMock = (onCall: (body: any) => void) => async (_url: unknown, options: any) => {
  onCall(JSON.parse(String(options?.body)));
  return new Response(JSON.stringify({ output_text: "What about 9 to 11?" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

test("unknown windows skip what Twin knows and keep its guesses", async () => {
  const store = await morningStore("America/New_York");
  await store.transaction((draft) => {
    draft.calendar_events.push({
      id: "class",
      user_id: "user_demo",
      all_day: false,
      deleted: false,
      start_at: "2026-11-03T15:00:00.000Z",
      end_at: "2026-11-03T16:00:00.000Z",
    } as any);
    draft.calendar_events.push({
      id: "declined",
      user_id: "user_demo",
      all_day: false,
      deleted: false,
      self_response_status: "declined",
      start_at: "2026-11-03T14:00:00.000Z",
      end_at: "2026-11-03T14:30:00.000Z",
    } as any);
    draft.twin_days.push(
      readyDay([
        activity("Maybe studying", "2026-11-03T13:30:00.000Z", "2026-11-03T15:00:00.000Z"),
        activity("Gym routine", "2026-11-03T17:00:00.000Z", "2026-11-03T18:00:00.000Z", {
          confidence: "grounded",
        }),
        activity("Locked lunch", "2026-11-03T16:10:00.000Z", "2026-11-03T17:00:00.000Z", {
          locked: true,
        }),
        activity("Stated plan", "2026-11-03T18:00:00.000Z", "2026-11-04T04:00:00.000Z", {
          source_message_ids: ["answer"],
        }),
      ]),
    );
  });
  assert.deepEqual(findUnknownWindows(await store.snapshot(), "user_demo", NOW), [
    { start_local: "08:00", end_local: "10:00", twin_guesses: ["Maybe studying"] },
  ]);
});

test("a day with no plan is one window from wake to sleep, capped at five", async () => {
  const store = await morningStore("America/New_York");
  assert.deepEqual(
    findUnknownWindows(await store.snapshot(), "user_demo", new Date("2026-11-03T10:00:00.000Z")),
    [{ start_local: "07:00", end_local: "23:00", twin_guesses: [] }],
  );
  await store.transaction((draft) => {
    for (let hour = 13; hour < 23; hour += 2)
      draft.calendar_events.push({
        id: `event-${hour}`,
        user_id: "user_demo",
        all_day: false,
        deleted: false,
        start_at: `2026-11-03T${hour}:00:00.000Z`,
        end_at: `2026-11-03T${hour + 1}:00:00.000Z`,
      } as any);
  });
  assert.equal(findUnknownWindows(await store.snapshot(), "user_demo", NOW).length, 5);
});

test("the check-in is offered only in the morning and until it finishes", async () => {
  const store = await morningStore("America/New_York");
  const state = await store.snapshot();
  assert.equal(morningCheckinStatus(state, "user_demo", NOW).available, true);
  assert.equal(
    morningCheckinStatus(state, "user_demo", new Date("2026-11-03T20:00:00.000Z")).available,
    false,
  );
  addCheckin(state, "active");
  const evening = new Date("2026-11-03T20:00:00.000Z");
  assert.equal(morningCheckinStatus(state, "user_demo", evening).available, false);
  assert.equal(activeCheckinBrief(state, "user_demo", "morning", evening), null);
  state.messages.push({
    id: "answer",
    user_id: "user_demo",
    conversation_id: "morning",
    role: "user",
    content: "Lab at 2.",
    status: "saved",
    created_at: NOW.toISOString(),
  });
  assert.deepEqual(morningCheckinStatus(state, "user_demo", evening), {
    available: true,
    conversation_id: "morning",
  });
  state.conversations[0].morning_checkin!.status = "complete";
  assert.equal(morningCheckinStatus(state, "user_demo", NOW).available, false);
});

test("typed answers wait, then finishing queues one job for today", async () => {
  const store = await morningStore();
  const today = localDateInZone(new Date(), (await store.snapshot()).settings[0].timezone);
  const home = await call(store, "GET", "/api/home");
  assert.equal(home.payload.morningCheckin.available, true);
  const body = JSON.stringify({ purpose: "morning_checkin" });
  const started = await call(store, "POST", "/api/talk/conversations", body);
  assert.equal(started.status, 201);
  const repeat = await call(store, "POST", "/api/talk/conversations", body);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.payload.id, started.payload.id);
  const base = `/api/talk/conversations/${started.payload.id}`;

  const empty = await call(store, "POST", `${base}/morning-checkin/complete`, "{}");
  assert.deepEqual(empty.payload, { status: "active", planningStatus: "not_queued" });

  const previousFetch = globalThis.fetch;
  let supplied: any;
  globalThis.fetch = talkMock((value) => (supplied = value)) as typeof fetch;
  try {
    const sent = await call(
      store,
      "POST",
      `${base}/messages`,
      JSON.stringify({ message: "I actually have class prep until 11, and my exam is tomorrow." }),
      { "idempotency-key": "answer-one" },
    );
    assert.equal(sent.status, 201);
    assert.equal(sent.payload.planningStatus, "waiting_for_checkin");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.match(supplied.instructions, /Morning check-in rules/);
  assert.match(supplied.input, /unknown_windows/);
  assert.equal((await store.snapshot()).jobs.length, 0);

  const finished = await call(store, "POST", `${base}/morning-checkin/complete`, "{}");
  assert.equal(finished.payload.status, "complete");
  assert.equal(finished.payload.planningStatus, "queued");
  const again = await call(store, "POST", `${base}/morning-checkin/complete`, "{}");
  assert.equal(again.payload.planningStatus, "not_queued");
  const state = await store.snapshot();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].payload.trigger, "after_conversation");
  assert.equal(state.jobs[0].payload.local_date, today);
  assert.equal(state.activity_reports.length, 0);
  assert.equal(state.facts.length, 0);
  const closed = await call(store, "POST", "/api/talk/conversations", body);
  assert.equal(closed.status, 409);
});

test("ordinary conversations ignore the check-in rules and cannot be completed", async () => {
  const store = await morningStore();
  const created = await call(store, "POST", "/api/talk/conversations");
  assert.equal(created.status, 201);
  assert.equal(created.payload.morning_checkin, undefined);
  const refused = await call(
    store,
    "POST",
    `/api/talk/conversations/${created.payload.id}/morning-checkin/complete`,
    "{}",
  );
  assert.equal(refused.status, 409);
  const invalid = await call(
    store,
    "POST",
    "/api/talk/conversations",
    JSON.stringify({ purpose: "other" }),
  );
  assert.equal(invalid.status, 422);
});

test("voice gets the rules, and ending the call queues today's build once", async () => {
  const store = await morningStore();
  const started = await call(
    store,
    "POST",
    "/api/talk/conversations",
    JSON.stringify({ purpose: "morning_checkin" }),
  );
  const conversationId = started.payload.id;
  const now = new Date();
  const state = await store.snapshot();
  const context = selectVoiceContext(state, "user_demo", conversationId, now);
  assert.ok(context.morning_checkin?.unknown_windows.length);
  const instructions = buildVoiceInstructions("collaborative", context);
  assert.match(instructions, /# Morning check-in/);
  assert.ok(
    instructions.indexOf("# Morning check-in") < instructions.indexOf("BEGIN_TWIN_CONTEXT"),
  );
  assert.doesNotMatch(
    buildVoiceInstructions("collaborative", { ...context, morning_checkin: undefined }),
    /# Morning check-in/,
  );
  await store.transaction((draft) => {
    draft.voice_sessions.push({
      id: "voice-one",
      user_id: "user_demo",
      conversation_id: conversationId,
      status: "active",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600_000).toISOString(),
      finalized_item_ids: [],
    } as any);
  });
  const completed = await call(
    store,
    "POST",
    `/api/talk/conversations/${conversationId}/voice-calls/voice-one/complete`,
    JSON.stringify({
      items: [
        {
          provider_item_id: "user-1",
          role: "user",
          transcript: "Work until noon, then I see my mom on Friday.",
          completed_at: now.toISOString(),
        },
      ],
    }),
    { "content-type": "application/json", "idempotency-key": "voice-finish" },
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.payload.planningStatus, "queued");
  const after = await store.snapshot();
  assert.equal(after.jobs.length, 1);
  assert.equal(after.jobs[0].payload.local_date, localDateInZone(now, after.settings[0].timezone));
  assert.equal(after.conversations[0].morning_checkin?.status, "complete");
});

test("planning sees only that date's user answers, on every trigger", async () => {
  const store = await morningStore("America/New_York");
  const state = await store.snapshot();
  addCheckin(state, "complete", "Lab from 2 to 4.");
  state.messages.push({
    id: "assistant-line",
    user_id: "user_demo",
    conversation_id: "morning",
    role: "assistant",
    content: "Anything else?",
    status: "saved",
    created_at: NOW.toISOString(),
  });
  for (const trigger of ["morning", "after_conversation", "manual"] as const) {
    const context = selectPlanningContext(state, "user_demo", {
      targetLocalDate: DATE,
      trigger,
      now: NOW,
    });
    assert.deepEqual(
      context.morning_checkin_answers.map((item) => item.content),
      ["Lab from 2 to 4."],
    );
    assert.ok(context.citation_id_allowlist.conversation_message_ids.includes("morning-answer"));
    assert.ok(!context.citation_id_allowlist.conversation_message_ids.includes("assistant-line"));
  }
  const otherDay = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-11-04",
    trigger: "morning",
    now: NOW,
  });
  assert.deepEqual(otherDay.morning_checkin_answers, []);
});

test("a manual rebuild may cite a check-in answer without creating a report", async () => {
  const store = await morningStore("America/New_York");
  await store.transaction((draft) => addCheckin(draft, "complete", "Lab from 2 to 4."));
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: DATE,
      idempotencyKey: "manual-after-checkin",
      now: NOW,
    },
    {
      propose: async (_key, context) => {
        assert.equal(context.morning_checkin_answers.length, 1);
        return {
          model: "planner-test-model",
          proposal: {
            outcome: "schedule",
            change_summary: "Added the lab.",
            no_change_reason: "",
            reason_source_ids: [],
            preserve_activity_ids: [],
            unresolved_conflicts: [],
            activities: [
              {
                activity_key: "studying",
                start_local: `${DATE}T07:30`,
                duration_minutes: 30,
                title: "Earlier",
                narrative: "Earlier time.",
                reason: "They said so.",
                supporting_fact_ids: [],
                source_event_ids: [],
                supporting_report_ids: [],
                source_message_ids: ["morning-answer"],
                confidence: "grounded",
                is_experiment: false,
              },
              {
                activity_key: "studying",
                start_local: `${DATE}T08:00`,
                duration_minutes: 30,
                title: "Lab",
                narrative: "Lab time.",
                reason: "They said so.",
                supporting_fact_ids: [],
                source_event_ids: [],
                supporting_report_ids: [],
                source_message_ids: ["morning-answer"],
                confidence: "grounded",
                is_experiment: false,
              },
            ],
          },
        };
      },
    },
  );
  assert.equal(result.status, "updated");
  const lab = result.day?.activities.find((item) => item.title === "Lab");
  assert.deepEqual(lab?.source_message_ids, ["morning-answer"]);
  assert.ok(lab?.source_types.includes("conversation"));
  assert.equal(lab?.confidence, "grounded");
  const earlier = result.day?.activities.find((item) => item.title === "Earlier");
  assert.equal(earlier?.confidence, "possible");
  assert.equal((await store.snapshot()).activity_reports.length, 0);
});

test("the automatic morning build is skipped only after a finished check-in", async () => {
  const active = await morningStore("America/New_York");
  const activeState = await active.snapshot();
  addCheckin(activeState, "active");
  assert.equal(queueDueMorningPlans(activeState, NOW).length, 1);
  const finished = await morningStore("America/New_York");
  const finishedState = await finished.snapshot();
  addCheckin(finishedState, "complete", "Lab from 2 to 4.");
  assert.equal(queueDueMorningPlans(finishedState, NOW).length, 0);
});

async function startVoiceCheckin(store: MemoryStore, conversationId: string, sessionId: string) {
  const now = new Date();
  await store.transaction((draft) => {
    draft.voice_sessions.push({
      id: sessionId,
      user_id: "user_demo",
      conversation_id: conversationId,
      status: "active",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600_000).toISOString(),
      finalized_item_ids: [],
    } as any);
  });
  return (disposition: "complete" | "abandoned") =>
    call(
      store,
      "POST",
      `/api/talk/conversations/${conversationId}/voice-calls/${sessionId}/complete`,
      JSON.stringify({
        disposition,
        items: [
          {
            provider_item_id: `${sessionId}-user`,
            role: "user",
            transcript: "Work until noon.",
            completed_at: now.toISOString(),
          },
        ],
      }),
      { "content-type": "application/json", "idempotency-key": `${sessionId}-finish` },
    );
}

test("a dropped call keeps the check-in open, and leaving Talk then builds once", async () => {
  const store = await morningStore();
  const started = await call(
    store,
    "POST",
    "/api/talk/conversations",
    JSON.stringify({ purpose: "morning_checkin" }),
  );
  const finish = await startVoiceCheckin(store, started.payload.id, "voice-dropped");
  const dropped = await finish("abandoned");
  assert.equal(dropped.status, 200);
  assert.equal(dropped.payload.planningStatus, "not_queued");
  let state = await store.snapshot();
  assert.equal(state.jobs.length, 0);
  assert.equal(state.conversations[0].morning_checkin?.status, "active");
  const left = await call(
    store,
    "POST",
    `/api/talk/conversations/${started.payload.id}/morning-checkin/complete`,
    "{}",
  );
  assert.equal(left.payload.planningStatus, "queued");
  state = await store.snapshot();
  assert.equal(state.jobs.length, 1);
});

test("voice in yesterday's unfinished check-in plans like ordinary Talk", async () => {
  const store = await morningStore();
  const today = localDateInZone(new Date(), (await store.snapshot()).settings[0].timezone);
  await store.transaction((draft) => {
    draft.conversations.push({
      id: "yesterday",
      user_id: "user_demo",
      title: "Morning check-in",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      morning_checkin: { local_date: addLocalDays(today, -1), status: "active" },
    });
  });
  const finish = await startVoiceCheckin(store, "yesterday", "voice-stale");
  const completed = await finish("complete");
  assert.equal(completed.payload.planningStatus, "queued");
  const state = await store.snapshot();
  assert.equal(state.jobs[0].payload.local_date, today);
  assert.equal(state.conversations[0].morning_checkin?.status, "active");
});

test("a failed check-in build brings back the automatic morning build", async () => {
  const store = await morningStore("America/New_York");
  const state = await store.snapshot();
  addCheckin(state, "complete", "Lab from 2 to 4.");
  state.jobs.push({
    id: "checkin-job",
    user_id: "user_demo",
    type: "twin_day_generation",
    dedupe_key: "plan:user_demo:after_conversation:morning-checkin:morning",
    status: "running",
    attempts: 1,
    run_after: NOW.toISOString(),
    payload: {},
  });
  assert.equal(queueDueMorningPlans(state, NOW).length, 0);
  state.jobs[0].status = "failed";
  assert.equal(queueDueMorningPlans(state, NOW).length, 1);
});

test("Talk after a finished check-in does not count as an answer", async () => {
  const store = await morningStore("America/New_York");
  const state = await store.snapshot();
  addCheckin(state, "complete", "Lab from 2 to 4.");
  state.conversations[0].morning_checkin!.completed_at = NOW.toISOString();
  state.messages.push({
    id: "later",
    user_id: "user_demo",
    conversation_id: "morning",
    role: "user",
    content: "Unrelated later chat.",
    status: "saved",
    created_at: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const context = selectPlanningContext(state, "user_demo", {
    targetLocalDate: DATE,
    trigger: "manual",
    now: new Date(NOW.getTime() + 120_000),
  });
  assert.deepEqual(
    context.morning_checkin_answers.map((item) => item.id),
    ["morning-answer"],
  );
});
