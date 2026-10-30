# Repair flexible schedule output

Status: Done

Owner: Main coordinating agent

## Goal

Allow a Twin day to be created when model-generated, flexible imagined activities overlap or extend beyond the target local day, without moving protected history or real Calendar commitments.

## Context and evidence

The planner currently rejects the complete proposal when any two activities overlap or any proposed activity ends after local midnight. The UI therefore keeps the old day and shows a retry message even when the invalid interval belongs only to a flexible imagined activity. Earlier day-creation blockers for source IDs, Calendar time rounding, experiment count, initial-day backlog/current coverage, trigger context, and active-version replacement have already been addressed in the current worktree.

## Constraints

- Calendar commitments, elapsed history, locked activities, direct user edits, and report-backed activity keep their exact intervals.
- Model output is untrusted; ownership, source citation, date, and interval validation remain enforced.
- A repair may trim or omit only flexible imagined activity.
- A saved day must remain non-overlapping and initial-day output must still cover the captured current instant.
- No live provider call, database mutation, deployment, commit, or push is authorized.

## In scope

- Clip flexible activity at the target local-day boundary when at least five minutes remain.
- Fit flexible activities into non-overlapping free segments around protected and already accepted activities.
- Prefer a valid segment covering the captured current instant during first-day creation.
- Fill an otherwise open first-day current instant with a neutral imagined placeholder.
- Drop only a flexible activity with no free segment of at least five minutes.
- Deduplicate repeated exact source IDs before allowlist validation.
- Preserve hard failures for protected/protected and Calendar/Calendar overlaps.
- Update provider guidance, documentation, and regression tests.

## Non-goals

- Moving or clipping a real Calendar commitment.
- Rewriting elapsed, locked, edited, or reported activity.
- Accepting unknown citations, invalid owners, or stale planning inputs.
- Adding provider retries or changing the database schema.

## Decisions and assumptions

- The server, not the model, is authoritative for interval safety.
- Flexible activities are considered in proposed start order; earlier accepted activity wins, except that first-day activities whose original intervals cover the captured current instant are considered first.
- A five-minute segment is the minimum useful repair because the existing activity contract already has a five-minute minimum.
- Protected overlaps remain visible as validation failures rather than being silently changed.

## Discoveries

- `validatePlannerOutput` currently rejects the entire schedule after parsing, even when only two flexible proposed activities overlap.
- Exact Calendar times are already canonicalized before overlap validation, so they can be marked fixed during repair.
- Initial-day current-time coverage is checked after overlap validation and must remain true after normalization.

## Delegation map

- Decision: The change is tightly coupled within planner validation, its prompt, tests, and documentation, so the main agent will implement it without delegation.

## Implementation slices

1. **Normalize flexible intervals — Done**
   - Owner: Main coordinating agent
   - Dependencies: Existing planner validation and canonical Calendar handling
   - Write scope: `src/domain/planner.ts`
   - Change: Clip flexible end-of-day overflow and fit flexible activity into remaining free segments while treating preserved and fixed Calendar activity as immutable.
   - Data or interface impact: No API or persistence schema change; accepted activity times may be safely shortened.
   - Verification: Focused planner tests for flexible overlap, protected precedence, midnight clipping, and protected overlap rejection.
2. **Align contract and documentation — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/integrations/openai.ts`, `README.md`
   - Change: Explain server repair behavior and the remaining hard boundaries.
   - Data or interface impact: Provider instructions only.
   - Verification: Typecheck, lint, and documentation review.
3. **Regression and final verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1 and 2
   - Write scope: `test/planning.test.ts`, this plan
   - Change: Add failure/conflict-path coverage, run the repository verification workflow, and record observed results.
   - Data or interface impact: None.
   - Verification: `node --test test/planning.test.ts` and `npm run verify`.

## Final verification

- `node --test test/planning.test.ts`
- `npm run verify`
- Review the repair against `code_review.md` and confirm protected/Calendar intervals cannot be changed.

## Verification results

- `node --test test/planning.test.ts`: 23 passed, 0 failed, 0 skipped.
- `npm run verify`: syntax, typecheck, lint, formatting, and tests passed; 68 tests passed, 0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated `TEST_DATABASE_URL` was used.
- Review against `code_review.md`: no unresolved findings. Owner scope, source allowlists, stale-input protection, idempotency, atomic version replacement, and secret handling are unchanged. Protected and fixed Calendar intervals are explicitly immutable in the repair path.

## Progress

- 2026-10-27: Plan created after reproducing the strict overlap rejection in planner validation.
- 2026-10-27: Flexible overlap, local-midnight overflow, current-gap, and duplicate-citation repairs implemented and verified; plan completed.

## Risks and recovery

- Risk: Repair could silently distort a real commitment.
- Safeguard or rollback: Only server-created IDs for flexible proposed activities are eligible; preserved and fixed Calendar IDs are immutable and their mutual conflicts still fail.
- Risk: Trimming could remove the initial activity covering now.
- Safeguard or rollback: Current-covering candidates receive priority and final current-time validation remains enforced.

## Done when

- Flexible overlaps no longer prevent creation of an otherwise valid day.
- Flexible overflow is clipped to local midnight or omitted when less than five minutes remains.
- Protected and fixed Calendar intervals remain exact, and conflicting immutable intervals still reject the proposal.
- Initial-day output still covers the captured current instant after repair.
- Relevant tests and the full repository verification pass, with unavailable checks reported.
