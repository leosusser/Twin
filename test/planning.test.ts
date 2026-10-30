import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Job, TwinActivity, TwinDayVersion } from "../src/domain/types.ts";
import { ProviderProblem, resolvePlannerModel } from "../src/integrations/openai.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";
import type { PlanningContext } from "../src/storage/context.ts";
import {
  planTwinDay,
  planningTargetDateFromConversation,
  queueDueMorningPlans,
} from "../src/services/day-planning.ts";
import { executeTwinDay, processJobs } from "../src/worker.ts";
import { MemoryStore } from "./memory-store.ts";

const priorEncryptionKey = process.env.TWIN_ENCRYPTION_KEY;
test.before(() => {
  process.env.TWIN_ENCRYPTION_KEY = "planning-test-encryption-key-not-a-real-secret";
});
test.after(() => {
  if (priorEncryptionKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
  else process.env.TWIN_ENCRYPTION_KEY = priorEncryptionKey;
});

async function planningStore(timezone = "America/New_York") {
  const store = await new MemoryStore(`planning-${randomUUID()}`).init();
  await store.transaction((draft) => {
    const settings = draft.settings[0];
    settings.timezone = timezone;
    settings.wake_time = "07:30";
    settings.sleep_time = "23:00";
    settings.onboarding_complete = true;
    draft.twin_days = [];
    draft.jobs = [];
    draft.idempotency = {};
    draft.facts = [];
    draft.memory_overrides = [];
    draft.calendar_events = [];
    draft.activity_reports = [];
    draft.messages = [];
    const model = draft.model_connections[0];
    model.encrypted_key = encryptSecret("test-provider-key");
    model.status = "connected";
    model.credential_version = 1;
    const calendar = draft.integrations.find((item) => item.provider === "google_calendar")!;
    calendar.mode = "live";
    calendar.status = "disconnected";
    calendar.selected_calendars = [];
    delete calendar.encrypted_token;
    delete calendar.last_successful_sync_at;
  });
  return store;
}

function activity(
  id: string,
  startAt: string,
  endAt: string,
  extras: Partial<TwinActivity> = {},
): TwinActivity {
  return {
    id,
    user_id: "user_demo",
    activity_key: "working",
    start_at: startAt,
    end_at: endAt,
    title: `Saved ${id}`,
    narrative: "A saved simulated activity.",
    reason: "Saved before replanning.",
    supporting_fact_ids: [],
    source_event_ids: [],
    supporting_report_ids: [],
    source_message_ids: [],
    source_types: [],
    confidence: "possible",
    is_experiment: false,
    ...extras,
  };
}

function priorDay(localDate: string, timezone: string, activities: TwinActivity[]): TwinDayVersion {
  return {
    id: `day-${localDate}`,
    user_id: "user_demo",
    local_date: localDate,
    timezone,
    version: 1,
    status: "ready",
    generated_at: `${localDate}T05:00:00.000Z`,
    reason: "Saved plan",
    memory_revision: 0,
    calendar_revision: 0,
    report_revision: 0,
    limited_context: [],
    tomorrow_may_change_because: [],
    activities,
  };
}

function scheduleProposal(
  localDate: string,
  input: {
    preserve?: string[];
    activities?: Array<Record<string, unknown>>;
    reasonSourceIds?: string[];
  } = {},
) {
  return {
    outcome: "schedule",
    change_summary: "Placed one grounded focus block.",
    no_change_reason: "",
    reason_source_ids: input.reasonSourceIds ?? [],
    preserve_activity_ids: input.preserve ?? [],
    activities: input.activities ?? [proposalActivity(localDate, "09:17", 37)],
    unresolved_conflicts: [],
  };
}

function proposalActivity(
  localDate: string,
  time: string,
  duration: number,
  extras: Record<string, unknown> = {},
) {
  return {
    activity_key: "working",
    start_local: `${localDate}T${time}`,
    duration_minutes: duration,
    title: "Deliberate focus",
    narrative: "The Twin tries a bounded focus block.",
    reason: "The timing follows the supplied context.",
    supporting_fact_ids: [],
    source_event_ids: [],
    supporting_report_ids: [],
    source_message_ids: [],
    confidence: "possible",
    is_experiment: false,
    ...extras,
  };
}

test("planner model precedence is explicit and ignores empty overrides", () => {
  assert.equal(
    resolvePlannerModel({ OPENAI_PLANNER_MODEL: "  planner-model  ", OPENAI_TEXT_MODEL: "talk" }),
    "planner-model",
  );
  assert.equal(
    resolvePlannerModel({ OPENAI_PLANNER_MODEL: " ", OPENAI_TEXT_MODEL: "text-model" }),
    "text-model",
  );
  assert.equal(
    resolvePlannerModel({ OPENAI_PLANNER_MODEL: "", OPENAI_TEXT_MODEL: "" }),
    "gpt-5.6-luna",
  );
});

test("future-dated conversation context routes to its explicit local date", () => {
  assert.equal(
    planningTargetDateFromConversation("Tomorrow afternoon needs to be lighter.", "2026-10-26"),
    "2026-10-27",
  );
  assert.equal(
    planningTargetDateFromConversation("Keep 2026-11-03 open after lunch.", "2026-10-26"),
    "2026-11-03",
  );
  assert.equal(
    planningTargetDateFromConversation("Yesterday was exhausting.", "2026-10-26"),
    "2026-10-26",
  );
});

test("the shared service persists the model-selected time and duration", async () => {
  const store = await planningStore();
  let calls = 0;
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-03-09",
      instruction: "Keep the morning focused.",
      idempotencyKey: "model-selected-shape",
      now: new Date("2026-03-09T13:30:00.000Z"),
    },
    {
      propose: async (apiKey, context) => {
        calls += 1;
        assert.equal(apiKey, "test-provider-key");
        assert.equal(context.timezone, "America/New_York");
        assert.equal(context.manual_instruction, "Keep the morning focused.");
        return {
          proposal: scheduleProposal("2026-03-09"),
          model: "planner-test-model",
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities.length, 1);
  assert.equal(result.day?.activities[0].start_at, "2026-03-09T13:17:00.000Z");
  assert.equal(result.day?.activities[0].end_at, "2026-03-09T13:54:00.000Z");
  assert.equal(result.day?.planning_trigger, "manual");
  assert.equal(result.day?.planner_model, "planner-test-model");
  assert.equal(result.day?.version, 1);
});

test("a day may contain several optional experiments", async () => {
  const store = await planningStore();
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-27",
      idempotencyKey: "multiple-experiments",
      now: new Date("2026-10-26T12:00:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-27", {
          activities: [
            proposalActivity("2026-10-27", "09:00", 30, { is_experiment: true }),
            proposalActivity("2026-10-27", "10:00", 30, { is_experiment: true }),
            proposalActivity("2026-10-27", "11:00", 30, { is_experiment: true }),
          ],
        }),
        model: "planner-test-model",
      }),
    },
  );

  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities.length, 3);
  assert.equal(result.day?.activities.filter((activity) => activity.is_experiment).length, 3);
});

