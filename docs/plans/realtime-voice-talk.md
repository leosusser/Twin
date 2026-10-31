# Realtime voice Talk

Status: Implemented — automated verification passed; live provider retry remains manual

Owner: Main coordinating agent

## Goal

Turn the existing Talk overlay into a real, interruptible speech-to-speech conversation while preserving typed Talk. Opening Talk requests microphone access, starts a server-authenticated OpenAI Realtime WebRTC call, displays completed user and Twin speech as transcript messages in the existing conversation, animates the existing orb from actual microphone and playback audio, and saves the completed conversation for Twin's existing bounded after-conversation planning path. Client-relayed voice text remains untrusted conversation context and is not promoted automatically into factual reports or memory.

## Context and evidence

- The current post-onboarding UI is the recently updated glass/paper design documented in [ui-redesign.md](./ui-redesign.md). The implementation uses the current overrides in `public/app.js` and the dedicated `public/ui-talk.css`; this plan must extend those files rather than restoring the older poster-style Talk markup or styles.
- Talk is currently text-only. `public/app.js` opens the existing full-screen Talk dialog, creates a conversation, renders saved messages, and submits typed turns to `POST /api/talk/conversations/:id/messages`.
- The current orb motion is a preview toggle (`talkPreview`) and CSS animation. It is not connected to microphone input, remote audio, or provider state.
- `src/api/router.ts` already validates conversation ownership, keeps the OpenAI key server-side, saves text messages and direct activity reports, queues avatar requests, and queues one `after_conversation` planning job after a complete text turn is saved.
- `src/storage/context.ts` and `PostgresStore.talkContext` already provide bounded, owner-scoped memory, recent messages, activity reports, Calendar events, and the current Twin day to text Talk. Voice should reuse this retrieval boundary rather than sending a lifetime transcript.
- `src/integrations/openai.ts` currently calls `/v1/responses` with `OPENAI_TEXT_MODEL` (default `gpt-5.6-luna`). No Realtime model, WebRTC call, voice, microphone, or voice-session API exists. The planner model path remains separate and must not change.
- The browser is plain module JavaScript with no frontend build step and no OpenAI Agents SDK dependency. The user selected native WebRTC so the implementation fits the existing frontend architecture.
- The user selected keeping typed Talk, showing completed user and Twin speech in the same transcript area, and saving a user-facing personality mode in Settings.
- Current repository guidance says browser code must not hold credentials or make direct provider calls. The user therefore selected the official **unified WebRTC interface**: the browser sends its SDP offer to Twin's backend; the backend combines it with the authoritative session configuration and calls OpenAI. The browser receives only the SDP answer. This deliberately replaces the originally proposed ephemeral-browser-token variant while preserving WebRTC audio.
- Official OpenAI documentation shows the unified flow using `POST /v1/realtime/calls`, native browser `RTCPeerConnection`, media tracks for microphone and generated speech, and a data channel for transcript/session events. The initial implementation used `gpt-realtime-2.1`; the default was later changed to the lower-cost compatible `gpt-realtime-2.1-mini`: <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>.
- Official OpenAI documentation supports semantic VAD with `eagerness: "low"`, automatic response creation, and interruption of an active response: <https://developers.openai.com/api/docs/guides/realtime-vad>.
- Official OpenAI prompting guidance recommends separate, explicit sections for role, personality, length, pacing, context, tools, and safety: <https://developers.openai.com/api/docs/guides/voice-prompting>.

## Goal, context, constraints, and done

- **Goal:** real voice Talk with accurate state, playback-driven orb animation, interruptions, saved transcript, bounded personal context, and existing planner integration.
- **Context:** preserve the current glass/paper Talk screen, typed fallback, PostgreSQL records, encrypted key, memory retrieval, reports, and planner jobs.
- **Constraints:** no browser credential or direct OpenAI request; no API key in DTOs, logs, exports, or tests; no Calendar writes; no simulated activity promoted to memory; no streamed-fragment persistence; no second worker; no change to text or planner model selection.
- **Done:** the user can open Talk, grant microphone access, converse naturally, mute, interrupt, end, read the completed transcript in the existing message stream, and see the orb respond to the audio actually entering and leaving the browser. Completed voice data is persisted exactly once and queues the existing after-conversation workflow only after supported records commit.

