# Live Google Calendar integration

Status: Done

Owner: Main coordinating agent

## Goal

Make Google Calendar a real, consented, read-only integration: a user can connect through
Google OAuth, automatically perform an initial sync, choose calendars, refresh changes,
disconnect cleanly, and prevent stale or unselected events from continuing to influence
Twin.

## Context and evidence

- The repository already has owner-bound OAuth state, encrypted refresh-token storage,
  Calendar event retrieval, per-calendar incremental cursors, worker jobs, and Calendar-aware
  planning.
- The current callback does not queue an initial sync, the browser has no calendar chooser,
  discovery is not paginated, and Calendar has no automated provider or route coverage.
- Reconnect, deselection, and disconnect retain prior selections/cursors/events. An in-flight
  sync can also write them back after consent is removed.
- The configured local environment currently has an encryption key and redirect URI, but no
  `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET`. Live provider verification is therefore not
  currently available.

## Constraints

- Remain loopback-only and single-user; do not add authentication, hosted infrastructure, or
  broader Google scopes.
- Use only `calendar.readonly`. Calendar entries are real commitments, not claims about what
  the user did.
- Keep refresh tokens server-side, encrypted at rest, absent from browser DTOs and logs.
- Preserve today's displayed Twin-day version. Calendar changes may queue a future version.
- Do not edit `.env`, create Google Cloud credentials, use live credentials, deploy, commit,
  or push without separate explicit authorization.
- Do not touch Gmail behavior except where shared OAuth helpers require compatible handling.
- Preserve existing user changes and the current clean application database.

## In scope

- Hardened Calendar OAuth initiation/callback, including PKCE, provider timeouts, denial and
  revoked-token handling, one-time state, clean reconnect, and automatic initial sync.
- Paginated calendar discovery, preserved selection, event pagination, incremental sync, and
  correct full replacement after a missing/expired cursor.
- Consent-safe selection/disconnect and an in-flight credential-generation guard.
- Settings UI states, calendar chooser, actionable failures, and sync-status polling.
- Mock provider/API/worker regression coverage and exact local Google Cloud setup guidance.

## Non-goals

- Gmail feature expansion, write access to Calendar, event creation/editing, webhooks,
  production OAuth verification, multi-user support, or a live credential smoke test without
  user-provided credentials.

## Decisions and assumptions

- Add an optional numeric credential revision to existing integration JSON records; no SQL
  schema migration is needed. OAuth success and disconnect advance it, and a worker may commit
  only if its captured revision is still current.
- Reauthorization is treated as a possible account change: clear old Calendar selections,
  cursors, events, failure state, and last-sync state before queuing a fresh sync.
- Deselecting or disconnecting removes the corresponding stored Calendar events immediately.
  Reselecting starts from a full sync.
- Initial discovery selects the primary calendar; subsequent discovery preserves known choices
  and adds newly discovered calendars as unselected.
- Provider behavior will be proven with mocked HTTP responses. Live OAuth remains unavailable
  until the user configures a Google Cloud Web Application client and exact redirect URI.

## Discoveries

- Fresh profiles are `live` + `disconnected`, but Settings currently labels them Reconnect and
  allows a guaranteed-to-fail sync.
- Google 410 recovery retries but does not signal the worker to replace stale stored events.
- `.env.example` uses `localhost` while the README example uses `127.0.0.1`; Google redirect
  URIs must match exactly.
- Independent review found that credential-only generations were insufficient: calendar
  selection is also a consent generation, stale job failures need the same generation guard as
  successful commits, and expired worker locks must be reclaimed after a restart.

## Delegation map

- `twin_explorer/trace_google_calendar`: read-only end-to-end behavior trace; no write scope;
  returned functional blockers, minimum slice, and test matrix.
- `twin_explorer/audit_google_oauth`: read-only OAuth/security/readiness audit; no write scope;
  returned consent, race, error-mapping, and acceptance evidence.
- `twin_reviewer/review_google_calendar`: read-only final review; found selection, future-day,
  stale-failure, and expired-lock gaps that were fixed and covered before handoff.
- Implementation decision: keep source and test edits in the main thread because the OAuth,
  worker, provider, UI, and tests share one evolving contract.

## Implementation slices

1. **Provider and OAuth contract — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Existing encryption and integration records.
   - Write scope: `src/domain/types.ts`, `src/integrations/google.ts`, `src/api/router.ts`.
   - Change: PKCE/state consumption, timeout/error mapping, clean reconnect, automatic initial
     job, connection prerequisites, paginated discovery, and full-sync metadata.
   - Data or interface impact: Optional credential revision and richer safe Calendar status;
     no schema change or secret exposure.
   - Verification: Provider and router tests for connect/callback/errors/replay/initial job.

