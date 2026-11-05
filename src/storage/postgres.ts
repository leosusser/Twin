import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { AppState } from "../domain/types.ts";
import { selectTalkContext } from "./context.ts";

export const collections = [
  "users",
  "settings",
  "imports",
  "observations",
  "facts",
  "memory_overrides",
  "integrations",
  "calendar_events",
  "gmail_cues",
  "twin_days",
  "activity_reports",
  "model_connections",
  "conversations",
  "messages",
  "voice_sessions",
  "avatar_designs",
  "avatar_assets",
  "avatar_requests",
  "jobs",
] as const;
export function emptyState(): AppState {
  return Object.fromEntries([
    ...collections.map((key) => [key, []]),
    ["idempotency", {}],
  ]) as unknown as AppState;
}
export function databasePool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const pg = createRequire(import.meta.url)("pg");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", () => console.error("DATABASE_CONNECTION_ERROR"));
  return pool;
}
// `scope` set: every record must belong to that one user (a scoped write cannot
// touch anyone else's rows).
export function validateState(state: AppState, scope?: string) {
  if (
    !state ||
    typeof state !== "object" ||
    Object.keys(state).some((k) => ![...collections, "idempotency"].includes(k as any))
  )
    throw new Error("UNSUPPORTED_STATE_SHAPE");
  const users = new Set(state.users?.map((u) => u.id));
  if (scope && [...users].some((id) => id !== scope)) throw new Error("RECORD_OUTSIDE_SCOPE");
  for (const key of collections) {
    if (!Array.isArray(state[key])) throw new Error("INVALID_STATE_COLLECTION");
    const ids = new Set<string>();
    for (const row of state[key] as any[]) {
      const id = key === "observations" ? null : (row.id ?? row.user_id);
      if (!row || typeof row !== "object" || (key !== "users" && !users.has(row.user_id)))
        throw new Error("INVALID_RECORD_OWNER");
      if (key !== "observations" && (typeof id !== "string" || ids.has(id)))
        throw new Error("DUPLICATE_OR_MISSING_RECORD_ID");
      if (id) ids.add(id);
    }
  }
  if (
    !state.idempotency ||
    Array.isArray(state.idempotency) ||
    typeof state.idempotency !== "object"
  )
    throw new Error("INVALID_IDEMPOTENCY");
}
function ownerOf(key: (typeof collections)[number], payload: any): string {
  return key === "users" ? payload.id : payload.user_id;
}
// All users' records. Admin tools and tests only; the app reads through forUser().
export async function readState(client: any): Promise<AppState> {
  const state = emptyState();
  for (const key of collections)
    (state as any)[key] = (
      await client.query(`SELECT payload FROM twin.${key} ORDER BY user_id, position`)
    ).rows.map((r: any) => r.payload);
  state.idempotency = Object.fromEntries(
    (await client.query("SELECT key,payload FROM twin.idempotency ORDER BY user_id, key")).rows.map(
      (r: any) => [r.key, r.payload],
    ),
  );
  return state;
}
// One round trip: every table filtered by the indexed user_id column.
const userStateSql =
  [
    ...collections.map(
      (key) => `SELECT '${key}' AS c, key, position, payload FROM twin.${key} WHERE user_id = $1`,
    ),
    "SELECT 'idempotency' AS c, key, 0 AS position, payload FROM twin.idempotency WHERE user_id = $1",
  ].join(" UNION ALL ") + " ORDER BY c, position, key";
