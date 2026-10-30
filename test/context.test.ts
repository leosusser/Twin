import test from "node:test";
import assert from "node:assert/strict";
import { seedState } from "../src/storage/store.ts";
import { selectPlanningContext, selectTalkContext } from "../src/storage/context.ts";
test("chat context is relevant, bounded, excludes suppressed memories and other users", () => {
  const state = seedState(),
    now = new Date();
  state.facts = Array.from({ length: 50 }, (_, i) => ({
    ...state.facts[0],
    id: `f${i}`,
    statement: i === 40 ? "Running helps me reset" : "An unrelated preference",
    updated_at: now.toISOString(),
  }));
  state.facts.push({
    ...state.facts[0],
    id: "suppressed",
    status: "suppressed",
    statement: "Running secret",
  });
  state.facts.push({
    ...state.facts[0],
    id: "foreign",
    user_id: "other",
    statement: "Running private",
  });
  state.messages.push({
    ...state.messages[0],
    id: "foreign",
    user_id: "other",
    content: "Private",
  });
  const context = selectTalkContext(state, "user_demo", "conversation_demo", "I am running", now);
  assert.equal(context.memory.length, 8);
  assert.equal(context.memory[0], "Running helps me reset");
  assert.ok(!JSON.stringify(context).includes("secret"));
  assert.ok(!JSON.stringify(context).includes("private"));
  assert.ok(context.recent.length <= 6);
  assert.ok(context.checkIns.length <= 5);
  assert.ok(context.events.length <= 8);
});