test("repeated exact citation IDs are deduplicated before validation", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.facts.push({
      id: "fact-focus",
      user_id: "user_demo",
      fact_key: "routine:focus",
      kind: "routine",
      statement: "I focus in the morning.",
      source_type: "chatgpt_voice_onboarding",
      source_id: "onboarding:focus",
      source_excerpt: "I focus in the morning.",
      captured_at: "2026-10-26T10:00:00.000Z",
      authority: "onboarding_user_stated",
      certainty: "user_stated",
      status: "active",
      version: 1,
      updated_at: "2026-10-26T10:00:00.000Z",
    });
  });
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-27",
      idempotencyKey: "duplicate-citations",
      now: new Date("2026-10-26T12:00:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-27", {
          reasonSourceIds: ["fact-focus", "fact-focus"],
          activities: [
            proposalActivity("2026-10-27", "09:00", 30, {
              supporting_fact_ids: ["fact-focus", "fact-focus"],
            }),
          ],
        }),
        model: "planner-test-model",
      }),
    },
  );
  assert.deepEqual(result.day?.reason_source_ids, ["fact-focus"]);
  assert.deepEqual(result.day?.activities[0].supporting_fact_ids, ["fact-focus"]);
});

test("the planner rejects a nonexistent local time at the DST boundary", async () => {
  const store = await planningStore();
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-03-08",
        idempotencyKey: "nonexistent-local-time",
        now: new Date("2026-03-07T12:00:00.000Z"),
      },
      {
        propose: async () => ({
          proposal: scheduleProposal("2026-03-08", {
            activities: [proposalActivity("2026-03-08", "02:30", 30)],
          }),
          model: "planner-test-model",
        }),
      },
    ),
    (error: unknown) => error instanceof ProviderProblem && error.code === "PLANNER_OUTPUT_INVALID",
  );
  assert.equal((await store.snapshot()).twin_days.length, 0);
});

test("remaining-day revisions cannot add simulated activities to elapsed time", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.twin_days.push(
      priorDay("2026-10-26", "America/New_York", [
        activity("future", "2026-10-26T20:00:00.000Z", "2026-10-26T21:00:00.000Z"),
      ]),
    );
  });
  let calls = 0;
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "after_conversation",
        targetLocalDate: "2026-10-26",
        idempotencyKey: "retrospective-insertion",
        now: new Date("2026-10-26T19:00:00.000Z"),
      },
      {
        propose: async () => {
          calls += 1;
          return {
            proposal: scheduleProposal("2026-10-26", {
              activities: [proposalActivity("2026-10-26", "08:00", 30)],
            }),
            model: "planner-test-model",
          };
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNER_REWROTE_ELAPSED_HISTORY",
  );
  assert.equal(calls, 1);
  assert.equal((await store.snapshot()).twin_days.length, 1);
});

test("a first late-day build creates imagined backlog and an activity covering now", async () => {
  const store = await planningStore();
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      idempotencyKey: "first-late-day-build",
      now: new Date("2026-10-27T03:13:30.000Z"),
    },
    {
      propose: async (_apiKey, context) => {
        assert.deepEqual(context.revision_window, {
          mode: "initial_day",
          earliest_new_activity_start_local: null,
          current_activity_required_at_local: "2026-10-26T23:13",
          day_end_local: "2026-10-27T00:00",
          preserve_activity_ids: [],
          adjustable_in_progress_activity_id: null,
        });
        assert.equal(context.existing_schedule, null);
        return {
          proposal: scheduleProposal("2026-10-26", {
            activities: [
              proposalActivity("2026-10-26", "08:00", 60),
              proposalActivity("2026-10-26", "23:00", 60),
            ],
          }),
          model: "planner-test-model",
        };
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities.length, 2);
  assert.equal(result.day?.activities[0].start_at, "2026-10-26T12:00:00.000Z");
  assert.equal(result.day?.activities[1].start_at, "2026-10-27T03:00:00.000Z");
  assert.equal(result.day?.activities[1].end_at, "2026-10-27T04:00:00.000Z");
});

test("a first current-day build fills an otherwise open current interval", async () => {
  const store = await planningStore();
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      idempotencyKey: "first-day-current-gap",
      now: new Date("2026-10-27T03:13:30.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-26", {
          activities: [proposalActivity("2026-10-26", "08:00", 60)],
        }),
        model: "planner-test-model",
      }),
    },
  );
  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities.length, 2);
  const current = result.day?.activities.find((item) => item.title === "Open time");
  assert.equal(current?.start_at, "2026-10-27T03:13:30.000Z");
  assert.equal(current?.end_at, "2026-10-27T03:43:30.000Z");
  assert.equal(current?.confidence, "possible");
  assert.deepEqual(current?.source_types, []);
});

