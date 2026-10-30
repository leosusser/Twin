Redesign the Twin UI so it looks and feels like a clean Apple app with a glass look. Use the frontend-design skill for the overall direction. Work in two passes with two different agents: a builder, then a reviewer who uses the app as a real iPhone user.

Also use the `interfaces` skills (jakubkrehel/skills):
- **Builder:** `better-ui` (surfaces, icons, motion), `better-typography`, `better-colors` (palette, tokens, contrast), `better-layout` (grouping, alignment, responsive), `better-writing` (labels, empty states, errors), and `better-accessibility` (keyboard, focus, ARIA, WCAG 2.2).
- **Reviewer:** `better-interface` for the ranked review across all areas.
- frontend-design sets the overall direction. The `better-*` skills set the exact details. If they disagree, follow frontend-design for the look and the `better-*` skills for accessibility and contrast.

## I must be able to go back

- Before changing anything, create a branch `ui-redesign` from the latest `main` and do all the work there. Don't commit to `main` or merge into it.
- Commit after each step (plan, build, fix pass) so I can step back to any point. Push the branch to `origin`.
- Finish by telling me exactly how to undo it: `git switch main` returns to the old UI, and `git branch -D ui-redesign` throws the redesign away. Only merge into `main` if I say I like it.

## Design direction: glass, clean, Apple

- **Look:** like iOS, using Apple's Liquid Glass style. Content sits on a soft background, and the bars, cards, sheets, the tab bar, and the Talk overlay are frosted glass layers on top of it. Use `backdrop-filter: blur() saturate()`, translucent fills, thin light borders, soft shadows, and generous rounded corners.
- **Clean:** lots of white space, calm color with one accent, and no heavy borders, loud gradients, or clutter. Every screen needs a clear hierarchy of title, primary content, then secondary.
- **Type:** the Apple system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif`) on the post-onboarding screens. Keep the Barlow font link in `index.html` because onboarding still uses it.
- **Readable glass:** text on glass must meet WCAG contrast. Support `prefers-reduced-transparency` (switch to solid fills) and `prefers-reduced-motion`. Add a fallback for browsers without `backdrop-filter`.
- **Motion:** subtle, quick, iOS-like springs and fades. Nothing bouncy or slow.

## It will be an iPhone app

- Design for iPhone first. Target 393×852 (iPhone 16/17), and check that it also works at 375×667 (SE) and 440×956 (Pro Max).
- Respect the notch and home indicator: add `viewport-fit=cover` to the viewport meta and use `env(safe-area-inset-*)` padding on the top bar, the tab bar, and the Talk overlay.
- Make tap targets at least 44×44 pt. Nothing may depend on hover. Use `100dvh`. Avoid layout jumps when the keyboard opens in Talk. Set font sizes to 16px or larger in inputs so iOS doesn't zoom.
- Navigation should feel like iOS: a bottom tab bar for Home, Schedule, and Settings, and Talk as a sheet or overlay.

## Keep the same size

- Keep the current sizing: the same content widths (such as the 434px max on Home), the same breakpoints (606, 440, and 340px), full-height `100dvh` screens, and roughly the same size for the avatar, cards, and sections.
- This is a restyle, not a re-layout. Nothing should get bigger, smaller, or rearranged beyond what the glass style and iPhone safe areas need. If something must change size, ask me first.

## Scope: what to change

- Only the screens shown after onboarding: Home, Schedule, Settings, and the Talk overlay (the red orb at the top right).
- Only frontend files in `public/`: `app.js` (render/markup only), `home.css`, `mockup-pages.css`, `avatar.css`, `styles.css`, `index.html`.

## Off limits

- **Onboarding is untouched.** Don't change `renderOnboarding()`, `onboardingSuccess()`, the onboarding prompt, `onboarding.css`, or any of the onboarding steps.
- **No backend changes.** Don't touch `src/`, `db/`, `test/`, the API routes, request and response shapes, the worker, or the database. The UI must call the same endpoints with the same data.
- **Keep every feature.** Every button, setting, action, link, and piece of information that exists today must still exist and still work. That includes Export, Delete Talk history, Restart onboarding, and Delete account. You may move or restyle features but not remove them.
- **Keep accessibility.** Keep all labels, roles, `aria-*` attributes, `role="status"` regions, keyboard access, focus states, and the skip link. Don't lower contrast.
- **Meaning labels can be minimal.** The labels for Calendar, Gmail, imagined twin activity, and user-reported activity can be toned down a lot: a small icon, a color accent, or a short tag instead of big pills or repeated text. A user still needs to be able to tell the four kinds apart at a glance, and a tooltip or legend should explain them.
- **Ask, don't delete.** If you think something is useless or confusing, stop and ask me before removing or hiding it. Put these in one short batch of questions rather than asking one at a time.

## How to run it

1. **Plan (main thread).** Create the `ui-redesign` branch. Use `twin-plan`. Before writing the plan, take "before" screenshots of Home, Schedule, Settings, and Talk at 393×852. List every feature and control on each screen: this list is the "must still work" checklist. Write the plan to `docs/plans/ui-redesign.md` and commit it.
2. **Build (`twin-builder` agent).** Give it exclusive write ownership of the frontend files listed above, minus all the onboarding code. It implements the redesign, keeps every item on the checklist working, runs `npm run verify`, and commits.
3. **User review (separate agent, after the build is done).** Start the app with `npm run dev` and open `http://127.0.0.1:4173` in the browser at iPhone size (393×852). Use the app as a normal person would: click through Home, Schedule, Settings, and Talk, and take screenshots. Skip onboarding. This agent does not edit code. Using `better-interface`, it reports:
   - What it likes and what it doesn't, from a user's point of view
   - Whether the app feels like a clean, glassy Apple app
   - Anything confusing, hard to find, ugly, broken, or hard to read on glass
   - Any checklist item that is missing or doesn't work, or anything that changed size
   - The top 5 fixes, ranked
4. **Fix pass.** The builder fixes the reviewer's top issues and commits. Anything that would remove a feature, change a size, or change the backend comes to me as a question instead.
5. **Finish (main thread).** Run `twin-verify` and push the `ui-redesign` branch. Show me before and after screenshots of each screen at iPhone size, and tell me how to keep the redesign or go back. Don't merge into `main`.

After it finishes, I'll run `/interface-review branch` myself to check the diff for regressions.
