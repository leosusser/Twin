# Twin pages for VS Code

This package contains **Schedule, Talk, and Settings only**. The Home mockup is not included.

## Files

- `twin-schedule-ui-mockup/`: `index.html`, `styles.css`, `script.js`, and implementation notes.
- `twin-talk-ui-mockup/`: `index.html`, `styles.css`, `script.js`, and implementation notes.
- `twin-settings-ui-mockup/`: `index.html`, `styles.css`, `script.js`, the approved baseline preview asset, and implementation notes.

Open each `index.html` to inspect the layout. Each page's `IMPLEMENTATION_NOTES.md` explains the intended app behavior and which content is only sample data.

## Integrating with the existing Home page

Reuse the Home page already supplied to the VS Code agent. These standalone files are design references; adapt them to the app's routes and components. Schedule links to Talk. Talk and Settings have back links that point to a sibling `twin-home-ui-mockup` folder in the local preview; replace those links with the app's navigation when implementing.

- Schedule: one scrollable chronological day, with the current position enlarged; date arrows in the mockup change the displayed date while activities remain examples.
- Talk: the orb is the button. Tapping or pressing it toggles a visual speaking animation; the mockup does not record audio.
- Settings: Avatar Studio is on the page. Photo selection shows a local preview only. The baseline image is a snapshot of the currently approved avatar; in the app, load it through the existing private user-scoped asset URL. Plug-in states and the memory paragraph are illustrative.

No Home page source or Home page assets are included in this package.