test("a first late-day build clips flexible activity at local midnight", async () => {
  const store = await planningStore();
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      idempotencyKey: "first-day-midnight-overflow",
      now: new Date("2026-10-27T03:13:30.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-26", {
          activities: [proposalActivity("2026-10-26", "23:00", 65)],
        }),
        model: "planner-test-model",
      }),
    },
  );
  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities[0].start_at, "2026-10-27T03:00:00.000Z");
  assert.equal(result.day?.activities[0].end_at, "2026-10-27T04:00:00.000Z");
});

test("an instruction-free remaining-day rebuild keeps backlog, clips current activity, and replaces later plans", async () => {
  const store = await planningStore();
  const elapsed = activity("elapsed", "2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z");
  const inProgress = activity(
    "in-progress",
    "2026-10-26T15:30:00.000Z",
    "2026-10-26T17:00:00.000Z",
  );
  const later = activity("later", "2026-10-26T18:00:00.000Z", "2026-10-26T19:00:00.000Z");
  await store.transaction((draft) => {
    draft.twin_days.push(priorDay("2026-10-26", "America/New_York", [elapsed, inProgress, later]));
  });

  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      idempotencyKey: "clip-current-and-replan",
      now: new Date("2026-10-26T16:07:30.000Z"),
    },
    {
      propose: async (_apiKey, context) => {
        assert.deepEqual(context.revision_window, {
          mode: "remaining_day",
          earliest_new_activity_start_local: "2026-10-26T12:08",
          current_activity_required_at_local: null,
          day_end_local: "2026-10-27T00:00",
          preserve_activity_ids: ["elapsed"],
          adjustable_in_progress_activity_id: "in-progress",
        });
        return {
          proposal: scheduleProposal("2026-10-26", {
            preserve: ["elapsed"],
            activities: [proposalActivity("2026-10-26", "13:00", 30)],
          }),
          model: "planner-test-model",
        };
      },
    },
  );

  assert.equal(result.status, "updated");
  assert.deepEqual(
    result.day?.activities.map((item) => [item.id, item.start_at, item.end_at]),
    [
      ["elapsed", elapsed.start_at, elapsed.end_at],
      ["in-progress", inProgress.start_at, "2026-10-26T16:07:30.000Z"],
      [result.day?.activities[2].id, "2026-10-26T17:00:00.000Z", "2026-10-26T17:30:00.000Z"],
    ],
  );
  assert.equal(
    result.day?.activities.some((item) => item.id === "later"),
    false,
  );
});

test("manual text catches today up from a saved report and replans the future", async () => {
  const store = await planningStore();
  const elapsed = activity(
    "old-simulated-history",
    "2026-10-26T12:00:00.000Z",
    "2026-10-26T13:00:00.000Z",
  );
  const locked = activity("locked", "2026-10-26T16:00:00.000Z", "2026-10-26T17:00:00.000Z", {
    locked: true,
  });
  const future = activity(
    "old-flexible-future",
    "2026-10-26T20:00:00.000Z",
    "2026-10-26T21:00:00.000Z",
  );
  await store.transaction((draft) => {
    draft.twin_days.push(priorDay("2026-10-26", "America/New_York", [elapsed, locked, future]));
  });
  const actualReport = "I worked from 8:30 to 11:30 and I am having lunch now.";
  const instruction = "Keep the afternoon lighter.";
  const request = {
    userId: "user_demo",
    trigger: "manual" as const,
    targetLocalDate: "2026-10-26",
    actualReport,
    instruction,
    idempotencyKey: "manual-catch-up",
    now: new Date("2026-10-26T18:14:00.000Z"),
  };
  let calls = 0;
  const dependencies = {
    propose: async (_apiKey: string, context: PlanningContext) => {
      calls += 1;
      const report = context.actual_activity_reports.find(
        (item: { statement: string }) => item.statement === actualReport,
      );
      assert.ok(report);
      assert.deepEqual(context.revision_window, {
        mode: "catch_up",
        earliest_new_activity_start_local: null,
        current_activity_required_at_local: "2026-10-26T14:14",
        day_end_local: "2026-10-27T00:00",
        preserve_activity_ids: ["locked"],
        adjustable_in_progress_activity_id: null,
      });
      assert.ok(context.citation_id_allowlist.activity_report_ids.includes(report.id));
      return {
        proposal: scheduleProposal("2026-10-26", {
          preserve: ["locked"],
          reasonSourceIds: [report.id],
          activities: [
            proposalActivity("2026-10-26", "08:30", 180, {
              title: "Reported morning work",
              supporting_report_ids: [report.id],
            }),
            proposalActivity("2026-10-26", "13:30", 60, {
              title: "Reported lunch",
              supporting_report_ids: [report.id],
            }),
            proposalActivity("2026-10-26", "15:00", 30, {
              title: "Lighter afternoon",
            }),
          ],
        }),
        model: "planner-test-model",
      };
    },
  };
  const result = await planTwinDay(store, request, dependencies);
  assert.equal(result.status, "updated");
  assert.equal(result.report?.source, "manual_rebuild_report");
  assert.equal(result.report?.statement, actualReport);
  assert.equal(result.report?.statement.includes(instruction), false);
  assert.equal(
    result.day?.activities.some((item) => item.id === elapsed.id),
    false,
  );
  assert.equal(
    result.day?.activities.some((item) => item.id === future.id),
    false,
  );
  assert.deepEqual(
    result.day?.activities.find((item) => item.id === locked.id),
    locked,
  );
  const reportedActivities = result.day?.activities.filter((item) =>
    item.supporting_report_ids?.includes(result.report!.id),
  );
  assert.equal(reportedActivities?.length, 2);
  assert.equal(
    reportedActivities?.every((item) => item.confidence === "grounded"),
    true,
  );
  assert.ok(
    result.day?.activities.some(
      (item) => new Date(item.start_at) <= request.now && request.now < new Date(item.end_at),
    ),
  );
  const replay = await planTwinDay(store, request, dependencies);
  assert.deepEqual(replay, result);
  assert.equal(calls, 1);
  const state = await store.snapshot();
  assert.equal(
    state.activity_reports.filter((item) => item.source === "manual_rebuild_report").length,
    1,
  );
  assert.deepEqual(
    state.twin_days.map((day) => day.status),
    ["superseded", "ready"],
  );
});

