# Personal Twin local prototype

A private, responsive prototype for importing a deliberate ChatGPT onboarding handoff, maintaining sourced memory, creating an illustrative day with an AI planner, talking through the user's own OpenAI API key, and keeping Calendar context visibly distinct from imagined or reported activity.

For a file-by-file guide and information-flow diagrams, read [Project map](PROJECT_MAP.md).

The persistent destinations are **Home**, **Schedule**, and **Settings**. Talk is the red top-right orb; onboarding/import is a pre-app flow. There are no social endpoints or schedule approval controls.

## Run locally

Requirements: Node.js 22.23.4 or newer, npm, and PostgreSQL 16+ (or Docker Desktop).

```bash
npm install
# Keep your existing .env and TWIN_ENCRYPTION_KEY if you have saved data.
# For a new installation only: cp .env.example .env
```

See [PostgreSQL setup and migration](db/README.md) for database setup, the one-time import,
and validation. The app no longer reads or writes `data/twin.json`. Import BEFORE
starting the new app. The server includes the worker; do not start a second worker.

Open `http://127.0.0.1:4173` after `npm run dev`.

An empty migrated database now opens the five-screen local onboarding flow: Name,
ChatGPT prompt, validated JSON import, OpenAI connection plus the first current-day plan,
and Avatar. The key is encrypted server-side, tested, and passed directly to the existing
planner; onboarding does not complete until a valid current-local-day schedule exists.
That first schedule may include clearly imagined Twin activity for elapsed hours and must include
an activity covering the current local time. Later revisions continue to preserve elapsed history.
The first build uses normalized owner-scoped memory created from the imported handoff rather than
reading the raw JSON file again. Import provenance IDs remain in PostgreSQL but are not exposed as
planner citation choices.
`db:seed` is optional demo data and should not be used when you want a clean profile.

If this machine supplies an inaccessible system OpenSSL config, the scripts already use `OPENSSL_CONF=/dev/null`. Run `npm run verify` before handing off changes.

## Development workflow

```bash
npm run typecheck    # TypeScript correctness for source and tests
npm run lint         # TypeScript and maintained browser JavaScript
npm run format:check # Formatting for maintained source and workflow files
npm run check        # Syntax, types, lint, and formatting
npm test             # Fast domain and API tests; PostgreSQL skips without TEST_DATABASE_URL
npm run verify       # Complete local quality gate
```

GitHub Actions runs `npm run verify` for pull requests and pushes to `main`. Database or migration changes also require `npm run test:postgres` against a dedicated empty test database as described in [the database guide](db/README.md).

PostgreSQL is the sole record store. Each domain record is a row in a dedicated table
in the `twin` schema, with its original payload in JSONB and indexed owner/key fields.
Private image bytes remain in `data/assets/`, outside the static web root.
Domain mutations use a database-wide transaction lock and row-level diffs. Reads are
repeatable-read database snapshots, not a process-local cache. This compatibility
adapter still loads full state for many routes and should use scoped queries before scaling.

## Environment

| Variable                                    | Purpose                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                                      | HTTP port; default `4173`                                                              |
| `DATABASE_URL`                              | Server-only PostgreSQL connection string; required                                     |
| `TEST_DATABASE_URL`                         | Dedicated empty PostgreSQL database for integration tests                              |
| `TWIN_ENCRYPTION_KEY`                       | Server-held secret, at least 24 characters, used for AES-256-GCM credential encryption |
| `OPENAI_TEXT_MODEL`                         | Talk Responses API model; default `gpt-5.6-luna`                                       |
| `OPENAI_PLANNER_MODEL`                      | Optional planner override; otherwise reuses `OPENAI_TEXT_MODEL`, then `gpt-5.6-luna`   |
| `OPENAI_IMAGE_MODEL`                        | Image edit model; default `gpt-image-1-mini`                                           |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app credentials                                                           |
| `GOOGLE_CALENDAR_REDIRECT_URI`              | Calendar callback, e.g. `http://127.0.0.1:4173/api/integrations/calendar/callback`     |
| `GOOGLE_GMAIL_REDIRECT_URI`                 | Gmail callback, e.g. `http://127.0.0.1:4173/api/integrations/gmail/callback`           |

Never commit `.env`. The browser receives masked OpenAI connection metadata only. The raw key and Google refresh tokens are encrypted before persistence, never returned in API DTOs, and provider calls originate from the backend/worker.

## Connected data flow