test("planning context is user-scoped, bounded, and distinguishes Calendar data states", () => {
  const state = seedState();
  const now = new Date("2026-10-26T12:00:00.000Z");
  state.settings[0].timezone = "America/New_York";
  state.twin_days = [];
  state.facts = Array.from({ length: 45 }, (_, index) => ({
    ...state.facts[0],
    id: `planning-fact-${index}`,
    statement: `Planning fact ${index}`,
    source_id: `onboarding:${index}`,
    updated_at: new Date(now.getTime() - index * 1000).toISOString(),
  }));
  state.facts.push({
    ...state.facts[0],
    id: "planning-suppressed",
    status: "suppressed",
    statement: "Suppressed planning secret",
  });
  state.facts.push({
    ...state.facts[0],
    id: "planning-foreign",
    user_id: "other-user",
    statement: "Other user's private fact",
  });
  state.messages = Array.from({ length: 18 }, (_, index) => ({
    id: `planning-message-${index}`,
    user_id: "user_demo",
    conversation_id: "planning-conversation",
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    content: `Planning message ${index}`,
    status: "saved" as const,
    created_at: new Date(now.getTime() - (18 - index) * 1000).toISOString(),
  }));
  state.messages.push({
    ...state.messages[0],
    id: "planning-message-other-conversation",
    conversation_id: "other-conversation",
    content: "Do not include this other conversation.",
  });
  state.messages.push({
    ...state.messages[0],
    id: "planning-message-foreign",
    user_id: "other-user",
    content: "Do not include this other user's message.",
  });
  state.memory_overrides = Array.from({ length: 20 }, (_, index) => ({
    id: `override-${index}`,
    user_id: "user_demo",
    fact_key: `fact:${index}`,
    action: "edit" as const,
    replacement: `Replacement ${index}`,
    recorded_at: new Date(now.getTime() - index * 1000).toISOString(),
    version: index + 1,
  }));
  state.activity_reports = Array.from({ length: 20 }, (_, index) => ({
    id: `report-${index}`,
    user_id: "user_demo",
    conversation_message_id: `planning-message-${index % 18}`,
    local_date: "2026-10-26",
    activity_key: "working" as const,
    statement: `Actual report ${index}`,
    source: "talk_user_report" as const,
    created_at: new Date(now.getTime() - index * 1000).toISOString(),
  }));
  const calendar = state.integrations.find((item) => item.provider === "google_calendar")!;
  calendar.mode = "live";
  calendar.status = "connected";
  calendar.selected_calendars = [{ id: "primary", name: "Primary", selected: true }];
  calendar.last_successful_sync_at = new Date(now.getTime() - 60_000).toISOString();
  state.calendar_events = [
    {
      id: "busy-event",
      user_id: "user_demo",
      external_id: "provider-busy",
      calendar_id: "primary",
      title: "Saved commitment",
      start_at: "2026-10-26T14:00:00.000Z",
      end_at: "2026-10-26T15:00:00.000Z",
      source_timezone: "America/New_York",
      all_day: false,
      deleted: false,
      availability: "busy",
      sync_revision: 1,
    },
    {
      id: "cancelled-event",
      user_id: "user_demo",
      external_id: "provider-cancelled",
      calendar_id: "primary",
      title: "Cancelled meeting",
      start_at: "2026-10-26T16:00:00.000Z",
      end_at: "2026-10-26T17:00:00.000Z",
      source_timezone: "America/New_York",
      all_day: false,
      deleted: true,
      availability: "busy",
      sync_revision: 1,
    },
  ];
  const read = () =>
    selectPlanningContext(state, "user_demo", {
      targetLocalDate: "2026-10-26",
      trigger: "after_conversation",
      conversationId: "planning-conversation",
      now,
    });
  let context = read();
  assert.equal(context.memory.length, 32);
  assert.equal(context.recent_conversation.length, 10);
  assert.ok(context.memory.every((fact) => !("source_id" in fact)));
  assert.equal(context.memory_changes.length, 12);
  assert.equal(context.actual_activity_reports.length, 12);
  assert.deepEqual(
    context.citation_id_allowlist.fact_ids,
    context.memory.map((item) => item.id),
  );
  assert.deepEqual(
    context.citation_id_allowlist.calendar_event_ids,
    context.calendar.events.map((item) => item.id),
  );
  assert.deepEqual(
    context.citation_id_allowlist.activity_report_ids,
    context.actual_activity_reports.map((item) => item.id),
  );
  assert.deepEqual(
    context.citation_id_allowlist.conversation_message_ids,
    context.recent_conversation.map((item) => item.id),
  );
  assert.deepEqual(
    context.citation_id_allowlist.existing_activity_ids,
    context.existing_schedule?.activities.map((item) => item.id) ?? [],
  );
  assert.equal(context.calendar.data_state, "available");
  assert.deepEqual(
    context.calendar.events.map((event) => [event.id, event.status]),
    [
      ["busy-event", "active"],
      ["cancelled-event", "cancelled"],
    ],
  );
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("Suppressed planning secret"), false);
  assert.equal(serialized.includes("Other user's private fact"), false);
  assert.equal(serialized.includes("other conversation"), false);
  state.calendar_events[0].deleted = true;
  context = read();
  assert.equal(context.calendar.data_state, "empty");
  calendar.last_successful_sync_at = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString();
  context = read();
  assert.equal(context.calendar.data_state, "stale");
  calendar.status = "failed";
  context = read();
  assert.equal(context.calendar.data_state, "stale");
  calendar.status = "disconnected";
  delete calendar.last_successful_sync_at;
  context = read();
  assert.equal(context.calendar.data_state, "unavailable");
});