test("manual catch-up lets reported history replace an overlapping elapsed Calendar plan", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.calendar_events.push({
      id: "elapsed-calendar-plan",
      user_id: "user_demo",
      external_id: "provider-elapsed-plan",
      calendar_id: "primary",
      title: "Planned meeting",
      start_at: "2026-10-26T13:00:00.000Z",
      end_at: "2026-10-26T19:00:00.000Z",
      source_timezone: "America/New_York",
      all_day: false,
      deleted: false,
      availability: "busy",
      self_response_status: "accepted",
      sync_revision: 1,
    });
  });

  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      actualReport: "I went for a walk from 9 to 10 instead of attending the meeting.",
      idempotencyKey: "reported-history-wins-elapsed-calendar",
      now: new Date("2026-10-26T18:14:00.000Z"),
    },
    {
      propose: async (_apiKey, context) => {
        const reportId = context.actual_activity_reports[0].id;
        return {
          proposal: scheduleProposal("2026-10-26", {
            activities: [
              proposalActivity("2026-10-26", "09:00", 60, {
                title: "Reported walk",
                activity_key: "walking",
                confidence: "grounded",
                supporting_report_ids: [reportId],
              }),
              proposalActivity("2026-10-26", "09:00", 60, {
                title: "Planned meeting",
                confidence: "grounded",
                source_event_ids: ["elapsed-calendar-plan"],
              }),
              proposalActivity("2026-10-26", "14:00", 30, {
                title: "Possible current break",
                confidence: "possible",
              }),
            ],
          }),
          model: "planner-test-model",
        };
      },
    },
  );

  assert.equal(result.status, "updated");
  assert.equal(
    result.day?.activities.some((item) => item.source_event_ids.includes("elapsed-calendar-plan")),
    false,
  );
  assert.equal(
    result.day?.activities.some((item) => item.title === "Reported walk"),
    true,
  );
  assert.deepEqual(result.day?.unresolved_conflicts?.[0].source_event_ids, [
    "elapsed-calendar-plan",
  ]);
});

test("manual catch-up records overlapping future Calendar commitments instead of failing", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.calendar_events.push(
      {
        id: "future-calendar-first",
        user_id: "user_demo",
        external_id: "provider-future-first",
        calendar_id: "primary",
        title: "First future commitment",
        start_at: "2026-10-26T19:00:00.000Z",
        end_at: "2026-10-26T20:00:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "busy",
        self_response_status: "accepted",
        sync_revision: 1,
      },
      {
        id: "future-calendar-second",
        user_id: "user_demo",
        external_id: "provider-future-second",
        calendar_id: "primary",
        title: "Second future commitment",
        start_at: "2026-10-26T19:30:00.000Z",
        end_at: "2026-10-26T20:30:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "busy",
        self_response_status: "accepted",
        sync_revision: 1,
      },
    );
  });

  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      actualReport: "The morning was quiet and I am taking a break now.",
      idempotencyKey: "future-calendar-conflict-is-visible",
      now: new Date("2026-10-26T18:14:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-26", {
          activities: [
            proposalActivity("2026-10-26", "14:00", 30, {
              title: "Possible current break",
              confidence: "possible",
            }),
            proposalActivity("2026-10-26", "15:00", 60, {
              title: "First future commitment",
              confidence: "grounded",
              source_event_ids: ["future-calendar-first"],
            }),
            proposalActivity("2026-10-26", "15:30", 60, {
              title: "Second future commitment",
              confidence: "grounded",
              source_event_ids: ["future-calendar-second"],
            }),
          ],
        }),
        model: "planner-test-model",
      }),
    },
  );

  assert.equal(result.status, "updated");
  assert.deepEqual(
    result.day?.activities.flatMap((item) => item.source_event_ids),
    ["future-calendar-first"],
  );
  assert.deepEqual(result.day?.unresolved_conflicts?.[0].source_event_ids, [
    "future-calendar-second",
  ]);
});

test("manual catch-up still rejects overlapping report-backed history", async () => {
  const store = await planningStore();
  let calls = 0;
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-10-26",
        actualReport: "I worked and walked at overlapping times this morning.",
        idempotencyKey: "contradictory-reported-history",
        now: new Date("2026-10-26T18:14:00.000Z"),
      },
      {
        propose: async (_apiKey, context) => {
          calls += 1;
          const reportId = context.actual_activity_reports[0].id;
          return {
            proposal: scheduleProposal("2026-10-26", {
              activities: [
                proposalActivity("2026-10-26", "09:00", 90, {
                  supporting_report_ids: [reportId],
                }),
                proposalActivity("2026-10-26", "10:00", 90, {
                  activity_key: "walking",
                  supporting_report_ids: [reportId],
                }),
                proposalActivity("2026-10-26", "14:00", 30),
              ],
            }),
            model: "planner-test-model",
          };
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNER_ACTIVITY_OVERLAP",
  );
  assert.equal(calls, 2);
});

