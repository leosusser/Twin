import test from "node:test";
import assert from "node:assert/strict";
import { seedState } from "../src/storage/store.ts";
import { selectTalkContext } from "../src/storage/context.ts";
test("chat context is relevant, bounded, excludes suppressed memories and other users",()=>{
  const state=seedState(),now=new Date();
  state.facts=Array.from({length:50},(_,i)=>({...state.facts[0],id:`f${i}`,statement:i===40?"Running helps me reset":"An unrelated preference",updated_at:now.toISOString()}));
  state.facts.push({...state.facts[0],id:"suppressed",status:"suppressed",statement:"Running secret"});
  state.facts.push({...state.facts[0],id:"foreign",user_id:"other",statement:"Running private"});
  state.messages.push({...state.messages[0],id:"foreign",user_id:"other",content:"Private"});
  const context=selectTalkContext(state,"user_demo","conversation_demo","I am running",now);
  assert.equal(context.memory.length,8);assert.equal(context.memory[0],"Running helps me reset");
  assert.ok(!JSON.stringify(context).includes("secret"));assert.ok(!JSON.stringify(context).includes("private"));
  assert.ok(context.recent.length<=6);assert.ok(context.checkIns.length<=5);assert.ok(context.events.length<=8);
});
