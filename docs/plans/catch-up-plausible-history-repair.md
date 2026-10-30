# Catch-up plausible history and repair retry

Status: Done

Owner: Main coordinating agent

## Goal

Allow a manual catch-up to build a coherent, realistic-looking past when the user's report leaves gaps, while keeping guessed activity visibly distinct from reported actual activity and retrying one invalid planner proposal with targeted correction feedback.

## Context and evidence

Catch-up validation currently requires every non-Calendar activity beginning before now, including the current activity, to cite the new manual report. The live planner can reasonably fill an unspecified gap but omit that citation; the server then rejects the entire day with `PLANNER_CATCH_UP_SOURCE_REQUIRED`.

## Constraints

- A guessed past activity is illustrative Twin activity, never a user-reported fact.
- Only an activity that cites the report may be labeled report-informed.
- Guessed elapsed/current activity must use `possible` confidence and no report citation.
- Calendar, locked, user-edited, and prior report-backed intervals remain exact.
- The report and successful replacement day remain owner-scoped, atomic, and idempotent.
- Retry at most once per planning request and only after server validation rejects model output; do not retry provider, credential, or stale-input failures.
- No live provider call, application-database mutation, deployment, commit, or push is authorized for verification.

## In scope

- Relax catch-up validation to allow explicitly possible, uncited imagined activity in elapsed gaps and at the current instant.
- Continue deriving report-backed labels only from exact report citations.
- Add one bounded correction retry containing a server-controlled validation code/message.
- Update the planner contract, user-facing explanation, documentation, and regression coverage.

## Non-goals

- Claiming a guessed activity actually occurred.
- Automatically adding a report citation to unsupported model output.
- Repeated or unbounded paid retries.
- Changing automatic remaining-day preservation or Calendar semantics.

## Decisions and assumptions

- “Close to realistic” means a plausible illustrative schedule grounded in supplied memory, Calendar, and report context; it does not mean factual reconstruction.
- The first proposal is discarded after validation failure. A single fresh proposal receives only the safe validation feedback and the same bounded context.
- A current activity is required in catch-up mode, but it may be either report-supported or explicitly possible/imagined.

## Discoveries

- Source labels are derived server-side from validated citation arrays, so an uncited possible activity already renders without the report-informed badge.
- Provider calls occur outside the storage transaction, and the report is persisted only with a successful day, so a correction retry does not create an orphan report.
- A live rebuild exposed a contract contradiction: catch-up validation allowed only the newly entered report, but the planner context still included and allowlisted older reports. The model could therefore follow the supplied allowlist and still be rejected by the validator.

## Delegation map

- Decision: The validator, retry contract, prompt, and tests are one tightly coupled trust-sensitive slice; the main coordinating agent will implement it without delegation.

## Implementation slices

1. **Represent correction feedback — Done**
   - Owner: Main coordinating agent
   - Dependencies: Existing bounded `PlanningContext`
   - Write scope: `src/storage/context.ts`, `src/integrations/openai.ts`, `src/services/day-planning.ts`
   - Change: Add optional server-controlled repair feedback and retry one validation failure.
   - Data or interface impact: Internal planner context only; no API or database schema change.
   - Verification: Planning-service retry test.
2. **Permit clearly imagined catch-up gaps — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: `src/domain/planner.ts`, planning tests
   - Change: Accept possible uncited elapsed/current activity, reject unsupported grounded claims, and retain current-time coverage.
   - Data or interface impact: Catch-up validation semantics only.
   - Verification: Possible-gap success, grounded-gap failure, and protected-history regressions.
3. **Align explanations and documentation — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1 and 2
   - Write scope: `public/app.js`, `README.md`, UI tests, this plan
   - Change: Explain that unspecified past gaps may be filled as imagined estimates and that invalid proposals receive one correction attempt.
   - Data or interface impact: Copy only.
   - Verification: UI contract test and browser inspection.