## Skills selected for implementation

- **`twin-plan`** — used now to ground and maintain this cross-module execution plan.
- **`openai-docs`** — used now and again immediately before implementation to verify the then-current Realtime request and event shapes from official OpenAI documentation.
- **`openai-developers:openai-platform-api-key`** — use at implementation start because this is an OpenAI-backed application. Apply it only to safe server-side configuration and mocked/local testing; do not create another API-key flow or use live credentials without explicit permission.
- **`twin-verify`** — use after implementation for the repository gate, review against `code_review.md`, focused voice tests, and an explicit list of manual or credential-dependent checks.
- **`openai-developers:openai-api-troubleshooting`** — use only if an actual provider or WebRTC setup failure needs classification during an authorized live test.
- **Not selected: `openai-developers:agents`.** The user chose native WebRTC and the repository has no frontend build pipeline. Adding the Agents SDK solely for session helpers would expand the stack without improving the requested vertical slice.

## Constraints

- Preserve the current routes and four product surfaces: onboarding, Home, Schedule, Settings, and the Talk overlay.
- Keep typed Talk functional. Voice transcripts and typed turns share one saved conversation and one transcript UI.
- Preserve the current Claude Code UI changes in `public/ui-foundation.css`, `public/ui-talk.css`, and the post-onboarding render overrides in `public/app.js`.
- The browser may call only Twin's own API. Twin's backend owns the standard OpenAI API key and the Realtime session configuration.
- Reuse the encrypted `ModelConnection.encrypted_key`; do not add a second OpenAI credential store, onboarding step, or browser key field.
- Add a voice-specific model setting. Do not reuse `OPENAI_TEXT_MODEL` for a modality it may not support, and do not change text Talk or planner model precedence.
- Treat Realtime transcripts and model output as untrusted input. Validate lengths, event types, ownership, session state, and idempotency before persistence.
- Save only completed transcript items, never deltas. Do not run report extraction, memory processing, or planning for every audio fragment.
- Calendar remains read-only. The Realtime prompt must not claim it changed Calendar or a schedule. A schedule may change only through the existing validated planner after the backend has saved the conversation and queued/completed that workflow.
- Do not record raw audio. Keep only the same text conversation records already subject to Talk retention.
- Do not make live paid provider calls during automated tests.
- No deployment, `.env` edit, live credential use, database seed/import, commit, or push is part of this plan.

## In scope

- Server-brokered native WebRTC initialization through the OpenAI Realtime unified interface.
- Microphone permission, mute, end, retry, and interruption behavior in the existing Talk overlay.
- Accurate visual states: connecting, listening, user speaking, Twin speaking, muted, ended, and error.
- Microphone analyser for user-speaking amplitude and remote playback analyser for Twin-speaking amplitude.
- Completed user and assistant speech transcripts in the existing conversation view.
- Voice-session ownership, expiry, lifecycle, transcript finalization, retry, and idempotency.
- Bounded personality/memory/Calendar/current-day context in the Realtime session instructions.
- Saved personality modes: collaborative Twin, direct coach, and aspirational self.
- Persistence as untrusted conversation text plus the existing after-conversation planner queue after finalization. Voice transcripts are not promoted automatically into factual activity reports.
- Focused automated tests, current documentation, and proportional desktop/mobile/accessibility manual checks.

## Non-goals

- No Calendar write tool, Gmail expansion, external messages, telephone/SIP support, recording archive, custom voice training, voice cloning, or multi-user hosting work.
- No frontend framework, bundler, Agents SDK, or broad rewrite of `public/app.js`.
- No change to the planner's schedule validation rules or text Talk's Responses API model.
- No attempt to treat automatic speech transcription as perfect evidence; the visible transcript remains editable only through future separate work.
- No promise that an in-progress schedule changed during the live reply. The existing backend planner remains authoritative after persistence.

