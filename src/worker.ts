import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgresStore, type Store } from "./storage/store.ts";
import { decryptSecret } from "./integrations/secrets.ts";
import { GoogleProblem, syncCalendar, syncGmail } from "./integrations/google.ts";
import { ProviderProblem } from "./integrations/openai.ts";
import {
  asNonEmptyProviderString,
  asProviderObject,
  asProviderObjects,
} from "./integrations/provider-json.ts";
import type { AppState, Job } from "./domain/types.ts";
import {
  calendarNeedsPlanningRefresh,
  planTwinDay,
  queueDueMorningPlans,
} from "./services/day-planning.ts";
import { registerAvatarRequest } from "./services/avatar-cancellation.ts";
import { libraryScene } from "./services/avatar-library.ts";
const avatarStyleReferencePath = fileURLToPath(
  new URL("../data/style-references/running-avatar.png", import.meta.url),
);
const avatarPromptVersion = 5;
type WorkerDependencies = { avatarStyleReferencePath?: string };
let store: PostgresStore;
let timer: ReturnType<typeof setInterval> | undefined;
let processing = false;
export async function startWorker(sharedStore: PostgresStore) {
  if (timer) return timer;
  store = sharedStore;
  console.log("Personal Twin worker started");
  await pollJobs();
  timer = setInterval(() => void pollJobs(), 5_000);
  return timer;
}
async function pollJobs() {
  if (processing) return;
  processing = true;
  try {
    await processJobs();
  } catch {
    console.error("WORKER_POLL_FAILED");
  } finally {
    processing = false;
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await startWorker(await new PostgresStore().init());
export async function processJobs(
  targetStore: Store = store,
  dependencies: WorkerDependencies = {},
) {
  const now = new Date();
  await targetStore.transaction((draft) => {
    queueDueMorningPlans(draft, now);
    for (const job of draft.jobs) {
      if (
        job.status === "running" &&
        job.locked_until &&
        new Date(job.locked_until) <= now &&
        job.attempts >= maxJobAttempts(job)
      ) {
        job.status = "failed";
        job.last_error_code = "JOB_LOCK_EXPIRED";
        delete job.locked_until;
        markFailure(draft, job, "JOB_LOCK_EXPIRED");
      }
    }
  });
  const jobs = (await targetStore.snapshot()).jobs.filter(
    (job) =>
      (job.status === "queued" && new Date(job.run_after) <= now) ||
      (job.status === "running" &&
        Boolean(job.locked_until) &&
        new Date(job.locked_until!) <= now &&
        job.attempts < maxJobAttempts(job)),
  );
  for (const job of jobs) {
    const claimed = await targetStore.transaction((draft) => {
      const item = draft.jobs.find((candidate) => candidate.id === job.id);
      const claimableQueued = item?.status === "queued" && new Date(item.run_after) <= new Date();
      const claimableExpired =
        item?.status === "running" &&
        Boolean(item.locked_until) &&
        new Date(item.locked_until!) <= new Date() &&
        item.attempts < maxJobAttempts(item);
      if (!item || (!claimableQueued && !claimableExpired)) return;
      item.status = "running";
      item.attempts += 1;
      item.locked_until = new Date(Date.now() + 300_000).toISOString();
      return true;
    });
    if (!claimed) continue;
    try {
      await execute(job, targetStore, dependencies);
      await targetStore.transaction((draft) => {
        const item = draft.jobs.find((candidate) => candidate.id === job.id);
        if (!item || item.status !== "running") return;
        item.status = "complete";
        delete item.locked_until;
      });
    } catch (error) {
      const knownProblem = error instanceof GoogleProblem || error instanceof ProviderProblem;
      const code = knownProblem ? error.code : "JOB_FAILED";
      const retryable = knownProblem ? error.retryable : true;
      await targetStore.transaction((draft) => {
        const item = draft.jobs.find((candidate) => candidate.id === job.id);
        if (!item || item.status !== "running") return;
        item.last_error_code = code;
        item.status = !retryable || item.attempts >= maxJobAttempts(item) ? "failed" : "queued";
        item.run_after = new Date(
          Date.now() + Math.min(300_000, 2 ** item.attempts * 2_000),
        ).toISOString();
        delete item.locked_until;
        markFailure(draft, item, code);
      });
    }
  }
}
async function execute(
  job: Job,
  targetStore: Store = store,
  dependencies: WorkerDependencies = {},
) {
  if (job.type === "calendar_sync") return executeCalendar(job, targetStore);
  if (job.type === "gmail_sync") return executeGmail(job, targetStore);
  if (job.type === "twin_day_generation") return executeTwinDay(job, targetStore);
  if (job.type === "avatar_generation") return executeAvatar(job, targetStore, dependencies);
  if (job.type === "cleanup") return executeCleanup(targetStore);
}
export async function executeCalendar(job: Job, targetStore: Store = store) {
  const state = await targetStore.snapshot();
  const connection = state.integrations.find(
    (item) => item.user_id === job.user_id && item.provider === "google_calendar",
  );
  if (!connection)
    throw new GoogleProblem("CALENDAR_CONNECTION_MISSING", "Calendar connection is missing.");
  if (connection.mode === "demo") {
    await targetStore.transaction((draft) => {
      const item = draft.integrations.find((candidate) => candidate.id === connection.id)!;
      item.status = "demo";
      item.last_successful_sync_at = new Date().toISOString();
      item.cursor = `demo-${Date.now()}`;
    });
    return;
  }
  const expectedCredentialVersion = Number(
    job.payload.credential_version ?? connection.credential_version ?? 0,
  );
  if (
    !connection.encrypted_token ||
    expectedCredentialVersion !== (connection.credential_version ?? 0)
  )
    return;
  const result = await syncCalendar(connection, job.user_id);
  await targetStore.transaction((draft) => {
    const item = draft.integrations.find((candidate) => candidate.id === connection.id);
    if (
      !item ||
      item.mode !== "live" ||
      !item.encrypted_token ||
      (item.credential_version ?? 0) !== expectedCredentialVersion
    )
      return;
    const selectedIds = new Set(
      result.selections.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
    );
    const replaceIds = new Set(result.fullSyncCalendarIds);
    draft.calendar_events = draft.calendar_events.filter(
      (event) =>
        event.user_id !== job.user_id ||
        (selectedIds.has(event.calendar_id) && !replaceIds.has(event.calendar_id)),
    );
    for (const event of result.events) {
      const index = draft.calendar_events.findIndex(
        (candidate) =>
          candidate.user_id === job.user_id &&
          candidate.external_id === event.external_id &&
          candidate.calendar_id === event.calendar_id,
      );
      if (index >= 0)
        draft.calendar_events[index] = {
          ...draft.calendar_events[index],
          ...event,
          id: draft.calendar_events[index].id,
        };
      else draft.calendar_events.push(event);
    }
    item.selected_calendars = result.selections;
    item.cursor = result.cursor;
    item.status = "connected";
    item.last_successful_sync_at = new Date().toISOString();
    delete item.failure_code;
  });
}
async function executeGmail(job: Job, targetStore: Store = store) {
  const state = await targetStore.snapshot();
  const connection = state.integrations.find(
    (item) => item.user_id === job.user_id && item.provider === "gmail",
  )!;
  if (connection.mode === "demo") {
    await targetStore.transaction((draft) => {
      const item = draft.integrations.find((candidate) => candidate.id === connection.id)!;
      item.status = "demo";
      item.last_successful_sync_at = new Date().toISOString();
      item.cursor = `demo-history-${Date.now()}`;
    });
    return;
  }
  const result = await syncGmail(connection, job.user_id);
  await targetStore.transaction((draft) => {
    const item = draft.integrations.find((candidate) => candidate.id === connection.id)!;
    for (const cue of result.cues) {
      const index = draft.gmail_cues.findIndex(
        (candidate) =>
          candidate.user_id === job.user_id &&
          candidate.source_message_id === cue.source_message_id,
      );
      if (index >= 0) {
        if (draft.gmail_cues[index].status !== "suppressed")
          draft.gmail_cues[index] = { ...cue, id: draft.gmail_cues[index].id };
      } else draft.gmail_cues.push(cue);
    }
    item.cursor = result.cursor;
    item.status = "connected";
    item.last_successful_sync_at = new Date().toISOString();
  });
}
export async function executeTwinDay(
  job: Job,
  targetStore: Store = store,
  dependencies: Parameters<typeof planTwinDay>[2] = {},
) {
  const trigger = job.payload.trigger;
  if (trigger !== "morning" && trigger !== "after_conversation")
    throw new ProviderProblem(
      "INVALID_PLANNING_TRIGGER",
      "This planning job has an unsupported trigger.",
      422,
      false,
    );
  const localDate = String(job.payload.local_date ?? "");
  if (trigger === "morning") {
    const state = await targetStore.snapshot();
    if (calendarNeedsPlanningRefresh(state, job.user_id)) {
      const connection = state.integrations.find(
        (item) => item.user_id === job.user_id && item.provider === "google_calendar",
      );
      if (connection) {
        const refreshJob: Job = {
          id: `planning-calendar-refresh:${job.id}`,
          user_id: job.user_id,
          type: "calendar_sync",
          dedupe_key: `planning-calendar-refresh:${job.id}`,
          status: "running",
          attempts: 1,
          run_after: new Date().toISOString(),
          payload: { credential_version: connection.credential_version ?? 0 },
        };
        try {
          await executeCalendar(refreshJob, targetStore);
        } catch (error) {
          const code = error instanceof GoogleProblem ? error.code : "CALENDAR_REFRESH_FAILED";
          await targetStore.transaction((draft) => markFailure(draft, refreshJob, code));
        }
      }
    }
  }
  const result = await planTwinDay(
    targetStore,
    {
      userId: job.user_id,
      trigger,
      targetLocalDate: localDate,
      conversationId:
        typeof job.payload.conversation_id === "string" ? job.payload.conversation_id : undefined,
      idempotencyKey: job.dedupe_key,
    },
    dependencies,
  );
  await targetStore.transaction((draft) => {
    const item = draft.jobs.find(
      (candidate) => candidate.id === job.id && candidate.user_id === job.user_id,
    );
    if (!item) return;
    item.result = {
      status: result.status,
      day_id: result.day?.id,
      day_version: result.day?.version,
    };
  });
  return result;
}
async function executeAvatar(
  job: Job,
  targetStore: Store = store,
  dependencies: WorkerDependencies = {},
) {
  const requestId = String(job.payload.request_id);
  const state = await targetStore.snapshot();
  const request = state.avatar_requests.find(
    (item) => item.id === requestId && item.user_id === job.user_id,
  );
  if (!request) throw new Error("AVATAR_REQUEST_MISSING");
  const design = state.avatar_designs.find(
    (item) => item.user_id === job.user_id && item.version === request.reference_design_version,
  );
  if (!design) throw new Error("AVATAR_DESIGN_MISSING");
  const automatic = request.source === "automatic_scene" && request.purpose === "activity";
  const outfit = (request.requested_outfit ?? "").trim();
  if (automatic && request.requested_activity_key && request.reference_asset_ids[0]) {
    const hit = libraryScene(
      state,
      job.user_id,
      request.reference_asset_ids[0],
      request.requested_activity_key,
      outfit,
    );
    if (hit) {
      await targetStore.transaction((draft) => {
        const item = draft.avatar_requests.find((candidate) => candidate.id === request.id)!;
        item.status = "ready";
        item.updated_at = new Date().toISOString();
      });
      return;
    }
  }
  const model = state.model_connections.find((item) => item.user_id === job.user_id);
  if (!model?.encrypted_key) throw new Error("OPENAI_KEY_MISSING");
  const [identityAssetId, ...supplementalAssetIds] = request.reference_asset_ids;
  const identity = state.avatar_assets.find(
    (item) =>
      item.id === identityAssetId &&
      item.user_id === job.user_id &&
      item.storage_key &&
      item.status === "ready",
  );
  if (!identity) throw new Error("AVATAR_REFERENCE_MISSING");
  const identityMime = identity.mime ?? "image/png";
  const references: { bytes: Buffer; mime: string; name: string }[] = [
    {
      bytes: await readFile(resolve(identity.storage_key!)),
      mime: identityMime,
      name: `identity-reference.${imageExtension(identityMime)}`,
    },
  ];
  try {
    references.push({
      bytes: await readFile(dependencies.avatarStyleReferencePath ?? avatarStyleReferencePath),
      mime: "image/png",
      name: "style-reference.png",
    });
  } catch {
    throw new ProviderProblem(
      "AVATAR_STYLE_REFERENCE_MISSING",
      "Twin's bundled avatar style reference is unavailable.",
      500,
      false,
    );
  }
  // A previous image only guides composition when it already wears this outfit.
  const priorActivity = state.avatar_assets.find(
    (item) =>
      item.id === supplementalAssetIds[0] &&
      item.user_id === job.user_id &&
      item.storage_key &&
      item.status === "ready" &&
      (item.outfit ?? "").trim() === outfit,
  );
  if (priorActivity) {
    const mime = priorActivity.mime ?? "image/png";
    references.push({
      bytes: await readFile(resolve(priorActivity.storage_key!)),
      mime,
      name: `previous-activity-reference.${imageExtension(mime)}`,
    });
  }
  const activeRequest = registerAvatarRequest(request.id);
  const started = await targetStore.transaction((draft) => {
    const item = draft.avatar_requests.find((candidate) => candidate.id === request.id);
    if (!item || item.status !== "queued") return false;
    item.status = "generating";
    item.updated_at = new Date().toISOString();
    return true;
  });
  if (!started) {
    activeRequest.release();
    throw new ProviderProblem("AVATAR_CANCELLED", "Avatar generation was stopped.", 409, false);
  }
  const form = new FormData();
  form.set("model", process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1-mini");
  for (const reference of references)
    form.append(
      "image[]",
      new Blob([Uint8Array.from(reference.bytes)], { type: reference.mime }),
      reference.name,
    );
  form.set("prompt", avatarPrompt(request.purpose, request.requested_change, outfit));
  form.set("background", "transparent");
  form.set("size", "1024x1536");
  form.set("quality", "medium");
  form.set("output_format", "png");
  form.set(
    "safety_identifier",
    createHash("sha256").update(job.user_id).digest("hex").slice(0, 32),
  );
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${decryptSecret(model.encrypted_key)}` },
      body: form,
      signal: AbortSignal.any([activeRequest.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (error) {
    if (activeRequest.signal.aborted)
      throw new ProviderProblem("AVATAR_CANCELLED", "Avatar generation was stopped.", 409, false);
    throw error;
  } finally {
    activeRequest.release();
  }
  const payload = asProviderObject(await response.json().catch(() => ({})));
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "OPENAI_AUTH_ERROR"
        : response.status === 429
          ? "OPENAI_RATE_OR_QUOTA"
          : response.status === 400
            ? "OPENAI_IMAGE_BAD_REQUEST"
            : "OPENAI_IMAGE_FAILED",
    );
  const encoded = asNonEmptyProviderString(asProviderObjects(payload.data)[0]?.b64_json);
  if (!encoded) throw new Error("IMAGE_OUTPUT_MISSING");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 20_000_000) throw new Error("IMAGE_OUTPUT_TOO_LARGE");
  const assetId = randomUUID();
  const path = resolve(`./data/assets/${assetId}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const saved = await targetStore.transaction((draft) => {
    const item = draft.avatar_requests.find((candidate) => candidate.id === request.id);
    if (!item || item.status !== "generating") return false;
    const now = new Date().toISOString();
    if (request.purpose === "activity" && request.requested_activity_key)
      draft.avatar_assets
        .filter(
          (item) =>
            item.user_id === job.user_id &&
            item.kind === "activity" &&
            item.activity_key === request.requested_activity_key,
        )
        .forEach((item) => {
          delete item.selected_at;
        });
    draft.avatar_assets.push({
      id: assetId,
      user_id: job.user_id,
      design_version: design.version,
      parent_asset_ids: request.reference_asset_ids,
      kind:
        request.purpose === "baseline"
          ? "base"
          : request.purpose === "activity"
            ? "activity"
            : "variant",
      activity_key: request.requested_activity_key,
      ...(request.purpose === "activity" && outfit ? { outfit } : {}),
      prompt_version: avatarPromptVersion,
      model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1-mini",
      storage_key: path,
      mime: "image/png",
      width: 1024,
      height: 1536,
      sha256: checksum,
      status: "ready",
      selected_at: request.purpose === "activity" ? now : undefined,
      created_at: now,
      last_used_at: now,
    });
    item.status = "ready";
    item.updated_at = now;
    return true;
  });
  if (!saved) {
    await unlink(path).catch(() => {});
    throw new ProviderProblem("AVATAR_CANCELLED", "Avatar generation was stopped.", 409, false);
  }
}
async function executeCleanup(targetStore: Store = store) {
  await targetStore.transaction((draft) => {
    const cutoff = new Date();
    draft.messages = draft.messages.filter((message) => {
      const settings = draft.settings.find((item) => item.user_id === message.user_id);
      return (
        !settings ||
        new Date(message.created_at) >
          new Date(cutoff.getTime() - settings.talk_retention_days * 86_400_000)
      );
    });
    const removedVoiceSessionIds = new Set<string>();
    draft.voice_sessions = draft.voice_sessions.filter((session) => {
      const settings = draft.settings.find((item) => item.user_id === session.user_id);
      const retentionCutoff = settings
        ? new Date(cutoff.getTime() - settings.talk_retention_days * 86_400_000)
        : cutoff;
      const retain = new Date(session.created_at) > retentionCutoff;
      if (!retain) removedVoiceSessionIds.add(session.id);
      return retain;
    });
    for (const key of Object.keys(draft.idempotency)) {
      const value = draft.idempotency[key] as { voice_session_id?: unknown } | undefined;
      if (
        [...removedVoiceSessionIds].some(
          (id) =>
            key.includes(`:${id}:`) || key.endsWith(`:${id}`) || value?.voice_session_id === id,
        )
      )
        delete draft.idempotency[key];
    }
  });
}
function maxJobAttempts(job: Job) {
  return job.type === "twin_day_generation" ? 3 : 5;
}
function markFailure(state: AppState, job: Job, code: string) {
  if (job.type === "calendar_sync" || job.type === "gmail_sync") {
    const provider = job.type === "calendar_sync" ? "google_calendar" : "gmail";
    const item = state.integrations.find(
      (candidate) => candidate.user_id === job.user_id && candidate.provider === provider,
    );
    const expectedCredentialVersion = Number(job.payload.credential_version ?? 0);
    if (
      item &&
      (job.payload.credential_version === undefined ||
        (item.credential_version ?? 0) === expectedCredentialVersion)
    ) {
      item.status = code === "GOOGLE_AUTH_EXPIRED" ? "expired" : "failed";
      item.failure_code = code;
    }
  }
  if (job.type === "avatar_generation") {
    const request = state.avatar_requests.find((item) => item.id === job.payload.request_id);
    if (request) {
      request.status = "failed";
      request.failure_code = code;
      request.updated_at = new Date().toISOString();
    }
  }
}
export function avatarPrompt(
  purpose: "baseline" | "activity" | "variant",
  requestedChange: string,
  outfit = "",
) {
  const identityLabel =
    purpose === "baseline"
      ? "Image 1 is the IDENTITY REFERENCE: the user's uploaded photograph."
      : "Image 1 is the IDENTITY REFERENCE: the user's approved baseline avatar and the primary authority for character identity.";
  const priorActivityLabel =
    purpose === "activity"
      ? " If Image 3 is present, it is a previous activity composition reference only; it must not override the approved character in Image 1 or the style in Image 2."
      : "";
  const purposeInstruction =
    purpose === "baseline"
      ? `For the baseline, use a relaxed standing pose and preserve the person's visible clothing unless the request specifies an outfit change. Requested baseline direction: ${requestedChange}`
      : purpose === "activity" && outfit
        ? `For this activity variation, preserve the approved character's face, hair, skin tone, apparent age, body proportions, and rendering style. Dress the character in exactly this outfit for this activity, ignoring the clothing in the reference images: ${outfit}. Change pose, expression, and props only as needed to show this activity clearly and believably: ${requestedChange}`
        : purpose === "activity"
          ? `For this activity variation, preserve the approved character's face, hair, skin tone, apparent age, body proportions, and rendering style. Keep clothing consistent unless the activity or request calls for a change. Change pose, expression, clothing, and props only as needed to show this activity clearly and believably: ${requestedChange}`
          : `Preserve the approved character's identity and rendering style. Apply only this requested variation, keeping clothing consistent unless a change is explicitly requested: ${requestedChange}`;
  const activityClarity =
    purpose === "activity" ? " The requested activity must be visually unmistakable." : "";

  return `Create a full-body 3D animated avatar of the person in the IDENTITY REFERENCE, using the visual style of the STYLE REFERENCE.

${identityLabel}
Image 2 is the STYLE REFERENCE: the supplied running character.${priorActivityLabel}

The STYLE REFERENCE determines the animation style, rendering, softness, character proportions, and level of facial stylization. The IDENTITY REFERENCE determines the person's recognizable appearance.

Preserve the person's face shape and jawline, skin tone, hair color, texture, hairline and hairstyle, eye shape and color when discernible, eyebrows, nose, mouth, facial hair, glasses, apparent age, and visible body proportions. Translate these features into the reference's friendly, polished 3D animation style.

Do not reproduce the style-reference character's identity. Do not copy that character's specific face, curly hair, skin tone, body, or navy running outfit. The output must resemble the uploaded or approved person, and must not automatically make them younger, thinner, more muscular, or otherwise generic.

Present the person at their best with light, natural-looking glamour retouching: use a warm natural expression, confident relaxed posture, flattering studio lighting, gently evened skin rendering that retains natural texture, subtly softened temporary blemishes and under-eye shadows, neat hair, and polished, well-presented clothing. Keep the effect subtle, camera-ready, and recognizably the same person—not airbrushed or transformed. Do not apply narrow generic beauty standards, sexualization, or unrealistic perfection, and do not change facial structure, permanent or distinctive features such as freckles, moles, or scars, skin tone, apparent age, body size or shape, hairline, disability-related features, glasses, or mobility aids.

Use a polished, soft 3D animated character with expressive, gently enlarged eyes, rounded and softly sculpted facial forms, smooth shading, believable skin, detailed sculpted hair appropriate to the person, natural anatomy, and believable hands, limbs, clothing, and shoes. Use recognizable human proportions with a slightly larger head and an approachable animated appearance. Match the reference's degree of stylization without turning the result into a photograph, flat illustration, anime character, plastic-looking doll, or exaggerated caricature.

${purposeInstruction}

Show the entire character, including the complete head, both hands, and both feet, as an isolated cutout on a fully transparent background. Do not add a backdrop, floor plane, border, frame, or opaque background color. Keep the full body comfortably inside the frame with clean transparent edges and soft studio lighting.${activityClarity}

No text, logos, watermarks, borders, interface elements, or extra people.`;
}
function imageExtension(mime: string) {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}
