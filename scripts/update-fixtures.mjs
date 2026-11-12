#!/usr/bin/env node
// Isolated release-feed fixture server for update *discovery* development.
//
// The fork's real release endpoint/trust inputs are ticket #39/#40 decisions; until then
// a development build must be able to exercise the checker without touching a live feed.
// This binds 127.0.0.1 only and serves `src/modules/updater/fixtures`:
//
//   pnpm dev:update-fixtures
//   VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT=http://127.0.0.1:8787/stable.json pnpm dev
//
// Routes can also simulate the bounded failure states:
//   /rate-limited  -> 429 with Retry-After
//   /offline       -> connection reset for every attempt
//   /malformed     -> 200 with a body that is not JSON
// No route ever serves a package: discovery must not download one.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const FIXTURES = join(import.meta.dirname, "..", "src/modules/updater/fixtures");

/** Fixture file per route; only manifests, never a package artifact. */
const ROUTES = {
  "/stable.json": "stable.json",
  "/stable-current.json": "stable-current.json",
  "/stable-bad-signature.json": "stable-bad-signature.json",
  "/stable-prerelease.json": "stable-prerelease.json",
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;

  if (path === "/rate-limited") {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
    response.end(JSON.stringify({ error: "fixture rate limit" }));
    return;
  }
  if (path === "/offline") {
    request.socket.destroy();
    return;
  }
  if (path === "/malformed") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{ this is not json");
    return;
  }

  const file = ROUTES[path];
  if (!file) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "no fixture at this route" }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(readFileSync(join(FIXTURES, file), "utf8"));
});

server.listen(PORT, HOST, () => {
  console.log(`update fixtures on http://${HOST}:${PORT}/stable.json (127.0.0.1 only)`);
});
