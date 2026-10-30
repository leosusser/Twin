# Manual day rebuild v2

Status: Done

Owner: Main coordinating agent

## Goal

Make **Rebuild my day** reliably return one coherent full-day view: reported actual history for elapsed time, clearly labeled AI estimates for unexplained past gaps, and a newly planned future from the current instant onward.

## Context and evidence

The current catch-up path asks one model result to preserve older protected activities, represent Calendar commitments, reconstruct elapsed time from a new report, and plan the future. The single-lane schedule validator then rejects any overlap between items it considers immutable. A live rebuild failed twice with `PLANNER_ACTIVITY_OVERLAP` because protected and/or Calendar-backed items occupied the same interval.

This is not merely a prompt-quality issue. Elapsed Calendar events are plans rather than proof of attendance, while the current validator treats them like future fixed commitments. Older report-backed schedule items are also preserved even when the new manual report is intended to reconstruct the whole elapsed day. Those contracts conflict with the user-confirmed rebuild semantics.

## Constraints

- Calendar is a real commitment but never proves attendance.
- The new direct report is the highest-authority source for what actually happened during this rebuild.
- AI-estimated elapsed gaps must remain visibly `possible` and must not carry report provenance.
- Locked and directly edited activities remain authoritative.
- Future fixed Calendar commitments remain fixed; conflicts are disclosed rather than silently moved.
- The model still chooses activities, timing, and duration. Server code validates and normalizes source/conflict representation but does not generate a fallback schedule.
- Reports and replacement days remain owner-scoped, atomic, idempotent, and stale-result protected.
- No schema redesign, live provider call, application-database mutation, deployment, commit, or push is authorized.

## In scope

- Redefine manual catch-up as a full-day replacement composed of report-grounded elapsed history, possible elapsed estimates, and future planning.
- Treat the newly entered report as comprehensive authority for elapsed reconstruction.
- Stop treating elapsed Calendar-only activities as proof of actual history.
- Preserve future Calendar commitments and direct locks/edits.
- Convert representational Calendar/protected overlaps into explicit unresolved conflicts when one single-lane item must be omitted, while retaining hard failures for contradictory user-authoritative activities.
- Align planner instructions, context preservation, validation, UI copy, and regression tests.

## Non-goals

- Writing anything to Google Calendar.
- Claiming an estimated gap actually occurred.
- Adding parallel schedule lanes or redesigning the Schedule page.
- Changing morning or after-conversation planning semantics.
- Editing already stored historical day versions in place.

## Decisions and assumptions

- User decision: AI reconstructs the elapsed day from the manual report.
- User decision: when elapsed Calendar plans conflict with what the user reports, show the reported actual activity instead.
- User decision: return the whole day—backlogged elapsed history plus a changed future portion.
- User decision: unexplained elapsed gaps may be filled with clearly labeled AI estimates.
- “Reported history wins” applies to Calendar-only elapsed representations. Locked and directly edited activities still outrank generated reconstruction.
- For future conflicts in a single-lane schedule, retain the highest-authority representable item and record the omitted Calendar commitment as unresolved; never move its supplied time.

## Discoveries

- `selectPlanningContext` currently preserves every locked, edited, report-backed, or Calendar-backed prior activity in catch-up mode.
- `validatePlannerOutput` marks both report-backed proposals and fixed Calendar proposals immutable, then fails before it evaluates the model's unresolved-conflict list.
- The commitment-presence check currently requires elapsed Calendar commitments during catch-up even though Calendar does not prove attendance.
- The UI already separates actual history from future guidance, so the API shape can remain compatible.

## Delegation map

- Decision: The context, prompt, validator, conflict normalization, UI wording, and tests share one trust-sensitive contract. The main coordinating agent will implement them serially without delegation.

## Implementation slices

1. **Define the rebuild-v2 context — Done**
   - Owner: Main coordinating agent
   - Dependencies: Existing manual report and planning context
   - Write scope: `src/storage/context.ts`, `src/integrations/openai.ts`
   - Change: Make the new report authoritative for elapsed reconstruction, preserve only direct locks/edits from the prior day during catch-up, and distinguish elapsed Calendar context from future fixed commitments.
   - Data or interface impact: Internal planning contract only; existing API fields remain unchanged.
   - Verification: Context tests for comprehensive report scope and protected IDs.
