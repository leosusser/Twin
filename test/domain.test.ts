import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHandoff,
  factKey,
  hashHandoff,
  validateHandoff,
  ValidationProblem,
} from "../src/domain/imports.ts";
import { generateDemoTwinDay } from "../src/domain/planner.ts";
import { localDateTimeToUtc, overlaps } from "../src/domain/time.ts";
import type { AppState, HandoffInput, Settings } from "../src/domain/types.ts";

const settings: Settings = {
  user_id: "u1",
  name: "Test",
  timezone: "America/New_York",
  wake_time: "07:30",
  sleep_time: "23:00",
  tomorrow_generation_time: "20:00",
  reminders_enabled: false,
  hide_bathroom_scene: false,
  talk_retention_days: 30,
  onboarding_complete: false,
  version: 1,
};
function state(): AppState {
  return {
    users: [{ id: "u1", email: "test@example.com", created_at: new Date().toISOString() }],
    settings: [structuredClone(settings)],
    imports: [],
    observations: [],
    facts: [],
    memory_overrides: [],
    integrations: [],
    calendar_events: [],
    gmail_cues: [],
    twin_days: [],
    activity_reports: [],
    model_connections: [],
    conversations: [],
    messages: [],
    avatar_designs: [],
    avatar_assets: [],
    avatar_requests: [],
    jobs: [],
    idempotency: {},
  };
}
function handoff(confidence: "user_stated" | "inferred" = "user_stated"): HandoffInput {
  return {
    schema_version: 1,
    source: "chatgpt_voice_onboarding",
    session_id: "session-1",
    created_at: "2026-10-18T20:00:00Z",
    timezone: "America/New_York",
    observations: [
      {
        id: "walk",
        kind: "wellbeing_cue",
        statement: "A walk after lunch helps me reset.",
        source_excerpt: "Walking helps.",
        confidence,
      },
    ],
  };
}

test("import validation rejects the whole malformed handoff", () => {
  const draft = state();
  assert.throws(
    () =>
      validateHandoff({ ...handoff(), observations: [{ ...handoff().observations[0], id: "" }] }),
    ValidationProblem,
  );
  assert.equal(draft.facts.length, 0);
  assert.equal(draft.observations.length, 0);
});
test("canonical import hashes are idempotent across object key order", () => {
  const a = handoff();
  const b = {
    timezone: a.timezone,
    created_at: a.created_at,
    session_id: a.session_id,
    source: a.source,
    observations: a.observations,
    schema_version: a.schema_version,
  };
  assert.equal(hashHandoff(a), hashHandoff(b));
});
test("explicit observations activate while inferences stay tentative", () => {
  const draft = state();
  const explicit = applyHandoff(draft, handoff("user_stated"), "u1");
  assert.equal(explicit.applied_counts.active, 1);
  const inferred = {
    ...handoff("inferred"),
    session_id: "session-2",
    observations: [
      {
        ...handoff("inferred").observations[0],
        id: "focus",
        statement: "A break may help afternoon focus.",
      },
    ],
  };
  const second = applyHandoff(draft, inferred, "u1");
  assert.equal(second.applied_counts.tentative, 1);
  assert.equal(draft.facts.find((item) => item.source_id.includes("focus"))?.status, "tentative");
});
test("removal tombstone outranks the same later import", () => {
  const draft = state();
  const input = handoff();
  draft.memory_overrides.push({
    id: "o1",
    user_id: "u1",
    fact_key: factKey(input.observations[0]),
    action: "remove",
    recorded_at: new Date().toISOString(),
    version: 1,
  });
  const result = applyHandoff(draft, input, "u1");
  assert.equal(result.conflict_count, 1);
  assert.equal(draft.facts.length, 0);
});
test("demo fixture activities never overlap", () => {
  const report = {
    id: "r1",
    user_id: "u1",
    conversation_message_id: "m1",
    local_date: "2026-10-17",
    activity_key: "studying" as const,
    statement: "I actually studied at the library.",
    source: "talk_user_report" as const,
    created_at: "2026-10-17T20:00:00Z",
  };
  const day = generateDemoTwinDay({
    userId: "u1",
    localDate: "2026-10-18",
    settings,
    events: [],
    facts: [],
    gmailCues: [],
    reports: [report],
  });
  for (let i = 0; i < day.activities.length; i++)
    for (let j = i + 1; j < day.activities.length; j++)
      assert.equal(
        overlaps(
          day.activities[i].start_at,
          day.activities[i].end_at,
          day.activities[j].start_at,
          day.activities[j].end_at,
        ),
        false,
      );
  assert.equal(day.report_revision, 1);
});
test("generating a later version does not mutate the current immutable version", () => {
  const current = generateDemoTwinDay({
    userId: "u1",
    localDate: "2026-10-18",
    settings,
    events: [],
    facts: [],
    gmailCues: [],
    reports: [],
  });
  const snapshot = structuredClone(current);
  const next = generateDemoTwinDay({
    userId: "u1",
    localDate: "2026-10-18",
    settings,
    events: [],
    facts: [],
    gmailCues: [],
    reports: [],
    previous: current,
  });
  assert.deepEqual(current, snapshot);
  assert.equal(next.version, current.version + 1);
});
test("local conversion respects DST boundaries", () => {
  assert.equal(
    localDateTimeToUtc("2026-03-07", "09:00", "America/New_York"),
    "2026-03-07T14:00:00.000Z",
  );
  assert.equal(
    localDateTimeToUtc("2026-03-09", "09:00", "America/New_York"),
    "2026-03-09T13:00:00.000Z",
  );
});
