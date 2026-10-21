import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { AppState } from "../domain/types.ts";
import { selectTalkContext } from "./context.ts";

export const collections = ["users","settings","imports","observations","facts","memory_overrides","integrations","calendar_events","gmail_cues","twin_days","activity_reports","model_connections","conversations","messages","avatar_designs","avatar_assets","avatar_requests","jobs"] as const;
export function emptyState():AppState {
  return Object.fromEntries([...collections.map(key=>[key,[]]),["idempotency",{}]]) as unknown as AppState;
}
export function databasePool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const pg=createRequire(import.meta.url)("pg");
  const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:5000});
  pool.on("error",()=>console.error("DATABASE_CONNECTION_ERROR"));
  return pool;
}
export function validateState(state:AppState) {
  if (!state || typeof state!=="object" || Object.keys(state).some(k=>![...collections,"idempotency"].includes(k as any))) throw new Error("UNSUPPORTED_STATE_SHAPE");
  const users=new Set(state.users?.map(u=>u.id));
  for(const key of collections){
    if(!Array.isArray(state[key])) throw new Error("INVALID_STATE_COLLECTION");
    const ids=new Set<string>();
    for(const row of state[key] as any[]){
      const id=key==="observations"?null:row.id??row.user_id;
      if(!row||typeof row!=="object"|| (key!=="users"&&!users.has(row.user_id))) throw new Error("INVALID_RECORD_OWNER");
      if(key!=="observations" && (typeof id!=="string"||ids.has(id))) throw new Error("DUPLICATE_OR_MISSING_RECORD_ID");
      if(id)ids.add(id);
    }
  }
  if(!state.idempotency||Array.isArray(state.idempotency)||typeof state.idempotency!=="object")throw new Error("INVALID_IDEMPOTENCY");
}
export async function readState(client:any):Promise<AppState>{
  const state=emptyState();
  for(const key of collections) (state as any)[key]=(await client.query(`SELECT payload FROM twin.${key} ORDER BY position`)).rows.map((r:any)=>r.payload);
  state.idempotency=Object.fromEntries((await client.query("SELECT key,payload FROM twin.idempotency")).rows.map((r:any)=>[r.key,r.payload]));
  return state;
}
function rows(state:AppState,key:typeof collections[number]){
  return new Map((state[key] as any[]).map((payload,position)=>[key==="observations"?String(position):String(payload.id??payload.user_id),{payload,position}]));
}
export async function writeChanges(client:any,before:AppState,after:AppState){
  validateState(after);
  for(const key of collections){
    const previous=rows(before,key),next=rows(after,key);
    for(const id of previous.keys())if(!next.has(id))await client.query(`DELETE FROM twin.${key} WHERE key=$1`,[id]);
    for(const [id,row] of next){
      if(isDeepStrictEqual(previous.get(id),row))continue;
      await client.query(`INSERT INTO twin.${key}(key,user_id,position,payload) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET user_id=EXCLUDED.user_id,position=EXCLUDED.position,payload=EXCLUDED.payload`,
        [id,key==="users"?row.payload.id:row.payload.user_id,row.position,JSON.stringify(row.payload)]);
    }
  }
  for(const key of Object.keys(before.idempotency))if(!(key in after.idempotency))await client.query("DELETE FROM twin.idempotency WHERE key=$1",[key]);
  for(const [key,payload] of Object.entries(after.idempotency))if(!isDeepStrictEqual(payload,before.idempotency[key]))await client.query("INSERT INTO twin.idempotency(key,payload) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload",[key,JSON.stringify(payload)]);
}
export class PostgresStore {
  pool:any;
  constructor(pool=databasePool()){this.pool=pool;}
  async init(){await this.pool.query("SELECT version FROM twin.schema_migrations WHERE version=1");return this;}
  async snapshot():Promise<AppState>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const state=await readState(client);await client.query("COMMIT");return state;}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async transaction<T>(mutation:(draft:AppState)=>T|Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      // Serialize legacy domain mutations across server/worker processes, not in RAM.
      await client.query("SELECT pg_advisory_xact_lock(841731)");
      const before=await readState(client),draft=structuredClone(before);
      const result=await mutation(draft);
      await writeChanges(client,before,draft);
      await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async close(){await this.pool.end();}
  async talkContext(userId:string,conversationId:string,text:string){
    const client=await this.pool.connect(),now=new Date();
    try{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state=emptyState();
      state.facts=(await client.query(`SELECT payload FROM twin.facts
        WHERE user_id=$1 AND payload->>'status'='active'
        ORDER BY ts_rank(to_tsvector('english',payload->>'statement'),plainto_tsquery('english',$2)) DESC,
        payload->>'updated_at' DESC LIMIT 8`,[userId,text])).rows.map((r:any)=>r.payload);
      state.messages=(await client.query(`SELECT payload FROM twin.messages WHERE user_id=$1
        AND payload->>'conversation_id'=$2 ORDER BY payload->>'created_at' DESC LIMIT 6`,[userId,conversationId])).rows.map((r:any)=>r.payload);
      state.activity_reports=(await client.query(`SELECT payload FROM twin.activity_reports WHERE user_id=$1
        AND payload->>'created_at'>=$2 AND payload->>'created_at'<=$3
        ORDER BY payload->>'created_at' DESC LIMIT 5`,[userId,new Date(now.getTime()-7*86400000).toISOString(),now.toISOString()])).rows.map((r:any)=>r.payload);
      state.calendar_events=(await client.query(`SELECT payload FROM twin.calendar_events WHERE user_id=$1
        AND payload->>'deleted'='false' AND
        ((payload->>'all_day'='true' AND payload->>'start_date'>=$2) OR
         (payload->>'all_day'='false' AND payload->>'start_at'>=$3))
        AND COALESCE(payload->>'start_at',payload->>'start_date')<=$4
        ORDER BY COALESCE(payload->>'start_at',payload->>'start_date') LIMIT 8`,
        [userId,now.toISOString().slice(0,10),now.toISOString(),new Date(now.getTime()+7*86400000).toISOString()])).rows.map((r:any)=>r.payload);
      await client.query("COMMIT");
      return selectTalkContext(state,userId,conversationId,text,now);
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