4. **Align catch-up report context with validation — Done**
   - Owner: Main coordinating agent
   - Dependencies: Existing catch-up contract
   - Write scope: `src/storage/context.ts`, `src/services/day-planning.ts`, focused tests, this plan
   - Change: Keep older reports stored but expose only the report entered for this catch-up as citeable planner evidence; classify an exhausted correction attempt as invalid generated output rather than a transient provider outage.
   - Data or interface impact: Internal bounded context and error semantics only; no API shape or database schema change.
   - Verification: Context allowlist, two-attempt planning failure, successful repair, and UI error-copy regressions.

## Final verification

- `node --test test/context.test.ts test/planning.test.ts test/router.test.ts test/ui.test.ts`
- Exact underlying commands for `npm run verify` if the sandbox continues to block the `npm` launcher.
- Desktop and narrow-phone inspection of the rebuild explanation and source labels.
- Review against `code_review.md` for provenance, paid retry bounds, idempotency, atomicity, and actual-versus-imagined labeling.

## Verification results

- Focused context, planning, API, and UI suite: 50 passed, 0 failed.
- Full repository-equivalent gate (syntax, TypeScript, ESLint, Prettier, and all tests): 77 passed, 0 failed, 1 PostgreSQL integration test skipped because no dedicated `TEST_DATABASE_URL` was supplied.
- Desktop 1280×900 and narrow-phone 390×844 browser inspection: estimate copy and both fields were visible, the actual-report field accepted focus, and neither viewport had horizontal overflow.
- Independent trust review initially found that unrelated reports could incorrectly ground guessed history and that retry scope covered other planner modes. Both were corrected: reconstructed elapsed activity may use only the current catch-up report, and the single validation retry is catch-up-only.
- Final re-review confirmed mixed current-plus-prior report citations are rejected, non-catch-up validation failure makes one provider call, and no High or Medium finding remains.
- No live provider request or application-database mutation was used for verification.
- Live-recurrence regression: focused context/planning/UI suite passed 40/40. The full local-equivalent gate passed syntax, TypeScript, ESLint, Prettier, and 78/78 runnable tests; the PostgreSQL integration test remained skipped because no dedicated `TEST_DATABASE_URL` was supplied.
- Browser inspection for the final error-copy change was unavailable because the local UI-control runtime exited on an environment-owned OpenSSL configuration error. Static UI coverage passed, and no live OpenAI request was made.

## Progress

- 2026-10-27: Mapped the live error to the all-elapsed-activity report-citation rule and recorded the trust-preserving retry design.
- 2026-10-27: Implemented possible imagined gaps and one correction retry; repaired independent-review findings, completed focused/full checks, and verified responsive UI copy.
- 2026-10-27: Reopened after a live rebuild showed older report IDs were still advertised as valid catch-up citations despite the stricter validator; implementing a single-source catch-up context and clearer exhausted-retry error.
- 2026-10-27: Limited catch-up report context and its citation allowlist to the newly entered report, retained older reports in storage, clarified exhausted validation errors, and completed the focused and full local gates.

## Risks and recovery

- Risk: Guessed history could appear factual.
- Safeguard or rollback: Only exact report citations produce report provenance; uncited catch-up estimates require `possible` confidence and remain illustrated as Twin planning.
- Risk: Validation retry could double provider cost.
- Safeguard or rollback: Retry exactly once, only for model validation failure, and reuse the same idempotent request claim.
- Risk: A retry could save against changed input.
- Safeguard or rollback: Existing input-revision recheck remains immediately before atomic save.

## Done when

- A vague report can produce a day containing possible imagined elapsed/current gap activity without the citation error.
- Unsupported elapsed/current activity marked grounded is rejected.
- One invalid proposal receives one correction retry, and a second invalid proposal leaves the existing day unchanged.
- Report-backed and imagined activities remain visibly distinct.
- Focused and full checks pass, with unavailable live-provider and PostgreSQL checks reported.
