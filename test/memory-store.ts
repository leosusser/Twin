import { seedState } from "../src/storage/store.ts";
import type { AppState } from "../src/domain/types.ts";
// Test double only. The server and worker exclusively construct PostgresStore.
const fixtures=new Map<string,AppState>();
export class MemoryStore {
  key:string;
  constructor(key:string){this.key=key;}
  async init(){if(!fixtures.has(this.key))fixtures.set(this.key,seedState());return this;}
  async snapshot(){return structuredClone(fixtures.get(this.key)!);}
  async transaction<T>(fn:(state:AppState)=>T|Promise<T>){const draft=await this.snapshot();const result=await fn(draft);fixtures.set(this.key,draft);return result;}
}
