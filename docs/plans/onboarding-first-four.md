# First four onboarding screens

Status: Done

Owner: Implementing agent

## Goal

Integrate the supplied Name → ChatGPT → Import → Avatar onboarding module as the
pre-app first-run experience, including recovery after local-account deletion, while
preserving the existing PostgreSQL, import, planner, provider, worker, and persistent
product surfaces.

## Context and evidence

- `docs/references/onboarding/` supplies the visual and interaction reference only.
- The existing browser onboarding combined prompt and import in one screen and assumed
  the fixed local user, settings, model connection, and avatar design already existed.
- Account deletion removed those required records, so `/api/bootstrap` returned a
  settings-not-found error and a restarted server rejected the empty database.
- The existing import endpoint already provides whole-payload validation, duplicate
  protection, atomic memory application, and initial twin-day generation.
- The existing avatar endpoints already provide private upload, generation jobs,
  polling, failure state, retry, and explicit baseline approval.

## Constraints

- Remain a loopback-only, single-user local prototype; do not add authentication or a
  second identity system.
- Do not add or change database tables, import schemas, memory precedence, planner
  behavior, retention, upload limits, provider-key handling, or worker architecture.
- Do not seed demo memories, events, schedules, or image assets for a clean profile.
- Keep imported/model text untrusted and keep provider credentials server-side.
- Do not seed, import, delete, deploy, publish, commit, or push user data/work.
- Preserve Home, Schedule, Settings, Talk, and unrelated worktree changes.

## In scope

- Minimal idempotent local-profile initialization using the existing fixed development
  identity and existing record collections.
- Four responsive, keyboard-accessible onboarding screens matching the supplied visual
  reference.
- Name persistence, exact revised prompt, current import contract, real avatar workflow,
  skip/failure/retry/approval states, and handoff to Home.
- Regression coverage and documentation for clean first run and post-deletion recovery.

## Non-goals

- Secure sign-up, phone/password verification, multi-user identity, schema changes, a
  fifth Connections screen, full transcript/original JSON archiving, larger uploads,
  selective source downloads, or live provider testing.

## Decisions and assumptions

- Add one idempotent `/api/profile/initialize` endpoint that creates only the minimum
  records needed by the current single-user architecture. Persist the entered name
  through the existing settings update endpoint.
- Represent new integration records as `live` + `disconnected`, not demo or connected.
- Do not queue a twin day for pre-onboarding name/settings changes; the current import
  endpoint creates the first day after a successful handoff.
- Keep the existing backend completion semantic (successful import completes
  onboarding). Preserve the Avatar screen across same-browser reloads with temporary
  local step state; approval or skip clears that state.
- If no OpenAI key is configured, explain the limitation and allow Avatar to be skipped;
  never present reference artwork as generated output.

## Discoveries

- Server startup previously treated a correctly migrated but empty database as an error.
- Avatar generation cannot run for a newly deleted/recreated profile until the user adds
  a new key; the supplied fourth screen therefore needs a truthful finish-later path.
- Port 4173 was temporarily occupied during an earlier visual-check attempt; no second
  worker was started successfully.
- Account deletion filtered every collection by `user_id`, but user rows are keyed by
  `id`. This left an orphan user after deleting the profile. Initialization then treated
  that orphan as a complete profile and did not recreate settings, causing the Name
  screen to dereference `settings.version` from `null`.

## Delegation map

- Decision: Keep implementation in the main thread because deletion, initialization,
  regression coverage, and targeted cleanup share one tightly coupled lifecycle.
- Evidence: A completed read-only `twin_explorer` trace identified the orphan-user path;
  it had no write scope and the main thread independently reconciled the source evidence.

## Implementation slices

1. **Reference and behavior trace — Done**
   - Change: Extract and inspect the supplied instructions, prompt, fragment, and preview;
     trace bootstrap, settings, import, deletion, avatar, and worker behavior.
   - Data or interface impact: None.
   - Verification: Compare implementation requirements with current route contracts.

2. **Clean local-profile lifecycle — Done**
   - Change: Make bootstrap empty-state safe, add idempotent minimal initialization, allow
     migrated empty-database startup, and avoid pre-import schedule jobs.
   - Data or interface impact: New `/api/profile/initialize`; no schema changes.
   - Verification: API test covers empty bootstrap, initialization, idempotent resume,
     no demo records/jobs, import, and deletion back to empty bootstrap.

3. **Four-screen browser flow — Done**
   - Change: Add scoped onboarding styles, revised prompt asset, four screens, temporary
     resume state, readable import errors, and real avatar state/actions.
   - Data or interface impact: Browser-only transient state; no credentials or raw
     provider calls in the browser.
   - Verification: Syntax check plus desktop/phone browser walkthrough, including input,
     navigation, malformed JSON, import success, avatar skip, and keyboard focus.

4. **Documentation and regression coverage — Done**
   - Change: Update run/database guidance and add focused API regression coverage.
   - Data or interface impact: Documents clean onboarding versus optional demo seed.
   - Verification: Focused Node test suite.