test("manual catch-up retries an unsupported grounded guess and accepts a possible imagined gap", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.twin_days.push(
      priorDay("2026-10-26", "America/New_York", [
        activity("old-history", "2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z"),
      ]),
    );
    draft.activity_reports.push({
      id: "prior-day-report",
      user_id: "user_demo",
      local_date: "2026-10-25",
      activity_key: "walking",
      statement: "I walked yesterday afternoon.",
      source: "talk_user_report",
      created_at: "2026-10-25T19:00:00.000Z",
    });
  });
  let calls = 0;
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      actualReport: "I worked this morning, but the rest is fuzzy.",
      idempotencyKey: "manual-catch-up-repair",
      now: new Date("2026-10-26T18:14:00.000Z"),
    },
    {
      propose: async (_apiKey, context) => {
        calls += 1;
        const reportId = context.actual_activity_reports[0].id;
        assert.deepEqual(context.citation_id_allowlist.activity_report_ids, [reportId]);
        assert.equal(
          context.actual_activity_reports.some((item) => item.id === "prior-day-report"),
          false,
        );
        if (calls === 1) assert.equal(context.repair_request, null);
        else
          assert.deepEqual(context.repair_request, {
            validation_code: "PLANNER_UNKNOWN_SOURCE",
            validation_message: "The planner referenced an unknown activity report source.",
          });
        return {
          proposal: scheduleProposal("2026-10-26", {
            activities: [
              proposalActivity("2026-10-26", "08:30", 30, {
                supporting_report_ids: [reportId],
              }),
              proposalActivity("2026-10-26", "14:00", 30, {
                title: "Plausible current break",
                confidence: calls === 1 ? "grounded" : "possible",
                supporting_report_ids: calls === 1 ? [reportId, "prior-day-report"] : [],
              }),
            ],
          }),
          model: "planner-test-model",
        };
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.status, "updated");
  const guessedCurrent = result.day?.activities.find(
    (item) => item.title === "Plausible current break",
  );
  assert.equal(guessedCurrent?.confidence, "possible");
  assert.deepEqual(guessedCurrent?.supporting_report_ids, []);
  assert.deepEqual(guessedCurrent?.source_types, []);
  const state = await store.snapshot();
  assert.equal(state.activity_reports.length, 2);
  assert.ok(state.activity_reports.some((report) => report.id === "prior-day-report"));
  assert.deepEqual(
    state.twin_days.map((day) => day.status),
    ["superseded", "ready"],
  );
});

test("manual catch-up derives possible confidence for an unsupported elapsed estimate", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.twin_days.push(
      priorDay("2026-10-26", "America/New_York", [
        activity("old-history", "2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z"),
      ]),
    );
  });
  let calls = 0;
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      actualReport: "The morning is unclear.",
      idempotencyKey: "manual-catch-up-repair-fails",
      now: new Date("2026-10-26T18:14:00.000Z"),
    },
    {
      propose: async () => {
        calls += 1;
        return {
          proposal: scheduleProposal("2026-10-26", {
            activities: [proposalActivity("2026-10-26", "14:00", 30, { confidence: "grounded" })],
          }),
          model: "planner-test-model",
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities[0].confidence, "possible");
  assert.deepEqual(result.day?.activities[0].supporting_report_ids, []);
  const state = await store.snapshot();
  assert.equal(state.activity_reports.length, 1);
  assert.deepEqual(
    state.twin_days.map((day) => day.status),
    ["superseded", "ready"],
  );
});

test("an actual report catches up today even when no prior Twin day exists", async () => {
  const store = await planningStore();
  const actualReport = "I worked this morning and I am eating lunch now.";

  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      actualReport,
      instruction: "Leave the late afternoon open.",
      idempotencyKey: "first-day-manual-catch-up",
      now: new Date("2026-10-26T18:14:00.000Z"),
    },
    {
      propose: async (_apiKey, context) => {
        assert.equal(context.revision_window.mode, "catch_up");
        assert.deepEqual(context.revision_window.preserve_activity_ids, []);
        assert.equal(context.existing_schedule, null);
        assert.equal(context.manual_instruction, "Leave the late afternoon open.");
        const report = context.actual_activity_reports.find(
          (item) => item.statement === actualReport,
        );
        assert.ok(report);
        return {
          proposal: scheduleProposal("2026-10-26", {
            reasonSourceIds: [report.id],
            activities: [
              proposalActivity("2026-10-26", "08:30", 180, {
                title: "Reported morning work",
                supporting_report_ids: [report.id],
              }),
              proposalActivity("2026-10-26", "13:30", 60, {
                title: "Reported lunch",
                supporting_report_ids: [report.id],
              }),
              proposalActivity("2026-10-26", "15:00", 30, {
                title: "Open afternoon",
              }),
            ],
          }),
          model: "planner-test-model",
        };
      },
    },
  );

  assert.equal(result.status, "updated");
  assert.equal(result.day?.version, 1);
  assert.equal(result.report?.statement, actualReport);
  assert.ok(
    result.day?.activities.some(
      (item) =>
        item.supporting_report_ids?.includes(result.report!.id) &&
        new Date(item.start_at) <= new Date("2026-10-26T18:14:00.000Z") &&
        new Date("2026-10-26T18:14:00.000Z") < new Date(item.end_at),
    ),
  );
});

test("Calendar commitment overflow fails safely before calling the provider", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    const calendar = draft.integrations.find((item) => item.provider === "google_calendar")!;
    calendar.status = "connected";
    calendar.selected_calendars = [{ id: "primary", name: "Primary", selected: true }];
    calendar.last_successful_sync_at = "2026-10-26T12:00:00.000Z";
    draft.calendar_events = Array.from({ length: 41 }, (_, index) => ({
      id: `commitment-${index}`,
      user_id: "user_demo",
      external_id: `provider-${index}`,
      calendar_id: "primary",
      title: `Commitment ${index}`,
      start_at: `2026-10-26T${String(4 + Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}:00.000Z`,
      end_at: `2026-10-26T${String(4 + Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15 + 10).padStart(2, "0")}:00.000Z`,
      source_timezone: "America/New_York",
      all_day: false,
      deleted: false,
      availability: "busy" as const,
      sync_revision: 1,
    }));
  });
  let calls = 0;
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-10-26",
        idempotencyKey: "calendar-overflow",
        now: new Date("2026-10-26T12:00:00.000Z"),
      },
      {
        propose: async () => {
          calls += 1;
          return { proposal: scheduleProposal("2026-10-26"), model: "planner-test-model" };
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNING_CALENDAR_OVERFLOW",
  );
  assert.equal(calls, 0);
  assert.equal((await store.snapshot()).twin_days.length, 0);
});

