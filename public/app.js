const ONBOARDING_PROMPT = `You are helping me create a private Personal Twin profile for a digital twin app. Talk with me naturally, one question at a time. Be warm, curious, and concise. Do not make assumptions when a follow-up question would help. I can skip any question.

Learn about my ordinary weekdays and weekends; wake and sleep times; work, school, caregiving, meals, travel, movement, and recurring commitments; when I tend to have energy or feel drained; what helps me feel better; what distracts me; people and activities that matter to me; habits I want to build; and limits the app must respect. Ask for my time zone and clarify approximate versus fixed times. Do not ask for passwords, API keys, medical diagnoses, or a full email history. Do not diagnose me or present yourself as a therapist.

At the end, summarize the important points in plain language. When I say “Finish and export JSON”, output ONLY valid JSON, with no Markdown fence or explanation. Use this shape:
{
  "schema_version": 1,
  "source": "chatgpt_voice_onboarding",
  "session_id": "a stable unique ID for this conversation",
  "created_at": "an ISO 8601 UTC timestamp",
  "timezone": "an IANA time zone such as America/New_York",
  "observations": [
    {
      "id": "a unique ID within this export",
      "kind": "routine | commitment | sleep | energy_cue | wellbeing_cue | distraction | goal | boundary",
      "statement": "one concise, self-contained fact",
      "source_excerpt": "a short supporting phrase from what I said, without a full transcript",
      "confidence": "user_stated | inferred"
    }
  ]
}
Use one observation per fact. Mark confidence "user_stated" only when I explicitly said it; mark an interpretation "inferred". Keep uncertain times approximate in the statement. Do not invent calendar events or fill gaps with guesses. Include only information I willingly shared. If I correct you, use the corrected version. Ensure the final JSON parses.`;
const SAMPLE = () =>
  JSON.stringify(
    {
      schema_version: 1,
      source: "chatgpt_voice_onboarding",
      session_id: `sample-${Date.now()}`,
      created_at: new Date().toISOString(),
      timezone: "America/New_York",
      observations: [
        {
          id: "walk-after-lunch",
          kind: "wellbeing_cue",
          statement: "A short walk after lunch often helps me reset.",
          source_excerpt: "Walking after lunch helps.",
          confidence: "user_stated",
        },
        {
          id: "evening-boundary",
          kind: "boundary",
          statement: "I want focused work to stay out of the late evening.",
          source_excerpt: "I want my evenings protected.",
          confidence: "user_stated",
        },
        {
          id: "focus-pattern",
          kind: "energy_cue",
          statement: "A real break may make late-afternoon focus easier.",
          source_excerpt: "A break sometimes seems to help.",
          confidence: "inferred",
        },
      ],
    },
    null,
    2,
  );
