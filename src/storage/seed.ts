import { PostgresStore, seedState } from "./store.ts";
import { collections } from "./postgres.ts";
const store=new PostgresStore();
try{
  await store.init();
  await store.transaction(draft=>{
    if(collections.some(key=>draft[key].length)||Object.keys(draft.idempotency).length)throw new Error("NOT_EMPTY");
    Object.assign(draft,seedState());
  });
  console.log("New local demo initialized.");
}catch{console.error("Initialization failed or database is not empty. Import existing data instead if applicable.");process.exitCode=1;}
finally{await store.close();}