## Decisions and assumptions

- **Transport:** native `RTCPeerConnection` using the OpenAI unified WebRTC interface. Browser SDP goes to Twin; Twin authenticates to OpenAI; the SDP answer returns to the browser.
- **Model precedence:** `OPENAI_REALTIME_MODEL` when non-empty, otherwise `gpt-realtime-2.1-mini`. This is independent of `OPENAI_TEXT_MODEL` and `OPENAI_PLANNER_MODEL`.
- **Voice precedence:** `OPENAI_REALTIME_VOICE` when non-empty, otherwise `marin`. Keep voice sound separate from behavioral instructions.
- **Input transcription:** configure a supported transcription model explicitly through `OPENAI_REALTIME_TRANSCRIPTION_MODEL`; use the current documented compatible default confirmed at implementation time. Do not guess a stale model name in code without that re-check.
- **Turn taking:** semantic VAD with low eagerness, `create_response: true`, and `interrupt_response: true`.
- **Transcript visibility:** append local provisional text only from complete provider transcript events. Mark it pending until the backend finalization response returns, then replace it with the canonical saved message DTOs.
- **Persistence boundary:** one voice session is finalized once. The browser sends only completed transcript items; the backend atomically saves new items as untrusted conversation text and queues at most one after-conversation planning job for the session. It does not promote client-relayed voice roles into factual activity reports or memory updates.
- **Text fallback:** the typed composer remains visible and usable when voice is idle, muted, ended, unavailable, or permission is denied. Do not send typed text through two provider paths.
- **Personality mode default:** existing and new profiles default to `collaborative`. Existing JSONB settings rows do not need destructive rewriting; read normalization supplies the default, and the next valid Settings save persists it.
- **Mode meanings:**
  - `collaborative`: warm, observant, practical, calmly encouraging; understand what is doable before advice.
  - `direct_coach`: concise and candid without guilt, diagnosis, or invented certainty.
  - `aspirational_self`: speaks as an encouraging possible future perspective while explicitly remaining an AI Twin, never literally the user.
- **No Realtime mutation tools in the first slice:** the prompt states that Twin cannot confirm schedule or Calendar changes during the live call. Conversation finalization feeds the existing validated planner. A future tool gateway can be planned separately if immediate, confirmed mutations become necessary.
- **Delegation:** at the user's explicit request, one `twin_builder` owned all implementation edits and one separate `twin_reviewer` remained read-only. The reviewer rejected four intermediate passes; the builder repaired each finding before the fifth review passed. The main coordinating thread owned the durable plan, integration review, and final verification.

## Discoveries

- The current UI differs materially from the older Talk implementation: `public/ui-talk.css` is loaded after legacy styles and now owns the glass Talk surface. Any implementation based only on `public/mockup-pages.css` would regress Claude Code's current design.
- The current Talk orb deliberately animates through `talkPreview`; this fake toggle must be removed only after real state and analyser values drive equivalent visual affordances.
- There is no browser build step and no OpenAI JS dependency. Native WebRTC is the smallest compatible choice.
- The repository's no-browser-provider-call rule rules out the ephemeral-token variant unless that rule is deliberately changed. The user selected the server-brokered unified interface instead.
- PostgreSQL stores JSONB record payloads in per-domain tables. A durable `voice_sessions` record requires a small forward migration and state wiring but no redesign of the record store.
- A live user attempt reached OpenAI but the UI collapsed all `400` and `404` responses into one generic configuration message. The multipart `session` part was also encoded as an untyped string even though the current OpenAI reference requires `application/json`.

## API and data contracts

### Voice session record

Add an owner-scoped `VoiceSession` record and `voice_sessions` collection/table:

```ts
interface VoiceSession {
  id: string;
  user_id: string;
  conversation_id: string;
  provider_session_id?: string;
  model: string;
  voice: string;
  personality_mode: "collaborative" | "direct_coach" | "aspirational_self";
  credential_version: number;
  status: "connecting" | "active" | "finalizing" | "complete" | "failed" | "expired";
  created_at: string;
  expires_at: string;
  completed_at?: string;
  failure_code?: string;
}
```