5. **Full repository verification and review — Done**
   - Change: Review the diff against `code_review.md`, repair only scoped defects, run
     `npm run verify`, and record unavailable credential/database checks accurately.
   - Data or interface impact: Narrow fixes only.
   - Verification: Exact checks below plus manual desktop and phone flow.

6. **Deletion and orphan recovery repair — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Existing minimal initialization and account-deletion routes.
   - Write scope: `src/storage/store.ts`, `src/api/router.ts`, `test/router.test.ts`, and
     this plan.
   - Change: Delete the fixed local user by `id`, rebuild missing profile scaffold records
     idempotently when an orphan user exists, and guard the browser contract with API-level
     recovery tests.
   - Data or interface impact: No schema or endpoint changes; corrects lifecycle behavior.
   - Verification: In-memory delete → zero owned records → initialize → name update, plus
     partial orphan repair and full repository verification.

7. **Authorized local database cleanup — Done**
   - Owner: Main coordinating agent.
   - Dependencies: User's explicit authorization to remove the previous local user and
     all of its data; repaired deletion lifecycle.
   - Write scope: Current application PostgreSQL records for the fixed local identity only.
   - Change: Resolve the configured application database without printing credentials,
     inspect counts, and atomically remove the previous local user so the database contains
     zero users. Do not alter `.env`, assets unrelated to that user, source JSON, schema, or
     database volume.
   - Data or interface impact: Destructive removal of the explicitly authorized previous
     local profile and its owned records.
   - Verification: Read back `twin.users` and all owned collection counts as zero.

## Final verification

- `npm run verify`
- `npm run test:postgres` only if `TEST_DATABASE_URL` is confirmed to target a dedicated
  empty disposable database.
- Browser: Name validation and creation; prompt display/copy/open affordances; back/next;
  pasted/file JSON; malformed and duplicate handling; import-to-Avatar; upload preview;
  no-key skip; generation pending/failure/retry/approval where mockable; final Home
  handoff; deletion-to-onboarding recovery.
- Browser viewports: desktop and narrow phone; visible focus and reduced-motion styles.

## Verification results

- `node --check` for server, worker, router, store, and browser app: passed.
- `node node_modules/typescript/bin/tsc -p tsconfig.json`: passed.
- `node node_modules/eslint/bin/eslint.js --max-warnings=0 src test public/app.js eslint.config.js`: passed.
- `node node_modules/prettier/bin/prettier.cjs --check ...`: passed.
- `node --test test/*.test.ts`: 16 passed, 1 skipped PostgreSQL integration, 0 failed.
- The `npm run verify` wrapper could not execute under the managed sandbox's executable
  policy, so its exact underlying syntax, typecheck, lint, formatting, and test commands
  were run directly with the repository's documented `OPENSSL_CONF=/dev/null` workaround.
- Isolated browser walkthrough passed at 1440 × 900 and 390 × 844: Name validation,
  ChatGPT instructions, malformed and valid import, retained input, no-key skip, avatar
  pending/failure/candidate/approval states, Home handoff, no horizontal overflow, visible
  keyboard focus, and reduced-motion behavior.
- Live provider generation was not called. PostgreSQL integration was not run because no
  dedicated empty `TEST_DATABASE_URL` was confirmed.
- Focused router verification passed 6 of 6 tests, including delete → zero collections →
  recreate → name update and repair of an existing orphan user.
- The configured application database was inspected without printing its connection
  string. It contained exactly one orphan `user_demo` row and zero records in every other
  Twin collection. The authorized targeted transaction removed that row; a post-commit
  read confirmed zero rows in all 19 record collections and `twin.idempotency`.
- The running loopback app was opened read-only after cleanup and rendered the empty Name
  onboarding screen. No profile was created during that browser check.

## Progress

- 2026-10-26: Reference inspected; lifecycle, UI, docs, and focused regression test
  implemented.
- 2026-10-26: Browser walkthrough and repository checks completed; a singular/plural
  success-copy defect found during verification was repaired and rechecked.
- 2026-10-26: Reopened after the delete → recreate failure was reproduced. User explicitly
  authorized removal of the previous local user and requested zero users in the application
  database; deletion/orphan repair started.
- 2026-10-26: Corrected user-row deletion and idempotent orphan recovery, added regression
  coverage, removed the sole authorized orphan row, confirmed a completely empty application
  database, and completed the available verification gate.

## Risks and recovery

- Risk: Import marks onboarding complete before Avatar finishes.
  Safeguard or rollback: Temporary browser step state keeps Avatar resumable on the same
  device; backend completion semantics remain unchanged as required.
- Risk: Minimal profile records accidentally resemble live connections or sample data.
  Safeguard or rollback: Integration records are explicitly disconnected and tests assert
  no facts, cues, calendar events, twin days, or avatar assets are created.
- Risk: Existing uncommitted changes overlap these files.
  Safeguard or rollback: Limit repairs to the onboarding slice and do not reset or replace
  unrelated work.

## Done when

- A migrated empty database and a post-deletion database both render Name onboarding.
- The four supplied screens function end to end using current backend services.
- No demo data or unsupported storage/provider behavior is introduced.
- Home, Schedule, Settings, and Talk retain their existing route/component behavior.
- Relevant automated and manual checks pass, with unavailable live/PostgreSQL checks
  reported rather than claimed.
