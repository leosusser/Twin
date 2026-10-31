import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  applyHandoff,
  hashHandoff,
  validateHandoff,
  ValidationProblem,
} from "../domain/imports.ts";
import { activityAt, activityLabel } from "../domain/planner.ts";
import { localDateInZone } from "../domain/time.ts";
import type {
  ActivityKey,
  AppState,
  AvatarGenerationRequest,
  IntegrationConnection,
  ModelConnection,
  TalkPersonalityMode,
} from "../domain/types.ts";
import { decryptSecret, encryptSecret, encryptionReady } from "../integrations/secrets.ts";
import {
  asNonEmptyProviderString,
  asProviderObject,
  asProviderString,
} from "../integrations/provider-json.ts";
import {
  configuredModels,
  createTalkReply,
  extractAvatarCommand,
  extractDirectReport,
  ProviderProblem,
  testOpenAIKey,
} from "../integrations/openai.ts";
import {
  createRealtimeCall,
  realtimeSessionConfig,
  resolveRealtimeConfig,
  selectVoiceContext,
} from "../integrations/openai-realtime.ts";
import {
  planTwinDay,
  planningTargetDateFromConversation,
  queueDayPlanningJob,
  queueDueMorningPlans,
} from "../services/day-planning.ts";
import { importPrototypeCalendarFeed } from "../services/prototype-calendar.ts";
import { cancelAvatarRequest } from "../services/avatar-cancellation.ts";
import { DEMO_USER_ID, initializeLocalProfile, type Store } from "../storage/store.ts";
import { selectTalkContext } from "../storage/context.ts";

