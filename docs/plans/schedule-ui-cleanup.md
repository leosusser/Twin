# Schedule UI cleanup

Status: Implemented — verification partial

Owner: Main coordinating agent

## Goal

Make Schedule feel calm, fast to scan, and substantially less cluttered while preserving date navigation, chronological activities, current-position emphasis, Calendar conflicts, source meaning, loading/empty states, Talk access, and the existing product navigation.

## Context and evidence

- The live Schedule is rendered in `public/app.js` and styled primarily in `public/mockup-pages.css`.
- The screen currently stacks a large TWIN/TALK header, a large page heading, a bordered date picker, loading/conflict notices, a label-and-scroll-hint row, a nested scroll region, large focused activity treatment, source badges on every activity, per-row “Why it appeared” disclosures, an optional tomorrow-change disclosure, and bottom navigation.
- The reference Schedule intentionally uses one chronological day and one emphasized current activity, but it is a visual reference rather than production behavior.
- Current production behavior already uses real day state, accessible date arrows, user timezone formatting, immutable past days, source labels, and empty/loading/conflict states.
- Schedule UI files already contain unrelated in-progress changes. Implementation must edit only the active Schedule override and its Schedule-specific CSS/test coverage.

## Constraints

- Keep Calendar commitments, imagined Twin activity, and user-reported actual activity visibly distinct. A cleaner design cannot imply that an imagined activity happened.
- Preserve Home, Schedule, Settings, the Talk overlay, date navigation, and bottom navigation.
- Preserve the current schedule data and API contracts; this is a presentation and interaction cleanup only.
- Keep conflicts visible when present, without presenting them as Google Calendar mutations.
- Maintain keyboard focus, semantic `time` elements, readable contrast, reduced-motion behavior, loading announcements, and touch targets.
- Preserve existing worktree changes and avoid broad reformatting of `public/app.js`.

## In scope

- Schedule information hierarchy, spacing, typography, row density, provenance display, details disclosure, and responsive layout.
- Desktop, 606px reference width, and narrow-phone behavior.
- Empty, loading, conflict, current-day, past-day, and future-day visual states.
- Focused regression coverage for the Schedule markup and navigation behavior.

## Non-goals

- Changing planner output, Calendar data, memory, schedule generation, or rebuild behavior.
- Adding drag-and-drop, editing Calendar events, completion checkboxes, or new schedule APIs.
- Redesigning Home, Settings, or Talk.

## Decisions and assumptions

- The Schedule’s primary job is to answer three questions quickly: what day is selected, what happens when, and which item is most relevant now.
- Per the user’s clarification, activity rows will not say “Twin imagined”; they will show only the activity’s time, title, and concise description. One quiet page-level label will say `Illustrative plan · not a record of what happened` so the UI remains truthful without cluttering every activity.
- Calendar-backed and report-backed items remain exceptional and receive a single compact source marker beside the title. Conversation provenance moves into details rather than appearing as another always-visible chip.
- The focused activity remains emphasized, but its type scale and colored container will be reduced so it does not dominate the entire viewport.
- Explanations, confidence, version metadata, and future-change reasons remain available through progressive disclosure rather than occupying the default scan path.
- No separate sidebar or card grid will be introduced; the page remains one chronological list.
- Implementation stays in the main thread because markup, CSS, accessibility, and responsive behavior are one tightly coupled surface.

## Discoveries

- The current production Schedule already replaced the older wide two-column design with the 606px mockup-inspired surface, so the cleanup should refine that implementation rather than rebuild it.
- The largest sources of visual noise are repeated provenance chips, per-row explanation controls, oversized current-item typography, multiple instructional labels, and strong borders around nearly every region.
- Existing automated tests cover Schedule API contracts but provide little direct coverage of Schedule markup or its trust labels.

## Delegation map

- Decision: no delegation. This is one tightly coupled UI slice in shared browser files.

## Implementation slices

1. **Simplify the page hierarchy — Done**
   - Owner: Main coordinating agent
   - Dependencies: None
   - Write scope: Schedule renderer in `public/app.js`; Schedule selectors in `public/mockup-pages.css`
   - Change: Reduce heading height, combine the page title and trust label, compact the date picker, remove the redundant “scroll the day” hint, and soften nonessential borders. Keep the date arrows and selected date as the strongest controls.
   - Data or interface impact: None.
   - Verification: Inspect current, past, and future dates at desktop and phone widths; confirm date arrows, loading state, and focus order still work.

2. **Make activity rows scan-first — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 1
   - Write scope: Schedule row helpers in `public/app.js`; row styles in `public/mockup-pages.css`
   - Change: Use a consistent time/title/short-description rhythm, reduce vertical padding, make the focused row only moderately larger, and keep long titles wrapping without pushing time labels out of alignment. Replace repeated source-chip groups with one compact exceptional-source line for Calendar/report context; ordinary imagined rows rely on the persistent page-level label.
   - Data or interface impact: No source data changes; only presentation changes.
   - Verification: Fixture coverage for imagined-only, Calendar-backed, report-backed, and mixed-source rows; manual inspection with short and long titles.

