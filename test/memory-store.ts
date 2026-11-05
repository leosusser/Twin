import { seedState } from "../src/storage/store.ts";
import { collections, emptyState, validateState } from "../src/storage/postgres.ts";
import type { AppState } from "../src/domain/types.ts";
// Test double only. The server and worker exclusively construct PostgresStore.
// Mirrors PostgresStore: a root view of every user, and forUser() views that read
// and write only one user's records. Replay (idempotency) records are kept per
// owner, like the Postgres (user_id, key) primary key.
const fixtures = new Map<string, AppState>();
const replays = new Map<string, Map<string, { owner: string; key: string; payload: unknown }>>();
const transactionTails = new Map<string, Promise<void>>();
const replayId = (owner: string, key: string) => `${owner}\0${key}`;
function ownerOf(collection: string, row: any): string {
  return collection === "users" ? row.id : row.user_id;
}
function rootReplayOwner(state: AppState, payload: any) {
  if (typeof payload?.user_id === "string") return payload.user_id as string;
  if (state.users.length === 1) return state.users[0].id;
  throw new Error("IDEMPOTENCY_OWNER_UNKNOWN");
}
export class MemoryStore {
  key: string;
  userId?: string;
  constructor(key: string, userId?: string) {
    this.key = key;
    this.userId = userId;
  }
  async init() {
    if (!fixtures.has(this.key)) {
      const state = seedState();
      const map = new Map();
      for (const [key, payload] of Object.entries(state.idempotency)) {
        const owner = rootReplayOwner(state, payload);
        map.set(replayId(owner, key), { owner, key, payload });
      }
      state.idempotency = {};
      fixtures.set(this.key, state);
      replays.set(this.key, map);
    }
    return this;
  }
  forUser(userId: string) {
    if (this.userId && this.userId !== userId) throw new Error("STORE_ALREADY_SCOPED");
    return this.userId ? this : new MemoryStore(this.key, userId);
  }
  async snapshot(): Promise<AppState> {
    const full = structuredClone(fixtures.get(this.key)!);
    const entries = [...replays.get(this.key)!.values()];
    if (!this.userId) {
      full.idempotency = Object.fromEntries(
        entries.map((entry) => [entry.key, structuredClone(entry.payload)]),
      );
      return full;
    }
    const scoped = emptyState();
    for (const collection of collections)
      (scoped as any)[collection] = (full[collection] as any[]).filter(
        (row) => ownerOf(collection, row) === this.userId,
      );
    for (const entry of entries)
      if (entry.owner === this.userId)
        scoped.idempotency[entry.key] = structuredClone(entry.payload) as any;
    return scoped;
  }
  async transaction<T>(fn: (state: AppState) => T | Promise<T>) {
    const prior = transactionTails.get(this.key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    transactionTails.set(this.key, tail);
    await prior;
    try {
      const before = await this.snapshot();
      const draft = structuredClone(before);
      const result = await fn(draft);
      if (this.userId) this.commitScoped(before, draft, this.userId);
      else this.commitRoot(before, draft);
      return result;
    } finally {
      release();
      if (transactionTails.get(this.key) === tail) transactionTails.delete(this.key);
    }
  }
  private commitRoot(before: AppState, draft: AppState) {
    const map = replays.get(this.key)!;
    const changed = JSON.stringify(before.idempotency) !== JSON.stringify(draft.idempotency);
    if (changed && draft.users.length > 1) throw new Error("IDEMPOTENCY_NEEDS_USER_SCOPE");
    if (changed) {
      for (const [id, entry] of map) if (!(entry.key in draft.idempotency)) map.delete(id);
      for (const [key, payload] of Object.entries(draft.idempotency)) {
        if (JSON.stringify(payload) === JSON.stringify(before.idempotency[key])) continue;
        const owner = rootReplayOwner(draft, payload);
        map.set(replayId(owner, key), { owner, key, payload });
      }
    }
    fixtures.set(this.key, { ...draft, idempotency: {} });
  }
  private commitScoped(before: AppState, draft: AppState, userId: string) {
    validateState(draft, userId);
    const full = fixtures.get(this.key)!;
    const merged = structuredClone(full);
    for (const collection of collections) {
      const others = (full[collection] as any[]).filter(
        (row) => ownerOf(collection, row) !== userId,
      );
      // Same rule as the Postgres upsert: an id another user owns cannot be taken over.
      if (collection !== "observations") {
        const foreign = new Set(others.map((row) => String(row.id ?? row.user_id)));
        for (const row of draft[collection] as any[])
          if (foreign.has(String(row.id ?? row.user_id))) throw new Error("RECORD_OUTSIDE_SCOPE");
      }
      (merged as any)[collection] = [...others, ...(draft[collection] as any[])];
    }
    const map = replays.get(this.key)!;
    for (const key of Object.keys(before.idempotency)) map.delete(replayId(userId, key));
    for (const [key, payload] of Object.entries(draft.idempotency))
      map.set(replayId(userId, key), { owner: userId, key, payload });
    fixtures.set(this.key, merged);
  }
  async userIds() {
    return fixtures
      .get(this.key)!
      .users.map((user) => user.id)
      .sort();
  }
  async dueJobUserIds(now: Date) {
    const due = fixtures
      .get(this.key)!
      .jobs.filter(
        (job) =>
          (job.status === "queued" && new Date(job.run_after) <= now) ||
          (job.status === "running" &&
            Boolean(job.locked_until) &&
            new Date(job.locked_until!) <= now),
      );
    return [...new Set(due.map((job) => job.user_id))];
  }
  async allSettings() {
    return structuredClone(fixtures.get(this.key)!.settings);
  }
  async existingJobKeys(dedupeKeys: string[]) {
    const wanted = new Set(dedupeKeys);
    return new Set(
      fixtures
        .get(this.key)!
        .jobs.map((job) => job.dedupe_key)
        .filter((key) => Boolean(key) && wanted.has(key)),
    );
  }
}
