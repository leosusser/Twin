# Single active day version

Status: Complete

Owner: Main coordinating agent

## Goal

When a new version is created for a user and local date, make it the only active version shown on
Home and Schedule while retaining older versions as superseded history.

## Context and evidence

- Planning currently marks only the one context-selected previous version as superseded.
- Shared reads choose the highest version without requiring `status === "ready"`.
- The user selected active-version replacement, not deleting history or discarding protected
  activities.

## Constraints

- Preserve protected activities through the existing server-owned preservation rule.
- Keep historical versions for provenance and recovery; do not delete records.
- Scope replacement by both user and local date.
- Preserve atomic save behavior and stale-input protection.

## In scope

- Supersede every older version for the same owner/date in the new-version transaction.
- Select only ready versions for planning context, Home, Schedule, and onboarding gates.
- Add regression coverage for sole-active selection and owner/date isolation.

## Non-goals

- Deleting historical day versions.
- Allowing the model to discard protected activities.
- Changing database schema or public response shapes.

## Decisions and assumptions

- “Replace active version” means one ready version per user/date; superseded rows remain stored.
- The newest version becomes active only after validation succeeds in the atomic save transaction.

## Discoveries

- `latestDay` currently sorts all statuses, so a higher-numbered superseded record could be shown.
- `selectPlanningContext` has the same status-independent lookup.

## Delegation map

- Decision: Keep this small, shared-state change in the main thread.

## Implementation slices

1. **Atomic active-version replacement — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `src/services/day-planning.ts`, `src/storage/context.ts`
   - Change: Supersede every same-owner/date version and plan only from the ready version.
   - Data or interface impact: Status semantics only; no schema change.
   - Verification: Planning regression tests.

2. **Read-path enforcement — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/api/router.ts`, relevant tests
   - Change: Home, Schedule, and onboarding select only ready day versions.
   - Data or interface impact: Superseded versions are never returned as active.
   - Verification: Router regression tests.

3. **Integrated verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: README and this plan only if needed
   - Change: Document active/superseded behavior and run `$twin-verify`.
   - Data or interface impact: None.
   - Verification: Commands below.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts test/router.test.ts`
- `npm run verify`

## Verification results

- `node --test test/context.test.ts test/planning.test.ts test/router.test.ts`: 36 passed,
  0 failed after correcting one pre-existing date-sensitive morning-worker test fixture.
- `npm run verify`: syntax, TypeScript, lint, formatting, and tests passed; 66 tests passed,
  0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated empty
  `TEST_DATABASE_URL` was supplied.
- No live provider call or application-data mutation was performed.

## Progress

- 2026-10-27: User selected active-version replacement with protected activities retained.
- 2026-10-27: Enforced one ready version per owner/date at save and read time, documented the
  behavior, added isolation/read regressions, and completed local verification.

## Risks and recovery

- Risk: Another user's or date's version is superseded.
  - Safeguard: Match both `user_id` and `local_date`; cover isolation in tests.
- Risk: No ready version exists after a failed generation.
  - Safeguard: Superseding occurs only after validation and inside the same transaction that inserts
    the new ready version.

## Done when

- Exactly one ready day exists per owner/date after a successful update.
- Home, Schedule, onboarding, and subsequent planning ignore superseded versions.
- Older versions remain stored and linked by parent ID.
- Focused and full verification pass.
