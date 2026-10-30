import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import {
  collections,
  databasePool,
  emptyState,
  readState,
  validateState,
  writeChanges,
} from "./postgres.ts";
import { migrateState } from "./store.ts";

export async function importLegacy(pool: any, file: string) {
  // Read-only: never rename, rewrite, or remove the original.
  const bytes = await readFile(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const state = migrateState(JSON.parse(bytes.toString("utf8")));
  validateState(state);
  for (const asset of state.avatar_assets)
    if (asset.storage_key) await access(resolve(asset.storage_key));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(841731)");
    const imported = await client.query("SELECT 1 FROM twin.legacy_imports WHERE sha256=$1", [sha]);
    if (imported.rows.length) {
      await client.query("COMMIT");
      return { alreadyImported: true };
    }
    const before = await readState(client);
    if (collections.some((key) => before[key].length) || Object.keys(before.idempotency).length)
      throw new Error("DESTINATION_NOT_EMPTY");
    await writeChanges(client, emptyState(), state);
    if (!isDeepStrictEqual(await readState(client), state)) throw new Error("ROUND_TRIP_MISMATCH");
    const counts = Object.fromEntries(collections.map((key) => [key, state[key].length]));
    await client.query("INSERT INTO twin.legacy_imports(sha256,counts) VALUES($1,$2)", [
      sha,
      JSON.stringify(counts),
    ]);
    await client.query("COMMIT");
    return { alreadyImported: false, verified: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
if (process.argv[1]?.endsWith("/import-json.ts")) {
  let pool: any;
  try {
    pool = databasePool();
    const result = await importLegacy(pool, resolve(process.argv[2] ?? "data/twin.json"));
    console.log(
      result.alreadyImported
        ? "This file was already imported; no changes made."
        : "Import committed and every record verified. Original file unchanged.",
    );
  } catch {
    console.error(
      "Import not completed. Check source format, private asset files, database connection, and that destination is empty. No partial import was committed.",
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
