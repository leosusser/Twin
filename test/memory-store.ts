import { seedState } from "../src/storage/store.ts";
import type { AppState } from "../src/domain/types.ts";
// Test double only. The server and worker exclusively construct PostgresStore.
const fixtures = new Map<string, AppState>();
const transactionTails = new Map<string, Promise<void>>();
export class MemoryStore {
  key: string;
  constructor(key: string) {
    this.key = key;
  }
  async init() {
    if (!fixtures.has(this.key)) fixtures.set(this.key, seedState());
    return this;
  }
  async snapshot() {
    return structuredClone(fixtures.get(this.key)!);
  }
  async transaction<T>(fn: (state: AppState) => T | Promise<T>) {
    const prior = transactionTails.get(this.key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    transactionTails.set(this.key, tail);
    await prior;
    try {
      const draft = await this.snapshot();
      const result = await fn(draft);
      fixtures.set(this.key, draft);
      return result;
    } finally {
      release();
      if (transactionTails.get(this.key) === tail) transactionTails.delete(this.key);
    }
  }
}