const app = {
  bootstrap: null,
  home: null,
  day: null,
  facts: [],
  settings: null,
  character: null,
  reports: [],
  conversations: [],
  route: "home",
  talkOpen: false,
  conversationId: null,
  showOnboarding: false,
  importResult: null,
  importError: null,
  importText: "",
  importFileName: "",
  loading: false,
  avatarBusy: false,
  avatarPreview: null,
  avatarPoll: null,
  avatarCandidateId: null,
  integrationPoll: null,
  schedulePending: false,
  scheduleRequest: 0,
  talkDraft: "",
  talkSending: false,
  ui: { scroll: {}, openDetails: {}, fields: {}, focusKey: null },
  scheduleRebuild: {
    busy: false,
    actualReport: "",
    instruction: "",
    status: null,
    idempotencyKey: null,
    requestSignature: null,
  },
};
const root = document.querySelector("#app");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const uuid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload.message ?? "Request failed");
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}
async function init() {
  try {
    app.bootstrap = await api("/api/bootstrap");
    app.showOnboarding = app.bootstrap.setup_required;
    app.route = ["home", "schedule", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
    if (!app.showOnboarding) await loadAll();
    render();
  } catch (error) {
    root.innerHTML = errorState("The twin couldn't start", error.message, true);
  }
}
async function loadAll() {
  const [home, settings, facts, character, reports, conversations] = await Promise.all([api("/api/home"), api("/api/settings"), api("/api/profile/facts"), api("/api/character"), api("/api/activity-reports"), api("/api/talk/conversations")]);
  Object.assign(app, {
    home,
    day: home.twinDayVersion,
    settings,
    facts,
    character,
    reports,
    conversations,
  });
  app.bootstrap.openai = settings.openai;
  app.conversationId = conversations[0]?.id ?? null;
  await ensureCurrentScene();
}
function render() {
  if (app.showOnboarding) return renderOnboarding();
  const home = app.route === "home";
  root.innerHTML = `<div class="shell ${home ? "home-shell" : ""}">${topbar()}<main id="main" class="app-main ${home ? "home-main" : ""}">${home ? homePage() : app.route === "schedule" ? schedulePage() : settingsPage()}</main>${bottomNav()}${talkLayer()}</div>`;
}
function topbar() {
  if (app.route === "home") return `<header class="app-top home-topbar"><button class="home-wordmark" data-route="home" aria-label="Twin home">TWIN</button><button class="home-talk-button ${app.talkOpen ? "open" : ""}" data-talk-toggle aria-label="${app.talkOpen ? "Close Talk" : "Talk to your twin"}" aria-expanded="${app.talkOpen}">${app.talkOpen ? "CLOSE" : "TALK"}</button></header>`;
  return `<header class="app-top"><button class="brand" data-route="home" aria-label="Personal Twin home"><span class="brand-mark">T</span><span class="brand-word">Personal Twin</span></button><button class="talk-orb ${app.talkOpen ? "open" : ""}" data-talk-toggle aria-label="${app.talkOpen ? "Close Talk" : "Open Talk"}" aria-expanded="${app.talkOpen}">${app.talkOpen ? closeIcon() : chatIcon()}</button></header>`;
}
function bottomNav() {
  if (app.route === "home") return `<nav class="bottom-nav home-bottom-nav" aria-label="Main navigation"><button data-route="schedule">SCHEDULE</button><button data-route="settings">SETTINGS</button></nav>`;
  const other = ["home", "schedule", "settings"].filter((item) => item !== app.route);
  return `<nav class="bottom-nav" aria-label="Other destinations">${other.map((item) => `<button data-route="${item}">${item}</button>`).join("")}</nav>`;
}
function homePage() {
  const h = app.home;
  if (!h?.twinDayVersion) return `<section class="home-screen home-empty">${empty("No twin day yet", "Import memory or wait for the first local generation.")}</section>`;
  const current = h.currentTwinActivity;
  const activity = current?.activity_label ?? activityName(current?.activity_key ?? "generic");
  const headline = current?.title ?? activity;
  const until = current?.end_at ? `Until ${formatTime(current.end_at, h.twinDayVersion.timezone)}` : "Now";
  const detail = `<span class="home-until">${escapeHtml(until)}</span>${current?.narrative ? escapeHtml(current.narrative) : ""}`;
  const next = h.nextTwinActivity;
  return `<section class="home-screen" aria-labelledby="home-current-activity"><section class="home-current"><p class="home-kicker"><span aria-hidden="true"></span>Your twin is</p><h1 id="home-current-activity">${escapeHtml(headline)}</h1><p class="home-detail">${detail}</p></section><section class="home-avatar" aria-label="Your twin ${escapeHtml(activity.toLowerCase())}">${sceneArtwork(h.scene, h.avatar, current?.activity_key ?? "generic", `Your twin ${activity.toLowerCase()}`)}${h.scene?.status === "generating" ? `<p class="home-generation-state" aria-live="polite">Creating the ${escapeHtml(activity.toLowerCase())} image…</p>` : ""}${h.scene?.status === "failed" ? `<p class="home-generation-state error">Image generation failed. <button class="text-link" data-retry-scene>Retry</button></p>` : ""}</section><section class="home-next" aria-labelledby="home-next-label"><div><p id="home-next-label" class="home-next-label">Next for your twin</p><p class="home-next-action">${escapeHtml(next?.title ?? "The day is open")}</p></div>${next?.start_at ? `<time class="home-next-time" datetime="${escapeHtml(next.start_at)}">${formatTime(next.start_at, h.twinDayVersion.timezone)}</time>` : ""}</section></section>`;
}
function previewRow(item) {
  return `<div class="preview-row"><time>${formatTime(item.start_at, app.settings.timezone)}</time><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.narrative)}</p></div><span class="pill imagined">Twin imagined</span></div>`;
}
function schedulePage() {
  const day = app.day;
  if (!day) return `<section class="page">${empty("No day to show", "This simulation has not been generated yet.")}</section>`;
  return `<section class="page"><div class="page-head"><div><p class="eyebrow">Read-only simulation · version ${day.version}</p><h1 class="display page-title">What day is the twin living?</h1></div><div class="meta-block"><strong>${formatShortDate(day.local_date)}</strong><span>${escapeHtml(day.timezone)}</span></div></div>${weekStrip(day.local_date)}<div class="schedule-layout"><section class="timeline" aria-label="Twin's illustrative timeline">${day.activities.map(activityBlock).join("")}</section><aside class="schedule-aside"><div class="tomorrow-note"><strong>Tomorrow may change because…</strong>${day.tomorrow_may_change_because.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div><div class="source-key"><span class="pill imagined">Twin's imagined activity</span><span class="pill calendar">Your real Calendar event</span><span class="pill report">You reported doing</span><p class="small">These categories never become one unlabeled timeline.</p></div><div class="context-card"><h3>Version details</h3><p class="small">Generated ${relativeTime(day.generated_at)} from memory revision ${day.memory_revision}, Calendar revision ${day.calendar_revision}, and report revision ${day.report_revision}.</p></div></aside></div></section>`;
}
function weekStrip(selected) {
  const base = new Date(`${selected}T12:00:00Z`);
  const day = base.getUTCDay();
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - ((day + 6) % 7));
  return `<div class="week-strip" aria-label="Choose day">${Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    const iso = date.toISOString().slice(0, 10);
    return `<button class="week-day ${iso === selected ? "active" : ""}" data-date="${iso}"><span>${date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span><strong>${date.getUTCDate()}</strong></button>`;
  }).join("")}</div>`;
}
function activityBlock(item) {
  const scene = libraryScene(item.activity_key);
  return `<article class="activity"><time class="activity-time">${formatTime(item.start_at, app.settings.timezone)}</time><div class="avatar-thumb">${sceneArtwork(scene, app.character.design, item.activity_key, item.title)}</div><div><span class="pill imagined">Twin's imagined activity · ${escapeHtml(activityName(item.activity_key))}</span>${item.source_types.includes("calendar") ? ` <span class="pill calendar">Calendar context</span>` : ""}${item.source_types.includes("report") ? ` <span class="pill report">Prior report</span>` : ""}<h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.narrative)}</p><details><summary>Why this appeared</summary><p>${escapeHtml(item.reason)}</p><p class="small">Confidence: ${escapeHtml(item.confidence)} · Activity key: ${escapeHtml(item.activity_key)}</p></details></div></article>`;
}
function settingsPage() {
  const s = app.settings;
  const calendar = s.integrations.find((item) => item.provider === "google_calendar");
  const gmail = s.integrations.find((item) => item.provider === "gmail");
  return `<section class="page"><div class="page-head"><div><p class="eyebrow">Control what the twin knows</p><h1 class="display page-title">Settings, memory, and character.</h1></div><p class="lede">Everything here is private to this local prototype. Demo integrations are labeled; live keys never return to the browser.</p></div><div class="settings-layout"><nav class="settings-index" aria-label="Settings sections"><a href="#memory">Activity memory</a><a href="#plugins">Plug-ins</a><a href="#character">Character Studio</a><a href="#openai">OpenAI</a><a href="#timing">Twin timing</a><a href="#privacy">Privacy</a></nav><div>${memorySection()}${pluginsSection(calendar, gmail)}${characterSection()}${openAISection()}${timingSection()}${privacySection()}</div></div></section>`;
}
function memorySection() {
  return `<section id="memory" class="settings-section"><h2>Activity memory</h2><p class="section-intro">Direct statements can shape the simulation. Tentative patterns stay visibly uncertain. Your edits and removals outrank later imports.</p><div class="flat-card">${
    app.facts
      .filter((item) => item.status !== "suppressed")
      .map((fact) => `<div class="fact"><div><p>${escapeHtml(fact.statement)}</p><small><span class="pill ${fact.status === "tentative" ? "tentative" : "report"}">${fact.status === "tentative" ? "Possible pattern" : "Saved preference"}</span> · ${escapeHtml(fact.source_type)} · updated ${relativeTime(fact.updated_at)}</small></div><div class="fact-actions"><button class="icon-button" data-edit-fact="${fact.id}" aria-label="Edit memory">✎</button><button class="icon-button" data-remove-fact="${fact.id}" aria-label="Remove memory">×</button></div></div>`)
      .join("") || empty("Memory is empty", "Import a handoff to give the twin grounded context.")
  }</div>${app.reports.length ? `<div class="flat-card"><div class="card-head"><h3>What you reported</h3><span class="pill report">Actual report</span></div>${app.reports.map((report) => `<div class="fact"><div><p>${escapeHtml(report.statement)}</p><small>You reported doing · ${formatLongDate(report.local_date)} · ${report.source === "manual_rebuild_report" ? "used to catch up this Twin day" : "informs later days"}</small></div></div>`).join("")}</div>` : ""}</section>`;
}
function pluginsSection(calendar, gmail) {
  return `<section id="plugins" class="settings-section"><h2>Plug-ins</h2><p class="section-intro">Calendar and Gmail use separate consent. Mail cues are possibilities—not events or proof of activity.</p>${connectionCard("calendar", "Google Calendar", calendar, "Read selected calendars and event timing only.")}${connectionCard("gmail", "Gmail", gmail, "Metadata scope only: headers, labels, and dates; no sending or full inbox copy.")}</section>`;
}
function connectionCard(key, title, item, description) {
  return `<div class="flat-card connection"><div class="provider-mark">${key === "calendar" ? "31" : "M"}</div><div><h3>${title} ${item.mode === "demo" ? `<span class="pill demo">Demo data</span>` : `<span class="pill report">${escapeHtml(item.status)}</span>`}</h3><p>${description}</p><p>Last synced: ${item.last_successful_sync_at ? relativeTime(item.last_successful_sync_at) : "never"}</p></div><div class="row-actions"><button class="mini" data-connect="${key}">${item.mode === "demo" ? "Set up live" : "Reconnect"}</button><button class="mini" data-sync="${key}">Sync now</button><button class="mini" data-disconnect="${key}">Disconnect</button></div></div>`;
}
function characterSection() {
  const d = app.character.design;
  const photo = app.character.photo;
  const baseline = app.character.baseline;
  const candidates = app.character.baseline_candidates ?? [];
  const scenes = (app.character.assets ?? []).filter((asset) => asset.kind === "activity" && asset.status === "ready").sort((a, b) => (b.selected_at ?? b.created_at).localeCompare(a.selected_at ?? a.created_at));
  const failed = (app.character.requests ?? []).find((request) => request.status === "failed" && request.failure_code !== "AVATAR_CANCELLED");
  const reference = app.avatarPreview?.dataUrl ?? photo?.assetUrl;
  return `<section id="character" class="settings-section"><h2>Avatar Studio</h2><p class="section-intro">Create one recognizable baseline from your photo, approve it, then let Twin reuse that identity for every activity. Photos and generated images stay behind private user-scoped URLs.</p><div class="avatar-flow"><article class="avatar-step"><div class="step-number">1</div><div><p class="eyebrow">Private reference</p><h3>Upload your photo</h3><p class="small">Use a clear, front-facing image. It is used only to preserve your face shape, hair, skin tone, and recognizable features.</p><div class="photo-preview ${reference ? "has-image" : ""}">${reference ? `<img src="${reference}" alt="${app.avatarPreview ? "Photo ready to upload" : "Private uploaded reference photo"}">` : avatarSvg(d, "generic", `${d.name} placeholder`)}</div><input id="avatar-photo" type="file" accept="image/png,image/jpeg,image/webp" hidden>${app.avatarPreview ? `<div class="form-actions"><button class="button red" data-save-avatar-photo>Use this photo</button><button class="button ghost" data-cancel-avatar-photo>Cancel</button></div>` : `<div class="form-actions"><label class="button ${photo ? "ghost" : "red"}" for="avatar-photo">${photo ? "Replace photo" : "Choose photo"}</label>${photo ? `<button class="button danger" data-delete-avatar-photo>Delete photo</button>` : ""}</div>`}</div></article><article class="avatar-step ${photo ? "" : "locked"}"><div class="step-number">2</div><div><p class="eyebrow">Identity anchor</p><h3>Approve a baseline</h3><p class="small">Twin creates a full-body, soft 3D illustrated version of you. Activity images cannot generate until you approve one.</p>${baseline ? `<div class="baseline-approved"><div class="avatar-image-frame"><img src="${baseline.assetUrl}" alt="Approved standing baseline avatar"></div><span class="pill report">Approved baseline · v${d.version}</span><div class="form-actions"><button class="button ghost" data-generate-baseline>Make another candidate</button></div></div>` : `<div class="avatar-image-frame fallback">${avatarSvg(d, "generic", `${d.name} baseline fallback`)}</div><button class="button red" data-generate-baseline ${!photo || app.avatarBusy ? "disabled" : ""}>${app.avatarBusy ? "Creating…" : "Generate baseline"}</button>`}${candidates.map((asset) => `<div class="candidate-card"><div class="avatar-image-frame"><img src="${asset.assetUrl}" alt="Baseline avatar candidate"></div><div><strong>Does this feel like you?</strong><p class="small">Approve it as the identity reference, or generate another candidate.</p><div class="form-actions"><button class="button red" data-approve-baseline="${asset.id}">Approve baseline</button><button class="button ghost" data-generate-baseline>Regenerate</button></div></div></div>`).join("")}${failed?.purpose === "baseline" ? `<div class="error-box">Baseline generation failed (${escapeHtml(failed.failure_code ?? "provider error")}). Your photo is still saved privately. <button class="text-link" data-generate-baseline>Retry</button></div>` : ""}</div></article><article class="avatar-step ${baseline ? "" : "locked"}"><div class="step-number">3</div><div><p class="eyebrow">Reusable activity art</p><h3>Activity library</h3><p class="small">Each activity is generated once from the approved baseline, saved here, and reused on future visits.</p>${scenes.length ? `<div class="activity-library">${scenes.map(activityAssetCard).join("")}</div>` : `<div class="empty compact"><h3>No activity images yet</h3><p>They appear here as the twin encounters studying, running, and other activities.</p></div>`}${failed?.purpose === "activity" ? `<div class="error-box">An activity image failed. The approved baseline remains visible instead. You can retry from Home or regenerate its saved activity.</div>` : ""}</div></article></div><div class="avatar-privacy"><div><strong>Private avatar data</strong><p class="small">Delete the source photo only, or remove the photo, baseline, and every generated activity image.</p></div><div class="row-actions">${photo ? `<button class="button ghost" data-delete-avatar-photo>Delete source photo</button>` : ""}<button class="button danger" data-delete-avatar-images ${photo || baseline || scenes.length ? "" : "disabled"}>Delete all avatar images</button></div></div></section>`;
}
function activityAssetCard(asset) {
  return `<div class="activity-card"><div class="activity-card-image"><img src="${asset.assetUrl}" alt="Twin ${escapeHtml(activityName(asset.activity_key).toLowerCase())}"></div><div class="activity-card-copy"><span class="pill ${asset.selected_at ? "report" : "tentative"}">${asset.selected_at ? "In use" : "Saved version"}</span><h4>${escapeHtml(activityName(asset.activity_key))}</h4><p class="small">Saved privately · avatar v${asset.design_version}</p><div class="row-actions"><button class="mini" data-regenerate-scene="${asset.id}">Regenerate</button>${!asset.selected_at ? `<button class="mini" data-select-scene="${asset.id}">Use this</button>` : ""}<button class="mini" data-delete-scene="${asset.id}">Delete</button></div></div></div>`;
}
function openAISection() {
  const c = app.settings.openai;
  return `<section id="openai" class="settings-section"><h2>OpenAI connection</h2><p class="section-intro">Your key powers live text Talk and optional character images. It is encrypted by the server and never shown again. Provider usage may be billed to the key owner.</p><div class="flat-card"><div class="secret-status"><span class="pill ${c.status === "connected" ? "report" : "tentative"}">${escapeHtml(c.status.replaceAll("_", " "))}</span><strong>${escapeHtml(c.key_masked ?? "No key saved")}</strong></div>${!c.encryption_ready ? `<div class="notice">Set <code>TWIN_ENCRYPTION_KEY</code> in the server environment before saving a key.</div>` : ""}<form id="key-form"><label class="field"><span>OpenAI API key</span><input class="input" type="password" name="api_key" autocomplete="off" placeholder="sk-…" required></label><div class="form-actions"><button class="button red" type="submit">${c.key_masked ? "Replace" : "Save key"}</button><button class="button ghost" type="button" data-test-key ${!c.key_masked ? "disabled" : ""}>Test connection</button><button class="button danger" type="button" data-remove-key ${!c.key_masked ? "disabled" : ""}>Remove</button></div></form><p class="small">Text: ${c.text_capability} · Image: ${c.image_capability}${c.tested_at ? ` · tested ${relativeTime(c.tested_at)}` : ""}</p></div></section>`;
}
function timingSection() {
  const s = app.settings;
  return `<section id="timing" class="settings-section"><h2>Twin timing</h2><p class="section-intro">Changes affect the next generated twin day. The timeline stays illustrative and read-only.</p><form id="settings-form" class="flat-card"><div class="form-grid"><label class="field full"><span>Time zone</span><input class="input" name="timezone" value="${escapeHtml(s.timezone)}"></label><label class="field"><span>Wake time</span><input class="input" type="time" name="wake_time" value="${s.wake_time}"></label><label class="field"><span>Sleep time</span><input class="input" type="time" name="sleep_time" value="${s.sleep_time}"></label><label class="field"><span>Tomorrow generation</span><input class="input" type="time" name="tomorrow_generation_time" value="${s.tomorrow_generation_time}"></label><label class="field"><span>Talk retention days</span><input class="input" type="number" min="1" max="365" name="talk_retention_days" value="${s.talk_retention_days}"></label></div><div class="form-actions"><button class="button" type="submit">Save timing</button></div></form></section>`;
}
function privacySection() {
  return `<section id="privacy" class="settings-section"><h2>Privacy</h2><p class="section-intro">Export or remove user-owned data. Destructive actions require explicit confirmation.</p><div class="flat-card"><div class="setting-row"><div><strong>Export my data</strong><span>JSON without provider secrets.</span></div><a class="button ghost" href="/api/account/export" download>Export</a></div><div class="setting-row"><div><strong>Delete Talk history</strong><span>Remove saved conversations and messages.</span></div><button class="button ghost" data-delete-history>Delete history</button></div><div class="setting-row"><div><strong>Restart onboarding</strong><span>Reopen the prompt and import flow without erasing memory.</span></div><button class="button ghost" data-restart-onboarding>Open flow</button></div><div class="setting-row"><div><strong>Delete account</strong><span>Remove all owned records and queued jobs.</span></div><button class="button danger" data-delete-account>Delete account</button></div></div></section>`;
}
function talkLayer() {
  if (!app.talkOpen) return "";
  const connection = app.settings?.openai;
  const conversation = app.conversations.find((item) => item.id === app.conversationId) ?? app.conversations[0];
  const messages = conversation?.messages ?? [];
  return `<div class="talk-layer open" data-talk-backdrop><section class="talk-panel" role="dialog" aria-modal="true" aria-label="Talk with your twin"><header class="talk-head"><div class="talk-head-copy"><strong>Talk</strong><span>Live text · reports shape tomorrow</span></div><button class="talk-orb open" data-talk-toggle aria-label="Close Talk" aria-expanded="true">${closeIcon()}</button></header><div class="talk-stream" tabindex="-1" data-talk-stream>${connection?.status !== "connected" ? `<div class="talk-setup">${avatarSvg(app.character?.design ?? app.home?.avatar, "generic", "Twin waiting")}<h3>Connect your key</h3><p>Talk is never faked. Add an OpenAI key in Settings to begin a live conversation.</p><button class="button red" data-route="settings" data-talk-toggle>Open Settings</button></div>` : `${messages.length ? messages.map((message) => `<div class="message ${message.role}"><div class="bubble">${escapeHtml(message.content)}</div><time>${new Date(message.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>`).join("") : `<div class="talk-setup"><h3>What actually happened?</h3><p>Tell the twin about your day, or explicitly ask for a new avatar scene. Direct reports are saved for tomorrow.</p></div>`}`}</div>${connection?.status === "connected" ? `<form class="talk-compose" id="talk-form"><textarea name="message" aria-label="Message" placeholder="I actually studied at the library…" required></textarea><button class="send" aria-label="Send message">↑</button></form>` : ""}</section></div>`;
}
function renderOnboarding() {
  root.innerHTML = `<main id="main" class="onboarding"><section class="onboard-intro"><div><p class="eyebrow">Private setup · outside-app voice</p><h1 class="display onboard-title">Meet the version of you that can try another day.</h1><p class="lede" style="color:#fff">The first conversation happens in ChatGPT. This app only receives the JSON you deliberately bring back.</p></div><ol class="steps"><li>Copy the complete prompt.</li><li>Paste it into a new ChatGPT chat.</li><li>Start ChatGPT Voice and talk naturally.</li><li>End Voice and type “Finish and export JSON”.</li><li>Copy the JSON back here.</li></ol><p class="small" style="color:#fff">No social feed. No conversation scraping. No clinical claims.</p></section><section class="onboard-work"><h2>1. Copy the complete prompt</h2><p class="small">Voice availability depends on your ChatGPT account and device. The same prompt also works in text.</p><div class="prompt-panel"><div class="prompt-toolbar"><span class="pill imagined">Exact onboarding prompt</span><button class="button red" data-copy-prompt>Copy prompt</button></div><pre class="prompt-text">${escapeHtml(ONBOARDING_PROMPT)}</pre></div><div class="import-panel"><h2>2. Bring back the JSON</h2><p class="small">Paste the JSON and press Import, or choose a .json file to import it immediately.</p><label class="field"><span>Paste exported JSON</span><textarea id="json-input" class="textarea" spellcheck="false" placeholder='{ "schema_version": 1, … }'>${escapeHtml(app.importText)}</textarea></label><div class="file-row"><input id="json-file" type="file" accept="application/json,.json"><button class="text-link" data-use-sample>Use sample JSON</button></div>${app.importFileName ? `<p class="small" role="status">Loaded <strong>${escapeHtml(app.importFileName)}</strong>${app.loading ? " — importing now…" : ""}</p>` : ""}${
    app.importError
      ? `<div class="error-box"><strong>${escapeHtml(app.importError.message)}</strong>${
          app.importError.fields
            ? `<ul>${Object.entries(app.importError.fields)
                .map(([key, value]) => `<li><code>${escapeHtml(key)}</code>: ${escapeHtml(value)}</li>`)
                .join("")}</ul>`
            : ""
        }</div>`
      : ""
  }${app.importResult ? onboardingSuccess() : `<button class="button red" data-import ${app.loading ? "disabled" : ""}>${app.loading ? "Checking…" : "Import and build my twin"}</button>`}</div></section></main>`;
}
function onboardingSuccess() {
  return `<div class="success-box"><strong>Your twin learned ${app.importResult.applied_counts.active + app.importResult.applied_counts.tentative} things.</strong><br>${app.importResult.applied_counts.active} saved preferences · ${app.importResult.applied_counts.tentative} possible patterns · ${app.importResult.conflict_count} preserved conflicts${app.importResult.duplicate ? " · duplicate safely reused" : ""}</div><div class="snapshot">${app.facts
    .slice(0, 5)
    .map((fact) => `<div class="snapshot-item"><p>${escapeHtml(fact.statement)}</p><span class="pill ${fact.status === "tentative" ? "tentative" : "report"}">${fact.status}</span> <span class="small">${escapeHtml(fact.source_type)}</span></div>`)
    .join("")}</div><div class="form-actions"><button class="button red" data-enter-home>Enter Home</button><button class="button ghost" data-route="settings" data-enter-home>Edit in Settings</button></div>`;
}
function avatarSvg(design, activity, label) {
  if (!design) return "";
  const seated = ["studying", "working", "eating", "bathroom"].includes(activity),
    resting = ["resting", "sleeping"].includes(activity),
    walking = ["walking", "running", "commuting"].includes(activity);
  const legs = seated || resting ? "M132 233l-29 27m82-27 28 27" : walking ? "M142 228l-37 48m75-47 36 44" : "M143 230l-12 48m50-48 13 48";
  const arms = seated ? "M124 179l-28 39 30 11m69-50 31 35-26 17" : walking ? "M124 179l-34 37m105-37 34 29" : "M124 180l-25 48m96-48 25 48";
  return `<svg viewBox="0 0 320 320" role="img" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg"><title>${escapeHtml(label)}</title><circle cx="160" cy="147" r="105" fill="#FFFDF8"/>${["studying", "working"].includes(activity) ? `<g><rect x="192" y="178" width="83" height="55" rx="5" fill="#24242B"/><rect x="198" y="184" width="71" height="43" rx="2" fill="#E7E8E6"/><path d="M184 234h99" stroke="#24242B" stroke-width="8" stroke-linecap="round"/></g>` : ""}${activity === "eating" ? `<ellipse cx="227" cy="229" rx="44" ry="12" fill="#fff" stroke="#24242B" stroke-width="3"/><circle cx="225" cy="224" r="13" fill="${design.accent}"/>` : ""}${activity === "bathroom" ? `<rect x="111" y="226" width="99" height="34" rx="12" fill="#fff" stroke="#24242B" stroke-width="3"/><rect x="134" y="258" width="54" height="22" rx="7" fill="#E6E8E7"/>` : ""}${resting ? `<rect x="55" y="246" width="210" height="30" rx="14" fill="#E7DBCC"/><rect x="73" y="236" width="57" height="23" rx="12" fill="#fff"/>` : ""}<path d="${legs}" stroke="${design.bottom}" stroke-width="21" stroke-linecap="round"/><path d="M130 275h-25m113 0h-25" stroke="#24242B" stroke-width="10" stroke-linecap="round"/><path d="M127 159q33-12 66 0l18 74q-51 21-101 0z" fill="${design.top}" stroke="#24242B" stroke-width="3"/><path d="${arms}" fill="none" stroke="${design.skin}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/><path d="M142 151v23m37-23v23" stroke="${design.skin}" stroke-width="21" stroke-linecap="round"/><ellipse cx="160" cy="111" rx="48" ry="53" fill="${design.skin}" stroke="#24242B" stroke-width="3"/><path d="${design.hair_style === "short" ? "M113 105q-5-57 48-58 54 1 48 58-17-35-48-31-30-3-48 31z" : "M108 110q-10-67 53-68 62 0 55 68-17-41-51-38-34-4-57 38z"}" fill="${design.hair}"/>${design.hair_style === "curly" ? [117, 133, 153, 174, 194, 209].map((x) => `<circle cx="${x}" cy="${65 + Math.abs(160 - x) / 3}" r="17" fill="${design.hair}"/>`).join("") : ""}<circle cx="144" cy="116" r="3.5" fill="#24242B"/><circle cx="178" cy="116" r="3.5" fill="#24242B"/><path d="M149 138q12 10 24 0" fill="none" stroke="#6F342B" stroke-width="3" stroke-linecap="round"/><circle cx="207" cy="178" r="5" fill="${design.accent}"/>${walking ? `<path d="M238 109q23-22 39-7m-15 36q19-18 31-4" fill="none" stroke="#70A185" stroke-width="5" stroke-linecap="round"/>` : ""}${activity === "running" ? `<path d="M66 173h38m-48 24h42" stroke="#D8320A" stroke-width="4" stroke-linecap="round"/>` : ""}${activity === "sleeping" ? `<text x="223" y="83" fill="#D8320A" font-size="25" font-family="Arial" font-weight="bold">Z z</text>` : ""}</svg>`;
}
function empty(title, body) {
  return `<div class="empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`;
}
function errorState(title, body, reload = false) {
  return `<div class="boot"><span class="boot-mark">!</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${reload ? `<button class="button" onclick="location.reload()">Try again</button>` : ""}</div>`;
}
function formatTime(iso, zone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
function formatClock(date, zone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
function formatLongDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
function formatShortDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
function relativeTime(iso) {
  const seconds = Math.round((new Date(iso) - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit] = abs < 60 ? [seconds, "second"] : abs < 3600 ? [Math.round(seconds / 60), "minute"] : abs < 86400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86400), "day"];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(amount, unit);
}
function chatIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
function closeIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function toast(message, error = false) {
  const region = document.querySelector("#toast-region");
  const item = document.createElement("div");
  item.className = `toast ${error ? "error" : ""}`;
  item.setAttribute("role", error ? "alert" : "status");
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 4200);
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  const guardsAsyncAction = target.matches("[data-save-calendar-selection],[data-sync],[data-connect],[data-disconnect],[data-generate-baseline],[data-cancel-baseline],[data-approve-baseline],[data-regenerate-scene],[data-select-scene],[data-delete-scene]");
  if (guardsAsyncAction) {
    if (target.getAttribute("aria-busy") === "true") return;
    target.disabled = true;
    target.setAttribute("aria-busy", "true");
  }
  try {
    if (target.dataset.route) {
      event.preventDefault();
      const nextRoute = target.dataset.route;
      if (target.hasAttribute("data-talk-toggle")) app.talkOpen = false;
      if (location.hash !== `#${nextRoute}`) history.pushState(null, "", `#${nextRoute}`);
      await navigateRoute(nextRoute);
      return;
    }
    if (target.matches("[data-talk-toggle]")) {
      const opening = !app.talkOpen;
      app.talkOpen = opening;
      if (opening && !app.conversationId && app.settings?.openai?.status === "connected") {
        const conversation = await api("/api/talk/conversations", { method: "POST", body: "{}" });
        app.conversationId = conversation.id;
        app.conversations.unshift({ ...conversation, messages: [] });
      }
      render();
      if (opening) setTimeout(() => document.querySelector("#talk-form textarea, .talk-connect, .talk-back")?.focus(), 20);
      else setTimeout(() => document.querySelector("[data-talk-toggle]")?.focus(), 20);
      return;
    }
    if (target.matches("[data-copy-prompt]")) {
      await navigator.clipboard.writeText(ONBOARDING_PROMPT);
      target.textContent = "Copied";
      toast("Complete prompt copied.");
      return;
    }
    if (target.matches("[data-use-sample]")) {
      app.importFileName = "";
      app.importResult = null;
      app.importError = null;
      app.importText = SAMPLE();
      document.querySelector("#json-input").value = app.importText;
      toast("Sample JSON loaded.");
      return;
    }
    if (target.matches("[data-import]")) {
      await submitImport();
      return;
    }
    if (target.matches("[data-enter-home]")) {
      app.showOnboarding = false;
      await loadAll();
      app.route = target.dataset.route ?? "home";
      location.hash = app.route;
      render();
      return;
    }
    if (target.matches("[data-save-avatar-photo]")) {
      if (!app.avatarPreview) return;
      app.avatarBusy = true;
      render();
      await api("/api/character/photo", {
        method: "POST",
        body: JSON.stringify({
          data_url: app.avatarPreview.dataUrl,
          filename: app.avatarPreview.name,
        }),
      });
      app.avatarPreview = null;
      await refreshAvatar();
      app.avatarBusy = false;
      render();
      toast("Private reference photo saved.");
      return;
    }
    if (target.matches("[data-cancel-avatar-photo]")) {
      app.avatarPreview = null;
      render();
      return;
    }
    if (target.matches("[data-delete-avatar-photo]")) {
      if (!confirm("Delete the private source photo? Approved and saved avatar images will remain.")) return;
      await api("/api/character/photo", { method: "DELETE", body: "{}" });
      app.avatarPreview = null;
      await refreshAvatar();
      render();
      toast("Source photo deleted.");
      return;
    }
    if (target.matches("[data-delete-avatar-images]")) {
      if (!confirm("Delete the source photo, approved baseline, and every generated activity image?")) return;
      await api("/api/character/images", { method: "DELETE", body: "{}" });
      app.avatarPreview = null;
      await refreshAvatar();
      app.home = await api("/api/home");
      render();
      toast("All private avatar images deleted.");
      return;
    }
    if (target.matches("[data-generate-baseline]")) {
      target.disabled = true;
      target.setAttribute("aria-busy", "true");
      try {
        await api("/api/character/baseline", {
          method: "POST",
          headers: { "idempotency-key": uuid() },
          body: "{}",
        });
        await refreshAvatar();
        render();
        toast("Baseline generation started.");
        startAvatarPoll();
      } finally {
        if (target.isConnected) {
          target.disabled = false;
          target.removeAttribute("aria-busy");
        }
      }
      return;
    }
    if (target.dataset.cancelBaseline) {
      clearTimeout(app.avatarPoll);
      app.avatarPoll = null;
      await api(`/api/character/baseline/${target.dataset.cancelBaseline}/cancel`, {
        method: "POST",
        body: "{}",
      });
      app.avatarBusy = false;
      await refreshAvatar();
      render();
      toast("Avatar generation stopped.");
      return;
    }
    if (target.dataset.approveBaseline) {
      await api(`/api/character/baseline/${target.dataset.approveBaseline}/approve`, {
        method: "POST",
        body: "{}",
      });
      await refreshAvatar();
      app.home = await api("/api/home");
      render();
      toast("Baseline approved. New activity images will preserve this identity.");
      await ensureCurrentScene();
      return;
    }
    if (target.dataset.deleteBaseline) {
      if (!confirm("Delete this saved avatar version? The current avatar and activity images will stay unchanged.")) return;
      await api(`/api/character/baseline/${target.dataset.deleteBaseline}`, { method: "DELETE" });
      app.avatarCandidateId = null;
      await refreshAvatar();
      render();
      toast("Avatar version deleted.");
      return;
    }
    if (target.dataset.regenerateScene) {
      app.avatarBusy = true;
      render();
      await api(`/api/character/scenes/${target.dataset.regenerateScene}/regenerate`, {
        method: "POST",
        headers: { "idempotency-key": uuid() },
        body: "{}",
      });
      toast("Activity image regeneration started.");
      startAvatarPoll();
      return;
    }
    if (target.dataset.selectScene) {
      await api(`/api/character/scenes/${target.dataset.selectScene}/select`, {
        method: "POST",
        body: "{}",
      });
      await refreshAvatar();
      app.home = await api("/api/home");
      render();
      toast("Activity version selected.");
      return;
    }
    if (target.dataset.deleteScene) {
      if (!confirm("Delete this saved activity image? The approved baseline and other activities will not change.")) return;
      await api(`/api/character/scenes/${target.dataset.deleteScene}`, {
        method: "DELETE",
        body: "{}",
      });
      await refreshAvatar();
      app.home = await api("/api/home");
      render();
      toast("Activity image deleted.");
      return;
    }
    if (target.matches("[data-retry-scene]")) {
      await ensureCurrentScene(true);
      render();
      return;
    }
    if (target.dataset.date) {
      app.day = await api(`/api/twin-days?date=${target.dataset.date}`);
      if (!app.day) toast("No simulated day exists for that date.", true);
      render();
      return;
    }
    if (target.dataset.editFact) {
      const fact = app.facts.find((item) => item.id === target.dataset.editFact);
      const statement = prompt("Edit this memory", fact.statement);
      if (!statement || statement === fact.statement) return;
      await api(`/api/profile/facts/${fact.id}`, {
        method: "PATCH",
        body: JSON.stringify({ statement, version: fact.version }),
      });
      await refreshSettings();
      render();
      toast("Memory updated for future days.");
      return;
    }
    if (target.dataset.removeFact) {
      const fact = app.facts.find((item) => item.id === target.dataset.removeFact);
      if (!confirm(`Remove “${fact.statement}”? This creates a tombstone so an old import cannot restore it.`)) return;
      await api(`/api/profile/facts/${fact.id}`, {
        method: "DELETE",
        body: JSON.stringify({ version: fact.version }),
      });
      await refreshSettings();
      render();
      toast("Memory removed and suppressed.");
      return;
    }
    if (target.matches("[data-save-calendar-selection]")) {
      const selected_ids = [...document.querySelectorAll("[data-calendar-choice]:checked")].map((input) => input.value);
      await api("/api/integrations/calendar/calendars", {
        method: "PATCH",
        headers: { "idempotency-key": uuid() },
        body: JSON.stringify({ selected_ids }),
      });
      toast("Calendar choices saved. Syncing now.");
      await refreshSettings();
      render();
      startIntegrationPoll("calendar");
      return;
    }
    if (target.dataset.sync) {
      await api(`/api/integrations/${target.dataset.sync}/sync`, {
        method: "POST",
        headers: { "idempotency-key": uuid() },
        body: "{}",
      });
      toast(`${target.dataset.sync} sync queued.`);
      await refreshSettings();
      render();
      startIntegrationPoll(target.dataset.sync);
      return;
    }
    if (target.dataset.connect) {
      const data = await api(`/api/integrations/${target.dataset.connect}/connect`);
      if (data.authorization_url) location.href = data.authorization_url;
      else toast(data.message);
      return;
    }
    if (target.dataset.disconnect) {
      if (target.dataset.disconnect === "calendar" && !confirm("Disconnect Google Calendar and remove its saved events from Twin?")) return;
      await api(`/api/integrations/${target.dataset.disconnect}`, { method: "DELETE" });
      await refreshSettings();
      render();
      toast(`${target.dataset.disconnect === "calendar" ? "Google Calendar" : "Gmail"} disconnected.`);
      return;
    }
    if (target.matches("[data-test-key]")) {
      target.disabled = true;
      target.setAttribute("aria-busy", "true");
      try {
        const result = await api("/api/settings/openai-key/test", { method: "POST", body: "{}" });
        toast(`Text ${result.text_capability}; image ${result.image_capability}.`);
        await refreshSettings();
        render();
      } finally {
        target.disabled = false;
        target.removeAttribute("aria-busy");
      }
      return;
    }
    if (target.matches("[data-remove-key]")) {
      if (!confirm("Remove the OpenAI key? Saved scenes stay available, but new provider calls stop.")) return;
      await api("/api/settings/openai-key", { method: "DELETE" });
      await refreshSettings();
      render();
      toast("OpenAI key removed.");
      return;
    }
    if (target.matches("[data-delete-history]")) {
      if (!confirm("Delete all saved Talk messages?")) return;
      await api("/api/talk/history", { method: "DELETE" });
      app.conversations = [];
      app.conversationId = null;
      render();
      toast("Talk history deleted.");
      return;
    }
    if (target.matches("[data-restart-onboarding]")) {
      app.showOnboarding = true;
      app.importResult = null;
      app.importError = null;
      render();
      return;
    }
    if (target.matches("[data-delete-account]")) {
      const confirmation = prompt('Type "DELETE MY TWIN" to permanently delete local account data.');
      if (!confirmation) return;
      await api("/api/account", { method: "DELETE", body: JSON.stringify({ confirmation }) });
      toast("Account data deleted.");
      setTimeout(() => location.reload(), 700);
      return;
    }
  } catch (error) {
    toast(error.payload?.message ?? error.message, true);
  } finally {
    if (guardsAsyncAction && target.isConnected) {
      target.disabled = false;
      target.removeAttribute("aria-busy");
    }
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.id === "json-file" && event.target.files?.[0]) {
    const file = event.target.files[0];
    app.importFileName = file.name;
    app.importResult = null;
    app.importError = null;
    app.importText = (await file.text()).replace(/^\uFEFF/, "");
    document.querySelector("#json-input").value = app.importText;
    await submitImport();
    return;
  }
  if (event.target.id === "avatar-photo" && event.target.files?.[0]) {
    const file = event.target.files[0];
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast("Choose a PNG, JPEG, or WebP photo.", true);
      return;
    }
    if (file.size > 8_000_000) {
      toast("Use a photo smaller than 8 MB.", true);
      return;
    }
    app.avatarPreview = { name: file.name, dataUrl: await fileDataUrl(file) };
    render();
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "schedule-rebuild-form") {
      const state = app.scheduleRebuild;
      if (state.busy) return;
      const localDate = form.dataset.planningDate ?? selectedScheduleDate();
      const today = localDate === app.home?.localDate;
      const rawActualReport = String(form.elements.actual_report?.value ?? "");
      const rawInstruction = String((today ? form.elements.future_instruction : form.elements.instruction)?.value ?? "");
      const actualReport = rawActualReport.trim();
      const instruction = rawInstruction.trim();
      state.actualReport = rawActualReport;
      state.instruction = rawInstruction;
      if (scheduleDateIsPast(localDate)) {
        state.status = {
          kind: "error",
          message: "Past Twin days stay unchanged. Choose today or a future day to rebuild.",
        };
        render();
        return;
      }
      if (actualReport.length > 500 || instruction.length > 500) {
        state.status = {
          kind: "error",
          message: "Keep each rebuild entry to 500 characters or fewer, then try again.",
        };
        render();
        return;
      }
      const request = today
        ? {
            local_date: localDate,
            ...(actualReport ? { actual_report: actualReport } : {}),
            ...(instruction ? { future_instruction: instruction } : {}),
          }
        : { local_date: localDate, ...(instruction ? { instruction } : {}) };
      const signature = JSON.stringify(request);
      if (state.requestSignature !== signature) {
        state.requestSignature = signature;
        state.idempotencyKey = uuid();
      }
      state.busy = true;
      state.status = null;
      render();
      try {
        const result = await api("/api/twin-days/rebuild", {
          method: "POST",
          headers: { "Idempotency-Key": state.idempotencyKey },
          body: JSON.stringify(request),
        });
        if (!["updated", "no_change"].includes(result.status) || result.trigger !== "manual") throw new Error("The planner returned an unexpected response.");
        if (result.status === "updated") {
          if (!result.day || result.day.local_date !== localDate) throw new Error("The planner returned a day that does not match your selection.");
          app.day = result.day;
          app.selectedDate = localDate;
          if (result.report) app.reports = [result.report, ...app.reports.filter((item) => item.id !== result.report.id)];
        }
        state.busy = false;
        state.actualReport = "";
        state.instruction = "";
        state.idempotencyKey = null;
        state.requestSignature = null;
        state.status = {
          kind: "success",
          message: result.message ?? (result.status === "updated" ? "Your Twin day was rebuilt." : "Your current Twin day already fits this request."),
        };
        render();
        setTimeout(() => document.querySelector("[data-schedule-rebuild-status]")?.focus(), 20);
        toast(state.status.message);
      } catch (error) {
        state.busy = false;
        state.status = scheduleRebuildError(error);
        if (error.payload) {
          state.idempotencyKey = null;
          state.requestSignature = null;
        }
        render();
        setTimeout(() => document.querySelector("[data-schedule-rebuild-status]")?.focus(), 20);
        toast(state.status.message, true);
      }
      return;
    }
    if (form.id === "talk-form") {
      const field = form.elements.message;
      const message = field.value.trim();
      if (!message || app.talkSending) return;
      app.talkDraft = field.value;
      app.talkSending = true;
      render();
      const id = app.conversationId;
      try {
        const result = await api(`/api/talk/conversations/${id}/messages`, {
          method: "POST",
          headers: { "idempotency-key": uuid() },
          body: JSON.stringify({ message }),
        });
        const conversation = app.conversations.find((item) => item.id === id);
        conversation.messages.push(result.user_message, result.assistant_message);
        if (result.report) app.reports.push(result.report);
        app.talkDraft = "";
        app.talkSending = false;
        render();
        setTimeout(() => {
          const stream = document.querySelector("[data-talk-stream]");
          if (stream) stream.scrollTop = stream.scrollHeight;
          document.querySelector("#talk-form textarea")?.focus();
        }, 20);
        if (result.report) toast("Saved as an actual activity. Twin is reviewing the remaining day.");
      } catch (error) {
        app.talkSending = false;
        render();
        setTimeout(() => document.querySelector("#talk-form textarea")?.focus(), 20);
        throw error;
      }
      return;
    }
    if (form.id === "key-form") {
      const key = form.elements.api_key.value;
      await api("/api/settings/openai-key", {
        method: "PUT",
        body: JSON.stringify({ api_key: key }),
      });
      form.reset();
      await refreshSettings();
      render();
      toast("Key encrypted and saved. Test it before using Talk.");
      return;
    }
    if (form.id === "avatar-form") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/character/design", { method: "PUT", body: JSON.stringify(data) });
      await refreshSettings();
      render();
      toast("New coded avatar version saved.");
      return;
    }
    if (form.id === "settings-form") {
      const data = Object.fromEntries(new FormData(form));
      data.talk_retention_days = Number(data.talk_retention_days);
      data.version = app.settings.version;
      await api("/api/settings", { method: "PATCH", body: JSON.stringify(data) });
      await refreshSettings();
      render();
      toast("Timing saved for the next twin day.");
      return;
    }
  } catch (error) {
    toast(error.payload?.message ?? error.message, true);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && app.talkOpen) {
    app.talkOpen = false;
    render();
    document.querySelector("[data-talk-toggle]")?.focus();
  }
});
async function submitImport() {
  const raw = document.querySelector("#json-input")?.value ?? app.importText;
  app.importText = raw;
  app.loading = true;
  app.importError = null;
  render();
  try {
    const result = await api("/api/imports", { method: "POST", body: raw });
    app.importResult = result;
    app.facts = await api("/api/profile/facts");
    app.loading = false;
    render();
  } catch (error) {
    app.loading = false;
    app.importError = {
      message: error.payload?.message ?? error.message,
      fields: error.payload?.field_errors,
    };
    render();
  }
}
async function refreshRoute() {
  if (app.route === "home") app.home = await api("/api/home");
  else if (app.route === "schedule") {
    app.home = await api("/api/home");
    app.day = app.home.twinDayVersion;
  } else await refreshSettings();
}
async function refreshSettings() {
  const [settings, facts, character, reports] = await Promise.all([api("/api/settings"), api("/api/profile/facts"), api("/api/character"), api("/api/activity-reports")]);
  Object.assign(app, { settings, facts, character, reports });
  app.bootstrap.openai = settings.openai;
}
function startIntegrationPoll(provider) {
  clearTimeout(app.integrationPoll);
  let attempts = 0;
  const type = provider === "calendar" ? "google_calendar" : "gmail";
  const tick = async () => {
    attempts += 1;
    try {
      await refreshSettings();
      render();
      const item = app.settings.integrations.find((candidate) => candidate.provider === type);
      if (item?.status === "syncing" && attempts < 40) {
        app.integrationPoll = setTimeout(tick, 1000);
        return;
      }
      app.integrationPoll = null;
      if (item?.status === "connected") toast(`${provider === "calendar" ? "Calendar" : "Gmail"} sync complete.`);
      else if (item?.status === "failed" || item?.status === "expired") toast(`${provider === "calendar" ? "Calendar" : "Gmail"} sync needs attention.`, true);
    } catch (error) {
      app.integrationPoll = null;
      toast(error.payload?.message ?? error.message, true);
    }
  };
  app.integrationPoll = setTimeout(tick, 500);
}
async function refreshAvatar() {
  app.character = await api("/api/character");
}
async function ensureCurrentScene(force = false) {
  const key = app.home?.currentTwinActivity?.activity_key;
  if (!key || !app.character?.baseline || app.home?.scene?.kind === "activity") return;
  try {
    const result = await api("/api/character/scenes/ensure", {
      method: "POST",
      headers: force ? { "idempotency-key": uuid() } : undefined,
      body: JSON.stringify({ activity_key: key }),
    });
    if (result.status === "ready" && result.asset) {
      app.home.scene = {
        kind: "activity",
        status: "ready",
        activity_key: key,
        activity_label: activityName(key),
        assetUrl: result.asset.assetUrl,
        asset: result.asset,
      };
    } else if (result.generation_request) {
      app.home.scene = {
        kind: "baseline",
        status: "generating",
        activity_key: key,
        activity_label: activityName(key),
        assetUrl: result.fallback_asset?.assetUrl,
        asset: result.fallback_asset,
      };
      startAvatarPoll();
    } else if (result.asset) {
      app.home.scene = {
        kind: "baseline",
        status: "fallback",
        activity_key: key,
        activity_label: activityName(key),
        assetUrl: result.asset.assetUrl,
        asset: result.asset,
      };
    }
  } catch (error) {
    toast(error.payload?.message ?? error.message, true);
  }
}
function startAvatarPoll() {
  clearTimeout(app.avatarPoll);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    try {
      await refreshAvatar();
      app.home = await api("/api/home");
      app.day = app.home.twinDayVersion;
      const pending = (app.character.requests ?? []).some((request) => ["queued", "generating"].includes(request.status));
      app.avatarBusy = pending;
      render();
      if (pending && attempts < 70) app.avatarPoll = setTimeout(tick, 1800);
      else {
        app.avatarPoll = null;
        if (!pending) toast("Avatar library updated.");
      }
    } catch {
      app.avatarBusy = false;
      app.avatarPoll = null;
      render();
    }
  };
  app.avatarPoll = setTimeout(tick, 1200);
}
function libraryScene(key) {
  const asset = (app.character?.assets ?? []).find((item) => item.kind === "activity" && item.activity_key === key && item.selected_at && item.design_version === app.character.design.version);
  if (asset) return { kind: "activity", status: "ready", assetUrl: asset.assetUrl, asset };
  return app.character?.baseline
    ? {
        kind: "baseline",
        status: "fallback",
        assetUrl: app.character.baseline.assetUrl,
        asset: app.character.baseline,
      }
    : null;
}
function sceneArtwork(scene, design, activity, label) {
  return scene?.assetUrl ? `<img class="avatar-art" src="${scene.assetUrl}" alt="${escapeHtml(label)}">` : avatarSvg(design, activity, label);
}
function activityName(key) {
  return (
    {
      generic: "Getting ready",
      studying: "Studying",
      working: "Working",
      walking: "Walking",
      running: "Running",
      eating: "Eating",
      sleeping: "Sleeping",
      resting: "Resting",
      commuting: "Commuting",
      bathroom: "Bathroom break",
    }[key] ?? "Getting ready"
  );
}
function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
window.addEventListener("hashchange", async () => {
  const route = location.hash.slice(1);
  if (["home", "schedule", "settings"].includes(route) && route !== app.route) await navigateRoute(route);
});