2. **Normalize source conflicts safely — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/domain/planner.ts`, focused planning tests
   - Change: Exclude unreported elapsed Calendar-only activities, retain future fixed commitments, and convert single-lane Calendar/protected collisions into unresolved conflicts without moving authoritative intervals.
   - Data or interface impact: Validation semantics and saved unresolved conflicts; no schema change.
   - Verification: Report-vs-elapsed-Calendar, future Calendar collision, contradictory report activity, and no-overlap success tests.
3. **Align the Settings experience — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: `public/app.js`, UI tests, README, this plan
   - Change: Explain that the report should cover what the user wants shown as actual, gaps may be estimated, and the future is rebuilt from now.
   - Data or interface impact: Copy and error guidance only.
   - Verification: Static UI contract plus desktop/narrow browser inspection when available.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts test/router.test.ts test/ui.test.ts`
- `npm run verify` or the exact underlying commands if the sandbox blocks the npm launcher.
- Review against `code_review.md` for source authority, Calendar semantics, overlap normalization, atomic persistence, idempotency, stale-result protection, and actual-versus-estimated labeling.
- No live OpenAI call; verify provider behavior with mocked proposals.

## Verification results

- Focused context/planning/router/UI suite: 54 passed, 0 failed.
- Full local-equivalent gate: syntax, TypeScript, ESLint, and Prettier passed; 81 runnable tests passed, 0 failed, and the PostgreSQL integration test was skipped because no dedicated `TEST_DATABASE_URL` was supplied.
- `npm run verify` was represented by its exact installed-tool commands because the sandbox blocks the `npm` launcher.
- Static UI coverage passed for the comprehensive report copy and elapsed `AI estimate` badge. The shared browser page reloaded but returned no readable accessibility snapshot, so desktop/narrow visual inspection is unavailable rather than claimed as passed.
- Mocked provider tests covered reported-history precedence, an ongoing elapsed Calendar plan, overlapping future Calendar commitments, correction retry, contradictory report-backed history, idempotent replay, and stale-result protection.
- No live OpenAI call, application-database mutation, deployment, commit, or push was performed.

## Progress

- 2026-10-27: Reproduced the live failure class from the screenshot, traced it to immutable overlap validation, gathered the four user decisions, and created this implementation-ready plan.
- 2026-10-27: Implemented comprehensive manual catch-up context, elapsed Calendar semantics, single-lane Calendar conflict normalization, visible estimate labels, documentation, and regression coverage; completed the focused and full local gates.
- 2026-10-27: Live testing exposed one remaining model-label mismatch. Changed elapsed catch-up confidence to derive from validated provenance: current-report citations are grounded and unsupported gaps are possible estimates, without another provider retry.

## Risks and recovery

- Risk: A Calendar commitment could disappear without explanation.
  - Safeguard: Omitted future commitments must be retained as unresolved conflicts with their exact source event IDs.
- Risk: AI-estimated backlog could look factual.
  - Safeguard: Only exact current-report citations receive report provenance; uncited elapsed gaps require `possible` confidence.
- Risk: A new report could erase a prior direct edit.
  - Safeguard: Locked and user-edited activities remain server-preserved and cannot be moved.
- Risk: Normalization could become a hidden deterministic planner.
  - Safeguard: It may only omit an unproven elapsed Calendar representation or resolve an unrepresentable immutable collision; it never invents, moves, or lengthens activities.

## Done when

- A report that conflicts with an elapsed Calendar plan produces reported history rather than a validation error.
- Unexplained elapsed gaps can appear only as visibly possible AI estimates.
- Future flexible activity is replanned from now and future fixed Calendar times remain unchanged.
- Single-lane Calendar/protected conflicts are disclosed instead of failing the whole rebuild.
- Contradictory user-authoritative overlaps still fail safely and preserve the existing day.
- Focused and full local checks pass, with unavailable live-provider, browser, and PostgreSQL checks reported accurately.