Never store the API key, raw SDP, microphone audio, generated audio, or full provider session instructions in this record.

### Start call

`POST /api/talk/conversations/:conversationId/voice-calls`

- Request content type: `application/sdp`; body is the browser offer, bounded to 64 KiB.
- Require an `Idempotency-Key` scoped to user and conversation.
- Validate conversation ownership, connected encrypted key, encryption readiness, SDP content type/body, duplicate active call, and session expiry.
- Assemble bounded voice context and server-owned instructions, then call `POST https://api.openai.com/v1/realtime/calls` with multipart `sdp` and `session` fields.
- Send the privacy-preserving hash of the local user ID as `OpenAI-Safety-Identifier`.
- Return `201 application/sdp` with only the SDP answer. Return the local voice-session ID and expiry in response headers such as `X-Twin-Voice-Session` and `X-Twin-Voice-Expires-At`; expose no provider credential or prompt.
- Map authentication, quota, unsupported model/voice, provider validation, timeout, and network failures to existing safe error DTO conventions. Mark the local voice session failed without logging SDP or private instructions.

### Finalize call

`POST /api/talk/conversations/:conversationId/voice-calls/:voiceSessionId/complete`

```json
{
  "items": [
    {
      "provider_item_id": "opaque provider item id",
      "role": "user | assistant",
      "transcript": "completed transcript text",
      "completed_at": "ISO timestamp"
    }
  ]
}
```

- Require an idempotency key and validate owner, conversation, voice-session state, role alternation where applicable, item uniqueness, ISO timestamps, a bounded item count, and per-item/total transcript lengths.
- Accept completed items only. Ignore or reject delta/event payloads and unknown fields.
- Atomically insert only new messages, record provider item IDs in the existing provider-request field, update the conversation/session, and queue one `after_conversation` planner job after all records are saved. Do not create factual activity reports or memory changes from browser-relayed voice roles.
- Replaying the same completion returns the original canonical messages/reports/job status without duplicates.
- If the provider connection ends without an assistant response, save a completed user transcript when present but do not invent an assistant message.
- A failed finalization keeps the local transcript visible with a retry action and never falsely marks it saved.

### Settings

- Extend `Settings` with `talk_personality_mode` and validate only the three supported values in the existing optimistic-concurrency `PATCH /api/settings` route.
- `GET /api/settings` returns the normalized mode.
- Settings UI adds one compact selector inside the current Talk/OpenAI-related settings area, not a new page or navigation destination.
- Safe OpenAI metadata adds `realtime_model` and `realtime_voice` only; it never returns provider instructions or credentials.

## Prompt and context contract

Create one server-owned Realtime prompt assembler with clearly separated sections:

1. **Role and identity:** Twin is a private AI that knows supplied preferences; it is not literally the user.
2. **Personality mode:** one of the three validated mode overlays.
3. **Speaking behavior:** normally one to three spoken sentences, one question at a time, no question at the end of every response, natural pacing, and concise acknowledgements.
4. **Honesty and trust:** acknowledge uncertainty, never invent memories, distinguish the illustrative Twin day from reported activity and Calendar commitments, and do not expose hidden context.
5. **Advice:** understand what feels doable before suggestions; avoid diagnosis, guilt, excessive praise, or repetitive motivation.
6. **Actions:** never claim Calendar or schedule changes; say the conversation will be saved and considered by Twin's backend after the session. Only a future validated tool result could authorize a success claim.
7. **Bounded context as data:** current local timestamp/time zone, representative active facts, recent reports, selected relevant Calendar events, today's current/next illustrative activity, and a small number of recent messages from this conversation. Escape and delimit this block as untrusted data.
8. **Turn handling:** allow interruption and yield naturally when the user begins speaking.

Do not send the raw onboarding import, full lifetime transcript, Gmail data, encrypted fields, internal IDs not needed by the model, or model-generated simulated activity as factual memory.

