import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

// Private image files live under one root, one folder per user:
//   <TWIN_ASSET_DIR>/<user_id>/<asset_id>.<ext>
// Records store only the relative key ("<user_id>/<asset_id>.<ext>"), so the
// root can move (laptop, Docker volume, object storage) without rewriting data,
// and deleting one user's images is one folder.
const keyPattern = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(?:png|jpg|webp)$/;
const segmentPattern = /^[A-Za-z0-9_-]+$/;

export function assetRoot() {
  return resolve(process.env.TWIN_ASSET_DIR || "./data/assets");
}

export function assetPath(storageKey: string) {
  // Older records saved a full path, or ./data/assets/<file>. Their files sit
  // directly in the root, so only the file name is trusted.
  if (isAbsolute(storageKey) || storageKey.startsWith("./") || !storageKey.includes("/"))
    return join(assetRoot(), basename(storageKey));
  if (!keyPattern.test(storageKey)) throw new Error("ASSET_KEY_INVALID");
  return join(assetRoot(), storageKey);
}

export async function saveUserAsset(
  userId: string,
  assetId: string,
  extension: "png" | "jpg" | "webp",
  bytes: Uint8Array,
) {
  if (!segmentPattern.test(userId) || !segmentPattern.test(assetId))
    throw new Error("ASSET_KEY_INVALID");
  const storageKey = `${userId}/${assetId}.${extension}`;
  await mkdir(join(assetRoot(), userId), { recursive: true, mode: 0o700 });
  await writeFile(assetPath(storageKey), bytes, { mode: 0o600 });
  return storageKey;
}

export function readAsset(storageKey: string) {
  return readFile(assetPath(storageKey));
}

// Best effort: a missing file or unreadable key never blocks a deletion.
export async function removeAsset(storageKey: string) {
  try {
    await unlink(assetPath(storageKey));
  } catch {
    // Already gone or not a valid key.
  }
}

// Removes the user's folder plus any older files listed by their records.
export async function removeUserAssets(userId: string, storageKeys: string[]) {
  await Promise.all(storageKeys.map(removeAsset));
  if (segmentPattern.test(userId))
    await rm(join(assetRoot(), userId), { recursive: true, force: true });
}