```text
Exact copyable onboarding prompt
  → manual ChatGPT Voice/text conversation
  → validated versioned JSON
  → active user-stated facts + tentative inferences
  → bounded AI day-planning context
  → validated immutable twin-day version
  → Home scene + read-only Schedule

Memory + corrections ───── sourced personal context ─┐
Calendar events ────────── real timing context ──────┼→ AI planner → ordinary validation → version save
Talk/report context ─────── recent/actual context ───┤
Manual instruction ─────── untrusted request data ──┘

Gmail cues remain a separate possible-context surface and are not sent to the day planner.

Settings → coded avatar design → activity SVG fallback
Talk/Studio explicit request → one image job → private versioned descendant → cache reuse
```

Trust boundaries:

- Imported text, Calendar descriptions, Gmail headers, and model output are untrusted data—not backend instructions.
- Direct user edits outrank Talk statements, onboarding statements, repeated imports, and inferences. Removal creates a durable tombstone.
- Calendar events are real commitments; Gmail cues are possible context; twin activities are imagined; activity reports are what the user says actually happened. The API and UI label these separately.
- Every successful revision creates a new immutable version and becomes the sole active version for
  that owner and local date. Older versions remain stored as superseded history and are never shown
  as the active Home or Schedule day. Automatic same-day revisions preserve elapsed, locked,
  explicitly edited, Calendar-backed, and report-backed activities. A manual catch-up report is a
  deliberate full elapsed-day replacement: direct locks/edits remain protected, while the latest
  report replaces older simulated or report-backed backlog. Invalid or stale results leave the
  last valid version unchanged.

## Demo and live adapters

Calendar and Gmail start disconnected and never claim a Google account is connected. With
Google credentials configured, each integration has separate OAuth state, scope, callback,
encrypted refresh token, cursor, and worker path.

Calendar uses `calendar.readonly`, S256 PKCE, one-time OAuth state, paginated calendar
discovery, per-calendar incremental tokens, cancellation records, and a clean full replacement
after HTTP 410. Reconnect, deselect, and disconnect remove prior Calendar context so it cannot
continue influencing Twin. Gmail uses `gmail.metadata`, keeps only bounded message IDs/headers
that match supported timing cues, uses `users.history.list`, and falls back to a bounded full
sync on HTTP 404. The implementation follows Google's [Calendar incremental sync guide](https://developers.google.com/workspace/calendar/api/guides/sync) and [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync).

### Configure Google Calendar

1. In Google Cloud, create or select a project and enable **Google Calendar API**.
2. Configure the OAuth consent screen. While it remains in testing, add the Google account you
   will connect as a test user.
3. Create an OAuth 2.0 client with application type **Web application**.
4. Add this exact authorized redirect URI:
   `http://127.0.0.1:4173/api/integrations/calendar/callback`.
