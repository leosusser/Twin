# Canonical Calendar commitment times

Status: Complete

Owner: Main coordinating agent

## Goal

Allow day creation to succeed when the model rounds a fixed Calendar commitment while retaining
the Calendar event's exact saved start and end timestamps.

## Context and evidence

- The current validator rejects any Calendar-backed proposed activity whose derived timestamps do
  not exactly match the cited event.
- The local prototype Calendar contains classes ending one minute before a conventional boundary,
  such as 10:15–11:44 (89 minutes). The model rounded one of these to 90 minutes, producing the
  visible `PLANNER_MOVED_COMMITMENT` failure.
- The failed proposal did not change the existing day or the Calendar record.

## Constraints

- Calendar remains a real commitment and the authoritative source of its timing.
- Never change imported Calendar records to accommodate model output.
- Keep overlap, local-day, ownership, citation, and later-revision protections intact.
- Do not make an additional paid provider call during implementation or verification.

## In scope

- Canonicalize a proposed activity to the exact bounds of its cited fixed timed commitment.
- Reject one activity that cites fixed commitments with different time ranges.
- Clarify the provider contract and add success/failure regression coverage.

## Non-goals

- Editing Calendar events or changing Calendar synchronization.
- Guessing attendance or turning Calendar plans into reported activity.
- Repairing unrelated malformed model fields.

## Decisions and assumptions

- The model continues to choose the activity presentation, but fixed-event timing comes only from
  the saved Calendar event.
- Multiple fixed event citations on one activity are accepted only if their exact bounds match.
- Canonicalization happens before local-day and overlap validation, so repaired times cannot bypass
  schedule integrity checks.

## Discoveries

- The affected local events have exact 89-minute durations; the model schema already permits any
  whole-minute duration, but the prompt did not emphasize irregular durations.

## Delegation map

- Decision: Keep this tightly coupled validator, prompt, and test change in the main thread.

## Implementation slices

1. **Canonical timing — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `src/domain/planner.ts`, `src/integrations/openai.ts`
   - Change: Replace model timing with one authoritative fixed-event interval and reject conflicting
     fixed intervals.
   - Data or interface impact: None; validation behavior only.
   - Verification: Planner unit tests.

2. **Regression coverage and verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `test/planning.test.ts`, this plan
   - Change: Cover rounded 89-minute repair and incompatible multi-event citations; run
     `$twin-verify`.
   - Data or interface impact: None.
   - Verification: Focused planner test and `npm run verify`.

## Final verification

- `node --test test/planning.test.ts`
- `npm run verify`
- Confirm the saved event records remain unchanged after planner validation.

## Verification results

- `node --test test/planning.test.ts`: 20 passed, 0 failed.
- `npm run verify`: syntax, TypeScript, lint, formatting, and tests passed; 62 tests passed,
  0 failed, and the opt-in PostgreSQL integration test was skipped because no dedicated empty
  `TEST_DATABASE_URL` was supplied.
- Read-only inspection confirmed the application Calendar records retain their original 89-minute
  intervals. No live OpenAI call was made.

## Progress

- 2026-10-26: Confirmed exact 89-minute Calendar intervals caused model rounding to fail strict
  validation; created this plan.
- 2026-10-26: Canonicalized cited fixed-event bounds, added incompatible-citation protection and
  regression tests, and completed the local verification gate.

## Risks and recovery

- Risk: Canonical repair creates an overlap with another proposed activity.
  - Safeguard: Existing overlap validation runs after canonicalization and rejects the whole output.
- Risk: One activity cites unrelated fixed events.
  - Safeguard: Require all cited fixed events to share identical bounds.

## Done when

- A rounded model proposal saves with the exact Calendar interval.
- Calendar records are not modified.
- Conflicting fixed-event citations and resulting overlaps fail safely.
- Focused and full verification pass, with unavailable live checks reported.
