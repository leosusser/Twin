# Onboarding OpenAI connection and first day

Status: Implemented and locally verified; live-provider and manual visual verification remain unavailable

Owner: Main coordinating agent

## Goal

Make the existing pre-app onboarding collect and validate the user's OpenAI API key, then create the Twin's schedule for the remaining local day before the optional avatar step and entry into Home.

## Context and evidence

- The current five-part experience is implemented as four browser screens in `public/app.js`: name, ChatGPT handoff, JSON import, and avatar.
- The JSON import currently marks `settings.onboarding_complete` immediately, even though no key or Twin day exists.
- Existing server routes already encrypt/save and test the OpenAI key and run the shared manual day planner. The browser never needs the raw key after submission.
- Remaining-day planning already leaves elapsed time blank, preserves existing protected history, and generates only from the next-minute boundary onward.

## Constraints

- Reuse `PUT /api/settings/openai-key`, `POST /api/settings/openai-key/test`, and `POST /api/twin-days/rebuild`.
- Keep credentials server-side and encrypted; never place the key in browser persistence, logs, URLs, or response DTOs.
- Do not create a fallback day if key validation or planning fails.
- Preserve the optional avatar flow and all existing application routes.
- Existing users whose onboarding is already complete must not be forced back through setup.

## In scope

- A dedicated OpenAI onboarding screen after memory import.
- Save, live-test, and use the key to build today's remaining schedule with visible busy, success, and actionable error states.
- A guarded onboarding-completion route that requires an imported profile, saved OpenAI key, and current local-day schedule.
- Focused route and frontend contract tests plus documentation.

## Non-goals

- New model configuration, credentials, schema, integrations, background workers, or a Calendar onboarding step.
- Live provider verification by the coding agent.

## Decisions and assumptions

- The order becomes Name → ChatGPT → Import → OpenAI + first day → Avatar.
- The OpenAI step is required. The avatar remains optional.
- The key is saved, tested, and then the shared planner is called with trigger `manual`; transient or invalid output keeps the user on the same step and preserves any existing day.
- Onboarding becomes complete only when the user finishes after the server can verify an import, encrypted key, and current local-day schedule.

## Discoveries

- `applyHandoff` currently sets `onboarding_complete`; that must stop for incomplete profiles while leaving already-complete profiles unchanged.
- Browser local storage alone is insufficient to protect the onboarding boundary after refresh, so completion needs a server-side guard.

## Delegation map

- Decision: Keep this tightly coupled UI/API lifecycle in the main thread; parallel writers would overlap the same onboarding state and contracts.

## Implementation slices

1. **Completion boundary — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `src/domain/imports.ts`, `src/api/router.ts`, route tests
   - Change: Keep onboarding incomplete after first import and add a guarded, idempotent completion endpoint.
   - Data or interface impact: One new internal onboarding route; no schema change.
   - Verification: Route tests cover missing import/key/day and successful completion.

2. **OpenAI and first-day onboarding screen — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1 and existing key/planner routes
   - Write scope: `public/app.js`, `public/onboarding.css`
   - Change: Add the fifth screen, protected password submission, connection test, immediate remaining-day planning, retry states, and progression to avatar.
   - Data or interface impact: Browser flow only; raw key remains only in the submitted request body.
   - Verification: Syntax/static contract checks and manual state review.

3. **Documentation and verification — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: `README.md`, this plan, narrow fixes
   - Change: Document the five-screen flow and first-day behavior.
   - Verification: Focused tests, `npm run verify`, and review against `code_review.md` through `$twin-verify`.

## Final verification

- `node --test test/router.test.ts test/planning.test.ts`
- `node --check public/app.js`
- `npm run verify`
- Manual flow: import → key submit/test → current-day plan → optional avatar → Home, including invalid key and planning failure states.

## Verification results

- Focused route/planning checks: 24 tests passed, 0 failed.
- Focused onboarding UI/route contract checks: 10 tests passed, 0 failed.
- Final `npm run verify`: passed with 49 tests passed, 0 failed, and the opt-in PostgreSQL integration test skipped because no dedicated `TEST_DATABASE_URL` was configured.
- Live OpenAI calls were not run; no live key, paid provider call, or credential-dependent success is claimed.
- Browser visual verification of a destructive fresh-profile flow was not run against the user's existing application data.

## Progress

- 2026-10-26: Traced import completion, key storage/testing, manual planning, bootstrap resume, and avatar progression; recorded the implementation boundary.
- 2026-10-26: Added guarded server completion, the required OpenAI + first-day screen, encrypted key reuse, immediate remaining-day planning, retry/error states, five-step progress and resume behavior, documentation, and focused regression coverage.

## Risks and recovery

- Risk: A refresh bypasses the key step.
  - Safeguard: Keep server-side onboarding incomplete until guarded completion.
- Risk: A failed provider call strands or erases the current day.
  - Safeguard: Reuse the planning service's failure retention and show retry on the same screen.
- Risk: Repeated clicks create paid duplicate calls.
  - Safeguard: Disable submission while busy and reuse one request idempotency key per attempt.

## Done when

- A fresh profile cannot complete onboarding without an import, encrypted OpenAI key, and valid current-local-date Twin day.
- Entering a valid key in onboarding uses the existing encrypted credential and shared planner to create the remaining day.
- Invalid/provider/planner failures remain actionable and never fabricate success or remove a valid schedule.
- Existing completed profiles and the optional avatar flow continue to work.
