import type { AppState, TwinActivity } from "./types.ts";
import { addLocalDays, localDateInZone, localDateTimeToUtc, localTimeInZone } from "./time.ts";

const CHECKIN_OPENS = "04:00";
const CHECKIN_CLOSES = "14:00";
const SHORTEST_WINDOW_MINUTES = 30;
const MOST_WINDOWS = 5;

export const MORNING_CHECKIN_RULES = `Morning check-in rules (these override the usual conversation style):
1. Your job is to learn what is really planned during morning_checkin.unknown_windows so Twin can build an accurate day. Open with a brief greeting and your first question.
2. Ask one short question at a time and name the time range you mean. Combine neighboring windows when that is natural.
3. Ask only about unknown_windows. Never ask about something Calendar, memory, or this conversation already answers.
4. twin_guesses are imagined and may be wrong. You may check one ("Are you still thinking of studying then?"), but never state one as fact.
5. Ask at most five questions in total. Accept "not sure" or "nothing planned" and move on without pressing.
6. If the person wants to stop, stop asking immediately.
7. Do not claim the schedule changed during this conversation. When you are done, say Twin will build the day when they leave this conversation.
8. Never invent plans, times, or commitments.`;

export interface UnknownWindow {
  start_local: string;
  end_local: string;
  twin_guesses: string[];
}

export interface MorningCheckinBrief {
  local_date: string;
  unknown_windows: UnknownWindow[];
}

function activityIsKnown(activity: TwinActivity) {
  return Boolean(
    activity.locked ||
    activity.user_edited ||
    activity.supporting_report_ids?.length ||
    activity.source_event_ids.length ||
    activity.source_message_ids?.length ||
    (activity.confidence === "grounded" && !activity.is_experiment),
  );
}

export function findUnknownWindows(
  state: AppState,
  userId: string,
  now = new Date(),
): UnknownWindow[] {
  const settings = state.settings.find((item) => item.user_id === userId);
  if (!settings) return [];
  const { timezone, wake_time: wake, sleep_time: sleep } = settings;
  const date = localDateInZone(now, timezone);
  const wakeAt = new Date(localDateTimeToUtc(date, wake, timezone)).getTime();
  const endAt = new Date(
    sleep > wake
      ? localDateTimeToUtc(date, sleep, timezone)
      : localDateTimeToUtc(addLocalDays(date, 1), "00:00", timezone),
  ).getTime();
  const startAt = Math.max(now.getTime(), wakeAt);
  if (startAt >= endAt) return [];
  const day = state.twin_days
    .filter(
      (item) => item.user_id === userId && item.local_date === date && item.status === "ready",
    )
    .sort((left, right) => right.version - left.version)[0];
  const activities = day?.activities ?? [];
  const interval = (item: { start_at?: string; end_at?: string }) => ({
    start: new Date(item.start_at!).getTime(),
    end: new Date(item.end_at!).getTime(),
  });
  const known = [
    ...state.calendar_events
      .filter(
        (event) =>
          event.user_id === userId &&
          !event.deleted &&
          !event.all_day &&
          event.start_at &&
          event.end_at &&
          event.availability !== "free" &&
          event.self_response_status !== "declined",
      )
      .map(interval),
    ...activities.filter(activityIsKnown).map(interval),
  ].sort((left, right) => left.start - right.start);
  const guesses = activities.filter((activity) => !activityIsKnown(activity));
  const open: Array<{ start: number; end: number }> = [];
  let cursor = startAt;
  for (const item of known) {
    if (item.start > cursor) open.push({ start: cursor, end: Math.min(item.start, endAt) });
    cursor = Math.max(cursor, item.end);
    if (cursor >= endAt) break;
  }
  if (cursor < endAt) open.push({ start: cursor, end: endAt });
  return open
    .filter((item) => item.end - item.start >= SHORTEST_WINDOW_MINUTES * 60_000)
    .slice(0, MOST_WINDOWS)
    .map((item) => ({
      start_local: localTimeInZone(new Date(item.start), timezone),
      end_local: localTimeInZone(new Date(item.end), timezone),
      twin_guesses: [
        ...new Set(
          guesses
            .filter((guess) => {
              const range = interval(guess);
              return range.start < item.end && item.start < range.end;
            })
            .map((guess) => guess.title.slice(0, 80)),
        ),
      ].slice(0, 3),
    }));
}

function checkinInWindow(time: string) {
  return time >= CHECKIN_OPENS && time < CHECKIN_CLOSES;
}

// An unanswered check-in ends with the window; one already underway may be finished later.
function checkinIsLive(state: AppState, conversationId: string, userId: string, time: string) {
  return (
    checkinInWindow(time) ||
    state.messages.some(
      (item) =>
        item.user_id === userId &&
        item.conversation_id === conversationId &&
        item.role === "user" &&
        item.status === "saved",
    )
  );
}

export function morningCheckinStatus(state: AppState, userId: string, now = new Date()) {
  const settings = state.settings.find((item) => item.user_id === userId);
  if (!settings?.onboarding_complete) return { available: false, conversation_id: null };
  const date = localDateInZone(now, settings.timezone);
  const time = localTimeInZone(now, settings.timezone);
  const today = state.conversations.filter(
    (item) => item.user_id === userId && item.morning_checkin?.local_date === date,
  );
  if (today.some((item) => item.morning_checkin?.status === "complete"))
    return { available: false, conversation_id: null };
  const active = today.find(
    (item) =>
      item.morning_checkin?.status === "active" && checkinIsLive(state, item.id, userId, time),
  );
  return {
    available:
      Boolean(active) ||
      (checkinInWindow(time) && findUnknownWindows(state, userId, now).length > 0),
    conversation_id: active?.id ?? null,
  };
}

export function activeCheckinBrief(
  state: AppState,
  userId: string,
  conversationId: string,
  now = new Date(),
): MorningCheckinBrief | null {
  const settings = state.settings.find((item) => item.user_id === userId);
  const checkin = state.conversations.find(
    (item) => item.id === conversationId && item.user_id === userId,
  )?.morning_checkin;
  if (!settings || checkin?.status !== "active") return null;
  if (checkin.local_date !== localDateInZone(now, settings.timezone)) return null;
  if (!checkinIsLive(state, conversationId, userId, localTimeInZone(now, settings.timezone)))
    return null;
  return {
    local_date: checkin.local_date,
    unknown_windows: findUnknownWindows(state, userId, now),
  };
}