test("planning trigger selects only its intended instruction or Talk transcript", () => {
  const state = seedState();
  state.settings[0].timezone = "America/New_York";
  state.twin_days = [];
  state.messages = [
    {
      id: "manual-should-not-see-this",
      user_id: "user_demo",
      conversation_id: "conversation-a",
      role: "user",
      content: "Private Talk context A",
      status: "saved",
      created_at: "2026-10-26T12:00:00.000Z",
    },
    {
      id: "talk-selected-message",
      user_id: "user_demo",
      conversation_id: "conversation-b",
      role: "user",
      content: "Use this triggering Talk context",
      status: "saved",
      created_at: "2026-10-26T12:01:00.000Z",
    },
  ];
  const now = new Date("2026-10-26T16:00:00.000Z");

  const initial = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "manual",
    now,
  });
  assert.equal(initial.revision_window.mode, "initial_day");
  assert.ok(initial.memory.length > 0);
  assert.ok(initial.memory.every((fact) => !("source_id" in fact)));
  assert.deepEqual(initial.recent_conversation, []);

  const manual = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "manual",
    instruction: "Make the afternoon lighter.",
    conversationId: "conversation-b",
    now,
  });
  assert.equal(manual.manual_instruction, "Make the afternoon lighter.");
  assert.deepEqual(manual.recent_conversation, []);
  assert.deepEqual(manual.citation_id_allowlist.conversation_message_ids, []);

  const afterTalk = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "after_conversation",
    instruction: "Ignore this manual-only text.",
    conversationId: "conversation-b",
    now,
  });
  assert.equal(afterTalk.manual_instruction, null);
  assert.deepEqual(
    afterTalk.recent_conversation.map((message) => message.id),
    ["talk-selected-message"],
  );
  assert.deepEqual(afterTalk.citation_id_allowlist.conversation_message_ids, [
    "talk-selected-message",
  ]);
});

test("remaining-day context separates protected backlog, adjustable current work, and future plans", () => {
  const state = seedState();
  state.settings[0].timezone = "America/New_York";
  state.twin_days = [
    {
      ...state.twin_days[0],
      local_date: "2026-10-26",
      timezone: "America/New_York",
      activities: [
        {
          ...state.twin_days[0].activities[0],
          id: "elapsed",
          start_at: "2026-10-26T13:00:00.000Z",
          end_at: "2026-10-26T14:00:00.000Z",
          source_event_ids: [],
        },
        {
          ...state.twin_days[0].activities[0],
          id: "in-progress",
          start_at: "2026-10-26T15:30:00.000Z",
          end_at: "2026-10-26T17:00:00.000Z",
          source_event_ids: [],
        },
        {
          ...state.twin_days[0].activities[0],
          id: "locked-future",
          start_at: "2026-10-26T18:00:00.000Z",
          end_at: "2026-10-26T19:00:00.000Z",
          source_event_ids: [],
          locked: true,
        },
        {
          ...state.twin_days[0].activities[0],
          id: "flexible-future",
          start_at: "2026-10-26T20:00:00.000Z",
          end_at: "2026-10-26T21:00:00.000Z",
          source_event_ids: [],
        },
      ],
    },
  ];
  state.twin_days.push({
    ...state.twin_days[0],
    id: "superseded-higher-version",
    version: 2,
    status: "superseded",
    activities: [],
  });

  const context = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "manual",
    now: new Date("2026-10-26T16:07:30.000Z"),
  });

  assert.deepEqual(context.revision_window, {
    mode: "remaining_day",
    earliest_new_activity_start_local: "2026-10-26T12:08",
    current_activity_required_at_local: null,
    day_end_local: "2026-10-27T00:00",
    preserve_activity_ids: ["elapsed", "locked-future"],
    adjustable_in_progress_activity_id: "in-progress",
  });
  assert.equal(context.existing_schedule?.status, "ready");
  assert.notEqual(context.existing_schedule?.id, "superseded-higher-version");
});