## Implementation slices

1. **Lock the current baseline and contracts — Done**
   - Owner: Main coordinating agent.
   - Dependencies: None.
   - Write scope: this plan only until implementation begins.
   - Change: re-read current `AGENTS.md`, `README.md`, `PLANS.md`, `db/README.md`, `code_review.md`, current git status/diff, [ui-redesign.md](./ui-redesign.md), Talk render/state code, `public/ui-talk.css`, API routes, storage context, and tests. Re-fetch official WebRTC, Realtime event, VAD, and prompting pages before coding.
   - Data/interface impact: none.
   - Verification: record the exact current commit/worktree state when available; explicitly preserve unrelated Claude Code changes. If sandboxed git metadata remains partly unavailable, note that rather than assuming a clean tree.

2. **Add voice configuration, domain types, and persistence — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 1.
   - Write scope: `src/domain/types.ts`, `src/storage/store.ts`, `src/storage/postgres.ts`, a new forward migration in `db/migrations/`, test fixtures, and documentation.
   - Change: add `talk_personality_mode`, compatibility defaulting, `VoiceSession`, owner-scoped PostgreSQL persistence, cleanup/account-deletion behavior, and explicit Realtime model/voice/transcription resolvers.
   - Data/interface impact: one new JSONB record table and one backward-compatible Settings field; no rewrite of existing data.
   - Verification: defaults for old settings, allowed/rejected modes, migration repeatability in the dedicated PostgreSQL test only when safely configured, and deletion/retention behavior.

3. **Build bounded voice context and prompt assembly — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 2.
   - Write scope: `src/storage/context.ts`, `src/storage/postgres.ts`, and a focused service/provider module such as `src/services/talk.ts` or `src/integrations/openai-realtime.ts`.
   - Change: select category-balanced, bounded user context; assemble base personality plus validated mode; serialize personal data as delimited untrusted context; configure semantic VAD, transcription, voice, and output audio.
   - Data/interface impact: new internal typed context and prompt contracts only.
   - Verification: owner isolation, context bounds, no Gmail/full transcript/raw import, correct mode overlay, simulated-vs-reported wording, prompt-injection data remains data, and exact model precedence.

4. **Broker and lifecycle-manage the WebRTC call — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 3.
   - Write scope: `src/integrations/openai-realtime.ts`, `src/api/router.ts`, and focused provider/router tests.
   - Change: accept bounded SDP, call `/v1/realtime/calls` using the decrypted existing key, return the SDP answer, create/update the local voice-session record, hash the safety identifier, enforce ownership/idempotency, and map provider errors safely.
   - Data/interface impact: add the start-call API contract and response headers described above.
   - Verification: mocked provider request contains model/voice/VAD/transcription/prompt and never leaks the key; wrong owner, missing key, malformed/oversized SDP, duplicate start, timeout, auth, quota, invalid model, and retry behavior are covered.

5. **Persist completed voice transcripts through the existing Talk pipeline — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 4.
   - Write scope: a shared Talk service, `src/api/router.ts`, storage types, and tests.
   - Change: add the completion endpoint, save completed messages exactly once as untrusted conversation text, and queue the existing after-conversation planner only after atomic persistence. Voice text is not promoted into factual reports or memories. Preserve typed Talk's response and idempotency contracts.
   - Data/interface impact: add the completion API; existing text endpoint remains compatible.
   - Verification: completed user/assistant transcript, user-only interrupted end, no fragment persistence, idempotent replay, at most one planner job, no factual-report promotion, stale/expired/wrong-conversation rejection, text Talk regression, and failure leaves existing messages/schedule valid.

