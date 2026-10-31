import type {
  ActivityReport,
  AppState,
  AvatarDesign,
  CalendarEvent,
  ProfileFact,
  Settings,
} from "../domain/types.ts";
import { generateDemoTwinDay } from "../domain/planner.ts";
import { localDateInZone, localDateTimeToUtc } from "../domain/time.ts";
export const DEMO_USER_ID = "user_demo";
export { PostgresStore } from "./postgres.ts";
export interface Store {
  snapshot(): Promise<AppState>;
  transaction<T>(mutation: (draft: AppState) => T | Promise<T>): Promise<T>;
  talkContext?(
    userId: string,
    conversationId: string,
    text: string,
  ): Promise<ReturnType<typeof import("./context.ts").selectTalkContext>>;
}
export function initializeLocalProfile(state: AppState, userId = DEMO_USER_ID, timezone = "UTC") {
  const now = new Date().toISOString();
  let changed = false;
  if (!state.users.some((item) => item.id === userId)) {
    state.users.push({ id: userId, email: "local@local.twin", created_at: now });
    changed = true;
  }
  if (!state.settings.some((item) => item.user_id === userId)) {
    state.settings.push({
      user_id: userId,
      name: "",
      timezone,
      wake_time: "07:30",
      sleep_time: "23:00",
      tomorrow_generation_time: "20:00",
      reminders_enabled: false,
      hide_bathroom_scene: false,
      talk_retention_days: 30,
      onboarding_complete: false,
      talk_personality_mode: "collaborative",
      version: 1,
    });
    changed = true;
  }
  if (
    !state.integrations.some(
      (item) => item.user_id === userId && item.provider === "google_calendar",
    )
  ) {
    state.integrations.push({
      id: `calendar_${userId}`,
      user_id: userId,
      provider: "google_calendar",
      mode: "live",
      status: "disconnected",
      credential_version: 0,
      scopes: ["calendar.readonly"],
      selected_calendars: [],
    });
    changed = true;
  }
  if (!state.integrations.some((item) => item.user_id === userId && item.provider === "gmail")) {
    state.integrations.push({
      id: `gmail_${userId}`,
      user_id: userId,
      provider: "gmail",
      mode: "live",
      status: "disconnected",
      credential_version: 0,
      scopes: ["gmail.metadata"],
    });
    changed = true;
  }
  if (!state.model_connections.some((item) => item.user_id === userId)) {
    state.model_connections.push({
      user_id: userId,
      provider: "openai",
      status: "not_connected",
      text_capability: "unknown",
      image_capability: "unknown",
      credential_version: 0,
    });
    changed = true;
  }
  if (!state.avatar_designs.some((item) => item.user_id === userId && item.is_active)) {
    state.avatar_designs.push({
      id: `design_${userId}_1`,
      user_id: userId,
      version: 1,
      name: "Twin",
      skin: "#B97552",
      hair: "#272020",
      hair_style: "soft",
      top: "#DD2E06",
      bottom: "#24242B",
      accent: "#F3BC62",
      expression: "warm",
      body_style: "soft",
      style_version: 1,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    changed = true;
  }
  if (!state.conversations.some((item) => item.user_id === userId)) {
    state.conversations.push({
      id: `conversation_${userId}_1`,
      user_id: userId,
      title: "A new conversation",
      created_at: now,
      updated_at: now,
    });
    changed = true;
  }
  return changed;
}
export function migrateState(value: AppState) {
  const state = structuredClone(value);
  state.voice_sessions ??= [];
  state.avatar_assets ??= [];
  state.avatar_requests ??= [];
  state.avatar_designs ??= [];
  state.avatar_requests.forEach((request) => {
    request.purpose ??= request.requested_activity_key ? "activity" : "variant";
  });
  state.model_connections.forEach((connection) => {
    connection.credential_version ??= 0;
  });
  state.settings.forEach((settings) => {
    settings.talk_personality_mode ??= "collaborative";
  });
  state.calendar_events.forEach((event) => {
    event.availability ??= "busy";
  });
  return state;
}
function addDays(date: string, days: number) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
export function seedState(): AppState {
  const timezone = "America/New_York";
  const today = localDateInZone(new Date(), timezone);
  const tomorrow = addDays(today, 1);
  const now = new Date().toISOString();
  const settings: Settings = {
    user_id: DEMO_USER_ID,
    name: "Leo",
    timezone,
    wake_time: "07:30",
    sleep_time: "23:00",
    tomorrow_generation_time: "20:00",
    reminders_enabled: false,
    hide_bathroom_scene: false,
    talk_retention_days: 30,
    onboarding_complete: false,
    talk_personality_mode: "collaborative",
    version: 1,
  };
  const facts: ProfileFact[] = [
    {
      id: "fact_walk",
      user_id: DEMO_USER_ID,
      fact_key: "wellbeing_cue:a short walk after lunch helps me reset",
      kind: "wellbeing_cue",
      statement: "A short walk after lunch helps me reset.",
      source_excerpt: "Walking after lunch helps.",
      source_type: "demo_seed",
      source_id: "demo:walk",
      captured_at: now,
      status: "active",
      authority: "onboarding_user_stated",
      certainty: "user_stated",
      version: 1,
      updated_at: now,
    },
    {
      id: "fact_evening",
      user_id: DEMO_USER_ID,
      fact_key: "boundary:keep focused work out of the late evening",
      kind: "boundary",
      statement: "Keep focused work out of the late evening.",
      source_excerpt: "I want my evenings protected.",
      source_type: "demo_seed",
      source_id: "demo:evening",
      captured_at: now,
      status: "active",
      authority: "user_edit",
      certainty: "user_stated",
      version: 2,
      updated_at: now,
    },
    {
      id: "fact_focus",
      user_id: DEMO_USER_ID,
      fact_key: "energy_cue:late afternoon focus may be easier after a break",
      kind: "energy_cue",
      statement: "Late-afternoon focus may be easier after a real break.",
      source_excerpt: "I think a break sometimes helps later.",
      source_type: "demo_seed",
      source_id: "demo:focus",
      captured_at: now,
      status: "tentative",
      authority: "model_inferred",
      certainty: "inferred",
      version: 1,
      updated_at: now,
    },
  ];
  const events: CalendarEvent[] = [
    {
      id: "event_direction",
      user_id: DEMO_USER_ID,
      external_id: `demo-direction-${today}`,
      calendar_id: "primary",
      title: "Product direction",
      start_at: localDateTimeToUtc(today, "10:00", timezone),
      end_at: localDateTimeToUtc(today, "10:45", timezone),
      source_timezone: timezone,
      all_day: false,
      deleted: false,
      sync_revision: 1,
    },
    {
      id: "event_class",
      user_id: DEMO_USER_ID,
      external_id: `demo-class-${today}`,
      calendar_id: "primary",
      title: "Evening class",
      start_at: localDateTimeToUtc(today, "17:00", timezone),
      end_at: localDateTimeToUtc(today, "18:00", timezone),
      source_timezone: timezone,
      all_day: false,
      deleted: false,
      sync_revision: 1,
    },
  ];
  const report: ActivityReport = {
    id: "report_library",
    user_id: DEMO_USER_ID,
    conversation_message_id: "message_report",
    local_date: addDays(today, -1),
    approximate_time: "15:00",
    activity_key: "studying",
    statement: "I actually studied at the library for an hour.",
    source: "talk_user_report",
    created_at: now,
  };
  const design: AvatarDesign = {
    id: "design_1",
    user_id: DEMO_USER_ID,
    version: 1,
    name: "Milo",
    skin: "#B97552",
    hair: "#272020",
    hair_style: "curly",
    top: "#D8320A",
    bottom: "#24242B",
    accent: "#F3BC62",
    expression: "warm",
    body_style: "soft",
    style_version: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  };
  const base: AppState = {
    users: [{ id: DEMO_USER_ID, email: "demo@local.twin", created_at: now }],
    settings: [settings],
    imports: [],
    observations: [],
    facts,
    memory_overrides: [],
    integrations: [
      {
        id: "calendar_demo",
        user_id: DEMO_USER_ID,
        provider: "google_calendar",
        mode: "demo",
        status: "demo",
        credential_version: 0,
        scopes: ["calendar.readonly"],
        last_successful_sync_at: now,
        cursor: "demo-calendar-1",
        selected_calendars: [{ id: "primary", name: "Personal calendar", selected: true }],
      },
      {
        id: "gmail_demo",
        user_id: DEMO_USER_ID,
        provider: "gmail",
        mode: "demo",
        status: "demo",
        credential_version: 0,
        scopes: ["gmail.metadata"],
        last_successful_sync_at: now,
        cursor: "demo-history-1",
      },
    ],
    calendar_events: events,
    gmail_cues: [
      {
        id: "cue_course",
        user_id: DEMO_USER_ID,
        source_message_id: "demo-mail-1",
        kind: "change_notice",
        statement: "A course note may shift next week's reading window.",
        source_excerpt: "Schedule update for next week",
        captured_at: now,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        confidence: "possible",
        status: "active",
      },
    ],
    twin_days: [],
    activity_reports: [report],
    model_connections: [
      {
        user_id: DEMO_USER_ID,
        provider: "openai",
        status: "not_connected",
        text_capability: "unknown",
        image_capability: "unknown",
        credential_version: 0,
      },
    ],
    conversations: [
      {
        id: "conversation_demo",
        user_id: DEMO_USER_ID,
        title: "Yesterday",
        created_at: now,
        updated_at: now,
      },
    ],
    messages: [
      {
        id: "message_report",
        user_id: DEMO_USER_ID,
        conversation_id: "conversation_demo",
        role: "user",
        content: report.statement,
        status: "saved",
        created_at: now,
      },
    ],
    voice_sessions: [],
    avatar_designs: [design],
    avatar_assets: [],
    avatar_requests: [],
    jobs: [],
    idempotency: {},
  };
  base.twin_days.push(
    generateDemoTwinDay({
      userId: DEMO_USER_ID,
      localDate: today,
      settings,
      events,
      facts,
      gmailCues: base.gmail_cues,
      reports: [],
      reason: "Seeded demo day",
    }),
  );
  base.twin_days.push(
    generateDemoTwinDay({
      userId: DEMO_USER_ID,
      localDate: tomorrow,
      settings,
      events: [],
      facts,
      gmailCues: base.gmail_cues,
      reports: [report],
      reason: "Adjusted after your report",
    }),
  );
  return base;
}