/* Reference-page integration. The standalone mockups supply presentation; app state and API behavior remain authoritative. */
function selectedScheduleDate() {
  return app.selectedDate ?? app.day?.local_date ?? app.home?.localDate ?? new Date().toISOString().slice(0, 10);
}
function scheduleDateIsPast(date) {
  return Boolean(app.home?.localDate && date < app.home.localDate);
}
function scheduleRebuildError(error) {
  const payload = error.payload ?? {};
  const message = String(payload.message ?? error.message ?? "The Twin day could not be rebuilt.");
  const signal = `${payload.code ?? ""} ${message}`.toLowerCase();
  const unchanged = /\b(?:day|schedule)\b[^.]{0,50}\bunchanged\b/i.test(message) ? "" : " Your current schedule is unchanged.";
  if (/openai.*key|api.?key|credential|unauthori[sz]ed|authentication|missing.*key|key.?required/.test(signal))
    return {
      kind: "error",
      message: `${message} Use OpenAI connection below to add or test your key.${unchanged}`,
    };
  if (/\bplanner[_ -]/.test(signal))
    return {
      kind: "error",
      message: `${message} Try rebuilding again. If it repeats, include approximate times for activities that must not overlap.${unchanged}`,
    };
  const retryable = payload.retryable === true || /provider|rate.?limit|timeout|temporar|network|failed to fetch/.test(signal);
  return {
    kind: "error",
    message: `${message} ${retryable ? "Try Rebuild my day again in a moment." : "Review what you entered and try again."}${unchanged}`,
  };
}
function scheduleRebuildForm(selected) {
  const state = app.scheduleRebuild;
  const past = scheduleDateIsPast(selected);
  const today = selected === app.home?.localDate;
  const disabled = state.busy || past;
  const status = state.busy
    ? {
        kind: "loading",
        message: today ? "Twin is rebuilding the full day: reported history and labeled estimates so far, then a new plan from now onward. Your existing schedule stays visible until it succeeds." : "Twin is rebuilding this day with your current memory and Calendar context. Your existing schedule will stay visible until it succeeds.",
      }
    : state.status;
  const statusMarkup = status ? `<div class="schedule-rebuild-status ${status.kind}" role="${status.kind === "error" ? "alert" : "status"}" aria-live="${status.kind === "error" ? "assertive" : "polite"}" tabindex="-1" data-schedule-rebuild-status><p>${escapeHtml(status.message)}</p></div>` : past ? `<p class="schedule-rebuild-past" role="status">Past Twin days stay unchanged. Choose today or a future day to rebuild.</p>` : "";
  const description = today ? "Describe everything you want shown as actually happened so far, then separately say what should change next. Twin may fill unexplained past gaps with clearly labeled AI estimates and rebuilds flexible activity from now onward." : "Describe how you want this future day planned while keeping commitments in place.";
  const fields = today ? `<label class="schedule-rebuild-instruction" for="schedule-rebuild-actual"><span class="sc">WHAT ACTUALLY HAPPENED SO FAR</span><textarea id="schedule-rebuild-actual" name="actual_report" maxlength="500" aria-describedby="schedule-rebuild-actual-help" placeholder="I worked from 9 to 11, walked at noon, and just ate lunch." ${disabled ? "disabled" : ""}>${escapeHtml(state.actualReport)}</textarea><small id="schedule-rebuild-actual-help"><span data-schedule-actual-count>${state.actualReport.length}</span>/500 · This replaces the elapsed backlog only after the rebuilt day succeeds. Include approximate times when you know them.</small></label><label class="schedule-rebuild-instruction" for="schedule-rebuild-future"><span class="sc">WHAT SHOULD CHANGE NEXT</span><textarea id="schedule-rebuild-future" name="future_instruction" maxlength="500" aria-describedby="schedule-rebuild-future-help" placeholder="Keep the afternoon lighter." ${disabled ? "disabled" : ""}>${escapeHtml(state.instruction)}</textarea><small id="schedule-rebuild-future-help"><span data-schedule-instruction-count>${state.instruction.length}</span>/500 · Planning guidance only; this is not saved as activity you did.</small></label>` : `<label class="schedule-rebuild-instruction" for="schedule-rebuild-instruction"><span>Planning instruction</span><textarea id="schedule-rebuild-instruction" name="instruction" maxlength="500" aria-describedby="schedule-rebuild-help" placeholder="Make the afternoon lighter." ${disabled ? "disabled" : ""}>${escapeHtml(state.instruction)}</textarea><small id="schedule-rebuild-help"><span data-schedule-instruction-count>${state.instruction.length}</span>/500 · Used only for this future-day rebuild.</small></label>`;
  return `<form id="schedule-rebuild-form" class="schedule-rebuild" data-planning-date="${escapeHtml(selected)}" aria-labelledby="schedule-rebuild-title"><div class="schedule-rebuild-heading"><div><span>AI day planner</span><h2 id="schedule-rebuild-title">Rebuild my day</h2></div><p>${escapeHtml(description)}</p></div>${fields}<div class="schedule-rebuild-actions"><button type="submit" ${disabled ? "disabled" : ""}>${state.busy ? "Rebuilding…" : "Rebuild my day"}</button></div>${statusMarkup}</form>`;
}
function settingsPlannerSection() {
  const date = app.home?.localDate ?? app.day?.local_date ?? new Date().toISOString().slice(0, 10);
  return `<section class="settings-planner settings-group" aria-labelledby="settings-planner-title"><h2 id="settings-planner-title" class="settings-group-title">Planner</h2><p class="settings-planner-date">Rebuilding ${escapeHtml(formatLongDate(date))}</p><div class="settings-planner-card glass-card">${scheduleRebuildForm(date)}</div></section>`;
}
function scheduleDateParts(date) {
  const value = new Date(`${date}T12:00:00Z`);
  return {
    day: new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(value),
    date: new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(value),
  };
}
function scheduleClock(iso, zone) {
  return formatTime(iso, zone).replace(/\s[AP]M$/i, "");
}
function localMinutes(iso, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((item) => item.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((item) => item.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}
function scheduleFocusIndex(day) {
  if (!day?.activities?.length || day.local_date !== app.home?.localDate) return -1;
  const now = new Date(app.home?.now ?? Date.now());
  const overlap = day.activities.findIndex((item) => new Date(item.start_at) <= now && now < new Date(item.end_at));
  if (overlap >= 0) return overlap;
  const upcoming = day.activities.findIndex((item) => new Date(item.start_at) >= now);
  return upcoming >= 0 ? upcoming : day.activities.length - 1;
}
function scheduleSourceBadges(item) {
  const types = item.source_types ?? [];
  const labels = [];
  const elapsed =
    app.day?.local_date === app.home?.localDate &&
    new Date(item.end_at) <= new Date(app.home?.now ?? Date.now());
  if (types.includes("calendar")) labels.push(`<span class="schedule-source src-chip src-calendar calendar">Calendar commitment</span>`);
  if (types.includes("report")) labels.push(`<span class="schedule-source src-chip src-reported report">Informed by your report</span>`);
  if (elapsed && item.confidence === "possible" && !types.includes("report"))
    labels.push(`<span class="schedule-source src-chip src-imagined estimate">AI estimate</span>`);
  return labels.length ? `<div class="schedule-source-list">${labels.join("")}</div>` : "";
}
function scheduleSourceKind(item) {
  const types = item.source_types ?? [];
  if (types.includes("calendar")) return "calendar";
  if (types.includes("report")) return "reported";
  return "imagined";
}
function scheduleSourceLegend(detailed) {
  const kinds = [
    ["calendar", "Calendar commitment", "A real event from your Google Calendar.", "Calendar"],
    ["reported", "Informed by your report", "Based on what you told Twin you did.", "Your report"],
    ["imagined", "Imagined", "Twin's illustrative guess, not something that happened.", "Imagined"],
  ];
  return detailed
    ? `<ul class="src-legend schedule-legend-detailed">${kinds.map(([kind, label, text]) => `<li class="src-${kind}"><span class="src-dot" aria-hidden="true"></span><span><strong>${label}</strong>${text}</span></li>`).join("")}</ul>`
    : `<ul class="src-legend schedule-legend" aria-label="What the dots mean">${kinds.map(([kind, , , short]) => `<li class="src-${kind}"><span class="src-dot" aria-hidden="true"></span>${short}</li>`).join("")}</ul>`;
}
function scheduleChevron(direction) {
  const path = direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7";
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function scheduleAlertGlyph() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 3.6 2.6 20h18.8L12 3.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.1" fill="currentColor"/></svg>`;
}
function scheduleSourceDetails(item) {
  const types = item.source_types ?? [];
  const labels = [];
  if (types.includes("calendar")) labels.push("Calendar commitment");
  if (types.includes("report")) labels.push("Informed by your report");
  if (types.includes("conversation")) labels.push("Conversation context");
  if (types.includes("memory")) labels.push("Saved memory");
  return labels.length ? labels.join(" · ") : "Planning context";
}
function scheduleActivityRow(item, index, focusIndex) {
  const state = index < focusIndex ? "is-past" : index === focusIndex ? "is-focus" : "is-future";
  const zone = app.settings?.timezone ?? app.day?.timezone;
  const kind = scheduleSourceKind(item);
  return `<li class="schedule-time-row ${state} src-${kind}"><time datetime="${escapeHtml(item.start_at)}"><span class="src-dot" aria-hidden="true"></span><span class="schedule-clock">${scheduleClock(item.start_at, zone)}</span></time><div class="schedule-event">${index === focusIndex ? `<span class="schedule-event-range">${escapeHtml(formatTime(item.start_at, zone))}–${escapeHtml(formatTime(item.end_at, zone))}</span>` : ""}<div class="schedule-event-heading"><h2>${escapeHtml(item.title)}</h2>${scheduleSourceBadges(item)}</div>${kind === "imagined" ? `<span class="visually-hidden">Imagined by Twin.</span>` : ""}<p>${escapeHtml(item.narrative)}</p><details class="schedule-event-details"><summary>Details</summary><div><p>${escapeHtml(item.reason)}</p><p>${escapeHtml(scheduleSourceDetails(item))} · ${escapeHtml(item.confidence)} confidence · ${escapeHtml(activityName(item.activity_key))}</p></div></details></div></li>`;
}
function memoryPortrait(facts) {
  if (!facts.length) return "Your twin does not have enough saved memory to describe your patterns yet.";
  const active = facts
    .filter((item) => item.status !== "tentative")
    .slice(0, 3)
    .map((item) => item.statement.trim());
  const tentative = facts
    .filter((item) => item.status === "tentative")
    .slice(0, 1)
    .map((item) => item.statement.trim());
  const certain = active.join(" ");
  const possible = tentative.length ? ` One possible pattern is: ${tentative[0]}` : "";
  return `${certain}${possible}`.trim();
}
function photoPlaceholder() {
  return `<div class="settings-photo-placeholder" aria-hidden="true"><svg viewBox="0 0 96 96" fill="none"><rect x="13" y="17" width="70" height="62" rx="11" stroke="currentColor" stroke-width="2"/><circle cx="48" cy="42" r="11" stroke="currentColor" stroke-width="2"/><path d="M25 71c4-13 13-20 23-20s19 7 23 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M70 15v20M60 25h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Your photo</span></div>`;
}
function calendarIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;
}
function talkGlyph() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 9.5v5M12 6v12M17 9.5v5"/></svg>`;
}
function twinDaypart() {
  const zone = app.settings?.timezone ?? app.home?.twinDayVersion?.timezone;
  let minutes;
  try {
    minutes = localMinutes(new Date().toISOString(), zone);
  } catch {
    const now = new Date();
    minutes = now.getHours() * 60 + now.getMinutes();
  }
  if (minutes >= 300 && minutes < 600) return "morning";
  if (minutes >= 600 && minutes < 900) return "midday";
  if (minutes >= 900 && minutes < 1110) return "afternoon";
  if (minutes >= 1110 && minutes < 1290) return "evening";
  return "night";
}
function gmailIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3.5 7 8.5 6.5L20.5 7"/></svg>`;
}