test("no-change results and duplicate requests leave the saved version untouched", async () => {
  const store = await planningStore();
  const saved = priorDay("2026-10-26", "America/New_York", [
    activity("saved", "2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z"),
  ]);
  await store.transaction((draft) => draft.twin_days.push(saved));
  let calls = 0;
  const request = {
    userId: "user_demo",
    trigger: "after_conversation" as const,
    targetLocalDate: "2026-10-26",
    conversationId: "conversation_demo",
    idempotencyKey: "no-change-turn",
    now: new Date("2026-10-26T10:00:00.000Z"),
  };
  const dependencies = {
    propose: async () => {
      calls += 1;
      return {
        proposal: {
          outcome: "no_change",
          change_summary: "",
          no_change_reason: "The new conversation does not affect today's plan.",
          reason_source_ids: [],
          preserve_activity_ids: [],
          activities: [],
          unresolved_conflicts: [],
        },
        model: "planner-test-model",
      };
    },
  };
  const first = await planTwinDay(store, request, dependencies);
  const replay = await planTwinDay(store, request, dependencies);
  await assert.rejects(
    planTwinDay(store, { ...request, instruction: "Use a different request body." }, dependencies),
    (error: unknown) => error instanceof ProviderProblem && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal(first.status, "no_change");
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  const state = await store.snapshot();
  assert.equal(state.twin_days.length, 1);
  assert.equal(state.twin_days[0].status, "ready");
  assert.equal(state.twin_days[0].version, 1);
});

test("the server preserves protected activities when the model omits their IDs", async () => {
  const store = await planningStore();
  const protectedActivities = [
    activity("elapsed", "2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z"),
    activity("locked", "2026-10-26T18:00:00.000Z", "2026-10-26T19:00:00.000Z", {
      locked: true,
    }),
    activity("edited", "2026-10-26T20:00:00.000Z", "2026-10-26T21:00:00.000Z", {
      user_edited: true,
    }),
    activity("reported", "2026-10-26T22:00:00.000Z", "2026-10-26T23:00:00.000Z", {
      supporting_report_ids: ["report-1"],
      source_types: ["report"],
    }),
  ];
  await store.transaction((draft) => {
    const current = {
      ...priorDay("2026-10-26", "America/New_York", protectedActivities),
      id: "current-day-version",
      version: 2,
    };
    draft.twin_days.push(
      {
        ...priorDay("2026-10-26", "America/New_York", []),
        id: "older-ready-version",
        version: 1,
      },
      current,
      {
        ...priorDay("2026-10-27", "America/New_York", []),
        id: "other-date-version",
      },
      {
        ...current,
        id: "other-user-version",
        user_id: "other-user",
        version: 7,
      },
    );
    draft.activity_reports.push({
      id: "report-1",
      user_id: "user_demo",
      conversation_message_id: "message-1",
      local_date: "2026-10-26",
      activity_key: "working",
      statement: "I actually finished this activity.",
      source: "talk_user_report",
      created_at: "2026-10-26T15:00:00.000Z",
    });
  });
  const accepted = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-26",
      idempotencyKey: "server-preserves-protected",
      now: new Date("2026-10-26T16:00:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-26", {
          preserve: ["unknown-model-activity"],
          activities: [proposalActivity("2026-10-26", "21:30", 20)],
        }),
        model: "planner-test-model",
      }),
    },
  );
  assert.equal(accepted.status, "updated");
  for (const protectedActivity of protectedActivities)
    assert.deepEqual(
      accepted.day?.activities.find((item) => item.id === protectedActivity.id),
      protectedActivity,
    );
  const state = await store.snapshot();
  assert.deepEqual(
    state.twin_days
      .filter((day) => day.user_id === "user_demo" && day.local_date === "2026-10-26")
      .map((day) => [day.id, day.status]),
    [
      ["older-ready-version", "superseded"],
      ["current-day-version", "superseded"],
      [accepted.day?.id, "ready"],
    ],
  );
  assert.equal(accepted.day?.version, 3);
  assert.equal(accepted.day?.parent_version_id, "current-day-version");
  assert.equal(state.twin_days.find((day) => day.id === "other-date-version")?.status, "ready");
  assert.equal(state.twin_days.find((day) => day.id === "other-user-version")?.status, "ready");
});

test("overlapping flexible model output is fitted into open schedule time", async () => {
  const store = await planningStore();
  const saved = priorDay("2026-10-27", "America/New_York", [
    activity("saved", "2026-10-27T13:00:00.000Z", "2026-10-27T14:00:00.000Z", {
      locked: true,
    }),
  ]);
  await store.transaction((draft) => draft.twin_days.push(saved));
  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-27",
      idempotencyKey: "overlap-output",
      now: new Date("2026-10-26T12:00:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-27", {
          preserve: ["saved"],
          activities: [
            proposalActivity("2026-10-27", "10:00", 60),
            proposalActivity("2026-10-27", "10:30", 60),
          ],
        }),
        model: "planner-test-model",
      }),
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(
    result.day?.activities.map((item) => [item.start_at, item.end_at]),
    [
      ["2026-10-27T13:00:00.000Z", "2026-10-27T14:00:00.000Z"],
      ["2026-10-27T14:00:00.000Z", "2026-10-27T15:00:00.000Z"],
      ["2026-10-27T15:00:00.000Z", "2026-10-27T15:30:00.000Z"],
    ],
  );
  const state = await store.snapshot();
  assert.deepEqual(
    state.twin_days.map((day) => day.status),
    ["superseded", "ready"],
  );
});

test("overlapping protected and fixed Calendar activity remains a hard conflict", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.twin_days.push(
      priorDay("2026-10-27", "America/New_York", [
        activity("locked", "2026-10-27T14:00:00.000Z", "2026-10-27T15:00:00.000Z", {
          locked: true,
        }),
      ]),
    );
    draft.calendar_events.push({
      id: "overlapping-calendar-event",
      user_id: "user_demo",
      external_id: "provider-overlap",
      calendar_id: "primary",
      title: "Fixed overlap",
      start_at: "2026-10-27T14:30:00.000Z",
      end_at: "2026-10-27T15:30:00.000Z",
      source_timezone: "America/New_York",
      all_day: false,
      deleted: false,
      availability: "busy",
      self_response_status: "accepted",
      sync_revision: 1,
    });
  });
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-10-27",
        idempotencyKey: "protected-calendar-overlap",
        now: new Date("2026-10-26T12:00:00.000Z"),
      },
      {
        propose: async () => ({
          proposal: scheduleProposal("2026-10-27", {
            preserve: ["locked"],
            activities: [
              proposalActivity("2026-10-27", "10:30", 60, {
                source_event_ids: ["overlapping-calendar-event"],
              }),
            ],
          }),
          model: "planner-test-model",
        }),
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNER_ACTIVITY_OVERLAP",
  );
  const state = await store.snapshot();
  assert.equal(state.twin_days.length, 1);
  assert.equal(state.twin_days[0].status, "ready");
});

