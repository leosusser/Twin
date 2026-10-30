# AI day-planning agent

Status: Remaining-day rebuild semantics implemented and locally verified; live-provider verification remains unavailable

Owner: Main coordinating agent

## Goal

Replace production fixed-time Twin-day generation with one model-backed, grounded, version-safe planning service used by morning, completed-conversation, and manual rebuild triggers.

## Context and evidence

- `src/domain/planner.ts` currently creates a fixed schedule and merely annotates Calendar overlaps.
- `src/integrations/openai.ts` already calls the Responses API for Talk with the user's encrypted server-side key; there is no in-app voice model or ephemeral voice token.
- `src/worker.ts` provides durable jobs, leases, retry/backoff, and the only worker process, but it has no recurring job producer and does not consume the saved `wake_time` or `tomorrow_generation_time`.
- `src/storage/context.ts` and the PostgreSQL adapter already provide bounded Talk retrieval; planning needs a separate bounded DTO that retains source IDs, authority, certainty, Calendar availability, current-day version, recent messages, reports, and corrections.
- Schedule is currently read-only. There is no activity edit/lock API, feedback record, no-change result, unresolved-conflict type, or manual rebuild route.
- The working tree contains substantial pre-existing changes. Preserve them and avoid unrelated cleanup.

## Constraints

- PostgreSQL remains the sole record store; use existing JSONB records and the existing single worker, without a second worker or new infrastructure.
- Provider calls stay server-side and reuse the saved encrypted OpenAI key. Never expose secrets or provider context to the browser.
- Imported text, Calendar content, recent conversation, manual instructions, and model output are untrusted data.
- Do not add Gmail to planner context, modify Calendar, write simulated activities to memory, or add a generic fallback schedule.
- Every read/write, source reference, job key, and persisted activity remains user-scoped.
- Provider I/O must occur outside the database transaction. Compare the exact bounded-input fingerprint before saving.
- Preserve prior valid schedules on missing credentials, provider failure, invalid output, or stale results.

## In scope

- Structured OpenAI planner call using the exact supplied system prompt.
- Shared planning service, bounded grounded context, strict validation/materialization, input fingerprinting, and atomic version save.
- `morning`, `after_conversation`, and `manual` triggers.
- Settings-page rebuild control with optional instruction and accessible busy/success/error states.
- Calendar availability/staleness and free/busy interpretation in planner context.
- Tests, configuration documentation, and verification.

## Non-goals

- A new schedule editor/lock UI, a feedback persistence feature, Gmail planning context, Calendar writes, authentication/multi-tenancy work, deployment, or live credential calls.
- Replacing the existing Talk or image model selections.

## Decisions and assumptions

- Planner model precedence is the first non-empty `OPENAI_PLANNER_MODEL`, then the first non-empty `OPENAI_TEXT_MODEL`, then `gpt-5.6-luna`. Talk continues to use only `OPENAI_TEXT_MODEL`; image generation remains unchanged.
- Morning planning uses the existing saved `wake_time` as its configured morning time. `tomorrow_generation_time` remains compatible but is not repurposed silently.
- A same-day revision is a new immutable version. The prior version remains stored; validation requires elapsed, locked, and explicitly user-edited activities to be reproduced exactly. This is the narrow reconciliation between the explicit remaining-day request and the prior stable-day product rule.
- For a same-day manual or after-conversation revision, completed activities remain exact backlog. A flexible activity spanning the rebuild instant may remain whole or be clipped at that instant, and only the next-minute boundary onward may be newly planned. If no saved day exists, elapsed time stays blank. Calendar-backed, locked, user-edited, and report-backed activities remain whole regardless of timing.
- Because no schedule lock/edit route exists, optional protection metadata is added for compatibility and enforced whenever present; this change does not invent an editor.
- Fresh onboarding without an OpenAI key does not generate a fixed fallback. It reports that a key is required; the morning producer or manual button can plan after a key is saved.
- The existing deterministic generator is retained only as an explicitly named demo fixture builder for seed/test data, never as production fallback.
- Calendar freshness is represented to the model. Morning planning attempts the existing Calendar sync path first when live data is stale; any refresh failure is labeled and the last valid schedule remains protected.

## Discoveries

- Talk is one completed `/v1/responses` call, not a stream; the correct planning hook is the final assistant/report transaction.
- `memoryStatus` is currently always `unchanged`; there is no Talk memory extraction to redesign.
- Existing revision counters are insufficient for stale detection, so the service needs a deterministic hash of the exact bounded inputs plus credential/settings/base-day revisions.
- Job dedupe currently ignores completed jobs, and save/job completion are separate transactions. Planning must persist an idempotent run result with the schedule save.
- Google Calendar normalization stores cancellation and all-day bounds but not transparency/free-busy; add minimal availability metadata.
- A live manual rebuild exposed an ambiguous citation contract: model-facing memory includes both the internal fact `id` accepted by validation and the provenance `source_id`, but the structured-output schema did not state which one citation fields must use. The strict validator correctly rejected the result and preserved the existing day.

## Delegation map

