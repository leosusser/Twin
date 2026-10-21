import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { routeApi } from "../src/api/router.ts";
import { MemoryStore } from "./memory-store.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";

class MockResponse {
  status=0; headers:Record<string,string>={}; body="";
  writeHead(status:number,headers:Record<string,string>={}){this.status=status;this.headers=headers;return this;}
  end(value?:string|Buffer){if(value)this.body+=value.toString();return this;}
}
function request(method:string,url:string,body="",headers:Record<string,string>={}){const stream=Readable.from(body?[Buffer.from(body)]:[] as Buffer[]) as any;stream.method=method;stream.url=url;stream.headers=headers;return stream;}
async function call(store:MemoryStore,method:string,url:string,body="",headers:Record<string,string>={}){const response=new MockResponse();await routeApi(request(method,url,body,headers),response as any,store);return{status:response.status,payload:response.body?JSON.parse(response.body):null};}

test("settings, schedule and chat/check-in routes retain their contracts",async()=>{
  const store=await new MemoryStore("feature-contracts").init();
  const settings=await call(store,"GET","/api/settings");
  assert.equal(settings.status,200);
  const changed=await call(store,"PATCH","/api/settings",JSON.stringify({version:settings.payload.version,wake_time:"08:00"}));
  assert.equal(changed.payload.wake_time,"08:00");
  assert.equal((await call(store,"GET","/api/home")).status,200);
  assert.equal((await call(store,"GET","/api/twin-days")).status,200);
  const conversation=await call(store,"POST","/api/talk/conversations");
  assert.equal(conversation.status,201);
  const previousKey=process.env.TWIN_ENCRYPTION_KEY,previousFetch=globalThis.fetch;
  try{
    process.env.TWIN_ENCRYPTION_KEY="test-only-encryption-key-not-a-real-secret";
    await store.transaction(d=>{d.model_connections[0].encrypted_key=encryptSecret("test-provider-key");});
    let supplied:any;
    globalThis.fetch=async(_url,options)=>{supplied=JSON.parse(String(options?.body));return new Response(JSON.stringify({output_text:"Thanks for sharing."}),{status:200,headers:{"content-type":"application/json"}});};
    const sent=await call(store,"POST",`/api/talk/conversations/${conversation.payload.id}/messages`,JSON.stringify({message:"I actually studied for an hour."}),{"idempotency-key":"chat-test"});
    assert.equal(sent.status,201);assert.equal(sent.payload.reportStatus,"saved_as_actual_activity");
    assert.ok(supplied.input.includes("recent_check_ins"));assert.ok(supplied.input.includes("upcoming_events"));
    const history=await call(store,"GET",`/api/talk/conversations/${conversation.payload.id}/messages`);
    assert.equal(history.payload.length,2);
    assert.equal((await call(store,"GET","/api/settings")).payload.openai.encrypted_key,undefined);
  }finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.TWIN_ENCRYPTION_KEY;else process.env.TWIN_ENCRYPTION_KEY=previousKey;}
});

test("API import applies memory atomically and duplicate retry reuses the result",async()=>{
  const path=`./data/router-test-${process.pid}.json`;const store=await new MemoryStore(path).init();
  try{
    const handoff={schema_version:1,source:"chatgpt_voice_onboarding",session_id:"api-session",created_at:"2026-10-18T20:00:00Z",timezone:"America/New_York",observations:[{id:"walk",kind:"wellbeing_cue",statement:"Walking after lunch helps me reset.",source_excerpt:"Walking helps.",confidence:"user_stated"},{id:"focus",kind:"energy_cue",statement:"A break may help afternoon focus.",source_excerpt:"Maybe a break helps.",confidence:"inferred"}]};
    const before=await call(store,"GET","/api/bootstrap");assert.equal(before.payload.setup_required,true);
    const first=await call(store,"POST","/api/imports",JSON.stringify(handoff));assert.equal(first.status,201);assert.equal(first.payload.applied_counts.active,1);assert.equal(first.payload.applied_counts.tentative,1);
    const after=await call(store,"GET","/api/bootstrap");assert.equal(after.payload.setup_required,false);
    const duplicate=await call(store,"POST","/api/imports",JSON.stringify(handoff));assert.equal(duplicate.status,200);assert.equal(duplicate.payload.id,first.payload.id);assert.equal(duplicate.payload.duplicate,true);
    const facts=await call(store,"GET","/api/profile/facts");assert.equal(facts.payload.filter((item:any)=>item.source_type==="chatgpt_voice_onboarding").length,2);
  }finally{await unlink(path).catch(()=>{});}
});