render = function () {
  if (app.showOnboarding) return renderOnboarding();
  const route = app.route;
  const shellClass = route === "home" ? "home-shell" : route === "schedule" ? "schedule-shell" : "settings-shell";
  const mainClass = route === "home" ? "home-main" : route === "schedule" ? "schedule-main" : "settings-main";
  const page = route === "home" ? homePage() : route === "schedule" ? schedulePage() : settingsPage();
  root.innerHTML = `<div class="shell ${shellClass} daypart-${twinDaypart()}">${topbar()}<main id="main" class="app-main ${mainClass}" tabindex="-1">${page}</main>${bottomNav()}</div>${talkLayer()}`;
};
topbar = function () {
  if (app.route === "home") return `<header class="app-top home-topbar"><button class="home-wordmark" data-route="home" aria-label="Twin home">Twin</button><button class="home-talk-button talk-trigger" data-talk-toggle aria-label="Talk to your twin" aria-expanded="${app.talkOpen}">${talkGlyph()}</button></header>`;
  if (app.route === "schedule") return `<header class="schedule-topbar"><button class="schedule-wordmark" data-route="home" aria-label="Twin home">Twin</button><button class="schedule-talk-button talk-trigger" data-talk-toggle aria-label="Talk to your twin" aria-expanded="${app.talkOpen}">${talkGlyph()}</button></header>`;
  return "";
};
bottomNav = function () {
  if (app.route === "home") return `<nav class="bottom-nav home-bottom-nav" aria-label="Main navigation"><button data-route="schedule">Schedule</button><button data-route="settings">Settings</button></nav>`;
  if (app.route === "schedule") return `<nav class="bottom-nav schedule-bottom-nav" aria-label="Main navigation"><button data-route="home">My twin</button><button data-route="settings">Settings</button></nav>`;
  return "";
};