export async function readUserState(client: any, userId: string): Promise<AppState> {
  const state = emptyState();
  for (const row of (await client.query(userStateSql, [userId])).rows) {
    if (row.c === "idempotency") state.idempotency[row.key] = row.payload;
    else (state as any)[row.c].push(row.payload);
  }
  return state;
}
// Row identity and order are computed per owner, so a one-user view and the
// all-users view agree on every key and position.
function rows(state: AppState, key: (typeof collections)[number]) {
  const counts = new Map<string, number>();
  return new Map(
    (state[key] as any[]).map((payload) => {
      const owner = ownerOf(key, payload);
      const position = counts.get(owner) ?? 0;
      counts.set(owner, position + 1);
      return [
        key === "observations" ? `${owner}:${position}` : String(payload.id ?? payload.user_id),
        { payload, position },
      ];
    }),
  );
}
function idempotencyOwner(payload: any, state: AppState, scope?: string) {
  if (scope) return scope;
  if (typeof payload?.user_id === "string") return payload.user_id as string;
  if (state.users.length === 1) return state.users[0].id;
  throw new Error("IDEMPOTENCY_OWNER_UNKNOWN");
}
export async function writeChanges(client: any, before: AppState, after: AppState, scope?: string) {
  validateState(after, scope);
  for (const key of collections) {
    const previous = rows(before, key),
      next = rows(after, key);
    for (const id of previous.keys())
      if (!next.has(id))
        await client.query(
          scope
            ? `DELETE FROM twin.${key} WHERE key=$1 AND user_id=$2`
            : `DELETE FROM twin.${key} WHERE key=$1`,
          scope ? [id, scope] : [id],
        );
    for (const [id, row] of next) {
      if (isDeepStrictEqual(previous.get(id), row)) continue;
      // A one-user write may only update rows that user already owns: if the id
      // belongs to someone else, the WHERE fails, no row changes, and we abort.
      const result = await client.query(
        `INSERT INTO twin.${key}(key,user_id,position,payload) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET user_id=EXCLUDED.user_id,position=EXCLUDED.position,payload=EXCLUDED.payload${scope ? ` WHERE twin.${key}.user_id=EXCLUDED.user_id` : ""}`,
        [id, ownerOf(key, row.payload), row.position, JSON.stringify(row.payload)],
      );
      if (scope && result.rowCount === 0) throw new Error("RECORD_OUTSIDE_SCOPE");
    }
  }
  // The all-users view flattens replay keys, so it cannot tell two users' identical
  // keys apart. Only one-user views may change them once there are several users.
  if (!scope && after.users.length > 1 && !isDeepStrictEqual(before.idempotency, after.idempotency))
    throw new Error("IDEMPOTENCY_NEEDS_USER_SCOPE");
  for (const key of Object.keys(before.idempotency))
    if (!(key in after.idempotency))
      await client.query(
        scope
          ? "DELETE FROM twin.idempotency WHERE user_id=$2 AND key=$1"
          : "DELETE FROM twin.idempotency WHERE key=$1",
        scope ? [key, scope] : [key],
      );
  for (const [key, payload] of Object.entries(after.idempotency))
    if (!isDeepStrictEqual(payload, before.idempotency[key]))
      await client.query(
        "INSERT INTO twin.idempotency(user_id,key,payload) VALUES($1,$2,$3) ON CONFLICT(user_id,key) DO UPDATE SET payload=EXCLUDED.payload",
        [idempotencyOwner(payload, after, scope), key, JSON.stringify(payload)],
      );
}
const globalLock = 841731;
const userLockSpace = 841732;
export class PostgresStore {
  pool: any;
  // Set on a store returned by forUser(); undefined on the all-users root store.
  userId?: string;
  constructor(pool = databasePool(), userId?: string) {
    this.pool = pool;
    this.userId = userId;
  }
  async init() {
    await this.pool.query("SELECT version FROM twin.schema_migrations WHERE version=3");
    return this;
  }
  // The same store interface, holding and locking only this user's records.
  forUser(userId: string): PostgresStore {
    if (this.userId && this.userId !== userId) throw new Error("STORE_ALREADY_SCOPED");
    return this.userId ? this : new PostgresStore(this.pool, userId);
  }
  private read(client: any) {
    return this.userId ? readUserState(client, this.userId) : readState(client);
  }
  async snapshot(): Promise<AppState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await this.read(client);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async transaction<T>(mutation: (draft: AppState) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One user's writes wait only for that same user. The all-users root store
      // (admin tools, migrations) still excludes everyone.
      if (this.userId)
        await client.query(
          "SELECT pg_advisory_xact_lock_shared($1::bigint), pg_advisory_xact_lock($2::int, hashtext($3))",
          [globalLock, userLockSpace, this.userId],
        );
      else await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [globalLock]);
      const before = await this.read(client),
        draft = structuredClone(before);
      const result = await mutation(draft);
      await writeChanges(client, before, draft, this.userId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
  async userIds(): Promise<string[]> {
    return (await this.pool.query("SELECT key FROM twin.users ORDER BY key")).rows.map(
      (r: any) => r.key,
    );
  }
  // Users with a job ready to run or a running job whose lock expired.
  async dueJobUserIds(now: Date): Promise<string[]> {
    return (
      await this.pool.query(
        `SELECT DISTINCT user_id FROM twin.jobs
         WHERE payload->>'status' IN ('queued','running')
           AND ((payload->>'status'='queued' AND (payload->>'run_after')::timestamptz <= $1)
             OR (payload->>'status'='running' AND (payload->>'locked_until')::timestamptz <= $1))`,
        [now.toISOString()],
      )
    ).rows.map((r: any) => r.user_id);
  }
  async allSettings(): Promise<AppState["settings"]> {
    return (await this.pool.query("SELECT payload FROM twin.settings")).rows.map(
      (r: any) => r.payload,
    );
  }
  async existingJobKeys(dedupeKeys: string[]): Promise<Set<string>> {
    if (!dedupeKeys.length) return new Set();
    return new Set(
      (
        await this.pool.query(
          "SELECT payload->>'dedupe_key' AS k FROM twin.jobs WHERE payload->>'dedupe_key' = ANY($1)",
          [dedupeKeys],
        )
      ).rows.map((r: any) => r.k),
    );
  }
  async talkContext(userId: string, conversationId: string, text: string) {
    const client = await this.pool.connect(),
      now = new Date();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = emptyState();
      state.facts = (
        await client.query(
          `SELECT payload FROM twin.facts
        WHERE user_id=$1 AND payload->>'status'='active'
        ORDER BY ts_rank(to_tsvector('english',payload->>'statement'),plainto_tsquery('english',$2)) DESC,
        payload->>'updated_at' DESC LIMIT 8`,
          [userId, text],
        )
      ).rows.map((r: any) => r.payload);
      state.messages = (
        await client.query(
          `SELECT payload FROM twin.messages WHERE user_id=$1
        AND payload->>'conversation_id'=$2 ORDER BY payload->>'created_at' DESC LIMIT 6`,
          [userId, conversationId],
        )
      ).rows.map((r: any) => r.payload);
      state.activity_reports = (
        await client.query(
          `SELECT payload FROM twin.activity_reports WHERE user_id=$1
        AND payload->>'created_at'>=$2 AND payload->>'created_at'<=$3
        ORDER BY payload->>'created_at' DESC LIMIT 5`,
          [userId, new Date(now.getTime() - 7 * 86400000).toISOString(), now.toISOString()],
        )
      ).rows.map((r: any) => r.payload);
      state.calendar_events = (
        await client.query(
          `SELECT payload FROM twin.calendar_events WHERE user_id=$1
        AND payload->>'deleted'='false' AND
        ((payload->>'all_day'='true' AND payload->>'start_date'>=$2) OR
         (payload->>'all_day'='false' AND payload->>'start_at'>=$3))
        AND COALESCE(payload->>'start_at',payload->>'start_date')<=$4
        ORDER BY COALESCE(payload->>'start_at',payload->>'start_date') LIMIT 8`,
          [
            userId,
            now.toISOString().slice(0, 10),
            now.toISOString(),
            new Date(now.getTime() + 7 * 86400000).toISOString(),
          ],
        )
      ).rows.map((r: any) => r.payload);
      await client.query("COMMIT");
      return selectTalkContext(state, userId, conversationId, text, now);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