test("API rejects malformed JSON without adding memory",async()=>{
  const path=`./data/router-invalid-${process.pid}.json`;const store=await new MemoryStore(path).init();
  try{const before=(await store.snapshot()).facts.length;const result=await call(store,"POST","/api/imports",'{"schema_version":1');assert.equal(result.status,400);assert.equal(result.payload.code,"INVALID_JSON");assert.equal((await store.snapshot()).facts.length,before);}finally{await unlink(path).catch(()=>{});}
});

test("private avatar photo and cached activity images survive reload without regenerating",async()=>{
  const path=`./data/router-avatar-${process.pid}.json`;const store=await new MemoryStore(path).init();const files:string[]=[];
  try{
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=";
    const uploaded=await call(store,"POST","/api/character/photo",JSON.stringify({filename:"me.png",data_url:`data:image/png;base64,${png}`}));
    assert.equal(uploaded.status,201);assert.equal(uploaded.payload.asset.kind,"source_photo");assert.equal(uploaded.payload.asset.storage_key,undefined);assert.match(uploaded.payload.asset.assetUrl,/^\/api\/assets\//);
    const now=new Date().toISOString();const baselineId=randomUUID();const studyId=randomUUID();const runId=randomUUID();const baselinePath=`./data/assets/${baselineId}.png`;const studyPath=`./data/assets/${studyId}.png`;const runPath=`./data/assets/${runId}.png`;files.push(baselinePath,studyPath,runPath);await mkdir(dirname(baselinePath),{recursive:true});for(const file of files)await writeFile(file,Buffer.from(png,"base64"));
    await store.transaction((draft)=>{const design=draft.avatar_designs.find((item)=>item.user_id==="user_demo"&&item.is_active)!;design.baseline_asset_id=baselineId;draft.avatar_assets.push({id:baselineId,user_id:"user_demo",design_version:design.version,parent_asset_ids:[design.source_photo_asset_id!],kind:"base",prompt_version:2,model:"test",storage_key:baselinePath,mime:"image/png",status:"ready",selected_at:now,approved_at:now,created_at:now},{id:studyId,user_id:"user_demo",design_version:design.version,parent_asset_ids:[baselineId],kind:"activity",activity_key:"studying",prompt_version:2,model:"test",storage_key:studyPath,mime:"image/png",status:"ready",selected_at:now,created_at:now},{id:runId,user_id:"user_demo",design_version:design.version,parent_asset_ids:[baselineId],kind:"activity",activity_key:"running",prompt_version:2,model:"test",storage_key:runPath,mime:"image/png",status:"ready",selected_at:now,created_at:now});});
    const studyFirst=await call(store,"POST","/api/character/scenes/ensure",JSON.stringify({activity_key:"studying"}));assert.equal(studyFirst.status,200);assert.equal(studyFirst.payload.cache_hit,true);
    const running=await call(store,"POST","/api/character/scenes/ensure",JSON.stringify({activity_key:"running"}));assert.equal(running.status,200);assert.equal(running.payload.asset.id,runId);
    const studyAgain=await call(store,"POST","/api/character/scenes/ensure",JSON.stringify({activity_key:"studying"}));assert.equal(studyAgain.payload.asset.id,studyId);assert.equal((await store.snapshot()).jobs.filter((job)=>job.type==="avatar_generation").length,0);
    const character=await call(store,"GET","/api/character");assert.equal(character.payload.baseline.id,baselineId);assert.equal(character.payload.assets.find((asset:any)=>asset.id===studyId).storage_key,undefined);
    const reloaded=await new MemoryStore(path).init();assert.equal((await reloaded.snapshot()).avatar_assets.some((asset)=>asset.id===studyId),true);assert.equal((await reloaded.snapshot()).avatar_assets.some((asset)=>asset.id===runId),true);
  }finally{for(const file of files)await unlink(file).catch(()=>{});const snapshot=(await store.snapshot());for(const asset of snapshot.avatar_assets)if(asset.kind==="source_photo"&&asset.storage_key)await unlink(asset.storage_key).catch(()=>{});await unlink(path).catch(()=>{});}
});
