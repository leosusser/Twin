# Twin Talk page handoff

Open `index.html` to review the Talk mockup. The home and schedule mockups link to it from their TALK buttons. The back arrow returns to whichever mockup opened Talk; opening Talk directly returns to home. Tap the orb itself to toggle a **visual speaking preview**: the higher orb grows and the bubbles drift behind it, fading as they reach the upper half of the conversation area. This preview does not request microphone access or transcribe speech.

## Visual source

- Match the home page's 606px maximum width, 1283px desktop canvas, white background, Barlow typography, red-orange accent, black rules, and shadow-free treatment.
- `work/ui_reference/board_talk.png` supplies the example conversation. The user requested **small text bubbles** and an expanding orb, so this mockup uses those instead of the board's avatar and transcript column.
- The invitation at the top asks the user to explain their day, feelings, and changes they are making today. It does not label the view “Live transcript.”
- All messages are examples. The mockup does not record audio, transcribe speech, save messages, or control a microphone.

## Codex implementation mapping

1. Open the Talk route from the existing TALK action. Keep a back action that returns to the page the user came from.
2. Render a chronological transcript of user and Twin turns. Keep bubbles compact, aligned right for the user and left for Twin, and layer them behind the orb. Move new bubbles upward slowly as the conversation progresses. Preserve the text in the DOM for accessibility.
3. Drive orb size and motion from real voice activity. It should sit high in the conversation area, be substantial at rest, and grow to roughly half the visible page while the user speaks. As the transcript moves upward behind it, gradually fade bubbles beginning around the middle of the conversation area. Respect reduced-motion settings.
4. Make the orb the keyboard-accessible talk button. Bind its pressed state, accessible label, and status to the real voice session. Show clear states for connecting, listening, Twin speaking, paused, ended, and errors. The orb in this mockup toggles an animation only.
5. Apply the app's privacy and retention rules before storing any transcript. Keep the prompt, transcript, and orb control usable with keyboard and screen readers.