- `twin_explorer/planning_backend_trace`: read-only `README.md`, planning/storage/worker/Calendar/API/tests; no writes; reported data contracts, concurrency, time-zone, and test gaps.
- `twin_explorer/planning_openai_ui_trace`: read-only OpenAI/Talk/context/Schedule/UI/tests; no writes; reported exact model/key flow and best conversation/UI hooks.
- `twin_builder/planning_ui`: after backend route/response contract is fixed, exclusive write ownership of `public/app.js` and `public/mockup-pages.css`; implement the manual form/states without changing backend files; return changed paths and syntax check.
- Main coordinating agent: exclusive ownership of all backend, test, documentation, plan, integration, and final verification changes.

## Implementation slices

1. **Contracts, context, and validation — Complete**
   - Owner: Main coordinating agent
   - Dependencies: Explorer reports reconciled.
   - Write scope: `src/domain/types.ts`, `src/domain/time.ts`, `src/domain/planner.ts`, `src/storage/context.ts`, `src/integrations/google.ts`, focused tests.
   - Change: Add trigger/conflict/protection/version metadata, bounded source-preserving planning context, Calendar availability, and strict no-change/schedule output validation.
   - Data or interface impact: Optional JSON fields only; no new collection or migration.
   - Verification: Domain/context tests cover allowed types, dates/time zones, durations, overlaps, commitment conflicts, source IDs, protected history, and Calendar state distinctions.

2. **Provider and shared planning service — Complete**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1.
   - Write scope: `src/integrations/openai.ts`, new `src/services/day-planning.ts`, `test/planning.test.ts`.
   - Change: Add exact planner prompt, structured Responses output, model precedence, encrypted-key reuse, idempotent claim, bounded provider call, input recheck, atomic save/no-change, and typed failures.
   - Data or interface impact: Internal service result contract; persisted planner metadata on new day versions.
   - Verification: Mocked provider tests for update/no-change/provider/invalid/stale/duplicate/owner paths.

3. **Trigger routing and worker scheduling — Complete**
   - Owner: Main coordinating agent
   - Dependencies: Slice 2.
   - Write scope: `src/api/router.ts`, `src/worker.ts`, `src/storage/store.ts`, router/worker tests.
   - Change: Remove production fixed generation, enqueue after a saved Talk completion, add manual route, produce once-per-local-day morning jobs at `wake_time`, and route all three values through the shared service. Correct worker store injection and planner retry typing.
   - Data or interface impact: `POST /api/twin-days/rebuild`; planning job payload/result metadata; import status becomes queued/key-required instead of falsely ready.
   - Verification: Trigger routing, once-per-day/DST, manual idempotency, Talk replay, failure retention, and retry-bound tests.

4. **Settings controls — Complete**
   - Owner: `twin_builder/planning_ui`
   - Dependencies: Manual API request `{ local_date, instruction? }`; response `{ status, trigger, day?, message }`; errors use existing envelope.
   - Write scope: `public/app.js`, `public/mockup-pages.css` only.
   - Change: Inline optional instruction, rebuild button, immediate duplicate prevention, and accessible loading/success/actionable error states; preserve the rendered day until success.
   - Data or interface impact: Browser-only state; no credentials/provider calls.
   - Verification: `node --check public/app.js`; manual desktop/narrow UI flow.

5. **Documentation, integration, and final verification — Complete with noted skips**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–4.
   - Write scope: `.env.example`, `README.md`, this plan, narrow repairs found by verification.
   - Change: Document models/precedence, credentials, triggers, button flow, Calendar state, no-fallback behavior, and scheduler/runtime requirements.
   - Data or interface impact: Configuration adds optional `OPENAI_PLANNER_MODEL`.
   - Verification: Focused tests, full `npm run verify`, review against `code_review.md`, and credential-dependent skips reported accurately.

6. **Citation contract repair — Complete**
   - Owner: Main coordinating agent
   - Dependencies: Existing bounded context and strict source validator.
   - Write scope: `src/storage/context.ts`, `src/integrations/openai.ts`, `public/app.js`, focused tests, and this plan.
   - Change: Supply explicit per-kind citation-ID allowlists, describe exact accepted IDs in the structured output contract, keep provenance IDs available but clearly forbidden as citations, and avoid duplicating the unchanged-schedule message in the browser.
   - Data or interface impact: Internal model context only; no API, database, credential, or persistence changes.
   - Verification: Context and route tests assert the allowlist and trusted citation instructions; existing unknown-source validation remains strict; full `npm run verify`.

7. **Remaining-day rebuild semantics — Complete**
   - Owner: Main coordinating agent
   - Dependencies: Existing shared planning service and immutable schedule versions.
   - Write scope: `src/domain/time.ts`, `src/domain/planner.ts`, `src/storage/context.ts`, `src/integrations/openai.ts`, focused tests, and this plan.
   - Change: Expose an explicit next-minute revision boundary and required protected IDs; preserve completed backlog; allow the model to keep or truncate one flexible in-progress activity; reject all newly invented elapsed activities; reconsider only flexible future activities.
   - Data or interface impact: Internal model context and instructions only; no browser API, database schema, credentials, or integrations change.
   - Verification: Focused tests cover a first late-day build, completed backlog, an in-progress flexible activity, protected future items, retrospective rejection, and full existing regression gates.

