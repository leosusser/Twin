import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assetPath,
  readAsset,
  removeAsset,
  removeUserAssets,
  saveUserAsset,
} from "../src/storage/assets.ts";

async function withAssetRoot(run: (root: string) => Promise<void>) {
  const previous = process.env.TWIN_ASSET_DIR;
  const root = await mkdtemp(join(tmpdir(), "twin-assets-"));
  process.env.TWIN_ASSET_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.TWIN_ASSET_DIR;
    else process.env.TWIN_ASSET_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("assets are saved under a per-user folder with a relative key", async () => {
  await withAssetRoot(async (root) => {
    const key = await saveUserAsset("user_a", "asset-1", "webp", Buffer.from("a"));
    assert.equal(key, "user_a/asset-1.webp");
    assert.equal(assetPath(key), join(root, "user_a", "asset-1.webp"));
    assert.equal((await stat(assetPath(key))).mode & 0o777, 0o600);
    assert.equal((await readAsset(key)).toString(), "a");
  });
});

test("older full-path keys resolve inside the current asset root", async () => {
  await withAssetRoot(async (root) => {
    await writeFile(join(root, "legacy.png"), "old");
    for (const key of [
      "/Users/someone/Downloads/Twin/data/assets/legacy.png",
      "./data/assets/legacy.png",
      "legacy.png",
    ]) {
      assert.equal(assetPath(key), join(root, "legacy.png"));
      assert.equal((await readAsset(key)).toString(), "old");
    }
  });
});

test("keys and ids that could escape the asset root are rejected", async () => {
  await withAssetRoot(async () => {
    for (const key of ["../etc/passwd", "user_a/../../x.png", "user_a/x.exe", "a/b/c.png"])
      assert.throws(() => assetPath(key), /ASSET_KEY_INVALID/);
    await assert.rejects(saveUserAsset("../x", "id", "png", Buffer.from("")), /ASSET_KEY_INVALID/);
    await assert.rejects(
      saveUserAsset("user", "../id", "png", Buffer.from("")),
      /ASSET_KEY_INVALID/,
    );
  });
});

test("deleting one user's images leaves other users' images in place", async () => {
  await withAssetRoot(async (root) => {
    const a = await saveUserAsset("user_a", "one", "webp", Buffer.from("a"));
    const b = await saveUserAsset("user_b", "two", "webp", Buffer.from("b"));
    await writeFile(join(root, "legacy-a.png"), "old");
    await removeUserAssets("user_a", [a, "/old/path/legacy-a.png"]);
    await assert.rejects(stat(join(root, "user_a")));
    await assert.rejects(stat(join(root, "legacy-a.png")));
    assert.equal((await readFile(assetPath(b))).toString(), "b");
    await removeAsset(b);
    await assert.rejects(stat(assetPath(b)));
  });
});
