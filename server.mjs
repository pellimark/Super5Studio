import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResultsService } from "./results-service.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function createAppServer({ root = projectRoot, resultsService: providedResultsService } = {}) {
  const resultsService = providedResultsService || createResultsService({
    archivePath: path.join(root, "data", "super5-draws.json"),
    checkStatePath: path.join(root, "data", "results-check.json"),
    logPath: path.join(root, "data", "results-update.log")
  });
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    if (pathname === "/api/results") {
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      try {
        const snapshot = await resultsService.getSnapshot();
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(JSON.stringify(snapshot));
      } catch (error) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(JSON.stringify({ error: error.message || "Results are temporarily unavailable." }));
      }
      return;
    }

    let requestedPath;
    try {
      requestedPath = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(error && error.code === "ENOENT" ? 404 : 500);
      response.end(error && error.code === "ENOENT" ? "Not found" : "Could not read file");
    }
  });
}

const isDirectRun = typeof process !== "undefined" && process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, "0.0.0.0", () => {
    process.stdout.write("Super5 Studio is ready at http://localhost:" + port + "\n");
  });
}
