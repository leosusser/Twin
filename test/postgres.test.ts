import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/storage/migrate.ts";
import { importLegacy } from "../src/storage/import-json.ts";
import {
  PostgresStore,
  initializeLocalProfile,
  migrateState,
  seedState,
} from "../src/storage/store.ts";
import { readFile as readSql } from "node:fs/promises";
import { databasePool } from "../src/storage/postgres.ts";
// Must be a dedicated EMPTY test database: never points at DATABASE_URL implicitly.
test(
  "PostgreSQL imports exactly, survives reconnect, rolls back and serializes writes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const pool = databasePool();
    let dir: string | undefined;
    try {
      const exists = await pool.query("SELECT to_regnamespace('twin') AS name");
      assert.equal(
        exists.rows[0].name,
        null,
        "TEST_DATABASE_URL must point to an empty dedicated database",
      );
      // Upgrade path: a version-2 database with two users gets per-user keys and positions.
      for (const file of ["001_records.sql", "002_voice_sessions.sql"])
        await pool.query(
          await readSql(new URL(`../db/migrations/${file}`, import.meta.url), "utf8"),
        );
      for (const [position, user] of ["user_a", "user_b"].entries()) {
        await pool.query(
          "INSERT INTO twin.users(key,user_id,position,payload) VALUES($1,$1,$2,$3)",
          [user, position, JSON.stringify({ id: user, email: "x", created_at: "2026-01-01" })],
        );
        await pool.query(
          "INSERT INTO twin.observations(key,user_id,position,payload) VALUES($1,$2,$3,$4)",
          [
            String(10 + position),
            user,
            10 + position,
            JSON.stringify({ user_id: user, n: position }),
          ],
        );
        await pool.query("INSERT INTO twin.idempotency(key,payload) VALUES($1,$2)", [
          `oauth:${user}`,
          JSON.stringify({ user_id: user }),
        ]);
      }
      await migrate(pool);
      assert.deepEqual(
        (await pool.query("SELECT key,position FROM twin.observations ORDER BY key")).rows,
        [
          { key: "user_a:0", position: 0 },
          { key: "user_b:0", position: 0 },
        ],
      );
      assert.deepEqual(
        (await pool.query("SELECT user_id,key FROM twin.idempotency ORDER BY key")).rows,
        [
          { user_id: "user_a", key: "oauth:user_a" },
          { user_id: "user_b", key: "oauth:user_b" },
        ],
      );
      const upgraded = new PostgresStore(pool);
      assert.deepEqual((await upgraded.forUser("user_b").snapshot()).observations, [
        { user_id: "user_b", n: 1 },
      ]);
      await pool.query("DROP SCHEMA twin CASCADE");

      await migrate(pool);
      await migrate(pool);
      dir = await mkdtemp(join(tmpdir(), "twin-pg-test-"));
      const path = `${dir}/legacy.json`,
        legacy = seedState(),
        original = JSON.stringify(legacy),
        // The importer fills defaults for older records, so compare with its output.
        state = migrateState(legacy);
      await writeFile(path, original, { mode: 0o600 });
      assert.deepEqual(await importLegacy(pool, path), { alreadyImported: false, verified: true });
      assert.equal(await readFile(path, "utf8"), original);
      assert.deepEqual(await importLegacy(pool, path), { alreadyImported: true });
      const first = await new PostgresStore(pool).init(),
        second = await new PostgresStore(pool).init();
      assert.deepEqual(await first.snapshot(), state);
      await assert.rejects(
        first.transaction((draft) => {
          draft.settings[0].name = "discard";
          throw new Error("rollback");
        }),
      );
      assert.deepEqual(await second.snapshot(), state);
      await Promise.all([
        first.transaction((d) => {
          d.settings[0].version++;
        }),
        second.transaction((d) => {
          d.settings[0].version++;
        }),
      ]);
      assert.equal((await first.snapshot()).settings[0].version, state.settings[0].version + 2);

      // Per-user stores: separate reads, separate replay keys, no cross-user waiting.
      const owner = state.users[0].id;
      const mine = first.forUser(owner),
        theirs = first.forUser("user_two");
      await theirs.transaction((draft) => {
        initializeLocalProfile(draft, "user_two", "UTC");
      });
      assert.deepEqual(
        (await mine.snapshot()).users.map((user) => user.id),
        [owner],
      );
      assert.deepEqual(
        (await theirs.snapshot()).users.map((user) => user.id),
        ["user_two"],
      );
      assert.deepEqual(await first.userIds(), [owner, "user_two"].sort());
      await mine.transaction((draft) => {
        draft.idempotency["talk:same"] = { who: "mine" };
      });
      await theirs.transaction((draft) => {
        draft.idempotency["talk:same"] = { who: "theirs" };
      });
      assert.deepEqual((await mine.snapshot()).idempotency["talk:same"], { who: "mine" });
      assert.deepEqual((await theirs.snapshot()).idempotency["talk:same"], { who: "theirs" });
      await assert.rejects(
        mine.transaction((draft) => {
          initializeLocalProfile(draft, "user_two", "UTC");
        }),
        /RECORD_OUTSIDE_SCOPE/,
      );
      const theirIntegration = (await theirs.snapshot()).integrations[0];
      await assert.rejects(
        mine.transaction((draft) => {
          draft.integrations.push({ ...draft.integrations[0], id: theirIntegration.id });
        }),
        /RECORD_OUTSIDE_SCOPE/,
      );
      assert.deepEqual((await theirs.snapshot()).integrations[0], theirIntegration);
      await assert.rejects(
        first.transaction((draft) => {
          draft.idempotency["root:write"] = { user_id: owner };
        }),
        /IDEMPOTENCY_NEEDS_USER_SCOPE/,
      );
      let releaseMine!: () => void;
      const held = mine.transaction(() => new Promise<void>((resolve) => (releaseMine = resolve)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await theirs.transaction((draft) => {
        draft.settings[0].name = "Second";
      });
      releaseMine();
      await held;
      const theirsBefore = await theirs.snapshot();
      await mine.transaction((draft) => {
        for (const key of Object.keys(draft) as Array<keyof typeof draft>)
          if (Array.isArray(draft[key])) (draft as any)[key] = [];
        draft.idempotency = {};
      });
      assert.deepEqual(await first.userIds(), ["user_two"]);
      assert.deepEqual(await theirs.snapshot(), theirsBefore);
      await pool.end();
      const fresh = await new PostgresStore(databasePool()).init();
      try {
        assert.equal((await fresh.snapshot()).settings[0].name, "Second");
      } finally {
        await fresh.close();
      }
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    } finally {
      if (!pool.ended) await pool.end();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  },
);