schedulePage = function () {
  const day = app.day;
  const selected = selectedScheduleDate();
  const date = scheduleDateParts(selected);
  const focusIndex = scheduleFocusIndex(day);
  const rows = day?.activities?.length ? day.activities.map((item, index) => scheduleActivityRow(item, index, focusIndex)).join("") : `<li class="schedule-empty"><h2>No plan for this day</h2><p>Try another date or rebuild this day from Settings.</p></li>`;
  const changes = day?.tomorrow_may_change_because ?? [];
  const conflicts = day?.unresolved_conflicts ?? [];
  const conflictMarkup = conflicts.length ? `<section class="schedule-conflicts" role="status" aria-labelledby="schedule-conflicts-title"><span class="schedule-conflicts-icon">${scheduleAlertGlyph()}</span><div class="schedule-conflicts-body"><span class="schedule-conflicts-label">Calendar conflict</span><h2 id="schedule-conflicts-title">Some commitments need attention</h2><ul>${conflicts.map((conflict) => `<li>${escapeHtml(conflict.description)}</li>`).join("")}</ul><p>These are planning conflicts, not changes to Google Calendar.</p></div></section>` : "";
  const pendingMarkup = app.schedulePending ? `<p class="schedule-loading" role="status">Loading another day…</p>` : "";
  const planDetails = day ? `<details class="schedule-plan-details"><summary>About this plan</summary><div><p>Illustrative plan · not a record of what happened.</p><p>Version ${day.version} · generated ${escapeHtml(relativeTime(day.generated_at))}</p>${scheduleSourceLegend(true)}${changes.length ? `<h2>What may shape tomorrow</h2>${changes.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}` : ""}</div></details>` : "";
  return `<section class="schedule-page" aria-labelledby="schedule-title" ${app.schedulePending ? 'aria-busy="true"' : ""}><div class="schedule-page-heading"><div><h1 id="schedule-title">Schedule</h1><p>Illustrative plan · not a record of what happened</p></div></div><section class="schedule-day-picker" aria-label="Selected day"><button class="schedule-day-arrow" type="button" data-day-step="-1" aria-label="Previous day" ${app.schedulePending ? "disabled" : ""}>${scheduleChevron("left")}</button><time class="schedule-selected-date" datetime="${selected}" aria-live="polite"><span class="schedule-day-name">${date.day}</span><span class="schedule-day-date">${date.date}</span></time><button class="schedule-day-arrow" type="button" data-day-step="1" aria-label="Next day" ${app.schedulePending ? "disabled" : ""}>${scheduleChevron("right")}</button></section>${pendingMarkup}${conflictMarkup}<section class="schedule-day" aria-label="Activities"><div class="schedule-day-scroll" tabindex="0" aria-label="Activities in time order; scroll for more"><ol class="schedule-timeline">${rows}</ol></div>${day?.activities?.length ? scheduleSourceLegend(false) : ""}${planDetails}</section></section>`;
};

settingsPage = function () {
  const settings = app.settings;
  const calendar = settings.integrations.find((item) => item.provider === "google_calendar");
  return `<section class="settings-page" aria-labelledby="settings-title"><header class="settings-page-header"><button class="settings-back" data-route="home" aria-label="Back to your twin"><span class="settings-chevron is-back" aria-hidden="true"></span><span aria-hidden="true">Twin</span></button><h1 id="settings-title">Settings</h1></header><div class="settings-scroll">${characterSection()}${pluginsSection(calendar)}${memorySection()}${settingsPlannerSection()}<section class="settings-more settings-group" aria-labelledby="more-settings-title"><h2 id="more-settings-title" class="settings-group-title">More settings</h2><div class="settings-more-list glass-list">${timingSection()}${openAISection()}${privacySection()}</div></section></div></section>`;
};