6. **Connect the current Talk UI to real audio — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 4; transcript rendering may land after Slice 5.
   - Write scope: `public/app.js`, a small new browser module if it reduces lifecycle risk, and `public/ui-talk.css`. Preserve `public/ui-foundation.css` unless a shared token is genuinely required.
   - Change: replace `talkPreview` with an explicit state machine; request microphone access only from the user gesture that opens Talk; create/close `RTCPeerConnection`, media streams, data channel, and audio contexts; post SDP to Twin; parse completed transcript/lifecycle events; add mute/end/retry controls; keep typed Talk; and clean up every resource on close, navigation, error, page hide, and retry.
   - Data/interface impact: browser-only session state; no credential storage.
   - Verification: state transitions, disabled duplicate controls, permission denial, unsupported browser, network/provider error, retry, mute track behavior, end cleanup, Escape/focus trap, typed fallback, reduced motion, and preserved scroll/draft behavior.

7. **Drive the orb from audible input and playback — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slice 6.
   - Write scope: the same Talk browser module, `public/app.js`, and `public/ui-talk.css`.
   - Change: connect the microphone stream to one `AnalyserNode` and the remote playback stream/audio element to another; calculate smoothed RMS or peak amplitude on `requestAnimationFrame`; map user amplitude to the user-speaking state and orb scale, and remote amplitude to Twin-speaking brightness/motion. The remote analyser, not response-generation completion, ends the visible Twin-speaking glow.
   - Data/interface impact: CSS custom properties such as `--talk-input-level` and `--talk-output-level`; no audio persistence.
   - Verification: deterministic unit tests for smoothing/mapping helpers, manual sustained speech/silence/playback-tail checks, motion stops when muted/ended, and `prefers-reduced-motion` changes status without amplitude animation.

8. **Add the Settings personality control and finish product states — Done**
   - Owner: Main coordinating agent.
   - Dependencies: Slices 2 and 6.
   - Write scope: current Settings render/submit code in `public/app.js`, current settings styles, and API/UI tests.
   - Change: add the three-mode selector, explain that sound and behavior are separate, show Realtime availability metadata, and provide actionable microphone/provider errors without fake connected states.
   - Data/interface impact: existing Settings PATCH gains one validated field.
   - Verification: save/reload, optimistic conflict, invalid mode, mobile layout, keyboard selection, visible labels, and no regression to current OpenAI key controls.

9. **Document, verify, and manually evaluate — Partially complete**
   - Owner: Main coordinating agent.
   - Dependencies: All implementation slices.
   - Write scope: `README.md`, `PROJECT_MAP.md`, this plan's progress/results, and tests.
   - Change: document the actual model precedence, unified server-brokered WebRTC flow, same encrypted credential reuse, browser requirements, transcript retention, personality modes, failure behavior, and manual test steps.
   - Data/interface impact: documentation only.
   - Verification: run `$twin-verify`, the full `npm run verify`, focused mocked voice tests, and current UI hook tests. Run PostgreSQL integration only against a dedicated empty `TEST_DATABASE_URL`. A live call remains unavailable unless the user separately authorizes use of their key.

10. **Expose safe Realtime rejection reasons — Done**

- Owner: Main coordinating agent.
- Dependencies: Slice 4.
- Write scope: `src/integrations/openai-realtime.ts`, focused Realtime tests, README, and this plan.
- Change: encode the multipart `session` part as `application/json`; parse only bounded OpenAI error metadata; return an actionable sanitized model, voice, transcription, access, or field-level reason without returning raw provider bodies, credentials, SDP, prompts, or private context.
- Data/interface impact: existing error DTO shape remains compatible; its human-readable message becomes more specific.
- Verification: assert the session multipart part has JSON content type; known provider errors identify the rejected field/access class; secret-like and private values are redacted; unknown/malformed bodies remain generic.

## Final verification

- `npm run check:syntax`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `npm run verify`
- `npm run test:postgres` only when `TEST_DATABASE_URL` is confirmed to be a dedicated empty database.
- Mocked API tests:
  - server-side standard key is used only in the provider request and never returned;
  - SDP and transcript size/content validation;
  - model/voice/transcription precedence;
  - semantic VAD low eagerness and interruption enabled;
  - owner scoping and idempotent start/finalize;
  - completed transcripts only;
  - no factual report or memory promotion from client-relayed voice transcripts, and at most one planner pass after finalization;
  - provider error mapping and cleanup.
