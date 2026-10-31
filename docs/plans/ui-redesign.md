# UI redesign: glass, clean, Apple-like (post-onboarding only)

Status: built, user-reviewed and fixed on branch `ui-redesign` (66779cb). Not merged into main; waiting on Leo. Brief: `docs/prompts/ui-redesign.md`.

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

The subject is a private twin that lives an imagined version of your day. The one memorable element is **the backdrop**: a warm beige-white paper whose top picks up the avatar's shirt color, with a faint time-of-day warmth. The shirt color is sampled client-side from the avatar image's torso (`syncShirtTint()`), and the last color is kept in localStorage, so no new data is needed. Everything else stays quiet.

| Token            | Value                                                 | Role                                              |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `--ink`          | `#1d1d1f`                                             | primary text                                      |
| `--ink-2`        | `#6e6e73`                                             | secondary text                                    |
| `--hairline`     | `rgba(60,60,67,.14)`                                  | separators and glass edges                        |
| `--glass`        | `rgba(255,255,255,.58)` + `blur(24px) saturate(180%)` | bars, cards, sheets                               |
| `--glass-strong` | `rgba(255,255,255,.78)`                               | text-heavy panels, and the fallback               |
| `--talk`         | `#e5383b`                                             | Talk only. Talk stays "the red orb" per AGENTS.md |
| `--src-calendar` | `#0a66d8`                                             | real Calendar commitment                          |
| `--src-gmail`    | `#b25e00`                                             | possible Gmail context                            |
| `--src-reported` | `#2f8a46`                                             | user-reported activity                            |
| `--src-imagined` | `--ink-2` with a dashed edge                          | imagined twin activity                            |

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

## Foundation API

`public/ui-foundation.css` is linked last in `index.html`, so it wins ties. Everything is scoped to `.shell` (Home, Schedule, Settings) or `.talk-layer`. Onboarding uses its own `--tw-*` tokens and is not affected. Screen builders should use these tokens and classes instead of hard-coded values.

**Markup the foundation owns (`public/app.js`):**

- `render()` adds `daypart-{morning|midday|afternoon|evening|night}` to `.shell`. `twinDaypart()` works it out from the clock in the saved time zone.
- `topbar()` renders the "Twin" wordmark and the Talk orb: `.talk-trigger` plus `.home-talk-button` or `.schedule-talk-button`, with `talkGlyph()` inside.
- `bottomNav()` renders the tab bar in sentence case. Home keeps Schedule on the left and Settings on the right.

**Tokens (`:root`):**

- **Color:** `--ink`, `--ink-2` (secondary text, at least 4.5:1 on sky and glass), `--hairline`, `--hairline-strong`, `--fill`, `--fill-pressed`, `--talk`, `--talk-pressed`, `--danger`, `--focus`.
- **Meanings:** `--src-calendar`, `--src-gmail`, `--src-reported`, `--src-imagined`.
- **Glass:** `--glass`, `--glass-strong`, `--glass-edge`, `--glass-blur` (use as `backdrop-filter: var(--glass-blur)` plus the `-webkit-` prefix), `--shadow-card`, `--shadow-float`.
- **Shape and space:**
  - radii: `--r-sheet` 22, `--r-card` 16, `--r-control` 12;
  - spacing: `--space-1` to `--space-6` (4, 8, 12, 16, 24, 32);
  - `--gutter`: the screen side padding. It is 24px, 16px at 440px and below, and 14px at 340px and below;
  - `--tap`: 44px.
- **Type:**
  - fonts: `--font-text`, `--font-display`;
  - scale: `--type-large-title` 34, `--type-title` 22, `--type-headline` 17, `--type-body` 17, `--type-callout` 15, `--type-footnote` 13 (size and line-height; set the weight yourself);
  - tracking: `--tracking-large`, `--tracking-body`.
  - Inside the app, the old `--display` and `--body` now resolve to the system stack, and `--muted` and `--line` map to `--ink-2` and `--hairline`.
- **Motion:** `--ease`, `--spring`, `--t-fast` 160ms, `--t-sheet` 420ms.
- **Sky:** `--sky-top`, `--sky-mid`, `--sky-bottom`. They mix `--shirt` (set by `syncShirtTint()`) into the daypart's `--paper-*` beige and are shared with the Talk layer through `:root:has(.shell.daypart-*)`.

**Classes:**

- **Backdrop:** `.shell::before` paints the sky behind every app screen. Use `.sky-surface` for a full-height layer that needs its own sky, such as the Talk sheet.
- **Glass:**
  - `.glass` is the base: fill, edge and blur. Add `.glass-strong` for text-heavy panels.
  - `.glass-card` adds the 16px radius and card shadow. `.glass-sheet` and `.glass-bar` add the 22px radius and float shadow.
  - `.glass-list` is an inset grouped list: rows are separated by hairlines inside one card.
- **Controls:**
  - `.ui-button` is a neutral fill, at least 44px tall. Add `.primary` for an ink fill or `.destructive` for red text.
  - `.ui-input` uses a 16px font so iOS never zooms.
- **Type helpers:**
  - `.t-large-title`, `.t-title`, `.t-headline`, `.t-body`, `.t-callout`, `.t-footnote`, `.t-secondary`, `.t-tabular`;
  - `.sc` renders a test-locked ALL-CAPS string in sentence case (for example `CURRENT AVATAR`, `SWITCH`, `WHAT ACTUALLY HAPPENED SO FAR`).
- **Source kinds:**
  - `.src-dot` is solid for Calendar, Gmail and reported activity, and a hollow ring for imagined activity. Set the kind on the dot or a parent with `.src-calendar`, `.src-gmail`, `.src-reported` or `.src-imagined`.
  - `.src-chip` is a dot plus a short colored label, with text colors that pass contrast at 13px.
  - `.src-legend` is a `<ul>` of `li.src-*`, each holding a `.src-dot` and `<strong>Label</strong>` with an explanation. Show the legend wherever the markers appear.
- **Already handled for every screen:**
  - visible focus (a 3px `--focus` outline);
  - glass toasts;
  - `@supports` fallback when `backdrop-filter` is missing;
  - `prefers-reduced-transparency` (solid fills, no blur), `prefers-contrast: more` and `prefers-reduced-motion`.
- **Notes for screen builders:**
  - `home.css` and `mockup-pages.css` still have `box-shadow: none !important` blanket rules. Delete them when you restyle a screen, or the glass shadows will not show.
  - Screen interiors still paint white backgrounds such as `.home-screen` and `.talk-surface`. Remove them so the sky shows through.
