import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { routeApi } from "../src/api/router.ts";
import { processJobs } from "../src/worker.ts";
import { DEMO_USER_ID, initializeLocalProfile } from "../src/storage/store.ts";
import type { Job } from "../src/domain/types.ts";
import { MemoryStore } from "./memory-store.ts";

const other = "user_other";

async function twoUserStore() {
  const store = await new MemoryStore(`user-scope-${randomUUID()}`).init();
  await store.transaction((draft) => {
    initializeLocalProfile(draft, other, "America/New_York");
  });
  return store;
}

function cleanupJob(userId: string): Job {
  return {
    id: `cleanup-${userId}`,
    user_id: userId,
    type: "cleanup",
    dedupe_key: `cleanup:${userId}`,
    status: "queued",
    attempts: 0,
    run_after: new Date(0).toISOString(),
    payload: {},
  } as Job;
}

test("a user's store sees only that user's records", async () => {
  const store = await twoUserStore();
  const mine = await store.forUser(DEMO_USER_ID).snapshot();
  const theirs = await store.forUser(other).snapshot();
  assert.deepEqual(
    mine.users.map((user) => user.id),
    [DEMO_USER_ID],
  );
  assert.deepEqual(
    theirs.users.map((user) => user.id),
    [other],
  );
  for (const state of [mine, theirs])
    for (const row of [...state.settings, ...state.integrations, ...state.avatar_designs])
      assert.equal(row.user_id, state.users[0].id);
  assert.ok(mine.settings.length && theirs.settings.length);
});

test("a user's transaction cannot write another user's records", async () => {
  const store = await twoUserStore();
  await assert.rejects(
    store.forUser(DEMO_USER_ID).transaction((draft) => {
      initializeLocalProfile(draft, other, "UTC");
    }),
    /RECORD_OUTSIDE_SCOPE/,
  );
  await assert.rejects(
    store.forUser(DEMO_USER_ID).transaction((draft) => {
      draft.settings[0].user_id = other;
    }),
    /INVALID_RECORD_OWNER/,
  );
  assert.throws(() => store.forUser(DEMO_USER_ID).forUser(other), /STORE_ALREADY_SCOPED/);
});

test("deleting one account leaves every other user's data in place", async () => {
  const store = await twoUserStore();
  const before = await store.forUser(other).snapshot();
  const stream = Readable.from([
    Buffer.from(JSON.stringify({ confirmation: "DELETE MY TWIN" })),
  ]) as any;
  stream.method = "DELETE";
  stream.url = "/api/account";
  stream.headers = {};
  const response = {
    status: 0,
    writeHead(status: number) {
      this.status = status;
      return this;
    },
    end() {
      return this;
    },
  };
  await routeApi(stream, response as any, store, {});
  assert.equal(response.status, 200);
  const after = await store.snapshot();
  assert.equal(
    after.users.some((user) => user.id === DEMO_USER_ID),
    false,
  );
  assert.deepEqual(await store.forUser(other).snapshot(), before);
});

test("the worker runs each user's due jobs on that user's own store", async () => {
  const store = await twoUserStore();
  await store.transaction((draft) => {
    draft.jobs.push(cleanupJob(DEMO_USER_ID), cleanupJob(other));
  });
  assert.deepEqual((await store.dueJobUserIds(new Date())).sort(), [other, DEMO_USER_ID].sort());
  await processJobs(store, {}, { queueMorning: false });
  const jobs = (await store.snapshot()).jobs.filter((job) => job.type === "cleanup");
  assert.deepEqual(
    jobs.map((job) => [job.user_id, job.status]).sort(),
    [
      [DEMO_USER_ID, "complete"],
      [other, "complete"],
    ].sort(),
  );
  assert.deepEqual(await store.dueJobUserIds(new Date()), []);
});

test("morning queuing skips users who already have today's morning job", async () => {
  const store = await twoUserStore();
  const settings = await store.allSettings();
  assert.equal(settings.length, 2);
  const keys = settings.map((item) => `plan:${item.user_id}:morning:2026-11-05`);
  await store.transaction((draft) => {
    draft.jobs.push({
      ...cleanupJob(other),
      id: "existing",
      dedupe_key: keys[1],
      status: "complete",
    });
  });
  assert.deepEqual([...(await store.existingJobKeys(keys))], [keys[1]]);
});

test("two users can use the same replay key without overwriting each other", async () => {
  const store = await twoUserStore();
  await store.forUser(DEMO_USER_ID).transaction((draft) => {
    draft.idempotency["talk:same"] = { who: "mine" } as any;
  });
  await store.forUser(other).transaction((draft) => {
    draft.idempotency["talk:same"] = { who: "theirs" } as any;
  });
  assert.deepEqual((await store.forUser(DEMO_USER_ID).snapshot()).idempotency["talk:same"], {
    who: "mine",
  });
  assert.deepEqual((await store.forUser(other).snapshot()).idempotency["talk:same"], {
    who: "theirs",
  });
});

test("a user cannot take over a record id another user owns", async () => {
  const store = await twoUserStore();
  const otherIntegration = (await store.forUser(other).snapshot()).integrations[0];
  await assert.rejects(
    store.forUser(DEMO_USER_ID).transaction((draft) => {
      draft.integrations.push({ ...(draft.integrations[0] as any), id: otherIntegration.id });
    }),
    /RECORD_OUTSIDE_SCOPE/,
  );
  assert.deepEqual((await store.forUser(other).snapshot()).integrations[0], otherIntegration);
});
