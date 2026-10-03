// Entry point for `npm run dashboard`: serves dashboard.html and the
// results/summary.json it reads. Set PORT to change the port.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const summaryFile = join(root, "results", "summary.json");
const port = Number(process.env.PORT) || 4173;

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (path === "/" || path === "/dashboard.html") {
      // Read on every request so edits to the page show up on reload.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(join(root, "dashboard.html")));
    } else if (path === "/api/summary" && existsSync(summaryFile)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(readFileSync(summaryFile));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(err instanceof Error ? err.message : String(err));
  }
});

// Bound to localhost only: the results hold model transcripts.
server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard: http://localhost:${port}/  (reading ${summaryFile}; Ctrl+C to stop)`);
});