export interface RouterDependencies {
  prototypeCalendarSourceUrl?: string;
  prototypeCalendarFetch?: typeof fetch;
  realtimeFetch?: typeof fetch;
}
export class HttpProblem extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  dependencies: RouterDependencies = {},
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const userId = DEMO_USER_ID;
  try {
    if (method === "GET" && url.pathname === "/api/bootstrap") {
      const state = await store.snapshot();
      return json(res, 200, bootstrap(state, userId));
    }
    if (method === "POST" && url.pathname === "/api/profile/initialize") {
      const body = await readJson(req);
      const timezone = typeof body.timezone === "string" ? body.timezone : "UTC";
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
      } catch {
        throw new HttpProblem(422, "INVALID_TIMEZONE", "Use a valid IANA time zone.", {
          field_errors: { timezone: "Use a valid IANA time zone." },
        });
      }
      const created = await store.transaction((draft) =>
        initializeLocalProfile(draft, userId, timezone),
      );
      const calendarConnection = (await store.snapshot()).integrations.find(
        (item) => item.user_id === userId && item.provider === "google_calendar",
      );
      if (
        dependencies.prototypeCalendarSourceUrl &&
        !(calendarConnection?.mode === "live" && calendarConnection.encrypted_token)
      ) {
        try {
          await importPrototypeCalendarFeed(
            store,
            userId,
            dependencies.prototypeCalendarSourceUrl,
            { fetchImpl: dependencies.prototypeCalendarFetch },
          );
        } catch {
          throw new HttpProblem(
            503,
            "PROTOTYPE_CALENDAR_PROVISION_FAILED",
            "The shared prototype Calendar could not be added. Retry profile setup.",
          );
        }
      }
      return json(res, created ? 201 : 200, {
        ...bootstrap(await store.snapshot(), userId),
        created,
      });
    }
    if (method === "GET" && url.pathname === "/api/home") {
      const state = await store.snapshot();
      return json(res, 200, homeRead(state, userId));
    }
    if (method === "POST" && url.pathname === "/api/imports") {
      const rawText = await readBody(req, 256_000);
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        throw new HttpProblem(400, "INVALID_JSON", "That text is not valid JSON.", {
          field_errors: { $: "Check commas, quotes, and brackets." },
        });
      }
      const input = validateHandoff(raw);
      const sha = hashHandoff(input);
      const existing = (await store.snapshot()).imports.find(
        (item) =>
          item.user_id === userId &&
          (item.sha256 === sha ||
            (item.source === input.source && item.source_session_id === input.session_id)),
      );
      if (existing) {
        const state = await store.snapshot();
        return json(res, 200, {
          ...existing,
          duplicate: true,
          twin_day_status: twinDayStatus(state, userId),
        });
      }
      const result = await store.transaction((draft) => {
        const batch = applyHandoff(draft, input, userId);
        queueDueMorningPlans(draft);
        return batch;
      });
      return json(res, 201, {
        ...result,
        duplicate: false,
        twin_day_status: twinDayStatus(await store.snapshot(), userId),
      });
    }
    const importMatch = url.pathname.match(/^\/api\/imports\/([^/]+)$/);
    if (method === "GET" && importMatch) {
      const batch = (await store.snapshot()).imports.find(
        (item) => item.id === importMatch[1] && item.user_id === userId,
      );
      if (!batch) throw new HttpProblem(404, "IMPORT_NOT_FOUND", "That import could not be found.");
      return json(res, 200, batch);
    }
    if (method === "GET" && url.pathname === "/api/profile/facts")
      return json(
        res,
        200,
        (await store.snapshot()).facts.filter((item) => item.user_id === userId),
      );
    const factMatch = url.pathname.match(/^\/api\/profile\/facts\/([^/]+)$/);
    if (method === "PATCH" && factMatch) {
      const body = await readJson(req);
      const fact = await store.transaction((draft) => {
        const item = draft.facts.find(
          (candidate) => candidate.id === factMatch[1] && candidate.user_id === userId,
        );
        if (!item) throw new HttpProblem(404, "FACT_NOT_FOUND", "That memory could not be found.");
        if (body.version !== item.version)
          throw new HttpProblem(409, "STALE_MEMORY", "This memory changed in another view.", {
            current_version: item.version,
            fact: item,
          });
        const statement = String(body.statement ?? "").trim();
        if (statement.length < 3 || statement.length > 600)
          throw new HttpProblem(422, "INVALID_MEMORY", "Use 3–600 characters.", {
            field_errors: { statement: "Use 3–600 characters." },
          });
        item.statement = statement;
        item.authority = "user_edit";
        item.certainty = "user_stated";
        item.status = "active";
        item.version += 1;
        item.updated_at = new Date().toISOString();
        draft.memory_overrides.push({
          id: randomUUID(),
          user_id: userId,
          fact_key: item.fact_key,
          action: "edit",
          replacement: statement,
          recorded_at: item.updated_at,
          version: item.version,
        });
        return item;
      });
      return json(res, 200, fact);
    }
    if (method === "DELETE" && factMatch) {
      const body = await readJson(req);
      const result = await store.transaction((draft) => {
        const item = draft.facts.find(
          (candidate) => candidate.id === factMatch[1] && candidate.user_id === userId,
        );
        if (!item) throw new HttpProblem(404, "FACT_NOT_FOUND", "That memory could not be found.");
        if (body.version !== item.version)
          throw new HttpProblem(409, "STALE_MEMORY", "This memory changed in another view.", {
            current_version: item.version,
            fact: item,
          });
        item.status = "suppressed";
        item.version += 1;
        item.updated_at = new Date().toISOString();
        draft.memory_overrides.push({
          id: randomUUID(),
          user_id: userId,
          fact_key: item.fact_key,
          action: "remove",
          recorded_at: item.updated_at,
          version: item.version,
        });
        return { removed: true, id: item.id, version: item.version };
      });
      return json(res, 200, result);
    }
    if (url.pathname === "/api/settings" && method === "GET") {
      const state = await store.snapshot();
      return json(res, 200, {
        ...ownSettings(state, userId),
        openai: safeModel(ownModel(state, userId)),
        integrations: state.integrations
          .filter((item) => item.user_id === userId)
          .map(safeIntegration),
      });
    }
    if (url.pathname === "/api/settings" && method === "PATCH") {
      const body = await readJson(req);
      const settings = await store.transaction((draft) => {
        const item = ownSettings(draft, userId);
        if (body.version !== undefined && body.version !== item.version)
          throw new HttpProblem(409, "STALE_SETTINGS", "Settings changed in another view.", {
            current_version: item.version,
            settings: item,
          });
        for (const field of ["wake_time", "sleep_time", "tomorrow_generation_time"] as const)
          if (typeof body[field] === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body[field]))
            item[field] = body[field];
        if (typeof body.name === "string") item.name = body.name.trim().slice(0, 80);
        if (typeof body.hide_bathroom_scene === "boolean")
          item.hide_bathroom_scene = body.hide_bathroom_scene;
        if (
          Number.isInteger(body.talk_retention_days) &&
          body.talk_retention_days >= 1 &&
          body.talk_retention_days <= 365
        )
          item.talk_retention_days = body.talk_retention_days;
        if (body.talk_personality_mode !== undefined) {
          if (!validTalkPersonality(body.talk_personality_mode))
            throw new HttpProblem(
              422,
              "INVALID_TALK_PERSONALITY",
              "Choose collaborative, direct coach, or aspirational self.",
              {
                field_errors: {
                  talk_personality_mode: "Choose one of the available personality modes.",
                },
              },
            );
          item.talk_personality_mode = body.talk_personality_mode;
        }
        if (typeof body.timezone === "string") {
          try {
            new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
            item.timezone = body.timezone;
          } catch {
            throw new HttpProblem(422, "INVALID_TIMEZONE", "Use a valid IANA time zone.");
          }
        }
        item.version += 1;
        return item;
      });
      return json(res, 200, settings);
    }
    if (url.pathname === "/api/settings/openai-key" && method === "PUT") {
      const body = await readJson(req);
      const key = String(body.api_key ?? "").trim();
      if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key))
        throw new HttpProblem(422, "INVALID_KEY_FORMAT", "Enter a complete OpenAI API key.", {
          field_errors: { api_key: "Expected a key beginning with sk-." },
        });
      if (!encryptionReady())
        throw new HttpProblem(
          503,
          "ENCRYPTION_NOT_CONFIGURED",
          "Set TWIN_ENCRYPTION_KEY before saving a provider key.",
        );
      const status = await store.transaction((draft) => {
        const connection = ownModel(draft, userId);
        connection.encrypted_key = encryptSecret(key);
        connection.key_suffix = key.slice(-4);
        connection.status = "connected";
        connection.text_capability = "unknown";
        connection.image_capability = "unknown";
        connection.credential_version = (connection.credential_version ?? 0) + 1;
        return safeModel(connection);
      });
      return json(res, 200, status);
    }
    if (url.pathname === "/api/settings/openai-key" && method === "DELETE") {
      const status = await store.transaction((draft) => {
        const item = ownModel(draft, userId);
        delete item.encrypted_key;
        delete item.key_suffix;
        item.status = "not_connected";
        item.text_capability = "unknown";
        item.image_capability = "unknown";
        item.credential_version = (item.credential_version ?? 0) + 1;
        return safeModel(item);
      });
      return json(res, 200, status);
    }
    if (url.pathname === "/api/settings/openai-key/test" && method === "POST") {
      const state = await store.snapshot();
      const connection = ownModel(state, userId);
      if (!connection.encrypted_key)
        throw new HttpProblem(409, "OPENAI_KEY_MISSING", "Add an OpenAI API key first.");
      try {
        const capabilities = await testOpenAIKey(decryptSecret(connection.encrypted_key));
        const result = await store.transaction((draft) => {
          const item = ownModel(draft, userId);
          item.status = "connected";
          item.text_capability = capabilities.text ? "available" : "unavailable";
          item.image_capability = capabilities.image ? "available" : "unavailable";
          item.tested_at = new Date().toISOString();
          return { ...safeModel(item), models: capabilities };
        });
        return json(res, 200, result);
      } catch (error) {
        if (error instanceof ProviderProblem)
          await store.transaction((draft) => {
            const item = ownModel(draft, userId);
            item.status =
              error.code === "OPENAI_AUTH_ERROR"
                ? "invalid"
                : error.code === "OPENAI_QUOTA"
                  ? "quota"
                  : "network_error";
            item.text_capability = "unavailable";
            item.image_capability = "unavailable";
            item.tested_at = new Date().toISOString();
          });
        throw error;
      }
    }
    if (url.pathname === "/api/onboarding/complete" && method === "POST") {
      const completed = await store.transaction((draft) => {
        const settings = ownSettings(draft, userId);
        const latestImport = draft.imports
          .filter((item) => item.user_id === userId && item.status === "applied")
          .sort((left, right) => right.received_at.localeCompare(left.received_at))[0];
        if (!latestImport)
          throw new HttpProblem(
            409,
            "ONBOARDING_IMPORT_REQUIRED",
            "Import your ChatGPT onboarding handoff before finishing setup.",
          );
        const model = ownModel(draft, userId);
        if (!model.encrypted_key)
          throw new HttpProblem(
            409,
            "OPENAI_KEY_MISSING",
            "Add and test an OpenAI API key before finishing setup.",
          );
        if (model.status !== "connected" || model.text_capability !== "available")
          throw new HttpProblem(
            409,
            "OPENAI_KEY_NOT_READY",
            "Test an OpenAI key with text-model access before finishing setup.",
          );
        const localDate = localDateInZone(new Date(), settings.timezone);
        const day = latestDay(draft, userId, localDate);
        if (!day || day.generated_at < latestImport.received_at)
          throw new HttpProblem(
            409,
            "TWIN_DAY_REQUIRED",
            "Build today's Twin schedule with your latest imported memory before finishing setup.",
          );
        if (!settings.onboarding_complete) {
          settings.onboarding_complete = true;
          settings.version += 1;
        }
        return bootstrap(draft, userId);
      });
      return json(res, 200, completed);
    }
    if (url.pathname === "/api/talk/conversations" && method === "GET") {
      const state = await store.snapshot();
      return json(
        res,
        200,
        state.conversations
          .filter((item) => item.user_id === userId)
          .map((conversation) => ({
            ...conversation,
            messages: state.messages.filter(
              (message) =>
                message.conversation_id === conversation.id && message.user_id === userId,
            ),
          })),
      );
    }
    if (url.pathname === "/api/talk/conversations" && method === "POST") {
      const conversation = await store.transaction((draft) => {
        const now = new Date().toISOString();
        const item = {
          id: randomUUID(),
          user_id: userId,
          title: "A new conversation",
          created_at: now,
          updated_at: now,
        };
        draft.conversations.push(item);
        return item;
      });
      return json(res, 201, conversation);
    }
    const messagesMatch = url.pathname.match(/^\/api\/talk\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch && method === "GET") {
      const state = await store.snapshot();
      ownConversation(state, userId, messagesMatch[1]);
      return json(
        res,
        200,
        state.messages.filter(
          (item) => item.user_id === userId && item.conversation_id === messagesMatch[1],
        ),
      );
    }
    if (messagesMatch && method === "POST")
      return await sendTalk(req, res, store, userId, messagesMatch[1]);
    const voiceStartMatch = url.pathname.match(
      /^\/api\/talk\/conversations\/([^/]+)\/voice-calls$/,
    );
    if (voiceStartMatch && method === "POST")
      return await startVoiceCall(
        req,
        res,
        store,
        userId,
        voiceStartMatch[1],
        dependencies.realtimeFetch,
      );
    const voiceCompleteMatch = url.pathname.match(
      /^\/api\/talk\/conversations\/([^/]+)\/voice-calls\/([^/]+)\/complete$/,
    );
    if (voiceCompleteMatch && method === "POST")
      return await completeVoiceCall(
        req,
        res,
        store,
        userId,
        voiceCompleteMatch[1],
        voiceCompleteMatch[2],
      );
    const voiceAbandonMatch = url.pathname.match(
      /^\/api\/talk\/conversations\/([^/]+)\/voice-calls\/([^/]+)\/abandon$/,
    );
    if (voiceAbandonMatch && method === "POST")
      return await abandonVoiceCall(
        req,
        res,
        store,
        userId,
        voiceAbandonMatch[1],
        voiceAbandonMatch[2],
      );
    if (url.pathname === "/api/talk/history" && method === "DELETE") {
      await store.transaction((draft) => {
        draft.messages = draft.messages.filter((item) => item.user_id !== userId);
        draft.conversations = draft.conversations.filter((item) => item.user_id !== userId);
        draft.voice_sessions = draft.voice_sessions.filter((item) => item.user_id !== userId);
        for (const key of Object.keys(draft.idempotency))
          if (
            key.startsWith(`voice-start:${userId}:`) ||
            key.startsWith(`voice-complete:${userId}:`) ||
            key.startsWith(`voice-abandon:${userId}:`)
          )
            delete draft.idempotency[key];
      });
      return json(res, 200, { deleted: true });
    }
    if (url.pathname === "/api/twin-days/rebuild" && method === "POST") {
      const body = await readJson(req);
      const state = await store.snapshot();
      const settings = ownSettings(state, userId);
      const today = localDateInZone(new Date(), settings.timezone);
      const localDate = body.local_date === undefined ? today : body.local_date;
      if (typeof localDate !== "string" || !validLocalDate(localDate))
        throw new HttpProblem(422, "INVALID_PLANNING_DATE", "Choose a valid local date.", {
          field_errors: { local_date: "Use a date in YYYY-MM-DD format." },
        });
      if (localDate < today)
        throw new HttpProblem(
          422,
          "PAST_DAY_PROTECTED",
          "Past Twin days stay unchanged. Choose today or a future day.",
        );
      for (const field of ["instruction", "actual_report", "future_instruction"] as const)
        if (body[field] !== undefined && typeof body[field] !== "string")
          throw new HttpProblem(
            422,
            "INVALID_PLANNING_INSTRUCTION",
            "Each rebuild entry must be text.",
            { field_errors: { [field]: "Use at most 500 characters." } },
          );
      const actualReport = String(body.actual_report ?? "").trim();
      const instruction = String(body.future_instruction ?? body.instruction ?? "").trim();
      if (actualReport.length > 500 || instruction.length > 500)
        throw new HttpProblem(
          422,
          "INVALID_PLANNING_INSTRUCTION",
          "Keep each rebuild entry to 500 characters or fewer.",
          {
            field_errors: {
              ...(actualReport.length > 500
                ? { actual_report: "Use at most 500 characters." }
                : {}),
              ...(instruction.length > 500
                ? { future_instruction: "Use at most 500 characters." }
                : {}),
            },
          },
        );
      if (actualReport && localDate !== today)
        throw new HttpProblem(
          422,
          "ACTUAL_REPORT_DATE_INVALID",
          "What happened so far can update only today. Use the planning instruction for a future day.",
          { field_errors: { actual_report: "Choose today to save an activity report." } },
        );
      const result = await planTwinDay(store, {
        userId,
        trigger: "manual",
        targetLocalDate: localDate,
        actualReport: actualReport || undefined,
        instruction: instruction || undefined,
        idempotencyKey: idempotencyKey(req, body),
      });
      return json(res, 200, result);
    }
    if (url.pathname === "/api/twin-days" && method === "GET") {
      const state = await store.snapshot();
      const settings = ownSettings(state, userId);
      const date = url.searchParams.get("date") ?? localDateInZone(new Date(), settings.timezone);
      if (!validLocalDate(date))
        throw new HttpProblem(422, "INVALID_PLANNING_DATE", "Choose a valid local date.");
      return json(res, 200, latestDay(state, userId, date) ?? null);
    }
    if (url.pathname === "/api/activity-reports" && method === "GET")
      return json(
        res,
        200,
        (await store.snapshot()).activity_reports.filter((item) => item.user_id === userId),
      );
    const integrationMatch = url.pathname.match(
      /^\/api\/integrations\/(calendar|gmail)(?:\/(status|connect|callback|sync|calendars|cues))?$/,
    );
    if (integrationMatch)
      return await integrationRoute(
        req,
        res,
        store,
        userId,
        integrationMatch[1] as "calendar" | "gmail",
        integrationMatch[2] ?? "status",
        url,
      );
    const cueMatch = url.pathname.match(/^\/api\/integrations\/gmail\/cues\/([^/]+)$/);
    if (cueMatch && method === "DELETE") {
      const cue = await store.transaction((draft) => {
        const item = draft.gmail_cues.find(
          (candidate) => candidate.id === cueMatch[1] && candidate.user_id === userId,
        );
        if (!item) throw new HttpProblem(404, "CUE_NOT_FOUND", "That mail cue could not be found.");
        item.status = "suppressed";
        return item;
      });
      return json(res, 200, cue);
    }
    if (url.pathname === "/api/character/photo" && method === "POST") {
      const body = await readJson(req, 12_000_000);
      const decoded = decodeImageDataUrl(body.data_url);
      const state = await store.snapshot();
      const design = activeDesign(state, userId);
      const assetId = randomUUID();
      const extension =
        decoded.mime === "image/png" ? "png" : decoded.mime === "image/webp" ? "webp" : "jpg";
      const path = resolve(`./data/assets/${assetId}.${extension}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, decoded.bytes, { mode: 0o600 });
      const oldPhoto = state.avatar_assets.find(
        (item) => item.id === design.source_photo_asset_id && item.user_id === userId,
      );
      const asset = await store.transaction((draft) => {
        const current = activeDesign(draft, userId);
        if (current.source_photo_asset_id)
          draft.avatar_assets = draft.avatar_assets.filter(
            (item) => item.id !== current.source_photo_asset_id,
          );
        const now = new Date().toISOString();
        const created = {
          id: assetId,
          user_id: userId,
          design_version: current.version,
          parent_asset_ids: [],
          kind: "source_photo" as const,
          prompt_version: 1,
          model: "user_upload",
          storage_key: path,
          original_name: String(body.filename ?? "reference-photo").slice(0, 180),
          mime: decoded.mime,
          sha256: createHash("sha256").update(decoded.bytes).digest("hex"),
          status: "ready" as const,
          selected_at: now,
          created_at: now,
          last_used_at: now,
        };
        draft.avatar_assets.push(created);
        current.source_photo_asset_id = assetId;
        current.updated_at = now;
        return created;
      });
      if (oldPhoto?.storage_key) await unlink(oldPhoto.storage_key).catch(() => {});
      return json(res, 201, {
        asset: safeAsset(asset),
        character: characterRead(await store.snapshot(), userId),
      });
    }
    if (url.pathname === "/api/character/photo" && method === "DELETE") {
      const state = await store.snapshot();
      const design = activeDesign(state, userId);
      const photo = state.avatar_assets.find(
        (item) => item.id === design.source_photo_asset_id && item.user_id === userId,
      );
      await store.transaction((draft) => {
        const current = activeDesign(draft, userId);
        draft.avatar_assets = draft.avatar_assets.filter(
          (item) => item.id !== current.source_photo_asset_id,
        );
        delete current.source_photo_asset_id;
        current.updated_at = new Date().toISOString();
      });
      if (photo?.storage_key) await unlink(photo.storage_key).catch(() => {});
      return json(res, 200, {
        deleted: true,
        character: characterRead(await store.snapshot(), userId),
      });
    }
    if (url.pathname === "/api/character/images" && method === "DELETE") {
      const files = (await store.snapshot()).avatar_assets
        .filter((item) => item.user_id === userId && item.storage_key)
        .map((item) => item.storage_key!);
      await store.transaction((draft) => {
        draft.avatar_assets = draft.avatar_assets.filter((item) => item.user_id !== userId);
        draft.avatar_requests = draft.avatar_requests.filter((item) => item.user_id !== userId);
        draft.jobs = draft.jobs.filter(
          (item) => !(item.user_id === userId && item.type === "avatar_generation"),
        );
        const current = activeDesign(draft, userId);
        delete current.source_photo_asset_id;
        delete current.baseline_asset_id;
        current.updated_at = new Date().toISOString();
      });
      await Promise.all(files.map((file) => unlink(file).catch(() => {})));
      return json(res, 200, {
        deleted: true,
        character: characterRead(await store.snapshot(), userId),
      });
    }
    if (url.pathname === "/api/character/baseline" && method === "POST") {
      const state = await store.snapshot();
      const design = activeDesign(state, userId);
      if (!design.source_photo_asset_id)
        throw new HttpProblem(
          409,
          "AVATAR_PHOTO_REQUIRED",
          "Upload a clear photo before generating the baseline avatar.",
        );
      const model = ownModel(state, userId);
      if (!model.encrypted_key)
        throw new HttpProblem(
          409,
          "OPENAI_KEY_MISSING",
          "Add an OpenAI API key in Settings before generating the avatar.",
        );
      const request = await queueAvatar(store, userId, {
        source: "studio",
        purpose: "baseline",
        change: "Create the neutral standing baseline avatar.",
        idempotency: String(req.headers["idempotency-key"] ?? randomUUID()),
        references: [design.source_photo_asset_id],
      });
      return json(res, 202, request);
    }
    const cancelBaselineMatch = url.pathname.match(/^\/api\/character\/baseline\/([^/]+)\/cancel$/);
    if (cancelBaselineMatch && method === "POST") {
      const requestId = cancelBaselineMatch[1];
      await store.transaction((draft) => {
        const request = draft.avatar_requests.find(
          (item) => item.id === requestId && item.user_id === userId && item.purpose === "baseline",
        );
        if (!request)
          throw new HttpProblem(
            404,
            "AVATAR_REQUEST_NOT_FOUND",
            "That avatar request was not found.",
          );
        if (request.status === "failed" && request.failure_code === "AVATAR_CANCELLED") return;
        if (request.status !== "queued" && request.status !== "generating")
          throw new HttpProblem(
            409,
            "AVATAR_REQUEST_NOT_PENDING",
            "That avatar request is no longer running.",
          );
        request.status = "failed";
        request.failure_code = "AVATAR_CANCELLED";
        request.updated_at = new Date().toISOString();
        const job = draft.jobs.find(
          (item) =>
            item.user_id === userId &&
            item.type === "avatar_generation" &&
            item.payload.request_id === requestId &&
            (item.status === "queued" || item.status === "running"),
        );
        if (job) {
          job.status = "failed";
          job.last_error_code = "AVATAR_CANCELLED";
          delete job.locked_until;
        }
      });
      const wasInFlight = cancelAvatarRequest(requestId);
      return json(res, 200, {
        cancelled: true,
        was_in_flight: wasInFlight,
        character: characterRead(await store.snapshot(), userId),
      });
    }
    const deleteBaselineMatch = url.pathname.match(/^\/api\/character\/baseline\/([^/]+)$/);
    if (deleteBaselineMatch && method === "DELETE") {
      const deleted = await store.transaction((draft) => {
        const current = activeDesign(draft, userId);
        const asset = draft.avatar_assets.find(
          (item) =>
            item.id === deleteBaselineMatch[1] &&
            item.user_id === userId &&
            item.kind === "base" &&
            item.status === "ready",
        );
        if (!asset)
          throw new HttpProblem(404, "BASELINE_NOT_FOUND", "That avatar version was not found.");
        if (current.baseline_asset_id === asset.id)
          throw new HttpProblem(
            409,
            "BASELINE_IN_USE",
            "Switch to another avatar before deleting the current one.",
          );
        draft.avatar_assets = draft.avatar_assets.filter((item) => item.id !== asset.id);
        return asset;
      });
      if (deleted.storage_key) await unlink(deleted.storage_key).catch(() => {});
      return json(res, 200, {
        deleted: true,
        character: characterRead(await store.snapshot(), userId),
      });
    }
    const approveBaselineMatch = url.pathname.match(
      /^\/api\/character\/baseline\/([^/]+)\/approve$/,
    );
    if (approveBaselineMatch && method === "POST") {
      const approved = await store.transaction((draft) => {
        const current = activeDesign(draft, userId);
        const asset = draft.avatar_assets.find(
          (item) =>
            item.id === approveBaselineMatch[1] &&
            item.user_id === userId &&
            item.kind === "base" &&
            item.status === "ready",
        );
        if (!asset)
          throw new HttpProblem(404, "BASELINE_NOT_FOUND", "That baseline candidate is not ready.");
        current.is_active = false;
        const now = new Date().toISOString();
        const next = {
          ...current,
          id: randomUUID(),
          version: current.version + 1,
          parent_version_id: current.version,
          baseline_asset_id: asset.id,
          is_active: true,
          created_at: now,
          updated_at: now,
        };
        asset.design_version = next.version;
        asset.approved_at = now;
        asset.selected_at = now;
        draft.avatar_assets
          .filter((item) => item.user_id === userId && item.kind === "base" && item.id !== asset.id)
          .forEach((item) => {
            delete item.selected_at;
            delete item.approved_at;
          });
        draft.avatar_designs.push(next);
        return asset;
      });
      return json(res, 200, {
        approved: safeAsset(approved),
        character: characterRead(await store.snapshot(), userId),
      });
    }
    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch && method === "GET") {
      const state = await store.snapshot();
      const asset = state.avatar_assets.find(
        (item) =>
          item.id === assetMatch[1] &&
          item.user_id === userId &&
          item.status === "ready" &&
          item.storage_key,
      );
      if (!asset)
        throw new HttpProblem(404, "ASSET_NOT_FOUND", "That private scene could not be found.");
      const body = await readFile(asset.storage_key!);
      res.writeHead(200, {
        "content-type": asset.mime ?? "image/png",
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      });
      return res.end(body);
    }
    if (url.pathname === "/api/character" && method === "GET") {
      const state = await store.snapshot();
      return json(res, 200, characterRead(state, userId));
    }
    if (url.pathname === "/api/character/design" && method === "PUT") {
      const body = await readJson(req);
      const updated = await store.transaction((draft) => {
        const current = activeDesign(draft, userId);
        const palette = ["skin", "hair", "top", "bottom", "accent"] as const;
        for (const field of palette)
          if (body[field] !== undefined && !/^#[0-9a-f]{6}$/i.test(body[field]))
            throw new HttpProblem(
              422,
              "INVALID_AVATAR_COLOR",
              `Use a six-digit hex color for ${field}.`,
            );
        current.is_active = false;
        const now = new Date().toISOString();
        const design = {
          ...current,
          id: randomUUID(),
          version: current.version + 1,
          parent_version_id: current.version,
          is_active: true,
          created_at: now,
          updated_at: now,
          name: typeof body.name === "string" ? body.name.trim().slice(0, 40) : current.name,
          hair_style: ["soft", "curly", "short"].includes(body.hair_style)
            ? body.hair_style
            : current.hair_style,
        };
        for (const field of palette) if (body[field]) design[field] = body[field];
        draft.avatar_designs.push(design);
        return design;
      });
      return json(res, 200, updated);
    }
    if (url.pathname === "/api/character/current" && method === "GET") {
      const state = await store.snapshot();
      const home = homeRead(state, userId);
      return json(res, 200, {
        activity: home.currentTwinActivity,
        scene: home.scene,
        design: home.avatar,
      });
    }
    if (url.pathname === "/api/character/scenes" && method === "GET") {
      const state = await store.snapshot();
      const key = url.searchParams.get("activity_key");
      return json(
        res,
        200,
        state.avatar_assets
          .filter(
            (item) =>
              item.user_id === userId &&
              item.kind !== "source_photo" &&
              (!key || item.activity_key === key),
          )
          .map(safeAsset),
      );
    }
    if (url.pathname === "/api/character/scenes/ensure" && method === "POST") {
      const body = await readJson(req);
      const key = body.activity_key as ActivityKey;
      if (!validActivity(key))
        throw new HttpProblem(422, "INVALID_ACTIVITY", "Choose a supported activity.");
      const state = await store.snapshot();
      const design = activeDesign(state, userId);
      const baseline = approvedBaseline(state, userId, design);
      if (!baseline)
        return json(res, 200, {
          status: "baseline_fallback",
          asset: null,
          cache_hit: false,
          reason: "APPROVED_BASELINE_REQUIRED",
        });
      const ready = state.avatar_assets.find(
        (item) =>
          item.user_id === userId &&
          item.design_version === design.version &&
          item.activity_key === key &&
          item.status === "ready" &&
          item.selected_at,
      );
      if (ready)
        return json(res, 200, { status: "ready", asset: safeAsset(ready), cache_hit: true });
      const model = ownModel(state, userId);
      if (!model.encrypted_key)
        return json(res, 200, {
          status: "baseline_fallback",
          asset: safeAsset(baseline),
          cache_hit: false,
          reason: "OPENAI_KEY_MISSING",
        });
      const request = await queueAvatar(store, userId, {
        source: "automatic_scene",
        purpose: "activity",
        change: activityImageDirection(key),
        activityKey: key,
        idempotency: String(req.headers["idempotency-key"] ?? `auto:${design.version}:${key}`),
        references: [baseline.id],
      });
      return json(res, 202, {
        status: request.status,
        generation_request: request,
        cache_hit: false,
        fallback_asset: safeAsset(baseline),
      });
    }
    const regenerateMatch = url.pathname.match(/^\/api\/character\/scenes\/([^/]+)\/regenerate$/);
    if (regenerateMatch && method === "POST") {
      const body = await readJson(req);
      const state = await store.snapshot();
      const asset = state.avatar_assets.find(
        (item) =>
          item.id === regenerateMatch[1] && item.user_id === userId && item.kind === "activity",
      );
      if (!asset)
        throw new HttpProblem(404, "SCENE_NOT_FOUND", "That activity image could not be found.");
      const design = activeDesign(state, userId);
      const baseline = approvedBaseline(state, userId, design);
      if (!baseline)
        throw new HttpProblem(
          409,
          "APPROVED_BASELINE_REQUIRED",
          "Approve a baseline avatar before regenerating activity images.",
        );
      const request = await queueAvatar(store, userId, {
        source: "studio",
        purpose: "activity",
        change: String(
          body.requested_change ?? activityImageDirection(asset.activity_key ?? "generic"),
        ),
        activityKey: asset.activity_key,
        idempotency: String(req.headers["idempotency-key"] ?? randomUUID()),
        references: [baseline.id, asset.id],
      });
      return json(res, 202, request);
    }
    const selectMatch = url.pathname.match(/^\/api\/character\/scenes\/([^/]+)\/select$/);
    if (selectMatch && method === "POST") {
      const asset = await store.transaction((draft) => {
        const selected = draft.avatar_assets.find(
          (item) =>
            item.id === selectMatch[1] && item.user_id === userId && item.status === "ready",
        );
        if (!selected)
          throw new HttpProblem(404, "SCENE_NOT_FOUND", "That ready scene could not be found.");
        draft.avatar_assets
          .filter((item) => item.user_id === userId && item.activity_key === selected.activity_key)
          .forEach((item) => {
            delete item.selected_at;
          });
        selected.selected_at = new Date().toISOString();
        return selected;
      });
      return json(res, 200, safeAsset(asset));
    }
    const deleteSceneMatch = url.pathname.match(/^\/api\/character\/scenes\/([^/]+)$/);
    if (deleteSceneMatch && method === "DELETE") {
      const state = await store.snapshot();
      const asset = state.avatar_assets.find(
        (item) =>
          item.id === deleteSceneMatch[1] && item.user_id === userId && item.kind === "activity",
      );
      if (!asset)
        throw new HttpProblem(404, "SCENE_NOT_FOUND", "That activity image could not be found.");
      await store.transaction((draft) => {
        draft.avatar_assets = draft.avatar_assets.filter((item) => item.id !== asset.id);
      });
      if (asset.storage_key) await unlink(asset.storage_key).catch(() => {});
      return json(res, 200, { deleted: true });
    }
    if (url.pathname === "/api/account/export" && method === "GET")
      return json(res, 200, exportUser(await store.snapshot(), userId), {
        "content-disposition": 'attachment; filename="personal-twin-export.json"',
      });
    if (url.pathname === "/api/account" && method === "DELETE") {
      const body = await readJson(req);
      if (body.confirmation !== "DELETE MY TWIN")
        throw new HttpProblem(422, "CONFIRMATION_REQUIRED", "Type DELETE MY TWIN to confirm.", {
          field_errors: { confirmation: "Exact confirmation required." },
        });
      const files = (await store.snapshot()).avatar_assets
        .filter((item) => item.user_id === userId && item.storage_key)
        .map((item) => item.storage_key!);
      await store.transaction((draft) => removeUserData(draft, userId));
      await Promise.all(files.map((file) => unlink(file).catch(() => {})));
      return json(res, 200, { deleted: true });
    }
    throw new HttpProblem(404, "NOT_FOUND", "That API route does not exist.");
  } catch (error) {
    if (error instanceof ValidationProblem)
      return json(res, error.status, {
        code: error.code,
        message: error.message,
        field_errors: error.field_errors,
        retryable: false,
      });
    if (error instanceof ProviderProblem)
      return json(res, error.status, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    if (error instanceof HttpProblem)
      return json(res, error.status, {
        code: error.code,
        message: error.message,
        retryable: error.status >= 500,
        ...error.extra,
      });
    console.error(JSON.stringify({ event: "api_error", code: "INTERNAL_ERROR" }));
    return json(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Your last readable twin day is unchanged.",
      retryable: true,
    });
  }
}
async function sendTalk(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  userId: string,
  conversationId: string,
) {
  const body = await readJson(req);
  const key = idempotencyKey(req, body);
  const text = String(body.message ?? "").trim();
  if (!text || text.length > 3000)
    throw new HttpProblem(
      422,
      "INVALID_MESSAGE",
      "Write a message between 1 and 3,000 characters.",
    );
  const prepared = await store.transaction((draft) => {
    const conversation = ownConversation(draft, userId, conversationId);
    const replay = draft.idempotency[`talk:${key}`];
    if (replay) return { replay, userMessage: null };
    let userMessage = draft.messages.find(
      (item) =>
        item.user_id === userId &&
        item.conversation_id === conversationId &&
        item.content === text &&
        item.status === "saved",
    );
    if (!userMessage) {
      userMessage = {
        id: randomUUID(),
        user_id: userId,
        conversation_id: conversationId,
        role: "user",
        content: text,
        status: "saved",
        created_at: new Date().toISOString(),
      };
      draft.messages.push(userMessage);
    }
    conversation.updated_at = new Date().toISOString();
    return { replay: null, userMessage };
  });
  if (prepared.replay) return json(res, 200, prepared.replay);
  const state = await store.snapshot();
  const connection = ownModel(state, userId);
  if (!connection.encrypted_key)
    throw new HttpProblem(
      409,
      "OPENAI_KEY_MISSING",
      "Add an OpenAI API key in Settings to use live Talk.",
    );
  const settings = ownSettings(state, userId);
  const today = localDateInZone(new Date(), settings.timezone);
  const reply = await createTalkReply(decryptSecret(connection.encrypted_key), {
    message: text,
    ...(store.talkContext
      ? await store.talkContext(userId, conversationId, text)
      : selectTalkContext(state, userId, conversationId, text)),
    day: latestDay(state, userId, today),
  });
  const report = extractDirectReport(text);
  const avatarCommand = extractAvatarCommand(text);
  const result = await store.transaction((draft) => {
    const assistant = {
      id: randomUUID(),
      user_id: userId,
      conversation_id: conversationId,
      role: "assistant" as const,
      content: reply.text,
      status: "saved" as const,
      created_at: new Date().toISOString(),
      provider_request_id: reply.requestId,
    };
    draft.messages.push(assistant);
    let reportRecord = null;
    if (report && prepared.userMessage) {
      reportRecord = {
        id: randomUUID(),
        user_id: userId,
        conversation_message_id: prepared.userMessage.id,
        local_date: today,
        activity_key: report.activity_key,
        statement: report.statement,
        source: "talk_user_report" as const,
        created_at: new Date().toISOString(),
      };
      draft.activity_reports.push(reportRecord);
    }
    let avatarRequest: AvatarGenerationRequest | null = null;
    if (avatarCommand && prepared.userMessage) {
      const design = activeDesign(draft, userId);
      const baseline = approvedBaseline(draft, userId, design);
      avatarRequest = {
        id: randomUUID(),
        user_id: userId,
        source: "talk" as const,
        purpose: avatarCommand.activity_key ? "activity" : "variant",
        source_message_id: prepared.userMessage.id,
        requested_change: avatarCommand.change,
        requested_activity_key: avatarCommand.activity_key,
        reference_design_version: design.version,
        reference_asset_ids: baseline ? [baseline.id] : [],
        idempotency_key: key,
        status: "queued" as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      draft.avatar_requests.push(avatarRequest);
      draft.jobs.push({
        id: randomUUID(),
        user_id: userId,
        type: "avatar_generation",
        dedupe_key: `avatar:${key}`,
        status: "queued",
        attempts: 0,
        run_after: new Date().toISOString(),
        payload: { request_id: avatarRequest.id },
      });
    }
    const planningJob = queueDayPlanningJob(draft, {
      userId,
      trigger: "after_conversation",
      targetLocalDate: planningTargetDateFromConversation(text, today),
      sourceId: assistant.id,
      conversationId,
    });
    const response = {
      user_message: prepared.userMessage,
      assistant_message: assistant,
      replyStatus: "saved",
      reportStatus: reportRecord ? "saved_as_actual_activity" : "none",
      memoryStatus: "unchanged",
      avatarRequestStatus: avatarRequest ? "queued" : "none",
      planningStatus: planningJob.status,
      planning_job_id: planningJob.id,
      report: reportRecord,
      avatar_request: avatarRequest,
    };
    draft.idempotency[`talk:${key}`] = response;
    return response;
  });
  return json(res, 201, result);
}

async function startVoiceCall(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  userId: string,
  conversationId: string,
  fetchImpl?: typeof fetch,
) {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/sdp")
    throw new HttpProblem(415, "VOICE_SDP_REQUIRED", "Send a WebRTC offer as application/sdp.");
  const key = requestIdempotencyKey(req);
  const sdp = await readBody(req, 65_536);
  if (!validSdpOffer(sdp))
    throw new HttpProblem(422, "INVALID_VOICE_SDP", "The browser voice offer was invalid.");
  const replayKey = `voice-start:${userId}:${conversationId}:${key}`;
  const now = new Date();
  const config = resolveRealtimeConfig();
  const claim = await store.transaction((draft) => {
    ownConversation(draft, userId, conversationId);
    const replay = draft.idempotency[replayKey] as { voice_session_id?: string } | undefined;
    if (replay?.voice_session_id)
      return { outcome: "replay" as const, voiceSessionId: replay.voice_session_id };
    for (const candidate of draft.voice_sessions)
      if (
        candidate.user_id === userId &&
        candidate.conversation_id === conversationId &&
        ["connecting", "active", "finalizing"].includes(candidate.status) &&
        new Date(candidate.expires_at) <= now
      )
        candidate.status = "expired";
    const existing = draft.voice_sessions.find(
      (item) =>
        item.user_id === userId &&
        item.conversation_id === conversationId &&
        ["connecting", "active", "finalizing"].includes(item.status) &&
        new Date(item.expires_at) > now,
    );
    if (existing) return { outcome: "active" as const, voiceSessionId: existing.id };
    const connection = ownModel(draft, userId);
    if (!connection.encrypted_key)
      throw new HttpProblem(
        409,
        "OPENAI_KEY_MISSING",
        "Add an OpenAI API key in Settings to use voice Talk.",
      );
    const settings = ownSettings(draft, userId);
    const session = {
      id: randomUUID(),
      user_id: userId,
      conversation_id: conversationId,
      model: config.model,
      voice: config.voice,
      personality_mode: settings.talk_personality_mode,
      credential_version: connection.credential_version ?? 0,
      status: "connecting" as const,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
      finalized_item_ids: [],
    };
    draft.voice_sessions.push(session);
    draft.idempotency[replayKey] = { voice_session_id: session.id };
    return {
      outcome: "claimed" as const,
      session,
      encryptedKey: connection.encrypted_key,
      personalityMode: settings.talk_personality_mode,
      context: selectVoiceContext(draft, userId, conversationId, now),
    };
  });
  if (claim.outcome === "replay")
    throw new HttpProblem(
      409,
      "VOICE_CALL_ALREADY_STARTED",
      "That voice connection was already started. Continue it or press Retry.",
      { voice_session_id: claim.voiceSessionId },
    );
  if (claim.outcome === "active")
    throw new HttpProblem(409, "VOICE_CALL_ACTIVE", "A voice conversation is already active.", {
      voice_session_id: claim.voiceSessionId,
    });
  const voiceSession = claim.session;
  try {
    const answer = await createRealtimeCall({
      apiKey: decryptSecret(claim.encryptedKey),
      sdp,
      session: realtimeSessionConfig(claim.personalityMode, claim.context),
      safetyIdentifier: createHash("sha256").update(`twin:${userId}`).digest("hex"),
      fetchImpl,
    });
    const activated = await store.transaction((draft) => {
      const item = draft.voice_sessions.find(
        (candidate) => candidate.id === voiceSession.id && candidate.user_id === userId,
      );
      if (!item) throw new Error("VOICE_SESSION_MISSING");
      const model = ownModel(draft, userId);
      if ((model.credential_version ?? 0) !== voiceSession.credential_version) {
        item.status = "failed";
        item.failure_code = "VOICE_CREDENTIAL_CHANGED";
        return false;
      }
      if (item.status !== "connecting") return false;
      item.status = "active";
      item.provider_session_id = answer.providerSessionId;
      return true;
    });
    if (!activated)
      throw new HttpProblem(
        409,
        "VOICE_CREDENTIAL_CHANGED",
        "The OpenAI connection changed while voice was starting. Retry Talk.",
      );
    res.writeHead(201, {
      "content-type": "application/sdp",
      "cache-control": "no-store",
      "x-twin-voice-session": voiceSession.id,
      "x-twin-voice-expires-at": voiceSession.expires_at,
    });
    return res.end(answer.sdp);
  } catch (error) {
    await store.transaction((draft) => {
      const item = draft.voice_sessions.find(
        (candidate) => candidate.id === voiceSession.id && candidate.user_id === userId,
      );
      if (item) {
        item.status = "failed";
        item.failure_code = error instanceof ProviderProblem ? error.code : "VOICE_START_FAILED";
      }
      const model = ownModel(draft, userId);
      if (
        error instanceof ProviderProblem &&
        (model.credential_version ?? 0) === voiceSession.credential_version
      ) {
        if (error.code === "OPENAI_AUTH_ERROR") model.status = "invalid";
        else if (error.code === "OPENAI_QUOTA") model.status = "quota";
        else if (error.code === "OPENAI_NETWORK_ERROR") model.status = "network_error";
      }
      delete draft.idempotency[replayKey];
    });
    throw error;
  }
}

async function abandonVoiceCall(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  userId: string,
  conversationId: string,
  voiceSessionId: string,
) {
  const body = await readJson(req, 1_000);
  if (Object.keys(body).some((key) => key !== "idempotency_key"))
    throw new HttpProblem(422, "INVALID_VOICE_ABANDON", "No voice transcript is accepted here.");
  const key = idempotencyKey(req, body);
  const replayKey = `voice-abandon:${userId}:${voiceSessionId}:${key}`;
  const result = await store.transaction((draft) => {
    ownConversation(draft, userId, conversationId);
    const session = draft.voice_sessions.find(
      (item) => item.id === voiceSessionId && item.user_id === userId,
    );
    if (!session || session.conversation_id !== conversationId)
      throw new HttpProblem(
        404,
        "VOICE_SESSION_NOT_FOUND",
        "That voice conversation could not be found.",
      );
    const replay = draft.idempotency[replayKey];
    if (replay) return replay;
    if (session.status === "complete")
      throw new HttpProblem(
        409,
        "VOICE_SESSION_ALREADY_COMPLETE",
        "That voice conversation was already saved.",
      );
    const now = new Date().toISOString();
    session.status = "failed";
    session.failure_code = "VOICE_CLIENT_ABANDONED";
    session.completed_at ??= now;
    const response = {
      voice_session: {
        id: session.id,
        status: session.status,
        completed_at: session.completed_at,
      },
      planningStatus: "not_queued",
    };
    draft.idempotency[replayKey] = response;
    return response;
  });
  return json(res, 200, result);
}

async function completeVoiceCall(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  userId: string,
  conversationId: string,
  voiceSessionId: string,
) {
  const body = await readJson(req, 40_000);
  const key = idempotencyKey(req, body);
  const { items, disposition } = validateVoiceTranscriptItems(body);
  const replayKey = `voice-complete:${userId}:${voiceSessionId}:${key}`;
  const result = await store.transaction((draft) => {
    ownConversation(draft, userId, conversationId);
    const session = draft.voice_sessions.find(
      (item) => item.id === voiceSessionId && item.user_id === userId,
    );
    if (!session || session.conversation_id !== conversationId)
      throw new HttpProblem(
        404,
        "VOICE_SESSION_NOT_FOUND",
        "That voice conversation could not be found.",
      );
    const replay = draft.idempotency[replayKey];
    if (replay) return replay;
    if (new Date(session.expires_at) < new Date() && session.status !== "complete") {
      session.status = "expired";
      throw new HttpProblem(
        409,
        "VOICE_SESSION_EXPIRED",
        "That voice session expired. Retry Talk.",
      );
    }
    if (!["active", "finalizing", "complete"].includes(session.status))
      throw new HttpProblem(
        409,
        "VOICE_SESSION_NOT_ACTIVE",
        "That voice session cannot be completed.",
      );
    const finalized = new Set(session.finalized_item_ids ?? []);
    if (session.status === "complete")
      throw new HttpProblem(
        409,
        "VOICE_SESSION_ALREADY_COMPLETE",
        "That voice session is already complete.",
      );
    session.status = "finalizing";
    const savedMessages = [];
    const now = new Date().toISOString();
    const settings = ownSettings(draft, userId);
    const today = localDateInZone(new Date(), settings.timezone);
    for (const item of items) {
      const completedAt = new Date(item.completed_at).getTime();
      if (
        completedAt < new Date(session.created_at).getTime() - 5 * 60_000 ||
        completedAt > Date.now() + 5 * 60_000
      )
        throw new HttpProblem(
          422,
          "INVALID_VOICE_TRANSCRIPT_TIME",
          "A completed transcript timestamp was outside this voice session.",
        );
      const providerRequestId = `voice:${voiceSessionId}:${item.provider_item_id}`;
      let message = draft.messages.find(
        (candidate) =>
          candidate.user_id === userId &&
          candidate.conversation_id === conversationId &&
          candidate.provider_request_id === providerRequestId,
      );
      if (!message) {
        message = {
          id: randomUUID(),
          user_id: userId,
          conversation_id: conversationId,
          role: item.role,
          content: item.transcript,
          status: "saved",
          created_at: item.completed_at,
          provider_request_id: providerRequestId,
        };
        draft.messages.push(message);
      }
      savedMessages.push(message);
      finalized.add(item.provider_item_id);
    }
    const conversation = ownConversation(draft, userId, conversationId);
    conversation.updated_at = now;
    session.finalized_item_ids = [...finalized];
    session.status = disposition === "abandoned" ? "failed" : "complete";
    session.completed_at = now;
    if (disposition === "abandoned") session.failure_code = "VOICE_CLIENT_ABANDONED";
    const userText = items
      .filter((item) => item.role === "user")
      .map((item) => item.transcript)
      .join(" ");
    const source = savedMessages.at(-1);
    const planningJob = source
      ? queueDayPlanningJob(draft, {
          userId,
          trigger: "after_conversation",
          targetLocalDate: planningTargetDateFromConversation(userText, today),
          sourceId: `voice-session:${voiceSessionId}`,
          conversationId,
        })
      : null;
    const response = {
      messages: savedMessages,
      reports: [],
      reportStatus: "none",
      memoryStatus: "unchanged",
      planningStatus: planningJob?.status ?? "not_queued",
      planning_job_id: planningJob?.id,
      voice_session: {
        id: session.id,
        status: session.status,
        completed_at: session.completed_at,
      },
    };
    draft.idempotency[replayKey] = response;
    return response;
  });
  return json(res, 200, result);
}
async function integrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  userId: string,
  provider: "calendar" | "gmail",
  action: string,
  url: URL,
) {
  const type = provider === "calendar" ? "google_calendar" : "gmail";
  const method = req.method ?? "GET";
  if (action === "status" && method === "GET") {
    const item = ownIntegration(await store.snapshot(), userId, type);
    return json(res, 200, safeIntegration(item));
  }
  if (action === "calendars" && provider === "calendar" && method === "GET")
    return json(
      res,
      200,
      ownIntegration(await store.snapshot(), userId, type).selected_calendars ?? [],
    );
  if (action === "calendars" && provider === "calendar" && method === "PATCH") {
    const body = await readJson(req);
    if (
      !Array.isArray(body.selected_ids) ||
      body.selected_ids.length > 250 ||
      body.selected_ids.some((id: unknown) => typeof id !== "string" || !id.trim())
    )
      throw new HttpProblem(422, "INVALID_CALENDAR_SELECTION", "Choose valid calendars.", {
        field_errors: { selected_ids: "Use a list of at most 250 calendar IDs." },
      });
    const ids = new Set<string>(body.selected_ids);
    const key = idempotencyKey(req, body);
    const result = await store.transaction((draft) => {
      const item = ownIntegration(draft, userId, type);
      if (!item.encrypted_token)
        throw new HttpProblem(409, "CALENDAR_NOT_CONNECTED", "Connect Google Calendar first.");
      const knownIds = new Set((item.selected_calendars ?? []).map((calendar) => calendar.id));
      const unknown = [...ids].filter((id) => !knownIds.has(id));
      if (unknown.length)
        throw new HttpProblem(422, "UNKNOWN_CALENDAR", "Refresh before choosing calendars.", {
          field_errors: { selected_ids: "One or more calendars are no longer available." },
        });
      const changedIds = new Set<string>();
      item.selected_calendars?.forEach((calendar) => {
        if (calendar.selected !== ids.has(calendar.id)) changedIds.add(calendar.id);
        calendar.selected = ids.has(calendar.id);
      });
      draft.calendar_events = draft.calendar_events.filter(
        (event) => event.user_id !== userId || !changedIds.has(event.calendar_id),
      );
      const cursors = parseIntegrationCursor(item.cursor);
      for (const id of changedIds) delete cursors[id];
      item.cursor = JSON.stringify(cursors);
      if (changedIds.size) {
        item.credential_version = (item.credential_version ?? 0) + 1;
      }
      item.status = "syncing";
      delete item.failure_code;
      const dedupe = `calendar-selection:${userId}:${key}`;
      let job = draft.jobs.find(
        (candidate) => candidate.user_id === userId && candidate.dedupe_key === dedupe,
      );
      if (!job) {
        job = {
          id: randomUUID(),
          user_id: userId,
          type: "calendar_sync",
          dedupe_key: dedupe,
          status: "queued",
          attempts: 0,
          run_after: new Date().toISOString(),
          payload: { credential_version: item.credential_version ?? 0 },
        };
        draft.jobs.push(job);
      }
      return { calendars: item.selected_calendars ?? [], job_id: job.id, status: job.status };
    });
    return json(res, 202, result);
  }
  if (action === "cues" && provider === "gmail" && method === "GET")
    return json(
      res,
      200,
      (await store.snapshot()).gmail_cues.filter((item) => item.user_id === userId),
    );
  if (action === "connect" && method === "GET") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirect =
      provider === "calendar"
        ? (process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI)
        : (process.env.GOOGLE_GMAIL_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI);
    if (!clientId || !redirect || !process.env.GOOGLE_CLIENT_SECRET || !encryptionReady())
      return json(res, 200, {
        mode: "live",
        status: "disconnected",
        configuration_required: true,
        message: `${provider === "calendar" ? "Calendar" : "Gmail"} needs server-side Google OAuth configuration first.`,
      });
    const state = randomUUID();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await store.transaction((draft) => {
      draft.idempotency[`oauth:${state}`] = {
        user_id: userId,
        provider: type,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        pkce_verifier: encryptSecret(verifier),
      };
    });
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", redirect);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set(
      "scope",
      provider === "calendar"
        ? "https://www.googleapis.com/auth/calendar.readonly"
        : "https://www.googleapis.com/auth/gmail.metadata",
    );
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    auth.searchParams.set("state", state);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    return json(res, 200, { mode: "live", authorization_url: auth.toString() });
  }
  if (action === "callback" && method === "GET") {
    const code = url.searchParams.get("code");
    const oauthState = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    if (!oauthState)
      throw new HttpProblem(
        400,
        "OAUTH_CALLBACK_INVALID",
        "OAuth returned without matching state.",
      );
    const record = await store.transaction((draft) => {
      const candidate = draft.idempotency[`oauth:${oauthState}`] as any;
      if (
        !candidate ||
        candidate.user_id !== userId ||
        candidate.provider !== type ||
        new Date(candidate.expires_at) < new Date()
      )
        throw new HttpProblem(
          400,
          "OAUTH_STATE_INVALID",
          "This OAuth return link expired or did not match.",
        );
      delete draft.idempotency[`oauth:${oauthState}`];
      return candidate;
    });
    if (oauthError)
      throw new HttpProblem(
        400,
        "OAUTH_DENIED",
        `${provider === "calendar" ? "Google Calendar" : "Gmail"} access was not granted.`,
      );
    if (!code)
      throw new HttpProblem(400, "OAUTH_CALLBACK_INVALID", "OAuth returned without a code.");
    const redirect =
      provider === "calendar"
        ? (process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI)
        : (process.env.GOOGLE_GMAIL_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI);
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !redirect)
      throw new HttpProblem(
        503,
        "GOOGLE_OAUTH_NOT_CONFIGURED",
        "Google OAuth is not configured on this server.",
      );
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirect!,
        grant_type: "authorization_code",
        code_verifier: decryptSecret(record.pkce_verifier),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = asProviderObject(await tokenResponse.json().catch(() => ({})));
    const refreshToken = asNonEmptyProviderString(token.refresh_token);
    if (!tokenResponse.ok || !refreshToken)
      throw new HttpProblem(
        502,
        "OAUTH_TOKEN_FAILED",
        "Google did not return a reusable connection.",
      );
    await store.transaction((draft) => {
      const item = ownIntegration(draft, userId, type);
      item.mode = "live";
      item.status = provider === "calendar" ? "syncing" : "connected";
      item.encrypted_token = encryptSecret(refreshToken);
      item.scopes = (asProviderString(token.scope) ?? "").split(" ").filter(Boolean);
      item.credential_version = (item.credential_version ?? 0) + 1;
      item.cursor = undefined;
      item.selected_calendars = provider === "calendar" ? [] : item.selected_calendars;
      delete item.failure_code;
      delete item.last_successful_sync_at;
      if (provider === "calendar") {
        draft.calendar_events = draft.calendar_events.filter((event) => event.user_id !== userId);
        draft.jobs.push({
          id: randomUUID(),
          user_id: userId,
          type: "calendar_sync",
          dedupe_key: `calendar-sync:${userId}:oauth:${oauthState}`,
          status: "queued",
          attempts: 0,
          run_after: new Date().toISOString(),
          payload: { credential_version: item.credential_version },
        });
      }
    });
    res.writeHead(302, { location: "/#settings" });
    return res.end();
  }
  if (action === "sync" && method === "POST") {
    const body = await readJson(req);
    const key = idempotencyKey(req, body);
    const job = await store.transaction((draft) => {
      const existing = draft.jobs.find(
        (item) =>
          item.user_id === userId && item.dedupe_key === `${provider}-sync:${userId}:${key}`,
      );
      if (existing) return existing;
      const item = ownIntegration(draft, userId, type);
      if (!item.encrypted_token || item.mode !== "live")
        throw new HttpProblem(
          409,
          "INTEGRATION_NOT_CONNECTED",
          `Connect ${provider === "calendar" ? "Google Calendar" : "Gmail"} first.`,
        );
      item.status = "syncing";
      delete item.failure_code;
      const created = {
        id: randomUUID(),
        user_id: userId,
        type: (provider === "calendar" ? "calendar_sync" : "gmail_sync") as
          "calendar_sync" | "gmail_sync",
        dedupe_key: `${provider}-sync:${userId}:${key}`,
        status: "queued" as const,
        attempts: 0,
        run_after: new Date().toISOString(),
        payload: { credential_version: item.credential_version ?? 0 },
      };
      draft.jobs.push(created);
      return created;
    });
    return json(res, 202, {
      job_id: job.id,
      status: job.status,
      last_successful_sync_at: ownIntegration(await store.snapshot(), userId, type)
        .last_successful_sync_at,
    });
  }
  if (method === "DELETE" || action === "disconnect") {
    const result = await store.transaction((draft) => {
      const item = ownIntegration(draft, userId, type);
      delete item.encrypted_token;
      item.mode = "live";
      item.status = "disconnected";
      item.scopes = [];
      item.cursor = undefined;
      item.credential_version = (item.credential_version ?? 0) + 1;
      delete item.failure_code;
      delete item.last_successful_sync_at;
      if (provider === "calendar") {
        item.selected_calendars = [];
        draft.calendar_events = draft.calendar_events.filter((event) => event.user_id !== userId);
        for (const job of draft.jobs) {
          if (
            job.user_id === userId &&
            job.type === "calendar_sync" &&
            (job.status === "queued" || job.status === "running")
          ) {
            job.status = "failed";
            job.last_error_code = "INTEGRATION_DISCONNECTED";
            delete job.locked_until;
          }
        }
      }
      return safeIntegration(item);
    });
    return json(res, 200, result);
  }
  throw new HttpProblem(405, "METHOD_NOT_ALLOWED", "That integration action is not available.");
}
async function queueAvatar(
  store: Store,
  userId: string,
  input: {
    source: "studio" | "automatic_scene";
    purpose: "baseline" | "activity" | "variant";
    change: string;
    activityKey?: ActivityKey;
    idempotency: string;
    references?: string[];
  },
) {
  return store.transaction((draft) => {
    const prior = draft.avatar_requests.find(
      (item) => item.user_id === userId && item.idempotency_key === input.idempotency,
    );
    if (prior) return prior;
    const design = activeDesign(draft, userId);
    const now = new Date().toISOString();
    const request = {
      id: randomUUID(),
      user_id: userId,
      source: input.source,
      purpose: input.purpose,
      requested_change: input.change,
      requested_activity_key: input.activityKey,
      reference_design_version: design.version,
      reference_asset_ids: input.references ?? [],
      idempotency_key: input.idempotency,
      status: "queued" as const,
      created_at: now,
      updated_at: now,
    };
    draft.avatar_requests.push(request);
    draft.jobs.push({
      id: randomUUID(),
      user_id: userId,
      type: "avatar_generation",
      dedupe_key: `avatar:${input.idempotency}`,
      status: "queued",
      attempts: 0,
      run_after: now,
      payload: { request_id: request.id },
    });
    return request;
  });
}
function bootstrap(state: AppState, userId: string) {
  const settings = state.settings.find((item) => item.user_id === userId);
  if (!settings)
    return {
      profile_exists: false,
      setup_required: true,
      settings: null,
      openai: null,
      avatar: null,
      integrations: [],
    };
  const model = state.model_connections.find((item) => item.user_id === userId);
  const avatar = state.avatar_designs.find((item) => item.user_id === userId && item.is_active);
  return {
    profile_exists: true,
    setup_required: !settings.onboarding_complete,
    settings,
    openai: model ? safeModel(model) : null,
    avatar: avatar ?? null,
    integrations: state.integrations.filter((item) => item.user_id === userId).map(safeIntegration),
  };
}
function homeRead(state: AppState, userId: string) {
  const settings = ownSettings(state, userId);
  const localDate = localDateInZone(new Date(), settings.timezone);
  const day = latestDay(state, userId, localDate);
  const current = day ? activityAt(day) : undefined;
  const next = day?.activities.find((item) => current && item.start_at > current.start_at);
  const design = activeDesign(state, userId);
  const scene = resolveScene(state, userId, design, current?.activity_key);
  return {
    localDate,
    now: new Date().toISOString(),
    twinDayVersion: day,
    currentTwinActivity: current
      ? { ...current, activity_label: activityLabel(current.activity_key) }
      : current,
    nextTwinActivity: next,
    scene,
    avatar: design,
    realCalendarContext: state.calendar_events.filter(
      (item) => item.user_id === userId && !item.deleted,
    ),
    mailCueCount: state.gmail_cues.filter(
      (item) => item.user_id === userId && item.status === "active",
    ).length,
    sourceLimitations: day?.limited_context ?? ["No twin day has been generated yet."],
    talkConnectionStatus: safeModel(ownModel(state, userId)).status,
  };
}
function characterRead(state: AppState, userId: string) {
  const design = activeDesign(state, userId);
  const assets = state.avatar_assets.filter((item) => item.user_id === userId);
  return {
    design,
    versions: state.avatar_designs
      .filter((item) => item.user_id === userId)
      .sort((a, b) => b.version - a.version),
    photo: assets.find((item) => item.id === design.source_photo_asset_id)
      ? safeAsset(assets.find((item) => item.id === design.source_photo_asset_id)!)
      : null,
    baseline: approvedBaseline(state, userId, design)
      ? safeAsset(approvedBaseline(state, userId, design)!)
      : null,
    baseline_candidates: assets
      .filter((item) => item.kind === "base" && item.status === "ready" && !item.approved_at)
      .map(safeAsset),
    assets: assets.filter((item) => item.kind !== "source_photo").map(safeAsset),
    requests: state.avatar_requests
      .filter((item) => item.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20),
    generation_capability: ownModel(state, userId).image_capability,
    current: homeRead(state, userId).scene,
  };
}
function twinDayStatus(state: AppState, userId: string) {
  const settings = ownSettings(state, userId);
  const localDate = localDateInZone(new Date(), settings.timezone);
  if (latestDay(state, userId, localDate)) return "ready";
  const job = state.jobs.find(
    (item) =>
      item.user_id === userId &&
      item.type === "twin_day_generation" &&
      item.payload.local_date === localDate,
  );
  if (job?.status === "queued" || job?.status === "running") return "queued";
  if (job?.status === "failed") return "failed";
  const model = state.model_connections.find((item) => item.user_id === userId);
  return model?.encrypted_key ? "scheduled" : "openai_key_required";
}
function validLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
async function readBody(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpProblem(413, "PAYLOAD_TOO_LARGE", "That request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, any>> {
  const text = await readBody(req, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpProblem(400, "INVALID_JSON", "That request is not valid JSON.");
  }
}
function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
function ownSettings(state: AppState, userId: string) {
  const item = state.settings.find((candidate) => candidate.user_id === userId);
  if (!item) throw new HttpProblem(404, "SETTINGS_NOT_FOUND", "Settings were not found.");
  item.talk_personality_mode ??= "collaborative";
  return item;
}
function ownModel(state: AppState, userId: string) {
  const item = state.model_connections.find((candidate) => candidate.user_id === userId);
  if (!item)
    throw new HttpProblem(404, "MODEL_CONNECTION_NOT_FOUND", "OpenAI settings were not found.");
  return item;
}
function ownIntegration(state: AppState, userId: string, provider: "google_calendar" | "gmail") {
  const item = state.integrations.find(
    (candidate) => candidate.user_id === userId && candidate.provider === provider,
  );
  if (!item) throw new HttpProblem(404, "INTEGRATION_NOT_FOUND", "That integration was not found.");
  return item;
}
function ownConversation(state: AppState, userId: string, id: string) {
  const item = state.conversations.find(
    (candidate) => candidate.id === id && candidate.user_id === userId,
  );
  if (!item)
    throw new HttpProblem(404, "CONVERSATION_NOT_FOUND", "That conversation could not be found.");
  return item;
}
function activeDesign(state: AppState, userId: string) {
  const item = state.avatar_designs.find(
    (candidate) => candidate.user_id === userId && candidate.is_active,
  );
  if (!item) throw new HttpProblem(404, "AVATAR_NOT_FOUND", "The twin design could not be found.");
  return item;
}
function latestDay(state: AppState, userId: string, date: string) {
  return state.twin_days
    .filter(
      (item) => item.user_id === userId && item.local_date === date && item.status === "ready",
    )
    .sort((a, b) => b.version - a.version)[0];
}
function safeModel(item: ModelConnection) {
  const { encrypted_key: _encryptedKey, ...safe } = item;
  const realtime = resolveRealtimeConfig();
  return {
    ...safe,
    planner_model: configuredModels().plannerModel,
    realtime_model: realtime.model,
    realtime_voice: realtime.voice,
    realtime_transcription_model: realtime.transcriptionModel,
    key_masked: item.key_suffix ? `••••${item.key_suffix}` : undefined,
    encryption_ready: encryptionReady(),
  };
}
function safeIntegration(item: IntegrationConnection) {
  const { encrypted_token: _encryptedToken, ...safe } = item;
  return { ...safe, has_credentials: Boolean(item.encrypted_token) };
}
function parseIntegrationCursor(value: string | undefined) {
  if (!value) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}
function idempotencyKey(req: IncomingMessage, body: Record<string, any>) {
  const value = req.headers["idempotency-key"] ?? body.idempotency_key;
  if (typeof value !== "string" || !value.trim())
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "Include an Idempotency-Key header.");
  return value.slice(0, 160);
}
function requestIdempotencyKey(req: IncomingMessage) {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || !value.trim())
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "Include an Idempotency-Key header.");
  return value.trim().slice(0, 160);
}
function validTalkPersonality(value: unknown): value is TalkPersonalityMode {
  return ["collaborative", "direct_coach", "aspirational_self"].includes(String(value));
}
function validSdpOffer(value: string) {
  return (
    value.length >= 20 &&
    value.length <= 65_536 &&
    value.startsWith("v=0") &&
    /(?:^|\r?\n)m=audio\s/i.test(value) &&
    !value.includes(String.fromCharCode(0))
  );
}
interface CompletedVoiceTranscriptItem {
  provider_item_id: string;
  role: "user" | "assistant";
  transcript: string;
  completed_at: string;
}
function validateVoiceTranscriptItems(body: Record<string, any>): {
  items: CompletedVoiceTranscriptItem[];
  disposition: "complete" | "abandoned";
} {
  const disposition = body.disposition ?? "complete";
  if (
    Object.keys(body).some((key) => !["items", "disposition", "idempotency_key"].includes(key)) ||
    (disposition !== "complete" && disposition !== "abandoned") ||
    !Array.isArray(body.items) ||
    body.items.length > 32
  )
    throw new HttpProblem(
      422,
      "INVALID_VOICE_TRANSCRIPT",
      "Send up to 32 completed transcript items and a valid close disposition.",
    );
  const ids = new Set<string>();
  let total = 0;
  const items = body.items.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new HttpProblem(422, "INVALID_VOICE_TRANSCRIPT", "A transcript item was invalid.");
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) => !["provider_item_id", "role", "transcript", "completed_at"].includes(key),
      ) ||
      typeof item.provider_item_id !== "string" ||
      !item.provider_item_id.trim() ||
      item.provider_item_id.length > 200 ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.transcript !== "string" ||
      !item.transcript.trim() ||
      item.transcript.trim().length > 3000 ||
      typeof item.completed_at !== "string" ||
      !Number.isFinite(new Date(item.completed_at).getTime())
    )
      throw new HttpProblem(
        422,
        "INVALID_VOICE_TRANSCRIPT",
        "Only completed, bounded voice transcript items can be saved.",
      );
    const id = item.provider_item_id.trim();
    if (ids.has(id))
      throw new HttpProblem(
        422,
        "DUPLICATE_VOICE_ITEM",
        "Each completed transcript item must be unique.",
      );
    ids.add(id);
    const transcript = item.transcript.trim();
    total += transcript.length;
    if (total > 24_000)
      throw new HttpProblem(
        413,
        "VOICE_TRANSCRIPT_TOO_LARGE",
        "That voice transcript is too large to save at once.",
      );
    return {
      provider_item_id: id,
      role: item.role as "user" | "assistant",
      transcript,
      completed_at: new Date(item.completed_at).toISOString(),
    };
  });
  return { items, disposition };
}
function validActivity(value: unknown): value is ActivityKey {
  return [
    "generic",
    "studying",
    "working",
    "walking",
    "running",
    "eating",
    "sleeping",
    "resting",
    "commuting",
    "bathroom",
  ].includes(String(value));
}
function approvedBaseline(state: AppState, userId: string, design = activeDesign(state, userId)) {
  return state.avatar_assets.find(
    (item) =>
      item.id === design.baseline_asset_id &&
      item.user_id === userId &&
      item.kind === "base" &&
      item.status === "ready" &&
      item.approved_at,
  );
}
function safeAsset<T extends Record<string, any>>(asset: T) {
  const { storage_key, ...safe } = asset;
  return {
    ...safe,
    assetUrl: asset.status === "ready" && storage_key ? `/api/assets/${asset.id}` : undefined,
  };
}
function resolveScene(
  state: AppState,
  userId: string,
  design = activeDesign(state, userId),
  key?: ActivityKey,
) {
  const baseline = approvedBaseline(state, userId, design);
  if (key) {
    const activity = state.avatar_assets
      .filter(
        (item) =>
          item.user_id === userId &&
          item.design_version === design.version &&
          item.activity_key === key &&
          item.kind === "activity" &&
          item.status === "ready" &&
          item.selected_at,
      )
      .sort((a, b) => String(b.selected_at).localeCompare(String(a.selected_at)))[0];
    if (activity)
      return {
        kind: "activity",
        status: "ready",
        activity_key: key,
        activity_label: activityLabel(key),
        assetUrl: `/api/assets/${activity.id}`,
        asset: safeAsset(activity),
      };
    const request = state.avatar_requests
      .filter(
        (item) =>
          item.user_id === userId &&
          item.reference_design_version === design.version &&
          item.purpose === "activity" &&
          item.requested_activity_key === key,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (baseline)
      return {
        kind: "baseline",
        status:
          request?.status === "failed"
            ? "failed"
            : request && ["queued", "generating"].includes(request.status)
              ? "generating"
              : "fallback",
        activity_key: key,
        activity_label: activityLabel(key),
        assetUrl: `/api/assets/${baseline.id}`,
        asset: safeAsset(baseline),
        error_code: request?.failure_code,
        retryable: request?.status === "failed",
      };
  }
  if (baseline)
    return {
      kind: "baseline",
      status: "ready",
      activity_key: key ?? "generic",
      activity_label: activityLabel(key ?? "generic"),
      assetUrl: `/api/assets/${baseline.id}`,
      asset: safeAsset(baseline),
    };
  return {
    kind: "coded",
    status: "fallback",
    activity_key: key ?? "generic",
    activity_label: activityLabel(key ?? "generic"),
  };
}
function activityImageDirection(key: ActivityKey) {
  return (
    {
      generic: "standing naturally in a neutral full-body pose",
      studying:
        "studying at a simple desk, seated naturally while reading notes beside an open laptop",
      working: "working with calm focus at a simple desk",
      walking: "walking outdoors with an easy natural stride",
      running:
        "running outdoors with believable athletic posture and a cheerful focused expression",
      eating: "having a relaxed meal at a small table",
      sleeping: "sleeping peacefully in a simple non-dramatic bedroom scene",
      resting: "resting comfortably with a book",
      commuting: "commuting with a small everyday bag",
      bathroom: "in a tasteful, playful, completely non-graphic bathroom scene",
    } as Record<ActivityKey, string>
  )[key];
}
function decodeImageDataUrl(value: unknown) {
  if (typeof value !== "string")
    throw new HttpProblem(422, "INVALID_AVATAR_PHOTO", "Choose a PNG, JPEG, or WebP photo.");
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match)
    throw new HttpProblem(422, "INVALID_AVATAR_PHOTO", "Choose a PNG, JPEG, or WebP photo.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > 8_000_000)
    throw new HttpProblem(413, "AVATAR_PHOTO_TOO_LARGE", "Use a photo smaller than 8 MB.");
  const mime = match[1];
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (
    (mime === "image/png" && !png) ||
    (mime === "image/jpeg" && !jpeg) ||
    (mime === "image/webp" && !webp)
  )
    throw new HttpProblem(
      422,
      "INVALID_AVATAR_PHOTO",
      "The file contents do not match its image type.",
    );
  return { mime, bytes };
}
function exportUser(state: AppState, userId: string) {
  const result: any = { exported_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(state))
    if (Array.isArray(value))
      result[key] = value
        .filter((item: any) => item.user_id === userId)
        .map((item: any) => {
          const copy = { ...item };
          delete copy.encrypted_key;
          delete copy.encrypted_token;
          return copy;
        });
  return result;
}
function removeUserData(state: AppState, userId: string) {
  for (const key of Object.keys(state) as Array<keyof AppState>) {
    const value = state[key];
    if (Array.isArray(value)) {
      (state as any)[key] = value.filter((item: any) =>
        key === "users" ? item.id !== userId : item.user_id !== userId,
      );
    }
  }
  state.idempotency = {};
}
