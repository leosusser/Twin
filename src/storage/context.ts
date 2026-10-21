import type { AppState } from "../domain/types.ts";
// Bounded, user-scoped retrieval. The SQL-backed store remains authoritative.
export function selectTalkContext(state:AppState,userId:string,conversationId:string,text:string,now=new Date()){
  const words=new Set(text.toLowerCase().match(/[a-z]{3,}/g)??[]);
  const score=(statement:string)=>[...new Set(statement.toLowerCase().match(/[a-z]{3,}/g)??[])].filter(word=>words.has(word)).length;
  const cutoff=new Date(now.getTime()-7*86400000).toISOString(),end=new Date(now.getTime()+7*86400000).toISOString();
  return {
    memory:state.facts.filter(f=>f.user_id===userId&&f.status==="active").sort((a,b)=>score(b.statement)-score(a.statement)||b.updated_at.localeCompare(a.updated_at)).slice(0,8).map(f=>f.statement.slice(0,600)),
    recent:state.messages.filter(m=>m.user_id===userId&&m.conversation_id===conversationId).sort((a,b)=>a.created_at.localeCompare(b.created_at)).slice(-6),
    checkIns:state.activity_reports.filter(r=>r.user_id===userId&&r.created_at>=cutoff&&r.created_at<=now.toISOString()).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,5).map(r=>({date:r.local_date,statement:r.statement.slice(0,600)})),
    events:state.calendar_events.filter(e=>e.user_id===userId&&!e.deleted&&(e.start_at??e.start_date??"")>=now.toISOString().slice(0,e.all_day?10:24)&&(e.start_at??e.start_date??"")<=end).sort((a,b)=>(a.start_at??a.start_date??"").localeCompare(b.start_at??b.start_date??"")).slice(0,8).map(e=>({title:e.title.slice(0,300),start:e.start_at??e.start_date,end:e.end_at??e.end_date,all_day:e.all_day}))
  };
}