5. Add the client ID and client secret to the ignored local `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Set `GOOGLE_CALENDAR_REDIRECT_URI` to the exact URI above and keep
   the existing `TWIN_ENCRYPTION_KEY` unchanged.
6. Restart `npm run dev`, finish onboarding, then open Settings → Plug-ins → Google Calendar →
   **Set up live**. Google returns to Settings and Twin automatically performs the first sync.

Google requires an exact redirect match: do not mix `localhost` and `127.0.0.1`. The browser
never receives the client secret or refresh token. Calendar access is read-only; Twin cannot
create, edit, or delete Google events.

### Prototype Calendar snapshot without OAuth

For this loopback prototype only, one private Wharton iCalendar feed is configured as a shared
server source. Copy `config/prototype-calendar.example.json` to the gitignored
`config/prototype-calendar.local.json` and put the private feed URL there. Then refresh every
existing profile with:

```bash
npm run calendar:prototype
```

The private URL stays only in that ignored server file. It is not stored on a user, written to
PostgreSQL, logged, or returned to the browser. At server startup, and whenever a new profile is
initialized, Twin applies the shared source to that profile. Normalized Calendar events remain
separate owner-scoped PostgreSQL records so one user's context can never satisfy another user's
query. The command reads today, the prior two owner-local days, and the next 31 days. Repeating an
unchanged feed is a no-op, and an owner's live Google connection is never replaced.

Settings labels this source **Prototype snapshot**. It is not a Google connection and does not
claim live Google sync. Server startup refreshes the snapshot, and the manual command is available
for an immediate refresh. Disconnect removes an owner's normalized events. Change or disable the
shared source in the local configuration file; the adapter remains replaceable because live Google
sync and the prototype snapshot share the same downstream Calendar event contract and planning
context.

Talk and day planning both use `POST /v1/responses` through the backend. Talk selects
`OPENAI_TEXT_MODEL` when it is defined, otherwise `gpt-5.6-luna`. The planner selects the first
non-empty value in this order: `OPENAI_PLANNER_MODEL`, `OPENAI_TEXT_MODEL`, then
`gpt-5.6-luna`. This gives planning an explicit override while reusing the existing text-model
setting by default; it does not alter Talk's model. There is no embedded voice-session model or
ephemeral voice token in this repository—the onboarding voice conversation happens in ChatGPT.

Both paths decrypt the same OpenAI API key saved in Settings only on the server. The browser
receives masked connection metadata and the configured planner model, never the credential or
provider context. Character generation uses the image edit endpoint and the configured
`OPENAI_IMAGE_MODEL` (default `gpt-image-1-mini`). Generated avatars are requested as transparent
PNG cutouts so the Home screen's `#ffffff` background shows through instead of becoming part of
the image. A baseline sends the user's private photo
first as the identity reference and the bundled running character second as the style reference.
Later activities send the approved baseline first as the identity authority and the same bundled
style reference second. Returned bytes are saved locally. The coded SVG remains the no-key
fallback for avatar art, but there is deliberately no fixed or generic fallback day when AI
planning fails. Models are configurable because availability changes. See OpenAI's
[text generation](https://developers.openai.com/api/docs/guides/text),
[image generation](https://developers.openai.com/api/docs/guides/image-generation), and
[API authentication](https://developers.openai.com/api/reference/overview) documentation.

### AI day-planning triggers

All planning uses one server-side service and the explicit trigger values `morning`,
`after_conversation`, and `manual`:

- **Morning:** the existing worker checks every five seconds and queues at most one run per
  user-local date once the saved `wake_time` is reached. The server must be running; no external
  cron or second worker is required. A stale live Calendar connection is refreshed first when
  possible. Empty, stale, and unavailable Calendar states remain distinct in model context. The
  legacy `tomorrow_generation_time` field remains stored for compatibility but does not drive this
  requested morning trigger.
- **After conversation:** one job is queued only after a complete Talk turn, its assistant reply,
  and any supported actual-activity report have committed. The model can return `no_change`; an
  accepted revision can alter only unprotected future activities. Only the triggering Talk
  conversation is included as transcript context.
- **Manual:** Settings → **Rebuild my day** immediately runs the same service for the current
  local date. For today, **What actually happened so far** is a comprehensive replacement for the
  elapsed backlog and is saved as a direct activity report only after a replacement day validates.
  The planner turns supported parts of that report into reported history and rebuilds flexible
  activity from the captured current time onward. The separate **What should change next** field
  guides only the future portion and is never saved as activity the user did.
  When the report leaves elapsed gaps or uncertain timing, the planner may add realistic-looking
  but explicitly `possible` imagined activity. Those estimates do not receive a report citation or
  report-informed label. The server derives elapsed confidence from provenance: current-report
  citations become `grounded`, while unsupported or ambiguous elapsed activity becomes `possible`,
  even if the model supplied the wrong label. If other model output fails server validation, Twin
  sends the validation problem back for one corrected planning attempt before keeping the existing
  day unchanged.
  Locked and user-edited activities remain exact. An elapsed Calendar event is treated as a plan,
  not proof of attendance; when it conflicts with the new report, the reported activity is shown
  and the Calendar item is retained as an unresolved conflict. Future fixed Calendar commitments
  retain their exact supplied times. If fixed items cannot share the single schedule lane, Twin
  keeps one representable item and records the omitted Calendar commitment as unresolved instead
  of moving it or failing the whole rebuild. A future-date entry is planning guidance rather than
  an activity report. The
  control disables duplicate submission and keeps the rendered schedule visible on any failure.
  If no text is supplied and no schedule exists yet, the initial build covers the full local day,
  labels earlier entries as imagined Twin activity, includes an activity covering the captured
  current time, and does not allow an activity to cross into the next local day. Manual planning
  does not include Talk transcripts.
  Before saving, it fits flexible imagined activities into open time, clips their target-day
  overflow at local midnight, and omits a flexible block when fewer than five safe minutes remain.
  If the first plan still leaves the captured current instant open, Twin adds a neutral, explicitly
  imagined **Open time** block inside that free interval.
  Locked, edited, reported, and exact Calendar intervals are never moved or clipped. Contradictory
  overlapping reported/locked/edited activities still leave the current valid day unchanged.

Planner context is owner-scoped and bounded: up to 32 sourced memories, 40 events in the target
local-day window, 10 recent messages, 12 corrections, and 12 actual reports, plus the current
version and optional instruction. Gmail is excluded. Provider calls happen outside storage
transactions; the exact bounded input is fingerprinted and rechecked before an atomic version
save. Planner jobs stop after three attempts. Invalid output, provider errors, missing keys, and
stale responses never supersede the last valid schedule.

### Photo-based avatar flow

Character Studio accepts a private PNG, JPEG, or WebP identity photo up to 8 MB. The server stores it under `data/assets/`, never exposes its storage path, and sends it to the configured image model only when the user requests a baseline. The style anchor is the tracked server-only `data/style-references/running-avatar.png`; it is not a user asset, public URL, or conversation attachment. The prompt tells the model to take rendering and stylization from that image without copying its face, hair, skin tone, body, or clothing. Baseline candidates must be approved before activity art can generate. Each activity request uses that approved baseline as its primary identity reference, saves the result privately, and reuses the selected image on later occurrences. Studying and running are separate cache keys. A failed generation falls back to the approved baseline; deleting avatar data removes both metadata and local user files without removing the shared style reference.

To create a new baseline, connect an OpenAI key in Settings, open Avatar Studio, upload and save a clear photo, and choose **Generate baseline**. Generation does not replace an approved image. Review the candidate and choose **Approve** only when it resembles the person; **Regenerate** creates another candidate and becomes **Stop** while that request is pending. Stop cancels the local job, aborts an in-flight request owned by the running server, and discards any late output; it cannot guarantee that provider-side processing or billing has not already begun. After approval, Home can generate the current activity image from that approved character and will reuse the selected cached version for the same avatar version and activity.

## API examples

Import and automatically apply memory:

```bash
curl -X POST http://127.0.0.1:4173/api/imports \
  -H 'Content-Type: application/json' \
  --data @handoff.json
```

Edit memory with optimistic concurrency:

```bash
curl -X PATCH http://127.0.0.1:4173/api/profile/facts/FACT_ID \
  -H 'Content-Type: application/json' \
  -d '{"statement":"A corrected direct preference.","version":1}'
```

Send Talk text safely on retry:

```bash
curl -X POST http://127.0.0.1:4173/api/talk/conversations/CONVERSATION_ID/messages \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-message-key' \
  -d '{"message":"I actually studied at the library for an hour."}'
```

Rebuild a selected Twin day with an optional instruction:

```bash
curl -X POST http://127.0.0.1:4173/api/twin-days/rebuild \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-manual-plan-key' \
  -d '{"local_date":"2026-10-26","instruction":"Make the afternoon lighter."}'
```

Route families implemented:

- imports and sourced profile facts, including edit/remove conflicts;
- Home, read-only twin days/activity reports, and manual AI rebuilds;
- Settings and masked OpenAI key lifecycle/test;
- Talk conversations/messages/history deletion;
- Calendar and Gmail connect/callback/status/sync/disconnect, calendar selection, and mail cue suppression;
- character design/current scene/library/ensure/regenerate/select and private asset reads;
- export and confirmed account deletion.

Errors use `{ code, message, field_errors?, retryable?, current_version? }`. Retryable mutations require `Idempotency-Key`.

## Data lifecycle and privacy

- Raw handoff content is parsed with a 256 KB request limit and is not kept in the prototype state; the import record stores its hash, counts, and seven-day conceptual expiry marker.
- Talk retention is configurable. The worker cleanup path removes messages beyond the chosen window.
- Gmail stores minimal normalized cues and metadata, never a complete inbox or attachments.
- Generated images are private user-scoped API reads and are deleted with account-owned records; filesystem asset deletion should be added before using this beyond local prototype work.
- Export omits encrypted credentials. Account deletion requires the exact phrase `DELETE MY TWIN`.
- After account deletion, the next reload returns to fresh local onboarding rather than
  requiring demo reseeding.

The onboarding import keeps the existing normalized observations, facts, and import
metadata. It does not archive the full external ChatGPT transcript or original JSON,
raise the 256 KB import limit, or add selective source-download controls.

## Verification status and known gaps

Automated tests cover malformed import/no partial application, canonical idempotency hashes,
explicit-versus-tentative memory, deletion precedence, bounded planning context, planner model
precedence, model-selected times and durations, local-time morning deduplication, manual and Talk
trigger routing, initial-day backlog/current-time coverage, local-midnight boundaries, no-change
replay, protected history, invalid output, bounded retries, and stale result rejection.
`npm run check` covers runtime syntax, TypeScript types, linting, and formatting.

Live OpenAI planning/Talk, Calendar, Gmail, and generated-image calls require user credentials and
are not exercised by the mocked local test suite. Their adapters, provider error states,
encryption boundary, and demo paths are implemented. A configured model override must still be
verified in the actual runtime account for availability and quota. OAuth verification/security
assessment may be required for a public Gmail release. The pitch deck was outside the workspace's
readable filesystem, so the interface follows the exact visual tokens and constraints in the
supplied plan rather than claiming pixel-level deck screenshot comparison. No deck artwork is
bundled; the original coded SVG avatar has no external art-license dependency.

PostgreSQL storage and the migration runner are implemented. Real PostgreSQL verification
must be run with a dedicated test database; it is skipped when TEST_DATABASE_URL is absent.
Remaining deployment gaps are detailed in [database setup](db/README.md), including
authentication, tenant isolation, scoped repositories, durable worker recovery, and
tested backup/restore. Do not deploy this local prototype as-is.
