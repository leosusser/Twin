# Local PostgreSQL

Run commands from the Twin project root. Stop the old app with Ctrl+C first.
Keep `.env`, its existing `TWIN_ENCRYPTION_KEY`, the original `data/twin.json`,
and `data/assets/` together in a private backup. Do not change the encryption key:
existing encrypted provider credentials need it.

## Start a database

With Docker Desktop running, create a local password and database (macOS zsh):

```bash
read -s "TWIN_DB_PASSWORD?Choose a local database password: "
export TWIN_DB_PASSWORD
docker run --name twin-postgres \
  -e POSTGRES_USER=twin -e POSTGRES_DB=twin \
  -e POSTGRES_PASSWORD="$TWIN_DB_PASSWORD" \
  -p 127.0.0.1:5432:5432 \
  -v twin-postgres-data:/var/lib/postgresql/data \
  -d postgres:16
unset TWIN_DB_PASSWORD
```

On subsequent starts use `docker start twin-postgres`. Do not remove its volume.
Alternatively, create a dedicated database and role on an existing PostgreSQL 16+
installation. Docker's initial superuser role is for local development only.

Add `DATABASE_URL` to the existing ignored `.env`, using the database host, port,
name, username and password you chose. Its format is
`postgresql://USER:URL_ENCODED_PASSWORD@127.0.0.1:5432/twin`.
Never put it in browser code or commit it. Password punctuation must be URL-encoded.
The image files are NOT stored in PostgreSQL.

## Existing Twin data

```bash
npm install
npm run db:migrate
npm run db:import
npm run dev
```

Open http://127.0.0.1:4173/#home.

`db:import` reads `data/twin.json` by default; a different source can be supplied:
`npm run db:import -- /absolute/path/to/backup.json`.
It validates ownership and unique IDs, checks referenced asset files exist, imports all
collections and idempotency records in one transaction, then compares the entire
database round-trip with the migrated input before commit. Original IDs, timestamps,
array order, references, historical versions, and encrypted credentials are retained.
Legacy missing avatar collections/purpose fields receive the same compatibility defaults
as the former JSON adapter. Unknown top-level fields are rejected, not discarded.
The original file is never modified or deleted.

The importer records the file hash in the same transaction. Repeating the same import
is a no-op. A different file is refused if ANY destination records exist. Do not seed
before importing. On failure, no partial records commit. Asset paths remain unchanged:
run from the same project root, and keep private files at their existing paths.
Back up database and files together. The importer will not repair dangling historical
references, rewrite history, or invent missing records.

## Brand-new installation only

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Seeding is explicit and refuses nonempty databases. Startup never silently seeds,
falls back to JSON, or imports private data.

## Checks

```bash
npm run check
npm test
```

Fast API tests use an in-memory test double and mock image results, not paid APIs.
For real PostgreSQL verification create a separate empty database and set
`TEST_DATABASE_URL` in `.env`, then run `npm run test:postgres`.
That test refuses an existing `twin` schema; it leaves the test schema in place for
safety. Use a new empty test database for another run. It checks repeatable migrations,
import equivalence, source-file preservation, rollback, simultaneous writers,
and reads after reconnection. Never use your application database for this test.

## Boundaries before multiple users

This remains a loopback-only, single-user app (`user_demo`), not a hosted service.
Before hosting: add authentication/session security, replace the fixed user identity,
enforce authorization for every route and asset, tenant-scope idempotency keys,
apply row-level security and cross-record ownership constraints, use a least-privilege
application role separate from migrations, and enable transport security.
Add CSRF protection/rate limits, backup/restore drills, secret rotation and key
management, private per-user object storage, retention/deletion guarantees, and
operational monitoring that never logs payloads or credentials.

Replace full-state reads/global write serialization with scoped repositories for
scale. Domain relationships are preserved in JSONB; except for owner foreign keys,
they are not yet enforced by relational foreign keys (some historical references
outlive chat retention). Worker claims are atomic, but robust crash recovery and
exactly-once paid image effects require a leased, fenced job runner and provider
idempotency. Do not run multiple workers in this local version.