characterSection = function () {
  const design = app.character.design;
  const photo = app.character.photo;
  const baseline = app.character.baseline;
  const candidates = app.character.baseline_candidates ?? [];
  const selectedCandidate = candidates.find((asset) => asset.id === app.avatarCandidateId) ?? candidates[0] ?? null;
  if (selectedCandidate) app.avatarCandidateId = selectedCandidate.id;
  else app.avatarCandidateId = null;
  const pendingBaseline = (app.character.requests ?? []).find((request) => request.purpose === "baseline" && ["queued", "generating"].includes(request.status));
  const baselinePending = Boolean(pendingBaseline);
  const scenes = (app.character.assets ?? []).filter((asset) => asset.kind === "activity" && asset.status === "ready").sort((a, b) => (b.selected_at ?? b.created_at).localeCompare(a.selected_at ?? a.created_at));
  const failed = (app.character.requests ?? []).find((request) => request.status === "failed" && request.failure_code !== "AVATAR_CANCELLED");
  const reference = app.avatarPreview?.dataUrl ?? photo?.assetUrl;
  const photoActions = app.avatarPreview ? `<div class="settings-inline-actions"><button class="ui-button primary" data-save-avatar-photo>Use this photo</button><button class="ui-button" data-cancel-avatar-photo>Cancel</button></div>` : `<label class="settings-step-action ui-button" for="avatar-photo">${photo ? "Replace photo" : "Choose photo"}</label>${photo ? `<div class="settings-inline-actions settings-danger-zone"><button class="ui-button destructive danger" data-delete-avatar-photo>Delete photo</button></div>` : ""}`;
  const baselineBody = baseline ? `<div class="settings-avatar-preview"><img src="${baseline.assetUrl}" alt="Current approved full-body baseline avatar"></div><p class="settings-baseline-status is-current"><span class="settings-status-square" aria-hidden="true"></span><span class="sc">CURRENT AVATAR</span><span class="settings-baseline-version">v${design.version}</span></p>` : `<div class="settings-avatar-preview">${avatarSvg(design, "generic", `${design.name} baseline preview`)}</div><p class="settings-baseline-status${baselinePending ? " is-pending" : ""}"><span class="settings-status-square" aria-hidden="true"></span>${baselinePending ? "Generation in progress" : photo ? "Ready to generate" : "Save a photo first"}</p>${pendingBaseline ? `<button class="settings-step-action ui-button destructive stop" type="button" data-cancel-baseline="${pendingBaseline.id}">Stop generating</button>` : `<button class="settings-step-action ui-button primary" type="button" data-generate-baseline ${!photo ? "disabled" : ""}>Generate baseline</button>`}`;
  const candidateMarkup = baseline ? `<section class="settings-avatar-versions" aria-labelledby="avatar-versions-title"><div class="settings-version-heading"><h4 id="avatar-versions-title">Previous versions</h4><span>${candidates.length} saved</span></div>${candidates.length ? `<div class="settings-version-strip" role="group" aria-label="Generated avatar versions">${candidates.map((asset, index) => `<button class="settings-version-thumb ${asset.id === selectedCandidate?.id ? "selected" : ""}" type="button" data-avatar-candidate="${asset.id}" aria-pressed="${asset.id === selectedCandidate?.id}" aria-label="Select avatar version ${index + 1}"><img src="${asset.assetUrl}" alt=""><span>v${index + 1}</span></button>`).join("")}</div>` : `<p class="settings-version-empty">Generate another version to compare it with your current avatar.</p>`}<div class="settings-version-actions"><button type="button" data-approve-baseline="${selectedCandidate?.id ?? ""}" ${selectedCandidate && !baselinePending ? "" : "disabled"}>SWITCH</button>${pendingBaseline ? `<button class="stop" type="button" data-cancel-baseline="${pendingBaseline.id}">STOP</button>` : `<button type="button" data-generate-baseline>REGENERATE</button>`}<button type="button" data-delete-baseline="${selectedCandidate?.id ?? ""}" ${selectedCandidate && !baselinePending ? "" : "disabled"}>DELETE</button></div></section>` : "";
  const sceneMarkup = scenes.length ? `<div class="settings-library-grid">${scenes.map((asset) => `<article class="settings-library-card"><img src="${asset.assetUrl}" alt="Twin ${escapeHtml(activityName(asset.activity_key).toLowerCase())}"><div class="settings-library-card-copy"><h4>${escapeHtml(activityName(asset.activity_key))}</h4><p>${asset.selected_at ? `<span class="settings-in-use">In use</span>` : "Saved version"}, avatar v${asset.design_version}</p><div class="settings-library-actions"><button class="ui-button" data-regenerate-scene="${asset.id}">Regenerate</button>${!asset.selected_at ? `<button class="ui-button" data-select-scene="${asset.id}">Use this</button>` : ""}<button class="ui-button destructive" data-delete-scene="${asset.id}">Delete</button></div></div></article>`).join("")}</div>` : `<div class="schedule-empty"><h2>No activity images yet</h2><p>Saved activity versions appear here after a baseline is approved.</p></div>`;
  return `<section id="character" class="settings-avatar settings-group" aria-labelledby="avatar-title"><div class="settings-avatar-intro"><h2 id="avatar-title" class="settings-group-title">Avatar</h2><p>Start with a private photo. Then approve one full-body avatar that Twin can carry into every part of your day.</p></div><div class="settings-avatar-grid"><article class="settings-avatar-card glass-card"><p class="settings-step-kicker">Step 1 of 2 <span>Private reference</span></p><h3>Upload your photo</h3><p class="settings-step-description">A clear, front-facing photo helps Twin keep your features recognizable.</p><div class="settings-avatar-preview settings-photo-preview">${reference ? `<img src="${reference}" alt="${app.avatarPreview ? "Selected photo preview" : "Private reference photo"}">` : photoPlaceholder()}</div><input class="visually-hidden" id="avatar-photo" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="photo-help"><p id="photo-help" class="settings-step-footnote">PNG, JPEG or WebP, under 8 MB.</p>${photoActions}</article><article class="settings-avatar-card glass-card"><p class="settings-step-kicker">Step 2 of 2 <span>Identity anchor</span></p><h3>Baseline avatar</h3><p class="settings-step-description">Approve one standing version of you. Activity images grow from this look.</p>${baselineBody}${candidateMarkup}</article></div>${failed ? `<div class="error-box">Avatar generation failed (${escapeHtml(failed.failure_code ?? "provider error")}). Your saved images are unchanged.</div>` : ""}<p class="settings-avatar-footer">Your approved look stays consistent as Twin studies, runs, and moves through the day.</p><details class="settings-avatar-library glass-card"><summary><span class="settings-library-title">Activity library</span><span class="settings-library-hint">View saved images<span class="settings-chevron" aria-hidden="true"></span></span></summary><div class="settings-library-content">${sceneMarkup}<div class="settings-avatar-delete"><p>Remove the private source photo only, or delete the photo, baseline, and all generated activity images.</p><div class="settings-library-actions">${photo ? `<button class="ui-button destructive" data-delete-avatar-photo>Delete photo</button>` : ""}<button class="ui-button destructive" data-delete-avatar-images ${photo || baseline || scenes.length ? "" : "disabled"}>Delete all images</button></div></div></div></details></section>`;
};

connectionCard = function (key, title, item, description) {
  const mode = item?.mode ?? "live";
  const prototype = mode === "prototype";
  const rawStatus = item?.status ?? "disconnected";
  const statusText = String(rawStatus).replaceAll("_", " ").toLowerCase();
  const status = mode === "demo" ? "Demo data" : prototype ? "Prototype snapshot" : statusText.charAt(0).toUpperCase() + statusText.slice(1);
  const icon = key === "calendar" ? calendarIcon() : gmailIcon();
  const hasCredentials = Boolean(item?.has_credentials);
  const hasConnection = hasCredentials || prototype;
  const syncing = rawStatus === "syncing";
  const connectLabel = hasCredentials ? "Reconnect" : "Set up live";
  const calendars = key === "calendar" && hasCredentials && (item?.selected_calendars ?? []).length ? `<fieldset class="settings-calendar-picker"><legend>Calendars to use</legend>${item.selected_calendars.map((calendar) => `<label><input type="checkbox" data-calendar-choice value="${escapeHtml(calendar.id)}" ${calendar.selected ? "checked" : ""}> <span>${escapeHtml(calendar.name)}</span></label>`).join("")}<button class="ui-button primary" data-save-calendar-selection ${syncing ? "disabled" : ""}>Save and sync</button></fieldset>` : "";
  const failure = item?.failure_code ? `<p class="settings-plugin-error" role="status">Sync needs attention: ${escapeHtml(String(item.failure_code).replaceAll("_", " ").toLowerCase())}.</p>` : "";
  const prototypeNote = prototype ? `<p>This one-time imported snapshot covers ${escapeHtml(item.source_window_start_date ?? "an unknown date")} through ${escapeHtml(item.source_window_end_date ?? "an unknown date")} and contains ${Number(item.source_event_count ?? 0)} events. It is not connected to Google and will not refresh automatically.</p>` : "";
  return `<details class="settings-plugin-entry"><summary class="settings-plugin-row"><span class="settings-plugin-icon settings-tile is-${key}">${icon}</span><span class="settings-plugin-copy"><h3>${title}</h3><p>${description}</p><span class="settings-plugin-status${rawStatus === "connected" && !prototype && mode !== "demo" ? " is-on" : ""}">${escapeHtml(status)}</span></span><span class="settings-row-action"><span class="visually-hidden">Manage</span><span class="settings-chevron" aria-hidden="true"></span></span></summary><div class="settings-plugin-controls"><p>${prototype ? "Imported" : "Last synced"}: ${item?.last_successful_sync_at ? relativeTime(item.last_successful_sync_at) : "never"}</p>${prototypeNote}${failure}${calendars}<div class="settings-plugin-actions"><button class="ui-button" data-connect="${key}">${connectLabel}</button><button class="ui-button" data-sync="${key}" ${!hasCredentials || syncing ? "disabled" : ""}>${prototype ? "Manual snapshot" : syncing ? "Syncing…" : "Sync now"}</button><button class="ui-button destructive" data-disconnect="${key}" ${!hasConnection ? "disabled" : ""}>Disconnect</button></div></div></details>`;
};
pluginsSection = function (calendar) {
  return `<section id="plugins" class="settings-plugins settings-group" aria-labelledby="plugins-title"><h2 id="plugins-title" class="settings-group-title">Plug-ins</h2><div class="settings-plugin-list glass-card glass-list">${connectionCard("calendar", "Google Calendar", calendar, "Your schedule and open time")}</div><p class="settings-section-intro">Choose what your twin can use to understand your day. Calendar events count as real commitments, so your twin plans around them.</p></section>`;
};

memorySection = function () {
  const facts = app.facts.filter((item) => item.status !== "suppressed");
  const portrait = memoryPortrait(facts);
  const factRows = facts.map((fact) => `<div class="settings-fact"><div><p>${escapeHtml(fact.statement)}</p><small>${fact.status === "tentative" ? "Possible pattern" : "Saved preference"} · ${escapeHtml(fact.source_type)} · ${relativeTime(fact.updated_at)}</small></div><div class="settings-fact-actions"><button data-edit-fact="${fact.id}" aria-label="Edit memory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="is-remove" data-remove-fact="${fact.id}" aria-label="Remove memory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>`).join("");
  const reportRows = app.reports.map((report) => `<div class="settings-fact is-report"><div><p>${escapeHtml(report.statement)}</p><small><span class="src-chip src-reported">You reported doing</span> · ${formatLongDate(report.local_date)} · ${report.source === "manual_rebuild_report" ? "Used to catch up this twin day" : "Informs later days"}</small></div></div>`).join("");
  return `<section id="memory" class="settings-memory settings-group" aria-labelledby="memory-title"><h2 id="memory-title" class="settings-group-title">Twin's picture of you</h2><div class="settings-memory-card glass-card"><div class="settings-memory-summary"><span class="settings-memory-label">${facts.length ? `${facts.length} live ${facts.length === 1 ? "memory" : "memories"}` : "Memory is empty"}</span><p>${escapeHtml(portrait)}</p></div><details class="settings-memory-review"><summary><span>Review memory</span><span class="settings-chevron" aria-hidden="true"></span></summary><div class="settings-facts">${factRows || `<div class="schedule-empty"><p>Import a handoff to give the twin grounded context.</p></div>`}${reportRows}</div></details></div></section>`;
};

timingSection = function () {
  const settings = app.settings;
  return `<details id="timing" class="settings-more-item"><summary><span class="settings-tile" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></span><span class="settings-more-label">Twin timing</span><span class="settings-chevron" aria-hidden="true"></span></summary><div class="settings-more-panel"><p>Twin schedules one AI morning run at your wake time in your saved time zone. Changes affect later runs; the timeline remains illustrative.</p><form id="settings-form"><div class="form-grid"><label class="field full"><span>Time zone</span><input class="input ui-input" name="timezone" value="${escapeHtml(settings.timezone)}"></label><label class="field"><span>Morning plan / wake time</span><input class="input ui-input" type="time" name="wake_time" value="${settings.wake_time}"></label><label class="field"><span>Sleep time</span><input class="input ui-input" type="time" name="sleep_time" value="${settings.sleep_time}"></label><label class="field"><span>Talk retention days</span><input class="input ui-input" type="number" min="1" max="365" name="talk_retention_days" value="${settings.talk_retention_days}"></label></div><div class="form-actions"><button class="ui-button primary" type="submit">Save timing</button></div></form></div></details>`;
};
openAISection = function () {
  const connection = app.settings.openai;
  const statusText = connection.status.replaceAll("_", " ").toLowerCase();
  return `<details id="openai" class="settings-more-item"><summary><span class="settings-tile" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2.5 2.5M18.5 4.5 21 7"/></svg></span><span class="settings-more-label">OpenAI connection</span><span class="settings-chevron" aria-hidden="true"></span></summary><div class="settings-more-panel"><p>Your key powers live text Talk, AI day planning, and optional character images. It is encrypted by the server and never shown again.</p><div class="secret-status"><span class="settings-plugin-status${connection.status === "connected" ? " is-on" : ""}">${escapeHtml(statusText.charAt(0).toUpperCase() + statusText.slice(1))}</span><strong>${escapeHtml(connection.key_masked ?? "No key saved")}</strong></div>${!connection.encryption_ready ? `<div class="notice">Set <code>TWIN_ENCRYPTION_KEY</code> in the server environment before saving a key.</div>` : ""}<form id="key-form"><label class="field"><span>OpenAI API key</span><input class="input ui-input" type="password" name="api_key" autocomplete="off" placeholder="sk-…" required></label><div class="form-actions"><button class="ui-button primary" type="submit">${connection.key_masked ? "Replace key" : "Save key"}</button><button class="ui-button" type="button" data-test-key ${!connection.key_masked ? "disabled" : ""}>Test connection</button><button class="ui-button destructive" type="button" data-remove-key ${!connection.key_masked ? "disabled" : ""}>Remove</button></div></form><p class="small">Text: ${connection.text_capability} · Planner: ${escapeHtml(connection.planner_model ?? "configured server-side")} · Image: ${connection.image_capability}${connection.tested_at ? ` · tested ${relativeTime(connection.tested_at)}` : ""}</p></div></details>`;
};
privacySection = function () {
  return `<details id="privacy" class="settings-more-item"><summary><span class="settings-tile" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg></span><span class="settings-more-label">Privacy &amp; data</span><span class="settings-chevron" aria-hidden="true"></span></summary><div class="settings-more-panel"><p>Export or remove user-owned data. Destructive actions require explicit confirmation.</p><div class="settings-privacy-list"><div class="settings-privacy-row"><div><strong>Export my data</strong><span>JSON without provider secrets.</span></div><a class="ui-button" href="/api/account/export" download>Export</a></div><div class="settings-privacy-row"><div><strong>Delete Talk history</strong><span>Remove saved conversations and messages.</span></div><button class="ui-button destructive" data-delete-history>Delete</button></div><div class="settings-privacy-row"><div><strong>Restart onboarding</strong><span>Reopen the prompt without erasing memory.</span></div><button class="ui-button" data-restart-onboarding>Restart</button></div></div><div class="settings-privacy-row is-account"><div><strong>Delete account</strong><span>Remove all owned records and queued jobs.</span></div><button class="ui-button destructive" data-delete-account>Delete account</button></div></div></details>`;
};