test("fixed Calendar commitments must be retained or returned as unresolved conflicts", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.calendar_events.push(
      {
        id: "busy-calendar-event",
        user_id: "user_demo",
        external_id: "provider-busy",
        calendar_id: "primary",
        title: "Fixed class",
        start_at: "2026-10-27T14:00:00.000Z",
        end_at: "2026-10-27T15:00:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "busy",
        self_response_status: "accepted",
        sync_revision: 1,
      },
      {
        id: "free-calendar-event",
        user_id: "user_demo",
        external_id: "provider-free",
        calendar_id: "primary",
        title: "Optional office hours",
        start_at: "2026-10-27T15:00:00.000Z",
        end_at: "2026-10-27T16:00:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "free",
        sync_revision: 1,
      },
    );
  });
  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-10-27",
        idempotencyKey: "missing-calendar-commitment",
        now: new Date("2026-10-26T12:00:00.000Z"),
      },
      {
        propose: async () => ({
          proposal: scheduleProposal("2026-10-27", {
            activities: [proposalActivity("2026-10-27", "12:00", 30)],
          }),
          model: "planner-test-model",
        }),
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNER_COMMITMENT_MISSING",
  );
  const accepted = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-27",
      idempotencyKey: "calendar-conflict-recorded",
      now: new Date("2026-10-26T12:00:00.000Z"),
    },
    {
      propose: async () => {
        const proposal = {
          ...scheduleProposal("2026-10-27", {
            reasonSourceIds: ["busy-calendar-event"],
            activities: [proposalActivity("2026-10-27", "12:00", 30)],
          }),
          unresolved_conflicts: [
            {
              kind: "uncertain_timing",
              description: "The fixed class cannot be reconciled with the supplied boundary.",
              source_event_ids: ["busy-calendar-event"],
            },
          ],
        };
        return { proposal, model: "planner-test-model" };
      },
    },
  );
  assert.equal(accepted.status, "updated");
  assert.deepEqual(accepted.day?.unresolved_conflicts?.[0].source_event_ids, [
    "busy-calendar-event",
  ]);
});

test("fixed Calendar commitments use exact saved bounds when the model rounds duration", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.calendar_events.push({
      id: "irregular-calendar-event",
      user_id: "user_demo",
      external_id: "provider-irregular",
      calendar_id: "primary",
      title: "Fixed 89-minute class",
      start_at: "2026-10-27T14:15:00.000Z",
      end_at: "2026-10-27T15:44:00.000Z",
      source_timezone: "America/New_York",
      all_day: false,
      deleted: false,
      availability: "busy",
      self_response_status: "accepted",
      sync_revision: 1,
    });
  });

  const result = await planTwinDay(
    store,
    {
      userId: "user_demo",
      trigger: "manual",
      targetLocalDate: "2026-10-27",
      idempotencyKey: "rounded-calendar-duration",
      now: new Date("2026-10-26T12:00:00.000Z"),
    },
    {
      propose: async () => ({
        proposal: scheduleProposal("2026-10-27", {
          activities: [
            proposalActivity("2026-10-27", "10:15", 90, {
              source_event_ids: ["irregular-calendar-event"],
            }),
          ],
        }),
        model: "planner-test-model",
      }),
    },
  );

  assert.equal(result.status, "updated");
  assert.equal(result.day?.activities[0].start_at, "2026-10-27T14:15:00.000Z");
  assert.equal(result.day?.activities[0].end_at, "2026-10-27T15:44:00.000Z");
  const savedEvent = (await store.snapshot()).calendar_events.find(
    (event) => event.id === "irregular-calendar-event",
  );
  assert.equal(savedEvent?.start_at, "2026-10-27T14:15:00.000Z");
  assert.equal(savedEvent?.end_at, "2026-10-27T15:44:00.000Z");
});

test("one activity cannot combine fixed Calendar commitments with different bounds", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.calendar_events.push(
      {
        id: "first-fixed-event",
        user_id: "user_demo",
        external_id: "provider-first",
        calendar_id: "primary",
        title: "First class",
        start_at: "2026-10-27T14:15:00.000Z",
        end_at: "2026-10-27T15:44:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "busy",
        sync_revision: 1,
      },
      {
        id: "second-fixed-event",
        user_id: "user_demo",
        external_id: "provider-second",
        calendar_id: "primary",
        title: "Second class",
        start_at: "2026-10-27T16:00:00.000Z",
        end_at: "2026-10-27T17:29:00.000Z",
        source_timezone: "America/New_York",
        all_day: false,
        deleted: false,
        availability: "busy",
        sync_revision: 1,
      },
    );
  });

  await assert.rejects(
    planTwinDay(
      store,
      {
        userId: "user_demo",
        trigger: "manual",
        targetLocalDate: "2026-10-27",
        idempotencyKey: "different-calendar-bounds",
        now: new Date("2026-10-26T12:00:00.000Z"),
      },
      {
        propose: async () => ({
          proposal: scheduleProposal("2026-10-27", {
            activities: [
              proposalActivity("2026-10-27", "10:15", 90, {
                source_event_ids: ["first-fixed-event", "second-fixed-event"],
              }),
            ],
          }),
          model: "planner-test-model",
        }),
      },
    ),
    (error: unknown) =>
      error instanceof ProviderProblem && error.code === "PLANNER_COMMITMENT_AMBIGUOUS",
  );
  assert.equal((await store.snapshot()).twin_days.length, 0);
});

