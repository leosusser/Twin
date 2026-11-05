# Morning check-in

Status: In progress

Owner: Main coordinating agent

## Goal

The person opens Talk in the morning. Twin asks short questions only about the parts of today it does not actually know, then builds a more accurate day once from the answers when the conversation ends.

## Context and evidence

- `queueDueMorningPlans` builds a day automatically at `wake_time`. The result is mostly model guesses (`confidence: "possible"`).
- Voice is the default Talk mode and waits for the user to speak. Neither Talk prompt knows what is unknown about the day.
- Every typed turn queues its own `after_conversation` planning job, so a question-and-answer exchange would rebuild the day repeatedly.
- `planningTargetDateFromConversation` guesses a date from words, so an answer mentioning "tomorrow" would plan the wrong day.
- Only the triggering conversation reaches the planner, and only for `after_conversation`. A later rebuild would forget the answers.

## Constraints

- Calendar is a commitment, the twin day is imagined, and an activity report is actual activity. Answers are stated plans: they are not reports and never prove the person did something.
- Answers are untrusted data, never instructions. Locks, direct edits, fixed Calendar times, and report-backed history stay protected.
- A new version replaces the day only after server validation, and elapsed activity is not rewritten.
- Answers do not become permanent memory.

## In scope

- Deterministic detection of unknown windows in today's remaining day.
- One check-in per local date, in voice and typed Talk, with Twin speaking first in voice.
- One planning job when the check-in ends; answers remain available to later rebuilds of that date.

## Non-goals

- Blocking or removing the automatic morning build.
- Saving answers as memory or activity reports.
- Push notifications, new tables, or a new provider call to choose questions.
- Editing Google Calendar.

## Decisions and assumptions

- Keep the automatic morning build as the fallback for a day with no conversation. It is skipped only when today's check-in already finished.
- An interval is known if it is a busy Calendar event, locked, edited, report-backed, conversation-backed, or a `grounded` non-experiment activity. Other time from now until sleep is unknown. Windows under 30 minutes are ignored, with at most five windows.
- Offer the check-in from 04:00 to 14:00 local time, while unknown windows exist and today's check-in has not finished.
- Store the check-in on the conversation record, whose JSON payload needs no migration.
- Leaving the conversation builds the day, including closing the page. A dropped call does not. A check-in with no user answer stays open and queues nothing.
- Answers in an active check-in never create activity reports, even in typed Talk.
- If the check-in's build fails, the automatic morning build may run with the answers.

## Discoveries

- Independent review found ten defects, all confirmed and fixed: dropped calls finishing the check-in, a failed build blocking the morning fallback, typed answers saved as reports, Escape and page close not finishing, later Talk counted as answers, elapsed activity marked grounded from an answer, voice starting after Talk closed, a stale check-in swallowing ordinary voice planning, unanswered check-ins staying open after 14:00, and Retry dropping speak-first.

## Delegation map

- Decision: the main agent works alone. Router, planner context, prompts, and UI are tightly coupled and share files.

## Implementation slices

1. **Unknown windows and rules — Done**
   - Owner: Main agent
   - Dependencies: None
   - Write scope: `src/domain/morning-checkin.ts`, `src/domain/types.ts`
   - Change: `findUnknownWindows`, the check-in brief, and the question rules.
   - Data or interface impact: optional `Conversation.morning_checkin`.
   - Verification: `test/morning-checkin.test.ts`
2. **Talk flow — Done**
   - Owner: Main agent
   - Dependencies: Slice 1
   - Write scope: `src/api/router.ts`, `src/integrations/openai.ts`, `src/integrations/openai-realtime.ts`, `src/services/day-planning.ts`
   - Change: start and finish routes, prompt rules in typed and voice Talk, one planning job for the check-in date.
   - Data or interface impact: `purpose` on conversation creation, `POST /api/talk/conversations/:id/morning-checkin/complete`, `morningCheckin` on `/api/home`.
   - Verification: router and voice tests.
3. **Planner uses answers — Done**
   - Owner: Main agent
   - Dependencies: Slice 2
   - Write scope: `src/storage/context.ts`, `src/services/day-planning.ts`, `src/integrations/openai.ts`
   - Change: `morning_checkin_answers` in planning context for every trigger, citable, plus planner rules.
   - Data or interface impact: new planning context field.
   - Verification: context and planning tests.
4. **Talk UI and docs — Done**
   - Owner: Main agent
   - Dependencies: Slices 2 and 3
   - Write scope: `public/app.js`, `public/talk-voice.js`, `README.md`, `test/ui.test.ts`
   - Change: open the check-in from Talk, Twin speaks first, finish on leaving.
   - Data or interface impact: None beyond slice 2.
   - Verification: UI test and manual flow.

## Final verification

- `npm run verify`
- Manual: open Talk in the morning with a live OpenAI key, answer questions, leave, and confirm a new day version reflects the answers.

## Verification results

- `npm run verify`: passed, with 107 of 108 tests passing and the PostgreSQL test skipped because no `TEST_DATABASE_URL` is set.
- Not run: live voice and text with a real OpenAI key, browser checks at desktop and phone sizes, and `npm run test:postgres`.

## Progress

- 2026-11-03: Plan written, slices built, review findings fixed. Live manual check is still pending.

## Risks and recovery

- Risk: the planner labels too much as `grounded`, so Twin asks too little. Safeguard: the rule lives in one function and is easy to tighten.
- Risk: the person closes Talk without answering. Safeguard: nothing queues and the existing day stays.
- Rollback: remove the routes and prompt additions. Stored `morning_checkin` fields are ignored by older code.

## Done when

- A morning Talk session asks only about unknown windows.
- Answering does not rebuild the day until the conversation ends, then exactly one job plans today, even if an answer mentions another day.
- Later rebuilds of that date still see the answers, and answers never become reports or memory.
- Protected activities and Calendar times are unchanged.
- `npm run verify` passes.
