# Avatar version carousel

Status: Done

Owner: Main coordinating agent

## Goal

Keep one large current baseline avatar visible, then present previously generated baseline candidates as a compact horizontal thumbnail carousel with clear Switch, Regenerate, and Delete actions and no misleading baseline-generation state caused by unrelated activity jobs.

## Context and evidence

- The active Avatar Studio is rendered by `characterSection` in `public/app.js` and styled in `public/mockup-pages.css`.
- The current approved baseline appears once at full size, but every value from `baseline_candidates` is then rendered as another full-size vertical candidate. The observed local Settings page currently has one approved baseline and five large candidates.
- Existing controls already support approving a candidate through `data-approve-baseline` and generating another candidate through `data-generate-baseline`.

## Constraints

- Preserve private asset URLs, generation jobs, approval behavior, and user-scoped storage.
- Do not change the separate activity-image library.
- Keep every available candidate reachable by keyboard, pointer, and horizontal scrolling.
- Preserve clear current/selected states and do not imply that selecting a thumbnail switches the saved baseline before the user activates Switch.

## In scope

- Replace the stacked full-size baseline candidates with a horizontal thumbnail strip below the large current baseline.
- Show four thumbnails at once where space allows; allow horizontal scrolling when more exist.
- Let a thumbnail select a candidate preview, then expose `SWITCH` and `REGENERATE` directly below the strip.
- Let the user delete the selected previous baseline candidate while protecting the current approved baseline.
- Scope baseline busy presentation to baseline jobs so activity jobs never relabel the baseline action as creating a new avatar.
- Turn Generate/Regenerate into a Stop control while a baseline request is queued or generating; Stop must cancel the saved job and abort an in-flight provider HTTP request owned by this server process.
- Request newly generated baselines and activity images as transparent PNG cutouts so the Home surface's `#ffffff` background shows through consistently.
- Responsive sizing and focused UI regression coverage.

## Non-goals

- Changing avatar generation, retaining additional history, or modifying activity images.
- Deleting or changing candidates merely because a thumbnail is selected; deletion remains a separate confirmed action.

## Decisions and assumptions

- “Previous avatars” means the existing generated baseline candidates returned in `baseline_candidates`.
- The approved baseline remains the single large image at the top and is visually marked Current.
- Candidate thumbnails are approximately one-sixth of the large preview area and sit side by side.
- Selecting a thumbnail only updates the local preview/selection state. `SWITCH` uses the existing approve-baseline action; `REGENERATE` uses the existing generation action.
- `DELETE` removes only the selected non-current baseline asset and its private file. The current approved baseline is rejected server-side.
- `STOP` is the same middle action in its pending state, requires no confirmation, and never deletes an already saved avatar.
- Provider cancellation is best-effort once OpenAI has accepted work: Twin aborts its HTTP request and discards any late output, but cannot guarantee that provider-side processing or billing has not already begun.
- The strip uses native horizontal scrolling with optional previous/next controls only if they materially improve the final narrow-screen behavior.

## Discoveries

- The current page renders five baseline candidates vertically, which is the source of the long layout.
- Existing approval and regeneration actions are sufficient; no storage or API work is needed for the requested interaction.
- The misleading `CREATING…` label came from the global `avatarBusy` flag, which also tracks pending activity-image jobs. Baseline controls need purpose-scoped pending state.

## Delegation map

- Decision: no delegation. The renderer, local selection state, CSS, and test are one small tightly coupled UI slice.

## Implementation slices

1. **Create compact version selection — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: `public/app.js`
   - Change: Keep the approved avatar large; render candidates as labelled thumbnail buttons; track the selected candidate in browser state; connect Switch and Regenerate to existing actions.
   - Data or interface impact: None.
   - Verification: Confirm thumbnail selection does not call the API and Switch uses the selected candidate ID.

2. **Style the horizontal carousel — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: Avatar selectors in `public/mockup-pages.css`
   - Change: Show four compact thumbnails where space permits, horizontal overflow beyond four, visible selected/current treatment, and touch/keyboard focus states.
   - Data or interface impact: None.
   - Verification: Desktop and narrow-phone visual checks with one, four, and more-than-four candidates.

3. **Add regression coverage — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–2
   - Write scope: `test/ui.test.ts`
   - Change: Assert the active Avatar Studio uses a horizontal candidate selector, keeps one large current avatar, and retains Switch/Regenerate actions.
   - Data or interface impact: None.
   - Verification: Focused UI test and repository verification workflow.

4. **Add safe candidate deletion and scoped busy state — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1–3
   - Write scope: `src/api/router.ts`, `public/app.js`, avatar CSS, router/UI tests
   - Change: Add an owner-scoped DELETE route for non-current baseline assets, expose a confirmed Delete control for the selected thumbnail, and derive baseline-busy presentation only from baseline requests.
   - Data or interface impact: New `DELETE /api/character/baseline/:id` contract; no schema change.
   - Verification: Delete a non-current candidate in the in-memory API test, reject deletion of the current baseline, confirm the UI never shows `CREATING…` because only an activity request is pending, and rerun repository verification.

## Final verification

