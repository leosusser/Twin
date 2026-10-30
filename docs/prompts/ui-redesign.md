Use the frontend-design skill to redesign the Twin UI so it looks and feels much better. Do this in two passes with two different agents: a builder, then a reviewer who uses the app as a real user.

Also use the `interfaces` skills (jakubkrehel/skills):
- **Builder:** `better-ui` (surfaces, icons, motion), `better-typography`, `better-colors` (palette, tokens, contrast), `better-layout` (grouping, alignment, responsive), `better-writing` (labels, empty states, errors), and `better-accessibility` (keyboard, focus, ARIA, WCAG 2.2).
- **Reviewer:** `better-interface` for the ranked review across all areas, and `interface-review` on the diff to catch anything the redesign made worse.
- frontend-design sets the overall direction. The `better-*` skills set the exact details. If they disagree, follow frontend-design for the look and the `better-*` skills for accessibility and contrast.

## Scope: what to change

- Only the screens shown after onboarding: Home, Schedule, Settings, and the Talk overlay (the red orb at the top right).
- Only frontend files in `public/`: `app.js` (render/markup only), `home.css`, `mockup-pages.css`, `avatar.css`, `styles.css`, `index.html`.
- Layout, typography, color, spacing, hierarchy, motion, empty and loading states, responsive and mobile layouts.

## Off limits

- **Onboarding is untouched.** Don't change `renderOnboarding()`, `onboardingSuccess()`, the onboarding prompt, `onboarding.css`, or any of the onboarding steps.
- **No backend changes.** Don't touch `src/`, `db/`, `test/`, the API routes, request and response shapes, the worker, or the database. The UI must call the same endpoints with the same data.
- **Keep every feature.** Every button, setting, action, link, and piece of information that exists today must still exist and still work. That includes Export, Delete Talk history, Restart onboarding, and Delete account. You may move or restyle features but not remove them.
- **Keep accessibility.** Keep all labels, roles, `aria-*` attributes, `role="status"` regions, keyboard access, and focus states, and keep the skip link if there is one. Don't lower contrast.
- **Meaning labels can be minimal.** The labels for Calendar, Gmail, imagined twin activity, and user-reported activity can be toned down a lot: a small icon, a color accent, or a short tag instead of big pills or repeated text. A user still needs to be able to tell the four kinds apart at a glance, and a tooltip or legend should explain them.
- **Ask, don't delete.** If you think something is useless or confusing, stop and ask me before removing or hiding it. Put these in one short batch of questions rather than asking one at a time.

## How to run it

1. **Plan (main thread).** Use `twin-plan`. Before writing the plan, list every feature and control on each post-onboarding screen: Home, Schedule, Settings, Talk. This list is the "must still work" checklist. Pick one design direction with frontend-design. Use `docs/references/ui/` for inspiration only. Write the plan to `docs/plans/ui-redesign.md`.
2. **Build (`twin-builder` agent).** Give it exclusive write ownership of the frontend files listed above, minus all the onboarding code. It implements the redesign, keeps every item on the checklist working, and runs `npm run verify`.
3. **User review (separate agent, after the build is done).** Start the app with `npm run dev`, open `http://127.0.0.1:4173` in the browser, and use it as a normal user would: click through Home, Schedule, Settings, and Talk, on both desktop and phone widths, and take screenshots. Skip onboarding. This agent does not edit code. It reports:
   - What it likes and what it doesn't, from a user's point of view
   - Anything confusing, hard to find, ugly, or broken
   - Any checklist item that is missing or doesn't work
   - The top 5 fixes, ranked
4. **Fix pass.** The builder fixes the reviewer's top issues. Anything that would remove a feature or change the backend comes to me as a question instead.
5. **Finish (main thread).** Run `twin-verify`, show me before and after screenshots of each screen, then commit and push.