2. **Worker reconciliation and consent boundaries — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 1 result contract.
   - Write scope: `src/worker.ts`, `src/api/router.ts`.
   - Change: Replace per-calendar event sets on full sync, reject stale worker commits, remove
     deselected/disconnected events and cursors, and clear failure state on success.
   - Data or interface impact: Stored events reflect only currently selected, connected
     calendars; future-day generation is queued after sync, selection, reconnect, and
     disconnect while today's displayed version remains unchanged.
   - Verification: Worker/route tests for 410, selection, disconnect, stale commits, stale
     failures, and expired job-lock recovery.

3. **Settings Calendar controls — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slices 1–2 API behavior.
   - Write scope: `public/app.js`, existing Settings CSS only if needed.
   - Change: Truthful Setup/Reconnect/Sync states, calendar checkboxes, selection save, and
     bounded status polling that rerenders until connected or failed.
   - Data or interface impact: Browser receives only safe integration metadata.
   - Verification: Desktop/narrow-phone flow with mocked APIs; keyboard and error states.

4. **Regression coverage and setup documentation — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Final contracts from prior slices.
   - Write scope: `test/google.test.ts`, `test/router.test.ts`, focused worker test support,
     `.env.example`, `README.md`, and this plan.
   - Change: Calendar/provider/OAuth lifecycle tests and exact Google Cloud setup instructions
     using one canonical loopback hostname.
   - Data or interface impact: Documentation only beyond tests.
   - Verification: Focused tests followed by the complete repository gate.

## Final verification

- `npm run verify`
- `npm run test:postgres` only if `TEST_DATABASE_URL` is a confirmed separate empty database.
- Mocked provider flows: discovery pagination, multi-page events, incremental cursor, 410 full
  replacement, cancellation, revoked token, OAuth denial/replay, reconnect, selection, and
  disconnect/in-flight safety.
- Browser: disconnected, connecting return, syncing, connected chooser, failure/reconnect, and
  disconnect at desktop and narrow-phone widths with keyboard focus and reduced motion.
- Live Google OAuth smoke test only if the user supplies authorized credentials and explicitly
  authorizes the provider call.

## Verification results

- `node --check` passed for the API router and worker.
- TypeScript passed with `tsc --noEmit`.
- ESLint passed with zero warnings.
- The repository's scoped Prettier check passed. A broader ad-hoc `prettier --check .` also
  inspected reference-only onboarding HTML and reported two pre-existing reference formatting
  warnings; those reference assets were not modified.
- Full in-memory test suite: 26 tests, 25 passed, 1 PostgreSQL test skipped, 0 failed.
- Focused Calendar/router suite: 15 passed, 0 failed.
- Isolated browser fixture covered connected selection, disconnected, syncing, and failed
  states at desktop and 390-pixel widths without horizontal overflow. The temporary fixture was
  removed after inspection.
- `npm run verify` itself is unavailable under the managed sandbox because launching `npm` is
  denied. Its exact underlying syntax, type, lint, format, and test commands were run directly.
- PostgreSQL integration was not run because no dedicated `TEST_DATABASE_URL` is configured.
- Live Google OAuth and Calendar calls were not run because this environment has no Google
  client ID or secret. The mocked provider path passed, but does not prove external Google Cloud
  configuration.

## Progress

- 2026-10-26: Existing Calendar/OAuth/UI/worker path traced by two bounded read-only explorers;
  blockers reconciled and implementation plan created.
- 2026-10-26: Implemented PKCE OAuth, automatic initial sync, paginated provider retrieval,
  consent-safe reconciliation, calendar selection UI, status polling, setup documentation, and
  mocked lifecycle coverage.
- 2026-10-26: Independent review exposed three additional race/recovery paths. Selection now
  advances the integration generation, future regeneration is queued when Calendar influence is
  removed, stale failures cannot overwrite a reconnect, and expired running jobs are reclaimed.
- 2026-10-26: Final local verification passed with the external-credential and dedicated-
  PostgreSQL limitations recorded above.

## Risks and recovery

- Risk: Reauthorization mixes events from a previously connected Google account.
  Safeguard or rollback: Clear Calendar-derived state before the new initial sync and guard
  commits by credential revision.
- Risk: Selection/disconnect changes remove user-authorized local Calendar context.
  Safeguard or rollback: This is intentional consent behavior; Google remains the source and a
  later reselect performs a full read-only sync.
- Risk: Provider pagination or 410 handling partially replaces data.
  Safeguard or rollback: Fetch completely before one atomic store transaction; retain current
  state when provider retrieval fails.
- Risk: No live credentials are available for final smoke testing.
  Safeguard or rollback: Report live verification unavailable and provide exact setup steps;
  never claim the mock path proves external account configuration.

## Done when

- Configured Connect completes OAuth once, stores only an encrypted refresh token, and queues
  the first Calendar sync without another click.
- Selected calendars and their current/cancelled events sync incrementally and survive reload.
- Deselect, disconnect, and reconnect cannot leave or resurrect stale Calendar influence.
- Settings shows accurate status, calendars, failures, and sync completion.
- Mocked regression coverage passes, today's displayed Twin day stays immutable, and setup docs
  are sufficient to configure the unavailable external credentials safely.
