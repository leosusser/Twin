import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { routeApi } from "./api/router.ts";
import { loadPrototypeCalendarConfig } from "./config/prototype-calendar.ts";
import { importSharedPrototypeCalendarForAllUsers } from "./services/prototype-calendar.ts";
import { PostgresStore } from "./storage/store.ts";
import { startWorker } from "./worker.ts";

const root = fileURLToPath(new URL("../public", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
let store: PostgresStore;
try {
  store = await new PostgresStore().init();
} catch {
  console.error(
    "Twin could not open its database. Install dependencies, configure DATABASE_URL, and run db:migrate.",
  );
  process.exit(1);
}
const prototypeCalendarConfig = await loadPrototypeCalendarConfig();
if (prototypeCalendarConfig) {
  try {
    const results = await importSharedPrototypeCalendarForAllUsers(
      store,
      prototypeCalendarConfig.sourceUrl,
    );
    console.log(`Shared prototype Calendar checked for ${results.length} user profile(s).`);
  } catch {
    console.error("PROTOTYPE_CALENDAR_STARTUP_IMPORT_FAILED");
  }
}
void startWorker(store);

const server = createServer(async (req, res) => {
  if ((req.url ?? "").startsWith("/api/"))
    return routeApi(req, res, store, {
      prototypeCalendarSourceUrl: prototypeCalendarConfig?.sourceUrl,
    });
  if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
    res.writeHead(405);
    return res.end();
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(root, safe);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(root, "index.html");
    }
    if (!file.startsWith(root)) throw new Error("invalid path");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": mime(extname(file)),
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () =>
  console.log(`Personal Twin ready at http://localhost:${port}`),
);

function mime(extension: string) {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
