# Allow multiple experiments during planner iteration

Status: Complete

Owner: Main coordinating agent

## Goal

Allow a valid Twin day to be created when the planner marks several activities as experiments.

## Context and evidence

- Product direction previously preferred at most one small habit experiment.
- The validator converted that preference into a hard failure for the entire day.
- A live onboarding proposal marked multiple activities as experiments and was rejected even though
  this label did not make the schedule structurally unsafe.

## Constraints

- Preserve `is_experiment` on every activity for UI meaning and future planner redesign.
- Preserve Calendar authority, overlap checks, local-day boundaries, current-time coverage, owner
  scope, protected history, and immutable version behavior.
- Do not make a paid provider call during implementation or verification.

## In scope

- Remove the numerical experiment limit.
- Tell the provider that zero or more activities may be experiments when grounded and useful.
- Add regression coverage for a day containing several experiments.

## Non-goals

- Redesigning how a full day is generated.
- Removing experiment labels or weakening other schedule validation.
- Editing the broader product-direction document before that redesign.

## Decisions and assumptions

- The user's direct instruction temporarily overrides the one-experiment preference in
  `docs/product-direction.md`.
- Experiments remain imagined activities, not factual memories or claims about actual behavior.

## Discoveries

- The limit exists only as one validator check; the schema already supports an experiment flag on
  every activity.

## Delegation map

- Decision: Keep this small, tightly coupled provider-contract and validator change in the main
  thread.

## Implementation slices

1. **Relax experiment count — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `src/domain/planner.ts`, `src/integrations/openai.ts`
   - Change: Remove the hard count rejection and make the provider contract plural.
   - Data or interface impact: No schema or public API change.
   - Verification: Planner unit test.

2. **Regression and full verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `test/planning.test.ts`, this plan
   - Change: Prove multiple experiment flags save successfully and run `$twin-verify`.
   - Data or interface impact: None.
   - Verification: `node --test test/planning.test.ts`, then `npm run verify`.

## Final verification

- `node --test test/planning.test.ts`
- `npm run verify`

## Verification results

- `node --test test/planning.test.ts`: 21 passed, 0 failed.
- `npm run verify`: syntax, TypeScript, lint, formatting, and tests passed; 63 tests passed,
  0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated empty
  `TEST_DATABASE_URL` was supplied.
- No live provider call was made.

## Progress

- 2026-10-26: User explicitly overrode the one-experiment preference for the current planner and
  requested that it no longer block day creation.
- 2026-10-26: Removed the numerical limit, clarified the provider contract, added a three-experiment
  regression, and completed local verification.

## Risks and recovery

- Risk: Too many activities are framed as experiments.
  - Safeguard: Keep grounding, reason, source, overlap, and maximum-activity validation; revisit
    experiment presentation during the planned day-generation redesign.

## Done when

- Multiple experiment activities no longer prevent a valid day from being saved.
- Other planner validation remains unchanged.
- Focused and full local checks pass.
