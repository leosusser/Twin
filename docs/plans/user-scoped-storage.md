# User-scoped storage

Status: implemented (see Verification).

## Goal

Every request and job reads and locks only its own user's rows, so adding users does not slow
anyone down, users never wait on each other's writes, and one user's data is easy to find,
export, or delete.

## Context

- Tables already hold one row per record with an indexed `user_id` and a `users` table.
- `PostgresStore.snapshot()` and `transaction()` read every row of every user (19 queries) and
  `transaction()` takes one database-wide lock, so cost grows with the total user count and all
  writes queue behind each other.
- `idempotency` rows have no owner, and `observations` use the global row position as their
  primary key, so two users would collide.
- Only three places work across users: the worker's job loop, morning-plan queuing, and the
  shared default calendar.

## Decisions

1. `store.forUser(userId)` returns a store with the same `snapshot()`/`transaction()`
   interface whose state holds only that user's rows. Existing route and job code keeps working
   unchanged on the scoped store; the router and each job get scoped once at the top.
2. A scoped read is one round trip: a single `UNION ALL` over every table filtered by the
   indexed `user_id`. Writes stay as row diffs, so only changed rows are written.
3. Locks: a scoped transaction takes a shared global lock plus an exclusive per-user lock
   (`pg_advisory_xact_lock(841732, hashtext(user_id))`). Different users run in parallel. The
   root (all-users) transaction keeps the exclusive global lock, so admin tools and
   migrations still exclude everyone.
4. A scoped write rejects any row whose owner is not the scoped user, so a bug cannot write
   another user's data.
5. Migration 003: `idempotency` gains `user_id` and the primary key `(user_id, key)`;
   observation keys become `<user_id>:<n>`; positions are renumbered per user; indexes for due
   jobs and job dedupe keys.
6. Worker: one query finds users with due or expired jobs, then each user's jobs run on that
   user's scoped store. Morning-plan queuing reads only the small settings table, skips users
   who already have today's morning job (one indexed query), and runs at most once a minute.
7. Deliberately not done: per-screen partial reads. With per-user loading, a request's cost
   depends only on that one user's data size, which retention keeps bounded. Narrower reads for
   Home can come later if one user's data grows large.

## Done when

- Router and jobs use scoped stores; cross-user code uses `userIds()`, `dueJobUserIds()`,
  `allSettings()`, and `existingJobKeys()`.
- Tests prove: a scoped snapshot excludes other users; a scoped write cannot touch other users;
  deleting one account leaves other users intact; two users' idempotency keys do not collide;
  jobs for two users both run.
- `npm run verify` passes and `npm run test:postgres` passes against a disposable database.

## Verification

- `npm run verify`: pass.
- `npm run test:postgres` on a disposable Docker PostgreSQL 16: pass, including the 003
  upgrade of a two-user version-2 database, separate replay keys, a held user-A transaction
  not blocking user B, and deleting user A leaving user B unchanged.
- Benchmark, 300 demo-sized users: one-user load 1.7 ms vs 41.0 ms all-users; one-user save
  2.3 ms vs 60.5 ms.
- Remaining: users who finished a morning check-in are rechecked once a minute until the day
  ends (cheap, one-user read); login still does not exist, so `DEMO_USER_ID` is the only user.
