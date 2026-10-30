# UI redesign: glass, clean, Apple-like (post-onboarding only)

Status: in progress on branch `ui-redesign`. Brief: `docs/prompts/ui-redesign.md`.

## Goal, context, constraints, done

- **Goal:** Home, Schedule, Settings and Talk look like a calm, clean Apple app with frosted glass layers. It must not look AI-generated. It stays a web app, built so it can become an iPhone app later.
- **Context:** the current UI is a bold Barlow Condensed poster style: black all-caps headings, a red TALK pill, hard 1px black borders, and a white 606px column on grey. All post-onboarding markup comes from `public/app.js` render functions. Styles live in `home.css`, `mockup-pages.css`, `avatar.css` and `styles.css`.
- **Constraints:** frontend only. Onboarding is untouched. Every feature, hook and accessibility attribute stays. Sizes stay the same. `test/ui.test.ts` locks some copy and structure, and it must still pass without being edited.
- **Done when:**
  - the after screenshots at 393×852 and 1440×900 read as clean, glassy and deliberate;
  - every checklist item below still works;
  - `npm run verify` passes;
  - the user-review agent's top issues are fixed.

## Design tokens

The subject is a private twin that lives an imagined version of your day. The one memorable element is **the backdrop following the time of day**. Behind the glass sits a soft, blurred sky field. Its tint comes from the local hour: pale cool morning, clear neutral midday, warm late afternoon, dusk violet-grey at night. It is computed client-side from the clock, with no new data. Everything else stays quiet.

| Token | Value | Role |
|---|---|---|
| `--ink` | `#1d1d1f` | primary text |
| `--ink-2` | `#6e6e73` | secondary text |
| `--hairline` | `rgba(60,60,67,.14)` | separators and glass edges |
| `--glass` | `rgba(255,255,255,.58)` + `blur(24px) saturate(180%)` | bars, cards, sheets |
| `--glass-strong` | `rgba(255,255,255,.78)` | text-heavy panels, and the fallback |
| `--talk` | `#e5383b` | Talk only. Talk stays "the red orb" per AGENTS.md |
| `--src-calendar` | `#0a66d8` | real Calendar commitment |
| `--src-gmail` | `#b25e00` | possible Gmail context |
| `--src-reported` | `#2f8a46` | user-reported activity |
| `--src-imagined` | `--ink-2` with a dashed edge | imagined twin activity |

- **Type:** the Apple system stack (`-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif`) in sentence case. Use iOS-like sizes: a 34px large title, 22px title, 17px body, 15px secondary and 13px footnote. Weight and size carry the hierarchy, not all-caps or letter-spacing. Strings that `test/ui.test.ts` locks in caps stay as they are in source.
- **Shape:** corner radius follows hierarchy: 22px sheets, 16px cards, 12px controls, and fully round only for the Talk orb and the avatar chip. Shadows are soft and large on floating layers only. List rows inside a card use hairlines, not their own cards.
- **Layout:** keep the current column widths and breakpoints (606px shell, 434px Home avatar column, breakpoints at 606, 440 and 340px). Left-align text, iOS style. The top bar and bottom nav become floating glass bars with `env(safe-area-inset-*)` padding. Home keeps Schedule on the left and Settings on the right.
- **Motion:** only motion that answers an action: the Talk sheet slides up, `<details>` expand, and buttons give press feedback. Respect `prefers-reduced-motion` and `prefers-reduced-transparency`, and use `@supports not (backdrop-filter)` to fall back to `--glass-strong`.
- **Avoid:** the purple/blue gradient blob, sparkles, emoji icons, the cream + terracotta look, all-caps eyebrows everywhere, `·`-joined meta strings added by the redesign, the same card shadow on everything, and `→` appended to buttons.

## Must-still-work checklist

Taken from `public/app.js` on `main` at `c9bd88d`. Every hook, `id`, and `aria-*` or `role` attribute in post-onboarding markup must survive.

- **Navigation:** `data-route` (home, schedule, settings), `data-talk-toggle`, `data-talk-backdrop`, hash routes, the skip link, `#main`.
- **Home:** current activity and its time (`#home-current-activity`), the avatar scene image, the next activity (`#home-next-label`), the Schedule and Settings buttons, and `data-talk-orb`.
- **Schedule:**
  - day stepping (`data-day-step`, `data-date`, `data-planning-date`) and the week strip;
  - the calendar conflict notice (`#schedule-conflicts-title`) and "Illustrative plan · not a record of what happened";
  - activity rows with source badges, Details `<details>` and "About this plan";
  - the rebuild form: `#schedule-rebuild-form`, `actual_report`, `future_instruction`, the counts, the status, and the AI estimate copy.
- **Settings:**
  - **Avatar studio:** photo upload, replace, save, cancel and delete (`data-save/cancel/delete-avatar-photo`), the baseline generate, approve, cancel and delete actions, `data-avatar-candidate` with SWITCH and REGENERATE, the scene select, regenerate, retry and delete actions, and `data-delete-avatar-images`.
  - **Memory:** facts with `data-edit-fact` and `data-remove-fact`.
  - **Plugins:** Calendar and Gmail connect, disconnect and sync, and the calendar choice and save (`data-calendar-choice`, `data-save-calendar-selection`).
  - **OpenAI:** `#key-form`, `data-test-key` and `data-remove-key`.
  - **Timing:** `#settings-form` (wake, sleep, reminders, bathroom scene, retention and the tomorrow settings).
  - **Planner settings.**
  - **Privacy:** Export, `data-delete-history`, `data-restart-onboarding` and `data-delete-account`.
- **Talk:** the dialog (`role="dialog"`, `aria-modal`), the conversation with timestamps, the streaming state (`data-talk-stream`), `#talk-form` and send, and the live regions.
- **Global:** the toast region, the loading, error and empty states, `aria-busy`, and the progressbar.

## Steps and verification

1. **Plan** (this file). Before screenshots are taken at 393×852 and 1440×900.
2. **Build:** a builder agent owns `public/app.js` (post-onboarding render functions only), `home.css`, `mockup-pages.css`, `avatar.css`, `styles.css` and `index.html`. Verify with `npm run verify` and the hook-diff check (every hook, `id` and `aria-*` on `main` still present).
3. **User review:** a separate read-only agent uses the app at both sizes and reports what works and what doesn't, plus the top 5 fixes.
4. **Fix pass:** the builder fixes those issues. Verify with `npm run verify` and fresh screenshots.
5. **Finish:** run `twin-verify` and push the branch. Do not merge.