- `OPENSSL_CONF=/dev/null node --check public/app.js`
- `OPENSSL_CONF=/dev/null node --test test/ui.test.ts`
- `npm run verify`
- Browser check on Settings at desktop and narrow-phone widths: one large current avatar, four visible thumbnails, horizontal access to extras, thumbnail selection, Switch, Regenerate, focus visibility, and no horizontal page overflow.

## Verification results

- `OPENSSL_CONF=/dev/null node --check public/app.js`: passed.
- `OPENSSL_CONF=/dev/null node --test test/ui.test.ts`: passed, 5 tests.
- Changed-file ESLint and Prettier checks: passed.
- `npm run verify`: passed syntax, typecheck, lint, formatting, and 69 runnable tests; the opt-in PostgreSQL integration test was skipped because no confirmed disposable `TEST_DATABASE_URL` was supplied.
- Live Settings page at 606px: exactly one large current avatar, five candidate thumbnails, four visible at once, horizontal overflow for the fifth, one selected state, working Switch target, and no page-level horizontal overflow.
- Live Settings page at 340px: four thumbnails fit the strip, the fifth remains horizontally reachable, both actions remain 44px-high side-by-side controls, selecting the fifth scrolls it into view, and the page has no horizontal overflow.
- Selecting a thumbnail changed only local selection state and updated the existing approve-baseline ID used by Switch; it did not issue an API request.
- Focused router test passed: deleting an owned non-current baseline removes its record and private file; deleting the current baseline returns `BASELINE_IN_USE`.
- Live Settings page at 340px showed `SWITCH`, `REGENERATE`, and `DELETE` as three 44px controls, six horizontally scrollable candidates, no `CREATING` text, and no page overflow.
- Final `npm run verify`: passed syntax, typecheck, lint, formatting, and 73 runnable tests; the opt-in PostgreSQL integration test remained skipped without a confirmed disposable `TEST_DATABASE_URL`.
- Baseline cancellation focused checks passed: queued cancellation marks the owner-scoped request and job `AVATAR_CANCELLED`; in-flight cancellation aborts the provider fetch and saves no asset.
- Changed-file syntax, typecheck, lint, formatting, and 20 focused tests passed.
- Full `npm test` passed 77 tests with the opt-in PostgreSQL integration test skipped. `npm run verify` passed syntax, typecheck, and lint, then stopped at the repository-wide formatting check because the unrelated pre-existing `test/planning.test.ts` change is not Prettier-formatted.
- Live browser verification was unavailable because the shared local app server was no longer listening on port 4173; no live provider call was made.
- Transparent-avatar focused verification passed: the mocked image request asserts `background=transparent`, `output_format=png`, the no-backdrop prompt, and prompt version 5. Typecheck, changed-file lint/formatting, and all 77 runnable tests passed; PostgreSQL remained skipped.

## Progress

- 2026-10-27: Inspected the active Avatar Studio, existing candidate actions, styles, and the live Settings page. Recorded a UI-only carousel plan and stopped before implementation as requested.
- 2026-10-27: User approved the proposed interaction. Implementation started in the existing browser-only Avatar Studio surface.
- 2026-10-27: Replaced the stacked candidates with the compact horizontal selector, preserved the existing Switch/Regenerate behavior, added regression coverage, and completed browser and repository verification.
- 2026-10-27: User requested removal of the misleading creating state and individual avatar deletion. Reopened the existing plan; no new plan file was created.
- 2026-10-27: Added owner-scoped non-current baseline deletion, protected the current baseline, scoped busy presentation to baseline requests, and completed focused, browser, and full-gate verification.
- 2026-10-27: Added a Regenerate/Stop toggle, persistent queued/running job cancellation, in-process provider abort, late-output rejection, and cancellation regression coverage. Full tests passed; repository-wide formatting remains blocked by an unrelated pre-existing file.
- 2026-10-27: Switched newly generated baseline and activity assets to transparent PNG output, removed the white-backdrop instruction, bumped the prompt version, and verified the provider form contract with mocks.

## Risks and recovery

- Risk: A selected thumbnail may be mistaken for the saved current baseline.
  - Safeguard: label the saved large avatar Current and label the thumbnail state Selected until Switch is activated.
- Risk: Horizontal scrolling can hide candidates or reduce keyboard clarity.
  - Safeguard: use native overflow, visible partial continuation, ordered focus, and clear focus/selected outlines.
- Recovery: Restore the existing candidate markup and styles; no data migration or rollback is required.

## Done when

- Exactly one current baseline is displayed at full size.
- Candidate versions appear in one compact horizontal row, with four visible where space allows and more reachable by horizontal scrolling.
- Clicking a thumbnail selects it without immediately changing the saved baseline.
- Switch and Regenerate appear below the thumbnails and invoke existing behavior.
- The Settings page no longer grows vertically for every generated baseline candidate.
- No backend, storage, generation, or activity-library behavior changes.
- The selected previous avatar can be deleted after confirmation without affecting the current avatar or activity images.
- Pending activity-image jobs never relabel the baseline control as creating a new avatar.
- A pending baseline replaces Generate/Regenerate with Stop, and stopping it leaves no generated asset or retryable job behind.
- Newly generated avatar assets use PNG output with provider transparency enabled and a prompt that forbids an opaque backdrop; existing saved versions change only when regenerated.
