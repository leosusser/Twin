import { readFile } from "node:fs/promises";
import { databasePool } from "./postgres.ts";
export async function migrate(pool:any){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(841731)");
    const exists=await client.query("SELECT to_regclass('twin.schema_migrations') AS name");
    if(!exists.rows[0].name)await client.query(await readFile(new URL("../../db/migrations/001_records.sql",import.meta.url),"utf8"));
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
if(process.argv[1]?.endsWith("/migrate.ts")){
  let pool:any;
  try{pool=databasePool();await migrate(pool);console.log("Database migrations applied.");}
  catch{console.error("Database migration failed. Check PostgreSQL availability and DATABASE_URL.");process.exitCode=1;}
  finally{await pool?.end();}
}
