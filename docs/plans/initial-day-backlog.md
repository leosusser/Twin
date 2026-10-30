# Initial-day backlog and current activity

Status: Complete

Owner: Main coordinating agent

## Goal

On first Twin-day creation, generate a complete illustrative schedule for the current local day, including imagined earlier-day backlog and an activity covering the current time. Keep later same-day revisions from rewriting elapsed history.

## Context and evidence

- First creation currently uses remaining-day rules even when no saved day exists. The planner is forbidden from creating anything before the next minute, so Home has no current activity.
- Near midnight, the model can propose an activity whose duration crosses the next local midnight; `validatePlannerOutput` rejects the whole day with “An activity falls outside the target local day.”
- Schedule already labels generated activities as imagined, which is required for any backfilled rows.

## Constraints

- Preserve immutable displayed-day versions and the existing protections for elapsed, locked, user-edited, Calendar-backed, and report-backed activities on later revisions.
- Generated backlog is imagined Twin activity, never a claim about what the user did and never a source for factual memory or activity reports.
- Keep Calendar commitments distinct and retain exact saved timing.
- Use the owner's saved IANA timezone and next local midnight, including DST days.
- Do not create a fixed fallback schedule or make additional paid provider calls solely to repair output.

## In scope

- A distinct initial-day planning window when the target is today and no saved schedule exists.
- Explicit provider instructions permitting imagined backlog, requiring an activity spanning the current timestamp, and prohibiting target-day overflow.
- Deterministic validation that first-day output covers now.
- Regression coverage and matching README behavior.

## Non-goals

- Reconstructing what the user actually did.
- Creating a schedule for the previous calendar date.
- Changing future-day or morning planning semantics beyond the shared local-day boundary.
- Schema, migration, worker, or public HTTP contract changes.

## Decisions and assumptions

- “Backlog for the previous day” is interpreted from the screenshot and request as the elapsed portion of the current local day. Those rows remain visibly imagined.
- `revision_window.mode` gains `initial_day`; `remaining_day` applies to current-day non-morning revisions only when a prior schedule exists.
- Initial-day validation requires at least one activity for which `start_at <= now < end_at`.
- The provider receives the exact next-local-midnight boundary; overflow remains a hard validation failure rather than silently changing model-selected times.

## Discoveries

- `src/storage/context.ts` and `src/domain/planner.ts` independently derive remaining-day behavior from date/trigger alone; both must include prior-schedule existence to stay consistent.
- `src/integrations/openai.ts` explicitly tells the model to leave elapsed time blank when no saved schedule exists.

## Delegation map

- `twin_explorer/trace_first_day`: read-only trace of planning context, provider contract, validator, and tests; no write scope; reports exact failure path and edge risks.
- Main coordinating agent: exclusive ownership of all edits, integration, plan status, and verification.

## Implementation slices

1. **Initial-day contract — Done**
   - Owner: Main coordinating agent
   - Dependencies: Explorer trace
   - Write scope: `src/storage/context.ts`, `src/domain/planner.ts`, `src/integrations/openai.ts`
   - Change: Add initial-day context, permit earlier imagined activities only without a previous current-day schedule, require current coverage, and expose local-midnight boundary.
   - Data or interface impact: Internal provider context only.
   - Verification: Context and planner unit tests.

2. **Regression coverage and documentation — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `test/context.test.ts`, `test/planning.test.ts`, `README.md`, this plan
   - Change: Replace the old first-late-day blank-history expectation with backlog/current coverage and document the behavior.
   - Verification: Focused tests and documentation review.

3. **Integrated verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: Narrow fixes in the files above only
   - Change: Run `$twin-verify`, inspect the combined diff, and exercise Schedule/Home at desktop and phone widths without another live provider call.
   - Verification: Commands and manual flows below.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts`
- `npm run verify`
- Manual late-day flow with mocked or already-saved output: Schedule shows imagined earlier rows; Home resolves the activity spanning now; no row crosses local midnight.

## Verification results

- `node --test test/context.test.ts test/planning.test.ts`: 22 passed, 0 failed.
- `npm run verify`: syntax, TypeScript, lint, formatting, and tests passed; 60 tests passed,
  0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated empty
  `TEST_DATABASE_URL` was supplied.
- Live onboarding generation was not exercised because it would use the user's OpenAI credential
  and make a paid provider call. Mocked planner tests cover the late-day backlog, current-time
  requirement, local-midnight rejection, and preservation of an existing valid schedule.

## Progress

- 2026-10-26: Traced the late-night failure and created this execution plan.
- 2026-10-26: Implemented the initial-day contract, added success and failure regressions, updated
  the README, and completed the local verification gate.

## Risks and recovery

- Risk: Backfilled simulation is mistaken for real history.
  - Safeguard: Preserve imagined labels and never convert generated rows into user reports or memory.
- Risk: Provider still proposes a cross-midnight activity.
  - Safeguard: Give it the explicit boundary and retain hard validation; keep any existing day unchanged on failure.
- Risk: Initial-day relaxation leaks into later revisions.
  - Safeguard: Gate it on the absence of a prior schedule and retain existing remaining-day regression tests.

## Done when

- First creation can include earlier imagined activities for today.
- The first saved day always contains an activity covering the request's current timestamp.
- Activities cannot cross the next local midnight.
- Later same-day revisions still cannot rewrite elapsed history.
- Relevant focused checks and `npm run verify` pass, with unavailable live-provider checks reported honestly.