- Browser/manual, desktop and narrow mobile:
  - press Talk and accept microphone;
  - connecting → listening → user speaking → Twin speaking;
  - Twin glow continues while buffered audio remains audible and stops on silence;
  - mute disables the microphone track and displays Muted;
  - speak over Twin and confirm interruption;
  - end stops tracks, peer connection, analyser loops, and AudioContexts;
  - completed user/Twin transcripts appear in the existing message area and remain after reload;
  - typed fallback still sends and persists normally;
  - permission denied/provider failure shows retry and leaves typed Talk usable;
  - focus, Escape, scroll position, unsent typed draft, reduced motion, and reduced transparency remain correct.
- Live-provider status must be reported precisely: do not claim a live WebRTC call passed unless an authorized key was actually used and the observed result was recorded.

## Verification results

- Read-only checker verdict after the final repair: **PASS**, no substantive findings.
- Direct JavaScript syntax checks passed for the server, worker, main browser app, and voice controller.
- TypeScript, ESLint, and Prettier checks passed.
- Full automated suite: 93 tests total, 92 passed, 0 failed, 1 skipped. The skip is the opt-in PostgreSQL integration test because no dedicated `TEST_DATABASE_URL` was configured.
- `npm run verify` could not be invoked through the sandboxed `npm` launcher; its underlying configured checks were run directly and passed.
- No live OpenAI call, physical microphone/WebRTC call, interactive desktop/mobile UI pass, or PostgreSQL migration test was performed. These remain explicit residual verification items.

## Progress

- 2026-10-31: Plan created after re-reading the repository following Claude Code's UI changes.
- 2026-10-31: User chose native WebRTC, typed Talk plus voice transcripts in the same conversation view, a Settings personality selector, and the server-brokered unified WebRTC interface.
- 2026-10-31: User confirmed voice must reuse Twin's existing encrypted Settings key. No new key or environment-key path will be introduced, and live credential use remains separately gated.
- 2026-10-31: Implementation started with one isolated `twin_builder`; the main thread retains plan ownership and final integration.
- 2026-10-31: Official OpenAI Realtime, WebRTC, semantic VAD, and voice-prompting guidance checked. The implementation uses the unified `/v1/realtime/calls` flow, documented Realtime lifecycle events, semantic VAD, and bounded server-owned instructions.
- 2026-10-31: Added owner-scoped durable voice sessions, atomic start claims, encrypted Settings-key reuse, bounded prompt/context assembly, native browser WebRTC, transcript finalization, personality modes, analyser-driven orb states, recovery/retention behavior, migration 002, and focused tests.
- 2026-10-31: Separate read-only checker rejected four intermediate passes for lifecycle, concurrency, trust, recovery, and transcript-drain defects. The builder repaired them; the fifth checker pass returned PASS with no substantive findings.
- 2026-10-31: Voice transcripts deliberately remain untrusted conversation text. They can inform the bounded after-conversation planner context but cannot become factual activity reports or memory updates without a separately trusted confirmation path.
- 2026-10-31: Changed the Realtime default from `gpt-realtime-2.1` to the compatible lower-cost `gpt-realtime-2.1-mini`; environment override precedence remains unchanged.
- 2026-10-31: Began a narrow diagnostics repair after the live UI showed the generic configuration error despite a funded API account. No live paid request is authorized for this repair.
- 2026-10-31: Corrected the unified Realtime multipart request so the `session` part is explicitly `application/json`. Added bounded parsing for provider code, type, parameter, and message fields; known access and validation failures now return a specific sanitized reason while malformed or unsafe provider bodies remain generic.
- 2026-10-31: The first live retry exposed `invalid_form_data`: OpenAI did not recognize the file-like `sdp` part. Updated the request to match the official API contract by sending `sdp` as a plain string form field while retaining `session` as the JSON multipart part, and added an exact regression assertion.
- 2026-10-31: The next live retry exposed `missing_model`, confirming the file-like `session` part was also ignored. Replaced browser-style `FormData` serialization with a bounded server-built multipart body matching OpenAI's documented curl form: `sdp` is an `application/sdp` data part, `session` is an `application/json` data part, and neither carries a filename.
- 2026-10-31: A successful provider claim exposed a stale-session recovery gap: the server returned the active session ID, but the browser offered no takeover path when page-close cleanup was lost. The first conflict now remains non-destructive and explains the risk; a subsequent explicit Retry abandons that stored session before reconnecting, preserving protection for a genuinely active tab until the user chooses takeover.
- 2026-10-31: Fixed a lightweight-rendering defect that updated the Talk error message but left the control row in its earlier connecting state. `syncTalkVoiceDom` now updates mute/end availability and inserts or removes the delegated Retry button as voice state changes, without replacing the Talk surface or losing its draft and scroll state.
- 2026-10-31: Re-ran JavaScript syntax checks, TypeScript, ESLint, Prettier, focused Realtime tests, and the full automated suite. All available checks passed: 93 tests total, 92 passed, 0 failed, and the opt-in PostgreSQL test skipped. No live provider request was made.

