# Twin schedule page handoff

Open `index.html` to review the design. `styles.css` contains the page styles; `script.js` lets the date arrows move one day at a time with no two-day limit. The activity list is **sample content** repeated as the selected date changes. It is not a connected or date-specific schedule. TALK links to the Talk mockup; bottom navigation remains a visual placeholder.

## Sources and design decisions

- Match the existing `outputs/twin-home-ui-mockup` design: 606px maximum screen width, 1283px minimum desktop height, white canvas, Barlow and Barlow Condensed, `#dd2e06` accent, black rules, no shadows, the TWIN / TALK header, and two-item bottom navigation. The enlarged activity has gentle rounding so it feels less square.
- `outputs/personal_twin_combined_pitch_book_v7.pptx`, slides 6–9, distinguishes calendar facts from the twin's parallel day. Slide 8 specifically gives the 2:00 PM Practice Test 1 example. `outputs/twin_behavior_change_faculty_discussion_deck_v9.pptx`, slides 2 and 4–6, supports a feasible action that fits the real day.
- Neither inspected deck provides an exact schedule-screen wireframe. The single chronological scroll area, larger focused action, and other sample activities are design proposals. Do not treat them as deck requirements.

## Codex implementation mapping

1. Reuse the app's current header, TALK action, routing, and bottom navigation. Highlight SCHEDULE on this route.
2. Show **only the twin's day** on this page. Put all activities in one chronological, vertically scrollable schedule. Make the row corresponding to the user's current position in the day substantially larger than the others, while keeping it in time order. There is no separate “Happening now” card or label.
3. Drive the date selector and activities from real app state. The arrows should move through dates without an arbitrary two-day limit; use the app's timezone for the selected date and event times.
4. On the current date, emphasize the activity that overlaps the present time. On another selected date, emphasize the relevant position in that day's plan without implying it is happening live. Keep `time` elements and accessible button labels.
5. Replace all sample data and remove the “SAMPLE DAY” badge once live data is connected. Handle empty days, loading, and days without a twin plan. Do not present a twin action as something the user actually did.
6. Keep the mobile layout and the clean, shadow-free treatment. Verify the single scroll region works with touch, mouse, and keyboard, and test long activity titles.

The static mockup makes no claim that the sample events were imported, that the twin completed them, or that the user followed the plan.