3. **Move secondary information behind one calm disclosure pattern — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slice 2
   - Write scope: Schedule renderer and Schedule CSS only
   - Change: Replace the always-repeated explanation treatment with a compact “Details” disclosure per activity. Inside it, retain reason, confidence, activity type, and full provenance. Put plan version/generated metadata and “tomorrow may change” information into one quiet plan-details section below the timeline. Keep conflicts outside disclosures because they require attention.
   - Data or interface impact: None.
   - Verification: Keyboard-open every disclosure, verify visible focus and screen-reader names, and confirm closing/re-rendering does not corrupt Schedule state.

4. **Polish responsive and state behavior — Done**
   - Owner: Main coordinating agent
   - Dependencies: Slices 1-3
   - Write scope: Schedule CSS, focused UI regression tests
   - Change: Tune spacing at 606px, 440px, and 340px; ensure one usable chronological scroll region; keep bottom navigation clear of content; add restrained skeleton/loading treatment without layout jumps; preserve reduced-motion behavior.
   - Data or interface impact: None.
   - Verification: Desktop and narrow-phone browser passes for populated, empty, loading, conflict, and long-content states; keyboard-only navigation; `npm run verify`.

## Final verification

- `OPENSSL_CONF=/dev/null node --check public/app.js`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `npm run verify`
- Manual desktop check around 606px: selected date, compact activity scan, current focus, Calendar/report provenance, disclosures, conflicts, loading, and empty state.
- Manual phone check around 390px and 340px: no horizontal scrolling, adequate touch targets, readable long titles, bottom navigation clearance, and one predictable vertical scroll experience.
- Keyboard check: skip link, Talk, date arrows, timeline disclosures, and bottom navigation have logical focus order and visible focus.
- Reduced-motion check: no required information depends on animation.

## Verification results

- `OPENSSL_CONF=/dev/null node --check public/app.js`: passed.
- `OPENSSL_CONF=/dev/null node --test test/ui.test.ts`: passed, 4 tests.
- `npm test`: passed, 67 tests; 1 PostgreSQL integration test skipped because no confirmed disposable `TEST_DATABASE_URL` was supplied.
- `npm run verify`: syntax, typecheck, and lint passed; the gate then stopped at `format:check` because the pre-existing `src/domain/planner.ts` change is not Prettier-clean. The UI-only scope intentionally did not rewrite that domain file.
- Browser fixture at 606px, 390px, and 340px: populated Schedule rendered without horizontal overflow; long titles wrapped; Calendar and report markers remained distinct; activity and plan disclosures opened; 50px date-arrow targets remained intact.
- Keyboard semantics inspection: skip link, top actions, date arrows, scroll region, each native `summary`, and bottom navigation are all in document order with `tabIndex=0`.
- Reduced-motion emulation: Schedule transitions collapse to effectively zero duration and no information depends on animation.
- Loading, empty, and conflict markup paths were reviewed, but those three states were not separately rendered in the browser fixture.

## Progress

- 2026-10-27: Inspected the active Schedule renderer, Schedule-specific CSS, reference mockup, responsive rules, interaction handlers, and existing tests. Recorded a presentation-only cleanup plan.
- 2026-10-27: User authorized implementation and clarified that individual activities must not carry a `Twin imagined` label. Implementation started with a single page-level illustrative-plan disclosure preserving the trust boundary.
- 2026-10-27: Implemented the Schedule-only hierarchy, row, disclosure, and responsive cleanup; added a focused UI regression test; completed populated-state browser checks and the available automated suite. Full verification remains partial because of unrelated `src/domain/planner.ts` formatting and the unavailable disposable PostgreSQL database.

## Risks and recovery

- Risk: Removing repeated labels could weaken the distinction between imagined and factual sources.
  - Safeguard: keep one persistent page-level `Illustrative plan · not a record of what happened` label and show compact Calendar/report markers on exceptional rows; verify the wording in tests.
- Risk: Increased density could reduce readability or touch accessibility.
  - Safeguard: preserve minimum control sizes, line height, focus styles, and responsive wrapping; validate at narrow widths.
- Risk: Moving information into disclosures could hide important conflicts.
  - Safeguard: conflicts remain expanded and prominent; only explanatory metadata is collapsed.
- Recovery: The change is isolated to Schedule markup and Schedule-specific CSS, so the previous renderer and selectors can be restored without data or migration rollback.

## Done when

- The selected date and chronological activities are immediately scannable without competing labels or panels.
- Ordinary rows show time, title, and one concise supporting line; the focused row is distinct but does not consume most of the viewport.
- Calendar and report provenance remains visible, while ordinary imagined status is stated once at page level.
- Reasons, confidence, source detail, version information, and future-change notes remain accessible without cluttering the default view.
- Empty, loading, conflict, long-title, desktop, phone, keyboard, and reduced-motion states are verified.
- No Schedule API, planner, Calendar, or stored-data contract changes.