## Risks and recovery

- **Risk: current frontend regressions.** `public/app.js` contains legacy functions plus later overrides, and the updated UI has a dedicated cascade. **Safeguard:** edit only the active post-onboarding Talk/Settings paths; preserve hooks from [ui-redesign.md](./ui-redesign.md); run UI contract tests and inspect both target sizes.
- **Risk: microphone or audio resources survive close/retry.** **Safeguard:** one idempotent teardown function stops all tracks, closes the peer/data channel/AudioContexts, cancels animation frames, clears handlers, and transitions state once.
- **Risk: generated-response completion is mistaken for audible completion.** **Safeguard:** Twin-speaking visuals use the analyser connected to the actual remote playback stream and decay only when playback amplitude is silent.
- **Risk: transcript deltas create duplicates or planner storms.** **Safeguard:** UI may render only completed items; backend finalizes once with provider item IDs and an idempotency key; planning queues once after atomic save.
- **Risk: provider prompt/context leaks.** **Safeguard:** browser receives SDP only; logs redact provider bodies; local records omit SDP/audio/prompt; response DTOs remain masked.
- **Risk: browser-submitted transcript is tampered with.** **Safeguard:** treat it as untrusted user/model data, bind it to an owned active voice session, validate strict bounds and item IDs, and never treat assistant text as user-reported fact. A later server-side event sideband can replace client relay if the prototype becomes hosted.
- **Risk: wrong or unavailable model/voice.** **Safeguard:** explicit Realtime-only environment settings, safe provider error, no fallback to an unrelated text model, and no fake voice session.
- **Risk: interrupted finalization.** **Safeguard:** retryable completion with stable idempotency; pending transcript remains visible; cleanup marks abandoned sessions expired without inventing saved messages.
- **Recovery:** voice code is additive. If the Realtime path fails, disable the voice start controls while preserving the existing typed Talk endpoint, saved conversations, planner, and current UI.

## Done when

- Opening Talk from Home or Schedule opens the current Talk surface, requests microphone permission, and attempts one authenticated server-brokered WebRTC call without exposing any OpenAI credential.
- The UI exposes visible, accessible connecting, listening, user speaking, Twin speaking, muted, ended, and retryable error states.
- Mute, end, retry, cleanup, and user interruption behave correctly without duplicate sessions.
- Orb scale/brightness follows smoothed microphone and audible remote playback levels; it does not stop merely because response generation finished.
- Completed speech appears as user/Twin transcript messages in the same stream used by typed Talk and remains after reload.
- Voice finalization is owner-scoped, bounded, atomic, and idempotent; it creates no factual report or memory from client-relayed roles and queues at most one existing after-conversation planner job when saved messages exist.
- Collaborative, direct coach, and aspirational-self modes are saved and applied without changing the chosen voice sound.
- Text Talk, planner behavior, Calendar read-only behavior, onboarding, avatar workflows, and the current Claude Code frontend design remain intact.
- Relevant checks pass, credential-dependent checks are identified accurately, and documentation describes the observed implementation rather than the intended one.
