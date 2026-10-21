# Personal Twin local prototype

A private, responsive prototype for importing a deliberate ChatGPT onboarding handoff, maintaining sourced memory, displaying an illustrative twin day, talking through the user's own OpenAI API key, and keeping Calendar/Gmail context visibly distinct from imagined or reported activity.

The persistent destinations are **Home**, **Schedule**, and **Settings**. Talk is the red top-right orb; onboarding/import is a pre-app flow. There are no social endpoints or schedule approval controls.

## Run locally

Requirements: Node.js 22.6 or newer, npm, and PostgreSQL 16+ (or Docker Desktop).

```bash
npm install
# Keep your existing .env and TWIN_ENCRYPTION_KEY if you have saved data.
# For a new installation only: cp .env.example .env
```

See [PostgreSQL setup and migration](db/README.md) for database setup, the one-time import,
and validation. The app no longer reads or writes `data/twin.json`. Import BEFORE
starting the new app. The server includes the worker; do not start a second worker.

Open `http://127.0.0.1:4173` after `npm run dev`.

If this machine supplies an inaccessible system OpenSSL config, the scripts already use `OPENSSL_CONF=/dev/null`. Run `npm run check` and `npm test` before changes.

PostgreSQL is the sole record store. Each domain record is a row in a dedicated table
in the `twin` schema, with its original payload in JSONB and indexed owner/key fields.
Private image bytes remain in `data/assets/`, outside the static web root.
Domain mutations use a database-wide transaction lock and row-level diffs. Reads are
repeatable-read database snapshots, not a process-local cache. This compatibility
adapter still loads full state for many routes and should use scoped queries before scaling.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; default `4173` |
| `DATABASE_URL` | Server-only PostgreSQL connection string; required |
| `TEST_DATABASE_URL` | Dedicated empty PostgreSQL database for integration tests |
| `TWIN_ENCRYPTION_KEY` | Server-held secret, at least 24 characters, used for AES-256-GCM credential encryption |
| `OPENAI_TEXT_MODEL` | Responses API model; default `gpt-5.6-luna` |
| `OPENAI_IMAGE_MODEL` | Image edit model; default `gpt-image-1-mini` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app credentials |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Calendar callback, e.g. `http://127.0.0.1:4173/api/integrations/calendar/callback` |
| `GOOGLE_GMAIL_REDIRECT_URI` | Gmail callback, e.g. `http://127.0.0.1:4173/api/integrations/gmail/callback` |

Never commit `.env`. The browser receives masked OpenAI connection metadata only. The raw key and Google refresh tokens are encrypted before persistence, never returned in API DTOs, and provider calls originate from the backend/worker.

## Connected data flow

```text
Exact copyable onboarding prompt
  → manual ChatGPT Voice/text conversation
  → validated versioned JSON
  → active user-stated facts + tentative inferences
  → immutable twin-day generator
  → Home scene + read-only Schedule

Calendar events ── real timing context ─┐
Gmail cues ────── possible context ─────┼→ next twin-day version
Talk reports ───── user-reported actual ┘

Settings → coded avatar design → activity SVG fallback
Talk/Studio explicit request → one image job → private versioned descendant → cache reuse
```

Trust boundaries:

- Imported text, Calendar descriptions, Gmail headers, and model output are untrusted data—not backend instructions.
- Direct user edits outrank Talk statements, onboarding statements, repeated imports, and inferences. Removal creates a durable tombstone.
- Calendar events are real commitments; Gmail cues are possible context; twin activities are imagined; activity reports are what the user says actually happened. The API and UI label these separately.
- Today's displayed twin day is stable. New reports queue tomorrow's version instead of rewriting history.

## Demo and live adapters

Calendar and Gmail start in an explicit **Demo data** state. Syncing demo connections exercises the same jobs/status API without claiming an account is connected. With Google credentials configured, each integration has separate OAuth state, scope, callback, encrypted refresh token, cursor, and worker path.

Calendar uses `calendar.readonly`, persists per-calendar incremental tokens, includes deletes, and falls back to a full sync on HTTP 410. Gmail uses `gmail.metadata`, keeps only bounded message IDs/headers that match supported timing cues, uses `users.history.list`, and falls back to a bounded full sync on HTTP 404. The implementation follows Google's [Calendar incremental sync guide](https://developers.google.com/workspace/calendar/api/guides/sync) and [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync).

Talk uses `POST /v1/responses` through the backend. Character generation uses the image edit endpoint with the user's private photo for the baseline and the approved baseline for later activities, then saves returned bytes locally. The coded SVG remains the no-key fallback. Models are configurable because availability changes. See OpenAI's [text generation](https://developers.openai.com/api/docs/guides/text), [image generation](https://developers.openai.com/api/docs/guides/image-generation), and [API authentication](https://developers.openai.com/api/reference/overview) documentation.

### Photo-based avatar flow

Character Studio accepts a private PNG, JPEG, or WebP reference photo up to 8 MB. The server stores it under `data/assets/`, never exposes its storage path, and sends it to the configured image model only when the user requests a baseline. Baseline candidates must be approved before activity art can generate. Each activity request uses that approved baseline as its primary reference, saves the result privately, and reuses the selected image on later occurrences. Studying and running are separate cache keys. A failed generation falls back to the approved baseline; deleting avatar data removes both metadata and local files.

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

Route families implemented:

- imports and sourced profile facts, including edit/remove conflicts;
- Home and read-only twin days/activity reports;
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

## Verification status and known gaps

Automated domain tests cover malformed import/no partial application, canonical idempotency hashes, explicit-versus-tentative memory, deletion precedence, non-overlapping simulated activities, report-to-tomorrow behavior, immutable version generation, and DST conversion. `npm run check` covers server, worker, and browser JavaScript syntax.

Live OpenAI, Calendar, Gmail, and generated-image calls require user credentials and were not exercised in the credential-free build environment. Their adapters, provider error states, encryption boundary, and demo paths are implemented. OAuth verification/security assessment may be required for a public Gmail release. The pitch deck was outside the workspace's readable filesystem, so the interface follows the exact visual tokens and constraints in the supplied plan rather than claiming pixel-level deck screenshot comparison. No deck artwork is bundled; the original coded SVG avatar has no external art-license dependency.

PostgreSQL storage and the migration runner are implemented. Real PostgreSQL verification
must be run with a dedicated test database; it is skipped when TEST_DATABASE_URL is absent.
Remaining deployment gaps are detailed in [database setup](db/README.md), including
authentication, tenant isolation, scoped repositories, durable worker recovery, and
tested backup/restore. Do not deploy this local prototype as-is.
