import { createHash, randomUUID } from "node:crypto";
import type { AppState, HandoffInput, ImportBatch, ObservationInput, ProfileFact } from "./types.ts";
const kinds = new Set(["routine", "commitment", "sleep", "energy_cue", "wellbeing_cue", "distraction", "goal", "boundary"]);
const sources = new Set(["chatgpt_voice_onboarding", "chatgpt_later_conversation"]);
export class ValidationProblem extends Error { code = "INVALID_HANDOFF"; status = 422; field_errors:Record<string,string>; constructor(field_errors: Record<string,string>) { super("The handoff has fields that need attention."); this.field_errors=field_errors; } }
export function canonicalize(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`; return JSON.stringify(value); }
export function hashHandoff(value: unknown) { return createHash("sha256").update(canonicalize(value)).digest("hex"); }
export function validateHandoff(value: unknown): HandoffInput {
  const errors: Record<string,string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationProblem({ $: "Expected a JSON object." });
  const item = value as Record<string,unknown>;
  if (item.schema_version !== 1) errors.schema_version = "Only schema version 1 is supported.";
  if (typeof item.source !== "string" || !sources.has(item.source)) errors.source = "Unsupported handoff source.";
  if (typeof item.session_id !== "string" || !item.session_id.trim() || item.session_id.length > 160) errors.session_id = "Use a non-empty session ID under 160 characters.";
  if (typeof item.created_at !== "string" || Number.isNaN(Date.parse(item.created_at))) errors.created_at = "Use an ISO-8601 timestamp.";
  if (typeof item.timezone !== "string") errors.timezone = "Use an IANA time zone."; else { try { new Intl.DateTimeFormat("en", { timeZone: item.timezone }).format(); } catch { errors.timezone = "Use a valid IANA time zone."; } }
  if (!Array.isArray(item.observations)) errors.observations = "Expected an observations array.";
  else if (!item.observations.length || item.observations.length > 100) errors.observations = "Include between 1 and 100 observations.";
  else { const ids = new Set<string>(); item.observations.forEach((raw,index) => { const path = `observations.${index}`; if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors[path] = "Expected an observation object."; return; } const observation = raw as Record<string,unknown>; if (typeof observation.id !== "string" || !observation.id.trim()) errors[`${path}.id`] = "ID is required."; else if (ids.has(observation.id)) errors[`${path}.id`] = "Observation IDs must be unique."; else ids.add(observation.id); if (typeof observation.kind !== "string" || !kinds.has(observation.kind)) errors[`${path}.kind`] = "Unsupported observation kind."; if (typeof observation.statement !== "string" || observation.statement.trim().length < 3 || observation.statement.length > 600) errors[`${path}.statement`] = "Use 3–600 characters."; if (!["user_stated","inferred"].includes(String(observation.confidence))) errors[`${path}.confidence`] = "Use user_stated or inferred."; if (observation.source_excerpt != null && (typeof observation.source_excerpt !== "string" || observation.source_excerpt.length > 240)) errors[`${path}.source_excerpt`] = "Keep the excerpt under 240 characters."; }); }
  if (Object.keys(errors).length) throw new ValidationProblem(errors); return item as unknown as HandoffInput;
}
export function factKey(observation: Pick<ObservationInput,"kind"|"statement">) { return `${observation.kind}:${observation.statement.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().slice(0,180)}`; }
export function applyHandoff(draft: AppState, input: HandoffInput, userId: string): ImportBatch {
  const now = new Date(); const batch: ImportBatch = { id: randomUUID(), user_id:userId, sha256:hashHandoff(input), source:input.source, source_session_id:input.session_id, schema_version:1, captured_at:input.created_at, received_at:now.toISOString(), status:"applied", applied_counts:{active:0,tentative:0}, conflict_count:0, fact_ids:[], raw_payload_expiry:new Date(now.getTime()+7*86_400_000).toISOString() };
  for (const observation of input.observations) {
    const key = factKey(observation); draft.observations.push({ ...observation, statement:observation.statement.trim(), source_excerpt:observation.source_excerpt?.trim(), user_id:userId, import_batch_id:batch.id, captured_at:input.created_at });
    const override = draft.memory_overrides.filter((item) => item.user_id===userId && item.fact_key===key).sort((a,b)=>b.version-a.version)[0];
    if (override?.action === "remove") { batch.conflict_count += 1; continue; }
    const existing = draft.facts.find((fact) => fact.user_id===userId && fact.fact_key===key);
    if (existing?.authority === "user_edit") { batch.conflict_count += 1; batch.fact_ids.push(existing.id); continue; }
    const status = observation.confidence === "user_stated" ? "active" : "tentative";
    const fact: ProfileFact = { id:existing?.id??randomUUID(), user_id:userId, fact_key:key, kind:observation.kind, statement:override?.replacement??observation.statement.trim(), source_excerpt:observation.source_excerpt?.trim()??observation.statement.trim().slice(0,180), source_type:input.source, source_id:`${input.session_id}:${observation.id}`, captured_at:input.created_at, status, authority:observation.confidence==="user_stated"?"onboarding_user_stated":"model_inferred", certainty:observation.confidence, version:(existing?.version??0)+1, updated_at:now.toISOString() };
    const index = draft.facts.findIndex((item)=>item.id===fact.id); if (index>=0) draft.facts[index]=fact; else draft.facts.push(fact); batch.fact_ids.push(fact.id); batch.applied_counts[status==="active"?"active":"tentative"] += 1;
  }
  draft.imports.push(batch); const settings=draft.settings.find((item)=>item.user_id===userId); if(settings){settings.timezone=input.timezone;settings.onboarding_complete=true;settings.version+=1;} return batch;
}
