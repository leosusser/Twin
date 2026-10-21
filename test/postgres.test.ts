import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { migrate } from "../src/storage/migrate.ts";
import { importLegacy } from "../src/storage/import-json.ts";
import { PostgresStore, seedState } from "../src/storage/store.ts";
import { databasePool } from "../src/storage/postgres.ts";
// Must be a dedicated EMPTY test database: never points at DATABASE_URL implicitly.
test("PostgreSQL imports exactly, survives reconnect, rolls back and serializes writes",{skip:!process.env.TEST_DATABASE_URL},async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  const pool=databasePool();let dir:string|undefined;
  try{
    const exists=await pool.query("SELECT to_regnamespace('twin') AS name");
    assert.equal(exists.rows[0].name,null,"TEST_DATABASE_URL must point to an empty dedicated database");
    await migrate(pool);await migrate(pool);
    dir=await mkdtemp("./data/pg-test-");
    const path=`${dir}/legacy.json`,state=seedState(),original=JSON.stringify(state);
    await writeFile(path,original,{mode:0o600});
    assert.deepEqual(await importLegacy(pool,path),{alreadyImported:false,verified:true});
    assert.equal(await readFile(path,"utf8"),original);
    assert.deepEqual(await importLegacy(pool,path),{alreadyImported:true});
    const first=await new PostgresStore(pool).init(),second=await new PostgresStore(pool).init();
    assert.deepEqual(await first.snapshot(),state);
    await assert.rejects(first.transaction(draft=>{draft.settings[0].name="discard";throw new Error("rollback");}));
    assert.deepEqual(await second.snapshot(),state);
    await Promise.all([first.transaction(d=>{d.settings[0].version++}),second.transaction(d=>{d.settings[0].version++})]);
    assert.equal((await first.snapshot()).settings[0].version,state.settings[0].version+2);
    await pool.end();
    const fresh=await new PostgresStore(databasePool()).init();
    try{assert.equal((await fresh.snapshot()).settings[0].version,state.settings[0].version+2);}finally{await fresh.close();}
    await unlink(path);await rmdir(dir);dir=undefined;
  }finally{if(!pool.ended)await pool.end();}
});
