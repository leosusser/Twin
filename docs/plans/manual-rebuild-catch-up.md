# Manual rebuild catch-up

Status: Done

Owner: Main coordinating agent

## Goal

Make a manual rebuild for today use a dedicated actual-report field as evidence about what happened, replace unprotected simulated history so the schedule catches up to now, and use a separate instruction field to replan the future.

## Context and evidence

Today’s existing `remaining_day` mode currently preserves every activity ending before the captured current time and rejects every newly proposed activity before the next minute. That is correct for automatic and instruction-free revisions, but it contradicts the intended manual catch-up behavior when the user supplies an account of the real day.

## Constraints

- Direct user reports outrank prior imagined activity.
- Locked, user-edited, report-backed, and Calendar-backed activities retain their exact intervals.
- Calendar remains a real commitment and does not prove attendance.
- New elapsed activities derived from the manual text must cite the saved manual report and display as report-informed, not as unsupported fact.
- The report and replacement day must save atomically and remain owner-scoped and idempotent.
- A future-date instruction is planning guidance, not a report about actual activity.
- No live provider call, application-database mutation, deployment, commit, or push is authorized.

## In scope

- Add a `catch_up` revision mode for a manual rebuild of today with nonempty text.
- Add a manual-rebuild activity report as bounded model context and an allowed citation.
- Permit replacement of unprotected elapsed simulated activity only in catch-up mode.
- Require replacement elapsed activity to cite the manual report.
- Require the catch-up result to cover the captured current instant and replan future flexible time.
- Save the report and replacement day in the same transaction.
- Separate the actual-report and future-instruction inputs in the UI, API, service, and provider contract.
- Add context, service, validation, API/UI, and conflict-path regression coverage.

## Non-goals

- Editing a past local date.
- Moving Calendar commitments or protected activity.
- Treating instruction-free automatic revisions as reports.
- Inferring that a Calendar event or prior simulated activity actually happened.

## Decisions and assumptions

- A nonempty **What happened so far** entry for today is an explicit user report.
- **What should change next** is optional planning guidance and must never be stored or rendered as activity the user actually did.
- The saved report uses a generic activity key because one entry may describe several elapsed activities; individual planned activities carry the report citation.
- The report is persisted only when a replacement schedule validates and saves.
- Instruction-free rebuilds retain the existing remaining-day preservation behavior.

## Discoveries

- `selectPlanningContext` currently exposes `remaining_day` for every non-morning revision of today and adds all elapsed activity IDs to the preserve list.
- `validatePlannerOutput` independently enforces the same elapsed boundary, so both context and validation must agree on the new mode.
- Activity reports are stored as owner-scoped JSONB payloads, so adding an optional message reference and a new source value requires no SQL migration.
- Independent review found that combining actual history and future direction would mislabel the future instruction as reported activity, that current coverage needed to cite the new report itself, and that catch-up must also work before any prior day exists. The implementation now separates the inputs and enforces both cases.

## Delegation map

- Decision: The context, validator, transaction, prompt, UI copy, and tests form one tightly coupled trust-sensitive slice, so the main agent will implement it without delegation.

## Implementation slices

1. **Represent catch-up evidence — Done**
   - Owner: Main coordinating agent
   - Dependencies: Existing activity-report and idempotency contracts
   - Write scope: `src/domain/types.ts`, `src/storage/context.ts`, `src/services/day-planning.ts`
   - Change: Create bounded manual report evidence, expose catch-up mode, and atomically save report plus day.
   - Data or interface impact: Activity reports accept a manual-rebuild source and optional Talk-message reference; no database schema change.
   - Verification: Context and planning-service tests.
2. **Validate catch-up scheduling — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/domain/planner.ts`, `src/integrations/openai.ts`
   - Change: Allow unprotected elapsed replacement in catch-up mode, require report citations for elapsed replacements, preserve protected intervals, and require current coverage.
   - Data or interface impact: Internal planning-context contract adds `catch_up`.
   - Verification: Success and missing-citation failure tests.
3. **Clarify user flow and documentation — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1 and 2
   - Write scope: `public/app.js`, `README.md`, relevant tests, this plan
   - Change: Explain that today’s text catches up actual history and then changes the future; retain future-date instruction semantics.
   - Data or interface impact: UI copy only.
   - Verification: UI contract test and full verification.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts test/router.test.ts test/ui.test.ts`
- `npm run verify`
- Review against `code_review.md`, especially owner scope, atomicity, idempotency, and actual-versus-imagined labeling.

## Verification results

- Focused context, planning, API, and UI suite: 49 passed, 0 failed.
- Full repository-equivalent gate (syntax, TypeScript, ESLint, Prettier, and all tests): 75 passed, 0 failed, 1 PostgreSQL integration test skipped because no dedicated `TEST_DATABASE_URL` was supplied.
- Desktop (1280×900) and narrow-phone (390×844) browser inspection: both fields and the submit control were visible, keyboard focus reached the actual-report field, and neither viewport had horizontal overflow.
- Independent trust review: no remaining High or Medium findings after correcting the separate input boundary, current-report citation requirement, first-day catch-up path, and one test-property typo.
- `npm run verify` could not launch because the sandbox denied the `npm` executable; the exact commands behind that script were run directly from the installed toolchain and passed.

## Progress

- 2026-10-27: Traced the reported error to duplicated elapsed-history protection in planning context and validation; plan created.
- 2026-10-27: Implemented catch-up evidence, atomic replacement, separated actual/future inputs, first-day support, regression coverage, review repairs, and final verification.

## Risks and recovery

- Risk: A future-only sentence could be misclassified as actual history.
- Safeguard or rollback: UI copy explicitly asks for what happened so far; only elapsed activities citing the report are labeled report-informed, while future activities remain ordinary planning output.
- Risk: A failed provider call could leave an orphaned report.
- Safeguard or rollback: Persist the manual report only in the same successful transaction as the validated replacement day.
- Risk: Catch-up could overwrite direct edits or commitments.
- Safeguard or rollback: The existing hard-protection set remains authoritative and exact.

## Done when

- Today’s rebuild with text can replace unprotected elapsed simulated activity and no longer raises `PLANNER_REWROTE_ELAPSED_HISTORY` for properly report-cited catch-up activity.
- Protected activity remains exact.
- The saved catch-up schedule covers now and future flexible activity can change.
- Manual evidence and the new active day save atomically and idempotent replay does not duplicate either.
- Future-date and instruction-free rebuild semantics remain unchanged.
- Relevant focused tests and `npm run verify` pass, with unavailable checks reported.
