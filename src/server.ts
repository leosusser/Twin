import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { routeApi } from "./api/router.ts";
import { PostgresStore } from "./storage/store.ts";
import { startWorker } from "./worker.ts";

const root = fileURLToPath(new URL("../public", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
let store:PostgresStore;
try {
  store = await new PostgresStore().init();
  if (!(await store.snapshot()).users.length) throw new Error("DATABASE_EMPTY");
} catch {
  console.error("Twin could not open its database. Install dependencies, configure DATABASE_URL, run db:migrate, then db:import (or db:seed for a new installation).");
  process.exit(1);
}
void startWorker(store);

const server = createServer(async (req, res) => {
  if ((req.url ?? "").startsWith("/api/")) return routeApi(req, res, store);
  if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) { res.writeHead(405); return res.end(); }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(root, safe);
    try { if ((await stat(file)).isDirectory()) file = join(file, "index.html"); } catch { file = join(root, "index.html"); }
    if (!file.startsWith(root)) throw new Error("invalid path");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime(extname(file)), "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); }
});

server.listen(port, "127.0.0.1", () => console.log(`Personal Twin ready at http://localhost:${port}`));

function mime(extension: string) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
