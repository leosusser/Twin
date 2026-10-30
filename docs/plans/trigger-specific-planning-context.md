# Trigger-specific planning context and server-owned preservation

Status: Complete

Owner: Main coordinating agent

## Goal

Give each day-planning trigger only its intended supplemental input and prevent harmless model ID
mistakes from blocking day creation or protected-history preservation.

## Context and evidence

- Imported JSON is normalized into owner-scoped PostgreSQL facts before planning. The planner should
  consume those facts, not the raw file.
- Model-facing memory currently exposes both canonical fact `id` and import `source_id`, which can
  cause `PLANNER_UNKNOWN_SOURCE` when the model cites the wrong field.
- Manual rebuild currently receives recent Talk messages even without a conversation trigger.
- Protected activity IDs are calculated server-side but the model must repeat them; omission causes
  `PLANNER_PROTECTED_ACTIVITY` and rejects the whole day.

## Constraints

- Imported text, manual instructions, transcripts, and model output remain untrusted data.
- Keep memory, Calendar, reports, conversations, activities, and saves owner-scoped.
- Preserve elapsed, locked, edited, report-backed, and Calendar-backed activities exactly.
- Keep Calendar commitments and imagined Twin activity semantically distinct.
- No schema, migration, or public HTTP contract change.

## In scope

- First-day planning uses planner rules plus normalized SQL memory; Calendar remains available as
  real commitment context when present.
- Manual rebuild includes only its text-box instruction as conversation-like input.
- Talk-triggered planning includes only the triggering conversation transcript.
- Remove import `source_id` from model-facing memory.
- Union server-required protected IDs into preservation regardless of model output.

## Non-goals

- Reading the original imported JSON during planning.
- Redesigning the entire day-generation algorithm.
- Weakening overlap, date-boundary, stale-input, owner, or Calendar validation.

## Decisions and assumptions

- “Planner.ts and the JSON after it becomes SQL” means deterministic planner rules plus normalized
  active facts selected from PostgreSQL.
- Calendar remains included because it is a real commitment source, not transcript or imported
  profile prose.
- Unknown model-requested preserve IDs are ignored; server-required protected IDs remain mandatory
  and automatic.

## Discoveries

- `selectPlanningContext` includes the most recent messages from every conversation whenever
  `conversationId` is absent, including manual and onboarding runs.
- The server already computes the exact protected activity IDs in `revision_window`; validation can
  safely use that same rule without model cooperation.

## Delegation map

- Decision: Keep the tightly coupled context, validator, prompt, and tests in the main thread.

## Implementation slices

1. **Trigger-specific context — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `src/storage/context.ts`, `src/integrations/openai.ts`
   - Change: Hide import source IDs and include transcript only for `after_conversation` with its
     conversation ID; clarify trigger contracts.
   - Data or interface impact: Internal provider context only.
   - Verification: Context unit tests.

2. **Server-owned protected history — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/domain/planner.ts`, `test/planning.test.ts`
   - Change: Normalize requested preserve IDs and automatically union protected activity IDs.
   - Data or interface impact: No schema or public API change.
   - Verification: Planner success and exact-preservation tests.

3. **Integrated verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: Tests, README, and this plan only if needed
   - Change: Run focused checks and `$twin-verify`.
   - Data or interface impact: None.
   - Verification: Commands below.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts`
- `npm run verify`

## Verification results

- `node --test test/context.test.ts test/planning.test.ts`: 26 passed, 0 failed.
- `npm run verify`: syntax, TypeScript, lint, formatting, and tests passed; 64 tests passed,
  0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated empty
  `TEST_DATABASE_URL` was supplied.
- No live provider call was made. Automated tests observed the exact initial/manual/Talk context
  boundaries and server-owned protected-history behavior.

## Progress

- 2026-10-27: Confirmed desired trigger boundaries and created implementation plan.
- 2026-10-27: Removed model-facing import source IDs, separated manual and Talk inputs, made
  protected preservation server-owned, documented the behavior, and completed local verification.

## Risks and recovery

- Risk: Talk context leaks into manual planning.
  - Safeguard: Require `trigger === "after_conversation"` and an exact conversation ID.
- Risk: Automatic preservation creates overlap with a new flexible proposal.
  - Safeguard: Existing overlap validation still rejects the new proposal while retaining the saved
    day.
- Risk: Removing `source_id` loses provenance.
  - Safeguard: Provenance stays in PostgreSQL; only the model-facing DTO omits the misleading alias.

## Done when

- First day sees normalized owner memory without import source IDs.
- Manual rebuild sees its instruction but no Talk transcript.
- Talk planning sees only the triggering transcript.
- Protected activities survive even if the model omits preserve IDs.
- Focused and full verification pass.