## Final verification

- `node --test test/planning.test.ts test/context.test.ts test/router.test.ts`
- `npm run verify`
- `npm run test:postgres` only if `TEST_DATABASE_URL` is confirmed as a dedicated empty database.
- Manual Settings flow at desktop and narrow-phone widths: optional instruction, busy/disabled duplicate prevention, success/no-change, actionable provider error, keyboard focus, and current-schedule retention on failure.
- Inspect the combined diff against `code_review.md`, including secret redaction, source ownership, version races, retries, and trust labels.

## Verification results

- `npm run verify`: passed on 2026-10-26; 44 tests passed, 0 failed, and the PostgreSQL integration test skipped because no dedicated `TEST_DATABASE_URL` was configured.
- Focused planning/context/router suite: 25 tests passed, including no-change, protected history, retrospective-insertion rejection, future-date routing, Calendar overflow, invalid output, stale-result protection, trigger routing, and manual idempotency.
- `node --check public/app.js`, TypeScript, ESLint, and Prettier checks passed through the full gate.
- Live OpenAI and Google calls were not run; no credential-dependent success is claimed.
- Browser control was unavailable: the native controller exited on the machine's inaccessible system OpenSSL configuration and the integrated page API returned empty snapshots. Desktop/narrow visual QA remains unobserved.
- PostgreSQL integration remains unrun until `TEST_DATABASE_URL` points to a dedicated empty database.
- Citation-contract focused suite: 25 tests passed, covering bounded context allowlists, exact provider instructions/schema descriptions, strict invalid-source rejection, manual routing, and existing schedule protections.
- Post-repair `npm run verify`: passed on 2026-10-26; 44 tests passed, 0 failed, and the opt-in PostgreSQL integration test remained skipped.
- Remaining-day focused planning/context/router suite: 28 tests passed, covering a first late-day build, next-minute boundary, completed backlog, truncation of flexible in-progress activity, replacement of later flexible plans, protected items, and retrospective rejection.
- Post-semantics `npm run verify`: passed on 2026-10-26; 47 tests passed, 0 failed, and the opt-in PostgreSQL integration test remained skipped because no dedicated `TEST_DATABASE_URL` was configured.

## Progress

- 2026-10-26: Read canonical guidance, repository docs, storage guide, source, tests, and current dirty status.
- 2026-10-26: Completed and reconciled two read-only explorer traces; fixed model/key, trigger, context, concurrency, and UI interfaces.
- 2026-10-26: Recorded product-rule reconciliation and started contracts/context/validation.
- 2026-10-26: Completed the shared AI planning service, all three triggers, bounded Calendar/memory context, validation and stale-result safeguards, Settings manual control, documentation, and mocked regression coverage.
- 2026-10-26: Moved **Rebuild my day** from Schedule to Settings at user direction; Schedule remains a read-only simulation surface and now displays unresolved Calendar conflicts.
- 2026-10-26: Reconciled final review findings by rejecting retrospective insertions, routing explicit future conversation dates, prioritizing fixed commitments with overflow fail-safe behavior, and binding idempotency keys to request input.
- 2026-10-26: Repaired the live unknown-source failure by adding exact per-kind citation allowlists and structured-output descriptions while retaining strict validation; deduplicated the browser's unchanged-schedule error copy.
- 2026-10-26: Implemented the confirmed remaining-day behavior: late first builds leave elapsed time blank; existing completed activities remain backlog; an unprotected in-progress activity can end at rebuild time; and only the next-minute boundary onward can be regenerated.

## Risks and recovery

- Risk: a stale model response overwrites a user edit or newer plan.
  - Safeguard: hash exact bounded inputs, compare inside the save transaction, and return/retry a typed stale result without superseding.
- Risk: Calendar is empty, stale, or unavailable but represented as equivalent.
  - Safeguard: explicit context status and last-successful-sync metadata; no invented events.
- Risk: duplicate paid calls or competing morning versions.
  - Safeguard: user-scoped durable trigger keys, active-run claims, stored completed results, and bounded worker attempts.
- Risk: invalid or adversarial model output becomes stored application state.
  - Safeguard: strict schema plus ordinary backend validation and server-assigned IDs/ownership.
- Risk: no API key during onboarding.
  - Safeguard: retain existing valid day/no day, report key-required status, and never substitute deterministic production output.

## Done when

- A valid mocked model proposal—not fixed backend slots—determines activities, times, durations, and smallest future revisions.
- All three explicit triggers call one service and are idempotent/version-safe.
- Grounded bounded context contains required source metadata and distinguishes Calendar states without Gmail.
- Invalid/provider/stale results leave the previous valid schedule untouched.
- Manual Settings rebuild has optional instruction and complete UI states.
- Focused and full checks pass, or unavailable credential/database/manual checks are reported precisely.
