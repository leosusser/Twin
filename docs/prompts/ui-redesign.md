Redesign the Twin UI so it looks and feels like a clean Apple app with a glass look. Use the frontend-design skill for the overall direction. Work in two passes with two different agents: a builder, then a reviewer who uses the app as a real user.

If the `interfaces` skills (jakubkrehel/skills) are installed, use them for the details. Skip this section if they aren't.
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
- **Must not look AI-generated.** Avoid the common AI-template tells:
  - purple or blue gradient blobs, glowing orbs, or sparkle ✨ icons
  - emoji used as icons, or a three-cards-in-a-row "feature grid"
  - every element in a rounded pill with a drop shadow
  - generic hero copy, Inter on a dark gradient
  - identical card spacing everywhere
  Make deliberate choices instead: real hierarchy, varied rhythm, restrained color, and custom details a designer would sign off on. If a screen looks like a default template, redo it.

## Web app now, iPhone app later

- This stays a web app that runs in the browser. Don't add native wrappers, a PWA manifest, service workers, or iOS-only code.
- Build it so it will be easy to move to an iPhone app later:
  - It must work well in a phone-sized browser (393×852) and on desktop.
  - It shouldn't need hover to work, and tap targets should be at least 44×44 px.
  - Use the same component patterns iOS uses: a tab bar or nav bar, cards, lists, and sheets.
  - Keep the design tokens (colors, radii, blur, spacing) in CSS custom properties so they map cleanly to SwiftUI later.
- It's safe to add `viewport-fit=cover` and `env(safe-area-inset-*)` padding, because browsers without a notch ignore them.

## Keep the same size

- Keep the current sizing: the same content widths (such as the 434px max on Home), the same breakpoints (606, 440, and 340px), full-height `100dvh` screens, and roughly the same size for the avatar, cards, and sections.
- This is a restyle, not a re-layout. Nothing should get bigger, smaller, or rearranged beyond what the glass style needs. If something must change size, ask me first.

## Scope: what to change

- Only the screens shown after onboarding: Home, Schedule, Settings, and the Talk overlay (the red orb at the top right).
- Only frontend files in `public/`: `app.js` (render/markup only), `home.css`, `mockup-pages.css`, `avatar.css`, `styles.css`, `index.html`.

## Off limits

- **Onboarding is untouched.** Don't change `renderOnboarding()`, `onboardingSuccess()`, the onboarding prompt, `onboarding.css`, or any of the onboarding steps.
- **No backend changes.** Don't touch `src/`, `db/`, `test/`, the API routes, request and response shapes, the worker, or the database. The UI must call the same endpoints with the same data.
- **Keep every feature (top priority).** Every button, setting, action, link, and piece of information that exists today must still exist and still work. That includes Export, Delete Talk history, Restart onboarding, and Delete account. You may move or restyle features but not remove them.
- **Keep accessibility.** Keep all labels, roles, `aria-*` attributes, `role="status"` regions, keyboard access, focus states, and the skip link. Don't lower contrast.
- **Meaning labels can be minimal.** The labels for Calendar, Gmail, imagined twin activity, and user-reported activity can be toned down a lot: a small icon, a color accent, or a short tag instead of big pills or repeated text. A user still needs to be able to tell the four kinds apart at a glance, and a tooltip or legend should explain them.
- **Ask, don't delete.** If you think something is useless or confusing, stop and ask me before removing or hiding it. Put these in one short batch of questions rather than asking one at a time.

## How to run it

1. **Plan (main thread).** Create the `ui-redesign` branch. Use `twin-plan`. Before writing the plan, take "before" screenshots of Home, Schedule, Settings, and Talk at desktop size and at phone size (393×852). List every feature and control on each screen: this list is the "must still work" checklist. Write the plan to `docs/plans/ui-redesign.md` and commit it.
2. **Build (`twin-builder` agent).** Give it exclusive write ownership of the frontend files listed above, minus all the onboarding code. It implements the redesign, keeps every item on the checklist working, runs `npm run verify`, and commits.
3. **User review (separate agent, after the build is done).** Start the app with `npm run dev` and open `http://127.0.0.1:4173` in the browser at desktop size and at phone size (393×852). Use the app as a normal person would: click through Home, Schedule, Settings, and Talk, and take screenshots. Skip onboarding. This agent does not edit code. Using `better-interface` if it's installed, it reports:
   - What it likes and what it doesn't, from a user's point of view
   - Whether the app feels like a clean, glassy Apple app
   - Anything confusing, hard to find, ugly, broken, or hard to read on glass
   - Any checklist item that is missing or doesn't work, or anything that changed size
   - The top 5 fixes, ranked
4. **Fix pass.** The builder fixes the reviewer's top issues and commits. Anything that would remove a feature, change a size, or change the backend comes to me as a question instead.
5. **Finish (main thread).** Run `twin-verify` and push the `ui-redesign` branch. Show me before and after screenshots of each screen at desktop and phone size, and tell me how to keep the redesign or go back. Don't merge into `main`.

After it finishes, if the interfaces skills are installed, I'll run `/interface-review branch` myself to check the diff for regressions.
