// Minimal dependency-free static file server for the built Vite SPA.
//
// Canonical `@canvas/web` is a pure client SPA (no app-tier server — auth lives
// in Convex, see docs/contracts/auth-flow.md). In the NAS stack the web service
// only needs to ship the built assets; Caddy terminates TLS in front of it.
// This server: serves files from /app/public, falls back to index.html for SPA
// routes (F11 client router), and answers /healthz for the compose healthcheck.
// Uses only the Node stdlib so the runtime image needs no extra dependencies.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = process.env.WEB_ROOT ?? "/app/public";
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Defence-in-depth security headers (FEN-87). The edge Caddy proxy sets the
// authoritative, origin-aware CSP (incl. the split-origin env extras) and
// OVERWRITES these in the normal request path. This static baseline only matters
// if the web container is ever reached directly (container-to-container, or a
// future direct expose), so it stays self-contained — no env templating. Same
// strict script-src / lenient style-src posture as the edge.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; " +
    "form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https://static-cdn.jtvnw.net; font-src 'self' data:; connect-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

async function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS });
  res.end(body);
}

async function tryFile(path) {
  try {
    const s = await stat(path);
    if (s.isFile()) return await readFile(path);
  } catch {
    /* not a file */
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "ok");

    // Resolve within ROOT; reject path traversal.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) return send(res, 403, "forbidden");

    let body = url.pathname === "/" ? null : await tryFile(filePath);
    // SPA fallback: unknown non-asset routes return index.html.
    if (body === null) {
      filePath = join(ROOT, "index.html");
      body = await tryFile(filePath);
      if (body === null) return send(res, 404, "not found");
    }
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    return send(res, 200, body, type);
  } catch {
    return send(res, 500, "internal error");
  }
});

server.listen(PORT, () => {
  console.log(`[web] serving ${ROOT} on :${PORT}`);
});