test("a stale model response cannot overwrite changed planning input", async () => {
  const store = await planningStore();
  await store.transaction((draft) => {
    draft.facts.push({
      id: "fact-stale",
      user_id: "user_demo",
      fact_key: "routine:focus",
      kind: "routine",
      statement: "I focus in the morning.",
      source_type: "chatgpt_voice_onboarding",
      source_id: "onboarding:focus",
      source_excerpt: "I focus in the morning.",
      captured_at: "2026-10-26T10:00:00.000Z",
      authority: "onboarding_user_stated",
      certainty: "user_stated",
      status: "active",
      version: 1,
      updated_at: "2026-10-26T10:00:00.000Z",
    });
  });
  const request = {
    userId: "user_demo",
    trigger: "manual" as const,
    targetLocalDate: "2026-10-27",
    idempotencyKey: "stale-input",
    now: new Date("2026-10-26T12:00:00.000Z"),
  };
  await assert.rejects(
    planTwinDay(store, request, {
      propose: async () => {
        await store.transaction((draft) => {
          const fact = draft.facts.find((item) => item.id === "fact-stale")!;
          fact.statement = "My morning availability changed.";
          fact.version += 1;
          fact.updated_at = "2026-10-26T12:01:00.000Z";
        });
        return {
          proposal: scheduleProposal("2026-10-27", {
            reasonSourceIds: ["fact-stale"],
            activities: [
              proposalActivity("2026-10-27", "09:17", 37, {
                supporting_fact_ids: ["fact-stale"],
              }),
            ],
          }),
          model: "planner-test-model",
        };
      },
    }),
    (error: unknown) => error instanceof ProviderProblem && error.code === "PLANNING_INPUT_STALE",
  );
  let state = await store.snapshot();
  assert.equal(state.twin_days.length, 0);
  assert.equal(
    Object.keys(state.idempotency).some((key) => key.startsWith("planning:")),
    false,
  );
  const retry = await planTwinDay(store, request, {
    propose: async () => ({
      proposal: scheduleProposal("2026-10-27"),
      model: "planner-test-model",
    }),
  });
  assert.equal(retry.status, "updated");
  state = await store.snapshot();
  assert.equal(state.twin_days.length, 1);
});

test("morning jobs use local wake time and deduplicate per local day", async () => {
  const store = await planningStore();
  assert.equal(
    await store
      .transaction((draft) => queueDueMorningPlans(draft, new Date("2026-10-26T11:29:00.000Z")))
      .then((jobs) => jobs.length),
    0,
  );
  assert.equal(
    await store
      .transaction((draft) => queueDueMorningPlans(draft, new Date("2026-10-26T11:30:00.000Z")))
      .then((jobs) => jobs.length),
    1,
  );
  assert.equal(
    await store
      .transaction((draft) => queueDueMorningPlans(draft, new Date("2026-10-26T15:00:00.000Z")))
      .then((jobs) => jobs.length),
    0,
  );
  assert.equal(
    await store
      .transaction((draft) => queueDueMorningPlans(draft, new Date("2026-10-27T11:30:00.000Z")))
      .then((jobs) => jobs.length),
    1,
  );
  const jobs = (await store.snapshot()).jobs.filter((job) => job.type === "twin_day_generation");
  assert.deepEqual(
    jobs.map((job) => [job.payload.trigger, job.payload.local_date]),
    [
      ["morning", "2026-10-26"],
      ["morning", "2026-10-27"],
    ],
  );
});

test("queued morning execution routes through the same planning service", async () => {
  const store = await planningStore();
  const job: Job = {
    id: "morning-job",
    user_id: "user_demo",
    type: "twin_day_generation",
    dedupe_key: "plan:user_demo:morning:2099-10-27",
    status: "running",
    attempts: 1,
    run_after: "2099-10-27T11:30:00.000Z",
    payload: { trigger: "morning", local_date: "2099-10-27" },
  };
  await store.transaction((draft) => draft.jobs.push(job));
  const result = await executeTwinDay(job, store, {
    propose: async (_key, context) => {
      assert.equal(context.trigger, "morning");
      return {
        proposal: scheduleProposal("2099-10-27"),
        model: "planner-test-model",
      };
    },
  });
  assert.equal(result.status, "updated");
  const storedJob = (await store.snapshot()).jobs.find((item) => item.id === job.id);
  assert.equal(storedJob?.result?.status, "updated");
  assert.equal(storedJob?.result?.day_version, 1);
});

test("planner jobs retain validation errors and stop after three attempts", async () => {
  const store = await planningStore();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  try {
    await store.transaction((draft) => {
      draft.settings[0].onboarding_complete = false;
      draft.jobs.push({
        id: "invalid-planner-job",
        user_id: "user_demo",
        type: "twin_day_generation",
        dedupe_key: "plan:user_demo:after_conversation:invalid",
        status: "queued",
        attempts: 0,
        run_after: "2026-01-01T00:00:00.000Z",
        payload: {
          trigger: "after_conversation",
          local_date: "2026-10-27",
          conversation_id: "conversation_demo",
        },
      });
    });
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        output_text: JSON.stringify(
          scheduleProposal("2026-10-27", { reasonSourceIds: ["unknown-source"] }),
        ),
      });
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await processJobs(store);
      if (attempt < 3)
        await store.transaction((draft) => {
          const job = draft.jobs.find((item) => item.id === "invalid-planner-job")!;
          assert.equal(job.status, "queued");
          job.run_after = "2026-01-01T00:00:00.000Z";
        });
    }
    const state = await store.snapshot();
    const job = state.jobs.find((item) => item.id === "invalid-planner-job")!;
    assert.equal(calls, 3);
    assert.equal(job.attempts, 3);
    assert.equal(job.status, "failed");
    assert.equal(job.last_error_code, "PLANNER_UNKNOWN_SOURCE");
    assert.equal(state.twin_days.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
