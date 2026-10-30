import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { processJobs } from "../src/worker.ts";
import { cancelAvatarRequest } from "../src/services/avatar-cancellation.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";
import { DEMO_USER_ID } from "../src/storage/store.ts";
import { MemoryStore } from "./memory-store.ts";

test("avatar image edits keep identity first and supply the bundled style reference second", async () => {
  const store = await new MemoryStore(`avatar-worker-${randomUUID()}`).init();
  const identityPath = `./data/assets/test-identity-${randomUUID()}.png`;
  const priorActivityPath = `./data/assets/test-prior-activity-${randomUUID()}.png`;
  const generatedPaths: string[] = [];
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  const calls: Array<{
    names: string[];
    prompt: string;
    quality: string | null;
    background: string | null;
    outputFormat: string | null;
  }> = [];

  try {
    await mkdir(dirname(identityPath), { recursive: true });
    await writeFile(identityPath, Buffer.from("identity"));
    await writeFile(priorActivityPath, Buffer.from("prior activity"));
    process.env.TWIN_ENCRYPTION_KEY = "avatar-worker-test-encryption-key";

    await store.transaction((draft) => {
      draft.model_connections[0].encrypted_key = encryptSecret("test-provider-key");
      draft.model_connections[0].status = "connected";
      draft.avatar_assets.push(
        {
          id: "identity-photo",
          user_id: DEMO_USER_ID,
          design_version: 1,
          parent_asset_ids: [],
          kind: "source_photo",
          prompt_version: 1,
          model: "user_upload",
          storage_key: identityPath,
          mime: "image/png",
          status: "ready",
          created_at: new Date().toISOString(),
        },
        {
          id: "prior-activity",
          user_id: DEMO_USER_ID,
          design_version: 1,
          parent_asset_ids: ["identity-photo"],
          kind: "activity",
          activity_key: "running",
          prompt_version: 2,
          model: "test",
          storage_key: priorActivityPath,
          mime: "image/png",
          status: "ready",
          created_at: new Date().toISOString(),
        },
      );
      draft.avatar_requests.push({
        id: "baseline-request",
        user_id: DEMO_USER_ID,
        source: "studio",
        purpose: "baseline",
        requested_change: "Create the neutral standing baseline avatar.",
        reference_design_version: 1,
        reference_asset_ids: ["identity-photo"],
        idempotency_key: "baseline-style-test",
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      draft.jobs.push({
        id: "baseline-job",
        user_id: DEMO_USER_ID,
        type: "avatar_generation",
        dedupe_key: "avatar:baseline-style-test",
        status: "queued",
        attempts: 0,
        run_after: new Date(0).toISOString(),
        payload: { request_id: "baseline-request" },
      });
    });

    globalThis.fetch = async (_url, options) => {
      const form = options?.body as FormData;
      calls.push({
        names: form.getAll("image[]").map((entry) => (entry as File).name),
        prompt: String(form.get("prompt")),
        quality: form.get("quality") === null ? null : String(form.get("quality")),
        background: form.get("background") === null ? null : String(form.get("background")),
        outputFormat: form.get("output_format") === null ? null : String(form.get("output_format")),
      });
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("generated-image").toString("base64") }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await processJobs(store);
    let state = await store.snapshot();
    const baseline = state.avatar_assets.find(
      (asset) => asset.kind === "base" && asset.model !== "test",
    );
    assert.ok(baseline?.storage_key);
    generatedPaths.push(baseline.storage_key);
    assert.deepEqual(calls[0].names, ["identity-reference.png", "style-reference.png"]);
    assert.equal(calls[0].quality, "medium");
    assert.equal(calls[0].background, "transparent");
    assert.equal(calls[0].outputFormat, "png");
    assert.match(calls[0].prompt, /Image 1 is the IDENTITY REFERENCE/);
    assert.match(calls[0].prompt, /Image 2 is the STYLE REFERENCE/);
    assert.match(calls[0].prompt, /Do not copy that character's specific face, curly hair/);
    assert.match(calls[0].prompt, /apparent age, and visible body proportions/);
    assert.match(calls[0].prompt, /light, natural-looking glamour retouching/);
    assert.match(calls[0].prompt, /retains natural texture/);
    assert.match(calls[0].prompt, /not airbrushed or transformed/);
    assert.match(calls[0].prompt, /freckles, moles, or scars/);
    assert.match(calls[0].prompt, /do not change facial structure/);
    assert.match(calls[0].prompt, /fully transparent background/);
    assert.match(calls[0].prompt, /Do not add a backdrop, floor plane, border, frame/);
    assert.equal(baseline.prompt_version, 5);
    assert.equal((await stat(baseline.storage_key)).mode & 0o777, 0o600);

    await store.transaction((draft) => {
      draft.avatar_requests.push({
        id: "activity-request",
        user_id: DEMO_USER_ID,
        source: "studio",
        purpose: "activity",
        requested_change: "running with a natural athletic stride",
        requested_activity_key: "running",
        reference_design_version: 1,
        reference_asset_ids: [baseline.id, "prior-activity"],
        idempotency_key: "activity-style-test",
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      draft.jobs.push({
        id: "activity-job",
        user_id: DEMO_USER_ID,
        type: "avatar_generation",
        dedupe_key: "avatar:activity-style-test",
        status: "queued",
        attempts: 0,
        run_after: new Date(0).toISOString(),
        payload: { request_id: "activity-request" },
      });
    });

    await processJobs(store);
    state = await store.snapshot();
    const activity = state.avatar_assets.find(
      (asset) => asset.kind === "activity" && asset.model !== "test",
    );
    assert.ok(activity?.storage_key);
    generatedPaths.push(activity.storage_key);
    assert.deepEqual(calls[1].names, [
      "identity-reference.png",
      "style-reference.png",
      "previous-activity-reference.png",
    ]);
    assert.match(calls[1].prompt, /approved baseline avatar and the primary authority/);
    assert.match(calls[1].prompt, /Image 3 is present/);
    assert.match(calls[1].prompt, /running with a natural athletic stride/);
    assert.deepEqual(activity.parent_asset_ids, [baseline.id, "prior-activity"]);
    assert.match(calls[1].prompt, /light, natural-looking glamour retouching/);
    assert.equal(activity.prompt_version, 5);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
    await Promise.all(
      [identityPath, priorActivityPath, ...generatedPaths].map((path) =>
        unlink(path).catch(() => {}),
      ),
    );
  }
});

test("a missing bundled style reference fails once before calling the image provider", async () => {
  const store = await new MemoryStore(`avatar-worker-missing-style-${randomUUID()}`).init();
  const identityPath = `./data/assets/test-identity-${randomUUID()}.png`;
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;

  try {
    await mkdir(dirname(identityPath), { recursive: true });
    await writeFile(identityPath, Buffer.from("identity"));
    process.env.TWIN_ENCRYPTION_KEY = "avatar-worker-test-encryption-key";
    globalThis.fetch = async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    };
    await store.transaction((draft) => {
      draft.model_connections[0].encrypted_key = encryptSecret("test-provider-key");
      draft.avatar_assets.push({
        id: "identity-photo",
        user_id: DEMO_USER_ID,
        design_version: 1,
        parent_asset_ids: [],
        kind: "source_photo",
        prompt_version: 1,
        model: "user_upload",
        storage_key: identityPath,
        mime: "image/png",
        status: "ready",
        created_at: new Date().toISOString(),
      });
      draft.avatar_requests.push({
        id: "missing-style-request",
        user_id: DEMO_USER_ID,
        source: "studio",
        purpose: "baseline",
        requested_change: "Create the neutral standing baseline avatar.",
        reference_design_version: 1,
        reference_asset_ids: ["identity-photo"],
        idempotency_key: "missing-style-test",
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      draft.jobs.push({
        id: "missing-style-job",
        user_id: DEMO_USER_ID,
        type: "avatar_generation",
        dedupe_key: "avatar:missing-style-test",
        status: "queued",
        attempts: 0,
        run_after: new Date(0).toISOString(),
        payload: { request_id: "missing-style-request" },
      });
    });

    await processJobs(store, {
      avatarStyleReferencePath: `./data/style-references/missing-${randomUUID()}.png`,
    });
    const state = await store.snapshot();
    const job = state.jobs.find((item) => item.id === "missing-style-job");
    const request = state.avatar_requests.find((item) => item.id === "missing-style-request");
    assert.equal(providerCalls, 0);
    assert.equal(job?.attempts, 1);
    assert.equal(job?.status, "failed");
    assert.equal(job?.last_error_code, "AVATAR_STYLE_REFERENCE_MISSING");
    assert.equal(request?.status, "failed");
    assert.equal(request?.failure_code, "AVATAR_STYLE_REFERENCE_MISSING");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
    await unlink(identityPath).catch(() => {});
  }
});

test("stopping an in-flight baseline aborts the provider request and saves no image", async () => {
  const store = await new MemoryStore(`avatar-worker-cancel-${randomUUID()}`).init();
  const identityPath = `./data/assets/test-identity-${randomUUID()}.png`;
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });

  try {
    await mkdir(dirname(identityPath), { recursive: true });
    await writeFile(identityPath, Buffer.from("identity"));
    process.env.TWIN_ENCRYPTION_KEY = "avatar-worker-test-encryption-key";
    await store.transaction((draft) => {
      draft.model_connections[0].encrypted_key = encryptSecret("test-provider-key");
      draft.avatar_assets.push({
        id: "cancel-identity-photo",
        user_id: DEMO_USER_ID,
        design_version: 1,
        parent_asset_ids: [],
        kind: "source_photo",
        prompt_version: 1,
        model: "user_upload",
        storage_key: identityPath,
        mime: "image/png",
        status: "ready",
        created_at: new Date().toISOString(),
      });
      draft.avatar_requests.push({
        id: "in-flight-baseline-request",
        user_id: DEMO_USER_ID,
        source: "studio",
        purpose: "baseline",
        requested_change: "Create another baseline avatar.",
        reference_design_version: 1,
        reference_asset_ids: ["cancel-identity-photo"],
        idempotency_key: "in-flight-cancel-test",
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      draft.jobs.push({
        id: "in-flight-baseline-job",
        user_id: DEMO_USER_ID,
        type: "avatar_generation",
        dedupe_key: "avatar:in-flight-cancel-test",
        status: "queued",
        attempts: 0,
        run_after: new Date(0).toISOString(),
        payload: { request_id: "in-flight-baseline-request" },
      });
    });
    globalThis.fetch = async (_url, options) => {
      providerStarted();
      return await new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    };

    const processing = processJobs(store);
    await started;
    assert.equal(cancelAvatarRequest("in-flight-baseline-request"), true);
    await processing;

    const state = await store.snapshot();
    assert.equal(
      state.avatar_requests.find((item) => item.id === "in-flight-baseline-request")?.failure_code,
      "AVATAR_CANCELLED",
    );
    assert.equal(
      state.jobs.find((item) => item.id === "in-flight-baseline-job")?.last_error_code,
      "AVATAR_CANCELLED",
    );
    assert.equal(
      state.avatar_assets.some((item) => item.kind === "base" && item.model !== "test"),
      false,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
    await unlink(identityPath).catch(() => {});
  }
});