test("manual report context enables catch-up while preserving only protected activity", () => {
  const state = seedState();
  state.settings[0].timezone = "America/New_York";
  state.twin_days = [
    {
      ...state.twin_days[0],
      local_date: "2026-10-26",
      timezone: "America/New_York",
      activities: [
        {
          ...state.twin_days[0].activities[0],
          id: "elapsed-flexible",
          start_at: "2026-10-26T13:00:00.000Z",
          end_at: "2026-10-26T14:00:00.000Z",
          source_event_ids: [],
        },
        {
          ...state.twin_days[0].activities[0],
          id: "locked-history",
          start_at: "2026-10-26T15:00:00.000Z",
          end_at: "2026-10-26T16:00:00.000Z",
          source_event_ids: [],
          locked: true,
        },
        {
          ...state.twin_days[0].activities[0],
          id: "older-reported-history",
          start_at: "2026-10-26T16:00:00.000Z",
          end_at: "2026-10-26T17:00:00.000Z",
          source_event_ids: [],
          supporting_report_ids: ["older-report"],
          source_types: ["report"],
        },
        {
          ...state.twin_days[0].activities[0],
          id: "elapsed-calendar-plan",
          start_at: "2026-10-26T17:00:00.000Z",
          end_at: "2026-10-26T18:00:00.000Z",
          source_event_ids: ["older-calendar-event"],
          supporting_report_ids: [],
          source_types: ["calendar"],
        },
      ],
    },
  ];
  const manualReport = {
    id: "manual-report",
    user_id: "user_demo",
    local_date: "2026-10-26",
    activity_key: "generic" as const,
    statement: "I worked this morning and I am having lunch now.",
    source: "manual_rebuild_report" as const,
    created_at: "2026-10-26T18:14:00.000Z",
  };
  state.activity_reports.push({
    id: "older-report",
    user_id: "user_demo",
    local_date: "2026-10-25",
    activity_key: "walking",
    statement: "I walked yesterday afternoon.",
    source: "talk_user_report",
    created_at: "2026-10-25T19:00:00.000Z",
  });
  const context = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "manual",
    instruction: "Keep the afternoon lighter.",
    manualReport,
    now: new Date("2026-10-26T18:14:00.000Z"),
  });

  assert.deepEqual(context.revision_window, {
    mode: "catch_up",
    earliest_new_activity_start_local: null,
    current_activity_required_at_local: "2026-10-26T14:14",
    day_end_local: "2026-10-27T00:00",
    preserve_activity_ids: ["locked-history"],
    adjustable_in_progress_activity_id: null,
  });
  assert.equal(context.actual_activity_reports[0].id, manualReport.id);
  assert.equal(context.actual_activity_reports.length, 1);
  assert.equal(context.manual_instruction, "Keep the afternoon lighter.");
  assert.deepEqual(context.citation_id_allowlist.activity_report_ids, [manualReport.id]);
  assert.ok(state.activity_reports.some((report) => report.id === "older-report"));
});

test("planning context prioritizes fixed commitments and reports event truncation", () => {
  const state = seedState();
  const now = new Date("2026-10-26T12:00:00.000Z");
  state.settings[0].timezone = "UTC";
  const calendar = state.integrations.find((item) => item.provider === "google_calendar")!;
  calendar.mode = "live";
  calendar.status = "connected";
  calendar.selected_calendars = [{ id: "primary", name: "Primary", selected: true }];
  calendar.last_successful_sync_at = now.toISOString();
  const freeEvents = Array.from({ length: 5 }, (_, index) => ({
    id: `free-${index}`,
    user_id: "user_demo",
    external_id: `free-provider-${index}`,
    calendar_id: "primary",
    title: `Free ${index}`,
    start_at: `2026-10-26T0${index}:00:00.000Z`,
    end_at: `2026-10-26T0${index}:30:00.000Z`,
    source_timezone: "UTC",
    all_day: false,
    deleted: false,
    availability: "free" as const,
    sync_revision: 1,
  }));
  const commitments = Array.from({ length: 40 }, (_, index) => ({
    id: `fixed-${index}`,
    user_id: "user_demo",
    external_id: `fixed-provider-${index}`,
    calendar_id: "primary",
    title: `Fixed ${index}`,
    start_at: `2026-10-26T${String(6 + Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}:00.000Z`,
    end_at: `2026-10-26T${String(6 + Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15 + 10).padStart(2, "0")}:00.000Z`,
    source_timezone: "UTC",
    all_day: false,
    deleted: false,
    availability: "busy" as const,
    sync_revision: 1,
  }));
  state.calendar_events = [...freeEvents, ...commitments];
  const context = selectPlanningContext(state, "user_demo", {
    targetLocalDate: "2026-10-26",
    trigger: "manual",
    now,
  });
  assert.equal(context.calendar.matching_event_count, 45);
  assert.equal(context.calendar.events.length, 40);
  assert.equal(context.calendar.truncated, true);
  assert.equal(context.calendar.fixed_commitment_overflow, false);
  assert.ok(context.calendar.events.every((event) => event.id.startsWith("fixed-")));
});