talkLayer = function () {
  if (!app.talkOpen) return "";
  const connection = app.settings?.openai;
  const connected = connection?.status === "connected";
  const conversation = app.conversations.find((item) => item.id === app.conversationId) ?? app.conversations[0];
  const messages = conversation?.messages ?? [];
  const transcript = messages.length ? messages.map((message) => `<li class="talk-message ${message.role === "user" ? "you" : "twin"}"><span class="talk-speaker">${message.role === "user" ? "You" : "Twin"}</span><p>${escapeHtml(message.content)}</p><small><time datetime="${escapeHtml(message.created_at)}">${new Date(message.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></small></li>`).join("") : `<li class="talk-empty-message">${connected ? "Tell your twin what actually happened today, or ask about the day ahead." : "Connect an OpenAI key in Settings to start a live text conversation."}</li>`;
  const orbAttributes = connected ? `data-talk-orb aria-label="Toggle the Talk orb animation"` : `data-route="settings" data-talk-toggle aria-label="Open Settings to connect Talk"`;
  return `<div class="talk-layer open" data-talk-backdrop><section class="talk-surface ${app.talkPreview ? "talking" : ""}" role="dialog" aria-modal="true" aria-labelledby="talk-title"><header class="talk-page-header"><button class="talk-back" data-talk-toggle aria-label="Back">${talkBackIcon()}</button><h1 id="talk-title">Talk</h1><span aria-hidden="true"></span></header><section class="talk-invitation" aria-labelledby="talk-invitation-title"><h2 id="talk-invitation-title">Explain your day.</h2><p>How are you feeling? What changes are you making today?</p></section><section class="talk-conversation-stage" aria-label="Conversation around the Twin orb"><p class="talk-conversation-label">${messages.length ? "Your conversation" : "Start a conversation"}</p><div class="talk-message-window" tabindex="-1" data-talk-stream><ol class="talk-message-track" aria-label="Conversation transcript">${transcript}</ol></div><button class="talk-orb-control" type="button" ${orbAttributes} aria-pressed="${Boolean(app.talkPreview)}"><span class="talk-orb-halo" aria-hidden="true"></span><span class="talk-orb-art" aria-hidden="true"><span class="talk-orb-core"></span></span></button></section><footer class="talk-dock"><div class="talk-status"><span class="talk-status-dot" aria-hidden="true"></span><span aria-live="polite">${connected ? (app.talkPreview ? "Orb in motion" : "Type to talk") : "Connection needed"}</span><small>${connected ? "Live text" : "Open Settings"}</small></div>${connected ? `<form class="talk-text-form" id="talk-form"><textarea name="message" aria-label="Message" placeholder="I actually studied at the library…" required ${app.talkSending ? "disabled" : ""}>${escapeHtml(app.talkDraft)}</textarea><button class="talk-send" aria-label="Send message" ${app.talkSending ? 'disabled aria-busy="true"' : ""}>${app.talkSending ? "…" : talkSendIcon()}</button></form>` : `<button class="talk-connect" data-route="settings" data-talk-toggle>Open Settings</button>`}</footer></section></div>`;
};
function talkBackIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`;
}
function talkSendIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
}

function uiElementKey(element) {
  if (!element || element === document.body) return null;
  if (element.id) return `id:${element.id}`;
  const form = element.closest?.("form");
  if (form?.id && element.name) return `form:${form.id}:${element.name}`;
  for (const name of ["route", "talkToggle", "dayStep", "talkOrb", "avatarCandidate"]) {
    if (element.dataset?.[name] !== undefined) return `data:${name}:${element.dataset[name]}`;
  }
  return null;
}
function findUiElement(key) {
  if (!key) return null;
  return [...root.querySelectorAll("button,a,input,textarea,select,summary,[tabindex]")].find((element) => uiElementKey(element) === key) ?? null;
}
function detailKey(detail, index) {
  return detail.id || `${app.route}:${detail.className}:${index}`;
}
function fieldKey(field, index) {
  const form = field.closest("form");
  return `${app.route}:${form?.id ?? "page"}:${field.id || field.name || index}`;
}
function captureUiState() {
  if (!root.firstElementChild) return;
  const scrollContainer = document.querySelector(app.route === "settings" ? ".settings-scroll" : app.route === "schedule" ? ".schedule-day-scroll" : ".home-shell");
  if (scrollContainer) app.ui.scroll[app.route] = scrollContainer.scrollTop;
  const talkStream = document.querySelector("[data-talk-stream]");
  if (talkStream) app.ui.scroll.talk = talkStream.scrollTop;
  const talkField = document.querySelector("#talk-form textarea");
  if (talkField) app.talkDraft = talkField.value;
  app.ui.openDetails[app.route] = [...root.querySelectorAll("details")].map(detailKey).filter((_, index) => root.querySelectorAll("details")[index].open);
  if (app.route === "settings") {
    [...root.querySelectorAll("input:not([type=password]):not([type=file]), textarea, select")].forEach((field, index) => {
      app.ui.fields[fieldKey(field, index)] = {
        value: field.value,
        checked: field.checked,
        type: field.type,
      };
    });
  }
  app.ui.focusKey = uiElementKey(document.activeElement);
}
function restoreUiState() {
  const scrollContainer = document.querySelector(app.route === "settings" ? ".settings-scroll" : app.route === "schedule" ? ".schedule-day-scroll" : ".home-shell");
  if (scrollContainer && Number.isFinite(app.ui.scroll[app.route])) scrollContainer.scrollTop = app.ui.scroll[app.route];
  const talkStream = document.querySelector("[data-talk-stream]");
  if (talkStream && Number.isFinite(app.ui.scroll.talk)) talkStream.scrollTop = app.ui.scroll.talk;
  const openDetails = new Set(app.ui.openDetails[app.route] ?? []);
  [...root.querySelectorAll("details")].forEach((detail, index) => {
    detail.open = openDetails.has(detailKey(detail, index));
  });
  if (app.route === "settings") {
    [...root.querySelectorAll("input:not([type=password]):not([type=file]), textarea, select")].forEach((field, index) => {
      const saved = app.ui.fields[fieldKey(field, index)];
      if (!saved) return;
      if (saved.type === "checkbox" || saved.type === "radio") field.checked = saved.checked;
      else field.value = saved.value;
    });
  }
  findUiElement(app.ui.focusKey)?.focus({ preventScroll: true });
  const shell = root.querySelector(".shell");
  if (shell) shell.inert = app.talkOpen;
  document.body.classList.toggle("talk-open", app.talkOpen);
}
const renderApplication = render;
render = function () {
  if (!app.ui.skipCapture) captureUiState();
  app.ui.skipCapture = false;
  renderApplication();
  restoreUiState();
};

refreshRoute = async function () {
  if (app.route === "home") app.home = await api("/api/home");
  else if (app.route === "schedule") {
    app.home = await api("/api/home");
    const selected = app.selectedDate ?? app.home.twinDayVersion?.local_date ?? app.home.localDate;
    app.day = selected === app.home.twinDayVersion?.local_date ? app.home.twinDayVersion : await api(`/api/twin-days?date=${selected}`);
    app.selectedDate = selected;
  } else await refreshSettings();
};
let routeRequest = 0;
async function navigateRoute(route) {
  if (!["home", "schedule", "settings"].includes(route)) return;
  captureUiState();
  const request = ++routeRequest;
  app.route = route;
  try {
    await refreshRoute();
    if (request !== routeRequest) return;
    app.ui.skipCapture = true;
    render();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setTimeout(() => document.querySelector("#main")?.focus({ preventScroll: true }), 20);
  } catch (error) {
    if (request === routeRequest) toast(error.payload?.message ?? error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const dayButton = event.target.closest("[data-day-step]");
  if (dayButton) {
    event.preventDefault();
    if (app.scheduleRebuild.busy || app.schedulePending) return;
    const date = new Date(`${selectedScheduleDate()}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(dayButton.dataset.dayStep));
    const requestedDate = date.toISOString().slice(0, 10);
    const request = ++app.scheduleRequest;
    app.schedulePending = true;
    app.scheduleRebuild.status = null;
    render();
    try {
      const day = await api(`/api/twin-days?date=${requestedDate}`);
      if (request !== app.scheduleRequest) return;
      app.day = day;
      app.selectedDate = requestedDate;
      if (!day) toast("No simulated day exists for that date.", true);
    } catch (error) {
      if (request === app.scheduleRequest) toast(error.payload?.message ?? error.message, true);
    } finally {
      if (request === app.scheduleRequest) {
        app.schedulePending = false;
        render();
      }
    }
    return;
  }
  const orb = event.target.closest("[data-talk-orb]");
  if (orb) {
    event.preventDefault();
    app.talkPreview = !app.talkPreview;
    render();
    setTimeout(() => document.querySelector("[data-talk-orb]")?.focus(), 20);
  }
});
document.addEventListener("click", (event) => {
  const candidate = event.target.closest("[data-avatar-candidate]");
  if (!candidate) return;
  event.preventDefault();
  app.avatarCandidateId = candidate.dataset.avatarCandidate;
  render();
  setTimeout(() => {
    const selected = document.querySelector(`[data-avatar-candidate="${CSS.escape(app.avatarCandidateId)}"]`);
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, 20);
});
document.addEventListener("input", (event) => {
  if (event.target.id === "schedule-rebuild-actual") {
    app.scheduleRebuild.actualReport = event.target.value;
    const count = document.querySelector("[data-schedule-actual-count]");
    if (count) count.textContent = String(event.target.value.length);
  }
  if (["schedule-rebuild-future", "schedule-rebuild-instruction"].includes(event.target.id)) {
    app.scheduleRebuild.instruction = event.target.value;
    const count = document.querySelector("[data-schedule-instruction-count]");
    if (count) count.textContent = String(event.target.value.length);
  }
  if (event.target.matches("#talk-form textarea")) app.talkDraft = event.target.value;
});
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-talk-toggle]") && !app.talkOpen) app.talkPreview = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !app.talkOpen) app.talkPreview = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !app.talkOpen) return;
  const dialog = document.querySelector(".talk-surface");
  if (!dialog) return;
  const controls = [...dialog.querySelectorAll('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
});

/* Five-screen onboarding integration. The reference supplies presentation; existing APIs remain authoritative. */
const ONBOARDING_STEP_KEY = "twin:onboarding-step";
app.onboardingStep = 0;
app.onboardingName = "";
app.onboardingPrompt = ONBOARDING_PROMPT;
app.onboardingError = "";
app.onboardingPlan = { busy: false, status: null, idempotencyKey: null };

