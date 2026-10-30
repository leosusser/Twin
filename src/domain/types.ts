export type Confidence = "user_stated" | "inferred";
export type FactStatus = "active" | "tentative" | "suppressed";
export type Authority =
  "user_edit" | "talk_user_stated" | "onboarding_user_stated" | "model_inferred" | "gmail_cue";
export type ActivityKey =
  | "generic"
  | "studying"
  | "working"
  | "walking"
  | "running"
  | "eating"
  | "sleeping"
  | "resting"
  | "commuting"
  | "bathroom";
export type PlanningTrigger = "morning" | "after_conversation" | "manual";
export interface ObservationInput {
  id: string;
  kind:
    | "routine"
    | "commitment"
    | "sleep"
    | "energy_cue"
    | "wellbeing_cue"
    | "distraction"
    | "goal"
    | "boundary";
  statement: string;
  source_excerpt?: string;
  confidence: Confidence;
}
export interface HandoffInput {
  schema_version: 1;
  source: "chatgpt_voice_onboarding" | "chatgpt_later_conversation";
  session_id: string;
  created_at: string;
  timezone: string;
  observations: ObservationInput[];
}
export interface StoredObservation extends ObservationInput {
  user_id: string;
  import_batch_id?: string;
  message_id?: string;
  captured_at: string;
}
export interface ImportBatch {
  id: string;
  user_id: string;
  sha256: string;
  source: string;
  source_session_id: string;
  schema_version: number;
  captured_at: string;
  received_at: string;
  status: "applied" | "invalid";
  applied_counts: { active: number; tentative: number };
  conflict_count: number;
  fact_ids: string[];
  raw_payload_expiry: string;
}
export interface ProfileFact {
  id: string;
  user_id: string;
  fact_key: string;
  kind: ObservationInput["kind"];
  statement: string;
  source_excerpt: string;
  source_type: string;
  source_id: string;
  captured_at: string;
  status: FactStatus;
  authority: Authority;
  certainty: Confidence;
  version: number;
  updated_at: string;
}
export interface MemoryOverride {
  id: string;
  user_id: string;
  fact_key: string;
  action: "edit" | "remove";
  replacement?: string;
  recorded_at: string;
  version: number;
}
export interface CalendarEvent {
  id: string;
  user_id: string;
  external_id: string;
  calendar_id: string;
  title: string;
  start_at?: string;
  end_at?: string;
  start_date?: string;
  end_date?: string;
  source_timezone: string;
  all_day: boolean;
  deleted: boolean;
  availability?: "busy" | "free";
  self_response_status?: "accepted" | "declined" | "tentative" | "needs_action";
  recurring_event_id?: string;
  source_type?: "google_api" | "prototype_ical" | "demo";
  sync_revision: number;
}
export interface IntegrationConnection {
  id: string;
  user_id: string;
  provider: "google_calendar" | "gmail";
  mode: "demo" | "live" | "prototype";
  status: "demo" | "connected" | "imported" | "disconnected" | "expired" | "syncing" | "failed";
  scopes: string[];
  encrypted_token?: { iv: string; tag: string; ciphertext: string };
  last_successful_sync_at?: string;
  cursor?: string;
  failure_code?: string;
  credential_version?: number;
  selected_calendars?: Array<{ id: string; name: string; selected: boolean }>;
  source_url_hash?: string;
  source_window_start_date?: string;
  source_window_end_date?: string;
  source_event_count?: number;
}
export interface GmailCue {
  id: string;
  user_id: string;
  source_message_id: string;
  kind: "dated_obligation" | "recurring_pattern" | "change_notice";
  statement: string;
  source_excerpt: string;
  captured_at: string;
  expires_at: string;
  confidence: "possible";
  status: "active" | "suppressed";
}
export interface TwinActivity {
  id: string;
  user_id: string;
  activity_key: ActivityKey;
  start_at: string;
  end_at: string;
  title: string;
  narrative: string;
  reason: string;
  supporting_fact_ids: string[];
  source_event_ids: string[];
  supporting_report_ids?: string[];
  source_message_ids?: string[];
  source_types: Array<"memory" | "calendar" | "gmail" | "report" | "conversation">;
  confidence: "grounded" | "possible";
  is_experiment: boolean;
  locked?: boolean;
  user_edited?: boolean;
}
export interface PlanningConflict {
  kind: "calendar_overlap" | "protected_activity" | "uncertain_timing" | "other";
  description: string;
  source_event_ids: string[];
}
export interface TwinDayVersion {
  id: string;
  user_id: string;
  local_date: string;
  timezone: string;
  version: number;
  status: "ready" | "superseded";
  generated_at: string;
  reason: string;
  memory_revision: number;
  calendar_revision: number;
  report_revision: number;
  limited_context: string[];
  tomorrow_may_change_because: string[];
  activities: TwinActivity[];
  parent_version_id?: string;
  planning_trigger?: PlanningTrigger;
  planner_model?: string;
  input_revision?: string;
  change_summary?: string;
  reason_source_ids?: string[];
  unresolved_conflicts?: PlanningConflict[];
}
export interface ActivityReport {
  id: string;
  user_id: string;
  conversation_message_id?: string;
  local_date: string;
  approximate_time?: string;
  activity_key: ActivityKey;
  statement: string;
  source: "talk_user_report" | "manual_rebuild_report";
  created_at: string;
  correction_of_id?: string;
}
export interface Settings {
  user_id: string;
  name: string;
  timezone: string;
  wake_time: string;
  sleep_time: string;
  tomorrow_generation_time: string;
  reminders_enabled: boolean;
  hide_bathroom_scene: boolean;
  talk_retention_days: number;
  onboarding_complete: boolean;
  version: number;
}
export interface ModelConnection {
  user_id: string;
  provider: "openai";
  encrypted_key?: { iv: string; tag: string; ciphertext: string };
  key_suffix?: string;
  status: "not_connected" | "connected" | "invalid" | "quota" | "network_error";
  text_capability: "unknown" | "available" | "unavailable";
  image_capability: "unknown" | "available" | "unavailable";
  tested_at?: string;
  credential_version?: number;
}
export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface Message {
  id: string;
  user_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: "saved" | "failed";
  created_at: string;
  provider_request_id?: string;
}
export interface AvatarDesign {
  id: string;
  user_id: string;
  version: number;
  parent_version_id?: number;
  name: string;
  skin: string;
  hair: string;
  hair_style: "soft" | "curly" | "short";
  top: string;
  bottom: string;
  accent: string;
  expression: "warm" | "focused" | "calm";
  body_style: "soft" | "angular";
  style_version: number;
  source_photo_asset_id?: string;
  baseline_asset_id?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
export interface AvatarAsset {
  id: string;
  user_id: string;
  design_version: number;
  parent_asset_ids: string[];
  kind: "source_photo" | "base" | "activity" | "variant";
  activity_key?: ActivityKey;
  prompt_version: number;
  model: string;
  storage_key?: string;
  original_name?: string;
  mime?: string;
  width?: number;
  height?: number;
  sha256?: string;
  status: "queued" | "generating" | "ready" | "failed";
  selected_at?: string;
  approved_at?: string;
  created_at: string;
  last_used_at?: string;
  error_code?: string;
}
export interface AvatarGenerationRequest {
  id: string;
  user_id: string;
  source: "talk" | "studio" | "automatic_scene";
  purpose: "baseline" | "activity" | "variant";
  source_message_id?: string;
  requested_change: string;
  requested_activity_key?: ActivityKey;
  reference_design_version: number;
  reference_asset_ids: string[];
  idempotency_key: string;
  status: "queued" | "generating" | "ready" | "failed";
  failure_code?: string;
  created_at: string;
  updated_at: string;
}
export interface Job {
  id: string;
  user_id: string;
  type: "calendar_sync" | "gmail_sync" | "twin_day_generation" | "avatar_generation" | "cleanup";
  dedupe_key: string;
  status: "queued" | "running" | "complete" | "failed";
  attempts: number;
  run_after: string;
  locked_until?: string;
  last_error_code?: string;
  payload: Record<string, unknown>;
  result?: {
    status: "updated" | "no_change";
    day_id?: string;
    day_version?: number;
  };
}
export interface AppState {
  users: Array<{ id: string; email: string; created_at: string }>;
  settings: Settings[];
  imports: ImportBatch[];
  observations: StoredObservation[];
  facts: ProfileFact[];
  memory_overrides: MemoryOverride[];
  integrations: IntegrationConnection[];
  calendar_events: CalendarEvent[];
  gmail_cues: GmailCue[];
  twin_days: TwinDayVersion[];
  activity_reports: ActivityReport[];
  model_connections: ModelConnection[];
  conversations: Conversation[];
  messages: Message[];
  avatar_designs: AvatarDesign[];
  avatar_assets: AvatarAsset[];
  avatar_requests: AvatarGenerationRequest[];
  jobs: Job[];
  idempotency: Record<string, unknown>;
}
