import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Home navigation places Schedule on the left and Settings on the right", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const homeNavs = [
    ...appSource.matchAll(
      /<nav class="bottom-nav home-bottom-nav"[^>]*><button data-route="([^"]+)">[^<]+<\/button><button data-route="([^"]+)">[^<]+<\/button><\/nav>/g,
    ),
  ];

  assert.ok(homeNavs.length > 0, "expected at least one Home navigation definition");
  for (const nav of homeNavs) {
    assert.deepEqual(nav.slice(1), ["schedule", "settings"]);
  }
});

test("local UI assets are revalidated instead of serving stale browser code", () => {
  const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

  assert.match(serverSource, /"cache-control": "no-cache"/);
  assert.doesNotMatch(serverSource, /max-age=/);
});

test("Schedule presents activities without repeated imagined badges", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const sourceHelper = appSource.match(
    /function scheduleSourceBadges\(item\)\s*\{[\s\S]+?\n\}/,
  )?.[0];

  assert.ok(sourceHelper, "expected the active Schedule source helper");
  assert.doesNotMatch(sourceHelper, /Twin imagined/i);
  assert.match(sourceHelper, /Calendar commitment/);
  assert.match(sourceHelper, /Informed by your report/);
  assert.match(appSource, /Illustrative plan · not a record of what happened/);
  assert.match(appSource, /<summary>About this plan<\/summary>/);
});

test("today's rebuild explains catch-up reporting before future replanning", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(appSource, /Describe everything you want shown as actually happened so far/);
  assert.match(appSource, /WHAT ACTUALLY HAPPENED SO FAR/);
  assert.match(appSource, /name="actual_report"/);
  assert.match(appSource, /WHAT SHOULD CHANGE NEXT/);
  assert.match(appSource, /name="future_instruction"/);
  assert.match(appSource, /not saved as activity you did/);
  assert.match(appSource, /clearly labeled AI estimates/);
  assert.match(appSource, />AI estimate</);
  assert.match(appSource, /result\.report/);
});

test("planner validation failures use an actionable rebuild message", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const errorHelper = appSource.match(
    /function scheduleRebuildError\(error\)\s*\{[\s\S]+?\n\}/,
  )?.[0];

  assert.ok(errorHelper, "expected the Schedule rebuild error helper");
  assert.match(errorHelper, /planner\[_ -\]/);
  assert.match(errorHelper, /include approximate times for activities that must not overlap/);
});

test("Avatar Studio keeps one large current avatar above a horizontal version picker", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../public/mockup-pages.css", import.meta.url), "utf8");
  const activeAvatarStudio = appSource.match(
    /characterSection\s*=\s*function\s*\(\)\s*\{[\s\S]+?connectionCard\s*=\s*function/,
  )?.[0];

  assert.ok(activeAvatarStudio, "expected the active Avatar Studio renderer");
  assert.match(appSource, /CURRENT AVATAR/);
  assert.match(appSource, /class="settings-version-strip"/);
  assert.match(appSource, /data-avatar-candidate/);
  assert.match(appSource, />SWITCH<\/button>/);
  assert.match(appSource, />REGENERATE<\/button>/);
  assert.match(appSource, /data-cancel-baseline/);
  assert.match(appSource, />STOP<\/button>/);
  assert.match(appSource, /data-delete-baseline/);
  assert.match(appSource, />DELETE<\/button>/);
  assert.doesNotMatch(activeAvatarStudio, /CREATING/);
  assert.match(activeAvatarStudio, /request\.purpose === "baseline"/);
  assert.doesNotMatch(appSource, /class="settings-candidate"/);
  assert.match(styles, /\.settings-version-strip\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styles, /\.settings-version-thumb\s*\{[^}]*calc\(\(100% - 24px\) \/ 4\)/s);
});

test("onboarding connects OpenAI and builds today before the optional avatar step", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(
    appSource,
    /const screens\s*=\s*\[\s*onboardingNameScreen,\s*onboardingChatGPTScreen,\s*onboardingImportScreen,\s*onboardingOpenAIScreen,\s*onboardingAvatarScreen,?\s*\]/,
  );
  assert.match(appSource, /aria-valuemax="5"/);
  assert.match(appSource, /api\("\/api\/settings\/openai-key"/);
  assert.match(appSource, /api\("\/api\/settings\/openai-key\/test"/);
  assert.match(appSource, /api\("\/api\/twin-days\/rebuild"/);
  assert.match(appSource, /api\("\/api\/onboarding\/complete"/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^)]*(?:api.?key|openai.?key)/i);
});