function savedOnboardingStep() {
  try {
    const value = Number(localStorage.getItem(ONBOARDING_STEP_KEY));
    return Number.isInteger(value) && value >= 0 && value <= 4 ? value : null;
  } catch {
    return null;
  }
}
function storeOnboardingStep(step) {
  try {
    localStorage.setItem(ONBOARDING_STEP_KEY, String(step));
  } catch {}
}
function clearOnboardingStep() {
  try {
    localStorage.removeItem(ONBOARDING_STEP_KEY);
  } catch {}
}
function onboardingGo(step) {
  app.onboardingStep = Math.max(0, Math.min(4, step));
  app.onboardingError = "";
  storeOnboardingStep(app.onboardingStep);
  render();
  setTimeout(() => document.querySelector("#twin-onboarding h1, #onboarding-name")?.focus?.(), 20);
}
function onboardingKicker(text) {
  return `<p class="tw-kicker"><span class="tw-square" aria-hidden="true"></span>${escapeHtml(text)}</p>`;
}
function onboardingHeader() {
  const name = (app.onboardingName || app.bootstrap?.settings?.name || "").trim();
  return `<header class="tw-header"><p class="tw-wordmark">TWIN</p><span class="tw-account">${app.onboardingStep === 0 ? "LET’S BEGIN" : `<span class="tw-account-dot" aria-hidden="true"></span>${escapeHtml(name ? `${name}’S TWIN` : "YOUR TWIN")}`}</span></header>`;
}
function onboardingFooter(label, attributes, disabled = false, skipAttributes = "") {
  return `<footer class="tw-footer"><div class="tw-footer-rule"></div><div class="tw-footer-content"><div class="tw-back-row">${app.onboardingStep > 0 ? `<button class="tw-back" type="button" data-onboarding-back aria-label="Previous step" ${app.onboardingPlan.busy ? "disabled" : ""}>←</button>` : ""}<span class="tw-step-count">0${app.onboardingStep + 1} / 05</span></div><button class="tw-primary" type="button" ${attributes} ${disabled ? "disabled" : ""}>${escapeHtml(label)}<span aria-hidden="true">→</span></button></div>${skipAttributes ? `<button class="tw-text-button" type="button" ${skipAttributes}>I’ll do this later</button>` : ""}</footer>`;
}
function onboardingErrors() {
  if (!app.onboardingError && !app.importError) return "";
  const error = app.importError ?? { message: app.onboardingError };
  return `<div class="tw-error" role="alert"><strong>${escapeHtml(error.message)}</strong>${
    error.fields
      ? `<ul class="tw-field-errors">${Object.entries(error.fields)
          .map(([key, value]) => `<li><code>${escapeHtml(key)}</code>: ${escapeHtml(value)}</li>`)
          .join("")}</ul>`
      : ""
  }</div>`;
}
function onboardingNameScreen() {
  const name = app.onboardingName || app.bootstrap?.settings?.name || "";
  return `<main class="tw-stage">${onboardingKicker("Your twin starts here")}<h1 tabindex="-1">What should<br>we call you?</h1><p class="tw-description">A fresh start. A little about you.<br>A Twin that grows from there.</p><form id="onboarding-name-form" class="tw-name-form"><label class="tw-label" for="onboarding-name">Your name</label><input class="tw-name-input" id="onboarding-name" name="name" autocomplete="given-name" maxlength="50" placeholder="Enter your name" value="${escapeHtml(name)}" required><p class="tw-name-footnote">Start by creating your personal Twin profile.</p>${onboardingErrors()}<button type="submit" hidden>Create account</button></form></main>${onboardingFooter(app.loading ? "Creating…" : "Create account", "data-onboarding-submit-name", app.loading || !name.trim())}`;
}
function onboardingChatGPTScreen() {
  return `<main class="tw-stage">${onboardingKicker(`Nice to meet you${app.onboardingName ? `, ${app.onboardingName}` : ""}`)}<h1 tabindex="-1">Let’s get<br>to know you.</h1><p class="tw-description">Use ChatGPT to tell Twin about your life.<br>Here’s how to get started.</p><div class="tw-gpt-actions"><section class="tw-gpt-step"><p class="tw-gpt-step-label"><span>01</span> Copy this prompt</p><p class="tw-gpt-step-help">The prompt tells ChatGPT what to ask you.</p><button class="tw-primary tw-gpt-button" type="button" data-onboarding-copy>Copy prompt <span aria-hidden="true">↗</span></button><details><summary>See the full prompt</summary><pre>${escapeHtml(app.onboardingPrompt)}</pre></details></section><section class="tw-gpt-step"><p class="tw-gpt-step-label"><span>02</span> Open ChatGPT and paste it</p><p class="tw-gpt-step-help">Start a new chat, then paste and send the prompt you copied.</p><a class="tw-primary tw-gpt-button tw-gpt-open" href="https://chatgpt.com/" target="_blank" rel="noopener">Open ChatGPT <span aria-hidden="true">↗</span></a></section><section class="tw-gpt-step"><p class="tw-gpt-step-label"><span>03</span> Talk, then bring back your output</p><p class="tw-gpt-step-help">If you want to talk, tap ChatGPT’s Voice icon after sending the prompt. When you’re done, say:</p><p class="tw-export-command">“Finish and export JSON”</p><p class="tw-gpt-step-help">Copy the final output, then return here.</p></section></div></main>${onboardingFooter("I have my output", "data-onboarding-next")}`;
}
function onboardingImportScreen() {
  return `<main class="tw-stage">${onboardingKicker("Bring it back")}<h1 tabindex="-1">Your story.<br>Now in Twin.</h1><p class="tw-description">Paste ChatGPT’s final output below.<br>This is where your Twin starts learning.</p><label class="tw-label tw-json-label" for="onboarding-json">ChatGPT’s final output</label><textarea class="tw-json" id="onboarding-json" spellcheck="false" placeholder="Paste your JSON here…">${escapeHtml(app.importText)}</textarea><div class="tw-import-links"><label class="tw-file-label" for="onboarding-json-file">Upload a JSON file ↗</label><input hidden id="onboarding-json-file" type="file" accept=".json,application/json">${app.importFileName ? `<span class="tw-note">${escapeHtml(app.importFileName)}</span>` : ""}</div>${onboardingErrors()}<p class="tw-note">You choose what to bring over. Your full ChatGPT conversation stays in ChatGPT.</p></main>${onboardingFooter(app.loading ? "Importing…" : "Import & continue", "data-onboarding-import", app.loading || !app.importText.trim())}`;
}
function onboardingOpenAIScreen() {
  const connection = app.settings?.openai ?? app.bootstrap?.openai;
  const plan = app.onboardingPlan;
  const ready = plan.status?.kind === "success";
  const connected = Boolean(connection?.key_masked);
  const disabled = plan.busy || !connection?.encryption_ready;
  const status = plan.status ? `<div class="tw-plan-status ${plan.status.kind}" role="${plan.status.kind === "error" ? "alert" : "status"}" aria-live="${plan.status.kind === "error" ? "assertive" : "polite"}" tabindex="-1"><strong>${escapeHtml(plan.status.title)}</strong><p>${escapeHtml(plan.status.message)}</p></div>` : "";
  const connectionSummary = connected ? `<div class="tw-key-saved"><span class="tw-account-dot" aria-hidden="true"></span><div><strong>Saved securely</strong><span>${escapeHtml(connection.key_masked)}</span></div></div>` : "";
  const form = ready ? "" : `<label class="tw-label tw-key-label" for="onboarding-openai-key">${connected ? "Replace key (optional)" : "OpenAI API key"}</label><input class="tw-key-input" id="onboarding-openai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${connected ? "Leave blank to use the saved key" : "sk-…"}" ${connected ? "" : "required"}><p class="tw-note">The browser sends this once to Twin’s server. It is encrypted at rest and never shown again. OpenAI usage may be billed to the key owner.</p>`;
  const encryption = connection?.encryption_ready ? "" : '<div class="tw-provider-note" role="alert">Twin cannot save a key until <code>TWIN_ENCRYPTION_KEY</code> is configured on the server.</div>';
  const footer = ready ? onboardingFooter("Continue to avatar", "data-onboarding-next") : onboardingFooter(plan.busy ? "Building your day…" : connected ? "Build my day" : "Connect & build", "data-onboarding-connect-plan", disabled);
  return `<main class="tw-stage">${onboardingKicker("Power your twin")}<h1 tabindex="-1">Build the rest<br>of today.</h1><p class="tw-description">Connect your own OpenAI key. Twin will test it, then create a private simulated schedule from now onward using the memory you imported.</p><div class="tw-key-panel">${connectionSummary}${form}${encryption}${status}</div></main>${footer}`;
}
function onboardingPhotoPlaceholder() {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="32" cy="23" r="11" stroke="currentColor" stroke-width="2"/><path d="M12 56c2-16 10-24 20-24s18 8 20 24" stroke="currentColor" stroke-width="2"/><path d="M52 9v14M45 16h14" stroke="currentColor" stroke-width="2"/></svg><p>A clear photo of you.</p><label class="tw-secondary" for="avatar-photo">Choose photo ↗</label>`;
}
function onboardingAvatarScreen() {
  const character = app.character;
  const photo = character?.photo;
  const baseline = character?.baseline;
  const candidates = character?.baseline_candidates ?? [];
  const candidate = candidates[0];
  const requests = character?.requests ?? [];
  const pendingRequest = requests.find((item) => item.purpose === "baseline" && ["queued", "generating"].includes(item.status));
  const pending = Boolean(pendingRequest);
  const failed = requests.find((item) => item.purpose === "baseline" && item.status === "failed" && item.failure_code !== "AVATAR_CANCELLED");
  const connected = (app.settings?.openai ?? app.bootstrap?.openai)?.status === "connected";
  const preview = app.avatarPreview;
  let image = onboardingPhotoPlaceholder();
  let state = "";
  let footer = "";
  if (baseline) {
    image = `<img src="${baseline.assetUrl}" alt="Your approved Twin avatar">`;
    state = `<div class="tw-avatar-confirm"><h3>That’s your Twin.</h3><p class="tw-description">Your approved look will carry into future activity images.</p></div>`;
    footer = onboardingFooter("Finish setup", 'data-onboarding-finish="home"');
  } else if (candidate) {
    image = `<img src="${candidate.assetUrl}" alt="Twin avatar candidate generated from your photo">`;
    state = `<div class="tw-avatar-confirm"><h3>Does this feel like you?</h3><p class="tw-description">Approve this look, or create another version.</p><div class="tw-candidate-actions"><button class="tw-text-button" type="button" data-approve-baseline="${candidate.id}">Approve this avatar</button><button class="tw-text-button" type="button" data-generate-baseline>Try another version</button></div></div>`;
    footer = onboardingFooter("Approve avatar", `data-approve-baseline="${candidate.id}"`, false, 'data-onboarding-finish="home"');
  } else if (preview) {
    image = `<img src="${preview.dataUrl}" alt="Selected reference photo preview">`;
    state = `<div class="tw-avatar-confirm"><h3>Use this photo?</h3><p class="tw-description">It stays private and is uploaded only when you confirm.</p><div class="tw-candidate-actions"><button class="tw-text-button" type="button" data-save-avatar-photo>Use this photo</button><button class="tw-text-button" type="button" data-cancel-avatar-photo>Choose another</button></div></div>`;
    footer = onboardingFooter("Save photo first", "", true, 'data-onboarding-finish="home"');
  } else if (photo) {
    image = `<img src="${photo.assetUrl}" alt="Your private reference photo">`;
    if (pending || app.avatarBusy) {
      state = '<p class="tw-avatar-state" role="status">Creating your illustrated avatar. This can take a few minutes…</p>';
      footer = onboardingFooter("Stop", `data-cancel-baseline="${pendingRequest?.id ?? ""}"`, false, 'data-onboarding-finish="home"');
    } else if (failed) {
      state = `<p class="tw-avatar-state error" role="alert">Avatar generation failed (${escapeHtml(failed.failure_code ?? "provider error")}). Your photo is still saved and you can retry.</p>`;
      footer = onboardingFooter("Try again", "data-generate-baseline", !connected, 'data-onboarding-finish="home"');
    } else if (!connected) {
      state = '<div class="tw-provider-note">Avatar generation needs an OpenAI connection. Finish setup now, then add your key in Settings and return to Avatar Studio.</div>';
      footer = onboardingFooter("Finish for now", 'data-onboarding-finish="home"');
    } else {
      state = '<p class="tw-note">Your photo is saved privately and ready to become an illustrated Twin.</p>';
      footer = onboardingFooter("Create avatar", "data-generate-baseline", false, 'data-onboarding-finish="home"');
    }
  } else footer = onboardingFooter("Continue later", 'data-onboarding-finish="home"');
  const imported = app.importResult ? app.importResult.applied_counts.active + app.importResult.applied_counts.tentative : app.facts.length;
  return `<main class="tw-stage">${imported ? `<p class="tw-import-success">✓ ${imported} ${imported === 1 ? "thing" : "things"} brought over. Your Twin is taking shape.</p>` : ""}${onboardingKicker("Give your twin a face")}<h1 tabindex="-1">A little<br>more like you.</h1><p class="tw-description">Upload a photo. Twin turns it into<br>your own illustrated avatar.</p><div class="tw-photo-box">${image}</div><input hidden id="avatar-photo" type="file" accept="image/png,image/jpeg,image/webp"><div class="tw-photo-actions">${photo || preview ? '<label class="tw-file-label" for="avatar-photo">Change photo ↗</label>' : '<span class="tw-note">PNG, JPEG, or WebP · under 8 MB</span>'}</div>${state}</main>${footer}`;
}
renderOnboarding = function () {
  const screens = [onboardingNameScreen, onboardingChatGPTScreen, onboardingImportScreen, onboardingOpenAIScreen, onboardingAvatarScreen];
  root.innerHTML = `<div id="twin-onboarding"><section class="tw-screen" aria-label="Twin onboarding">${onboardingHeader()}<div class="tw-progress" role="progressbar" aria-label="Onboarding progress" aria-valuemin="1" aria-valuemax="5" aria-valuenow="${app.onboardingStep + 1}"><span class="tw-progress-fill" style="width:${(app.onboardingStep + 1) * 20}%"></span></div>${screens[app.onboardingStep]()}</section></div>`;
};

init = async function () {
  try {
    const [bootstrap, prompt] = await Promise.all([
      api("/api/bootstrap"),
      fetch("/onboarding-prompt.txt")
        .then((response) => (response.ok ? response.text() : ONBOARDING_PROMPT))
        .catch(() => ONBOARDING_PROMPT),
    ]);
    app.bootstrap = bootstrap;
    app.onboardingPrompt = prompt;
    app.onboardingName = bootstrap.settings?.name ?? "";
    const saved = savedOnboardingStep();
    if (!bootstrap.profile_exists) {
      app.onboardingStep = 0;
      app.showOnboarding = true;
    } else if (!bootstrap.settings?.name?.trim()) {
      app.onboardingStep = 0;
      app.showOnboarding = true;
    } else if (bootstrap.setup_required) {
      app.onboardingStep = Math.max(1, saved ?? 1);
      app.showOnboarding = true;
      if (app.onboardingStep >= 3) await loadAll();
    } else if (saved !== null && saved >= 3) {
      app.onboardingStep = saved;
      app.showOnboarding = true;
      await loadAll();
    } else {
      app.showOnboarding = false;
      clearOnboardingStep();
      await loadAll();
    }
    app.route = ["home", "schedule", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
    render();
    if (app.settings?.integrations?.some((item) => item.provider === "google_calendar" && item.status === "syncing")) startIntegrationPoll("calendar");
  } catch (error) {
    root.innerHTML = errorState("The twin couldn't start", error.message, true);
  }
};

async function createOrResumeOnboardingProfile() {
  const input = document.querySelector("#onboarding-name");
  const name = String(input?.value ?? app.onboardingName).trim();
  if (!name || name.length > 50) {
    app.onboardingError = "Enter a name between 1 and 50 characters.";
    render();
    return;
  }
  app.loading = true;
  app.onboardingError = "";
  app.onboardingName = name;
  render();
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (!app.bootstrap?.profile_exists) await api("/api/profile/initialize", { method: "POST", body: JSON.stringify({ timezone }) });
    app.bootstrap = await api("/api/bootstrap");
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ name, timezone, version: app.bootstrap.settings.version }),
    });
    app.bootstrap = await api("/api/bootstrap");
    app.loading = false;
    onboardingGo(1);
  } catch (error) {
    app.loading = false;
    app.onboardingError = error.payload?.message ?? error.message;
    render();
  }
}
async function importOnboardingProfile() {
  const field = document.querySelector("#onboarding-json");
  app.importText = String(field?.value ?? app.importText);
  if (!app.importText.trim()) return;
  app.loading = true;
  app.importError = null;
  render();
  try {
    app.importResult = await api("/api/imports", { method: "POST", body: app.importText });
    app.bootstrap = await api("/api/bootstrap");
    await loadAll();
    app.onboardingPlan = { busy: false, status: null, idempotencyKey: null };
    app.loading = false;
    onboardingGo(3);
  } catch (error) {
    app.loading = false;
    app.importError = {
      message: error.payload?.message ?? error.message,
      fields: error.payload?.field_errors,
    };
    render();
  }
}
async function connectOpenAIAndBuildDay() {
  const plan = app.onboardingPlan;
  if (plan.busy) return;
  const field = document.querySelector("#onboarding-openai-key");
  const key = String(field?.value ?? "").trim();
  const hasSavedKey = Boolean((app.settings?.openai ?? app.bootstrap?.openai)?.key_masked);
  if (!key && !hasSavedKey) {
    plan.status = {
      kind: "error",
      title: "Enter your API key",
      message: "Use a complete OpenAI API key beginning with sk-.",
    };
    render();
    return;
  }
  plan.busy = true;
  plan.status = {
    kind: "loading",
    title: "Connecting securely",
    message: "Twin is testing the key and preparing the remaining day. Keep this window open.",
  };
  plan.idempotencyKey ??= uuid();
  render();
  try {
    if (key)
      await api("/api/settings/openai-key", {
        method: "PUT",
        body: JSON.stringify({ api_key: key }),
      });
    const tested = await api("/api/settings/openai-key/test", { method: "POST", body: "{}" });
    if (tested.text_capability !== "available") throw new Error("This key does not currently have access to a compatible text model.");
    await loadAll();
    const localDate = app.home?.localDate;
    if (!localDate) throw new Error("Twin could not determine your current local date.");
    const result = await api("/api/twin-days/rebuild", {
      method: "POST",
      headers: { "Idempotency-Key": plan.idempotencyKey },
      body: JSON.stringify({ local_date: localDate }),
    });
    if (!result.day || result.day.local_date !== localDate) throw new Error("Twin did not return a valid schedule for today.");
    await loadAll();
    plan.busy = false;
    plan.idempotencyKey = null;
    plan.status = {
      kind: "success",
      title: "Your day is ready",
      message: "Twin created a simulated schedule from now through the rest of your local day. Earlier elapsed time was left blank.",
    };
    render();
    setTimeout(() => document.querySelector(".tw-plan-status")?.focus?.(), 20);
  } catch (error) {
    plan.busy = false;
    plan.status = {
      kind: "error",
      title: "Your day was not created",
      message: error.payload?.message ?? error.message ?? "Check the key and try again. Any existing schedule is unchanged.",
    };
    await refreshSettings().catch(() => {});
    render();
  }
}
async function finishOnboarding(destination = "home") {
  app.loading = true;
  try {
    await api("/api/onboarding/complete", { method: "POST", body: "{}" });
    clearOnboardingStep();
    app.showOnboarding = false;
    app.onboardingStep = 0;
    app.bootstrap = await api("/api/bootstrap");
    await loadAll();
    app.route = destination;
    location.hash = destination;
    render();
    window.scrollTo(0, 0);
  } finally {
    app.loading = false;
  }
}

document.addEventListener("input", (event) => {
  if (event.target.id === "onboarding-name") {
    app.onboardingName = event.target.value;
    const button = document.querySelector("[data-onboarding-submit-name]");
    if (button) button.disabled = !event.target.value.trim();
  }
  if (event.target.id === "onboarding-json") {
    app.importText = event.target.value;
    const button = document.querySelector("[data-onboarding-import]");
    if (button) button.disabled = !event.target.value.trim();
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.id !== "onboarding-json-file" || !event.target.files?.[0]) return;
  const file = event.target.files[0];
  app.importFileName = file.name;
  app.importResult = null;
  app.importError = null;
  app.importText = (await file.text()).replace(/^\uFEFF/, "");
  render();
  setTimeout(() => document.querySelector("#onboarding-json")?.focus(), 20);
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "onboarding-name-form") return;
  event.preventDefault();
  await createOrResumeOnboardingProfile();
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.matches("[data-onboarding-submit-name]")) {
      await createOrResumeOnboardingProfile();
      return;
    }
    if (target.matches("[data-onboarding-back]")) {
      if (!app.onboardingPlan.busy) onboardingGo(app.onboardingStep - 1);
      return;
    }
    if (target.matches("[data-onboarding-next]")) {
      onboardingGo(app.onboardingStep + 1);
      return;
    }
    if (target.matches("[data-onboarding-copy]")) {
      await navigator.clipboard.writeText(app.onboardingPrompt);
      target.firstChild.textContent = "Copied ";
      toast("Complete prompt copied.");
      return;
    }
    if (target.matches("[data-onboarding-import]")) {
      await importOnboardingProfile();
      return;
    }
    if (target.matches("[data-onboarding-connect-plan]")) {
      await connectOpenAIAndBuildDay();
      return;
    }
    if (target.dataset.onboardingFinish) {
      await finishOnboarding(target.dataset.onboardingFinish);
      return;
    }
    if (target.matches("[data-restart-onboarding]")) {
      app.onboardingStep = 0;
      app.onboardingName = app.settings?.name ?? "";
      storeOnboardingStep(0);
      render();
      return;
    }
    if (target.matches("[data-delete-account]")) clearOnboardingStep();
  } catch (error) {
    toast(error.payload?.message ?? error.message, true);
  }
});

init();
