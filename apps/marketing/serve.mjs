// Static file server + a thin same-origin proxy onto @optiwork/api's demo
// endpoints, for the Anchor landing page.
//
// The proxy exists for the same reason apps/web/lib/api.ts is server-only:
// the API's demo bearer principal must never reach the browser (see that
// file's own comment). apps/marketing has no framework server the way
// apps/web does, so this gives it one, purely to keep that boundary intact
// while letting the pixel-art portal render real demo data same-origin (no
// CORS, no token in client JS).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  stepList,
  resetRun,
  runStep,
  runAction,
  currentRun,
  agreementAccess,
  submissionAccess,
} from "./workflow.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON object required.");
  return parsed;
}

const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4175);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_BASE_URL = process.env.OPTIWORK_API_BASE_URL ?? "http://127.0.0.1:4000";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

// Same demo-only principal apps/web/lib/api.ts builds. It is an identity
// assertion, not a credential — the demo profile's verifier isn't even
// constructed, so it grants nothing outside this local, offline profile.
const DEMO_OPERATOR = Buffer.from(JSON.stringify({
  subject: "USER-PLATFORM-ADMIN",
  organizationId: "ORG-OPTIWORK-ADMIN",
  roles: ["platform_admin", "audit_service", "compliance_service"],
  displayName: "Platform administrator"
}), "utf8").toString("base64url");

async function proxyToApi(req, res, path, init = {}) {
  try {
    const upstream = await fetch(new URL(path, API_BASE_URL), {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${DEMO_OPERATOR}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers
      }
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(body);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { message: `The Anchor API is not reachable at ${API_BASE_URL}. Start it with "pnpm --filter @optiwork/api dev".` }
    }));
  }
}

function safeDownloadName(value, fallback) {
  const cleaned = String(value ?? fallback).replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);
  return cleaned || fallback;
}

async function streamPrivateObject(access, res, fallbackName) {
  const signedUrl = access?.url ?? access?.access?.url;
  if (typeof signedUrl !== "string") throw new Error("The storage service returned no download URL.");
  const upstream = await fetch(new URL(signedUrl, API_BASE_URL));
  if (!upstream.ok) throw new Error(`Private object download failed (HTTP ${upstream.status}).`);
  const contentType = access?.contentType ?? upstream.headers.get("content-type") ?? "application/octet-stream";
  const fileName = safeDownloadName(access?.fileName, fallbackName);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  const requestPath = new URL(req.url, `http://${HOST}`).pathname;

  if (requestPath === "/api/state" && req.method === "GET") {
    await proxyToApi(req, res, "/v1/demo/state");
    return;
  }
  if (requestPath === "/api/run" && req.method === "POST") {
    await proxyToApi(req, res, "/v1/demo/walkthrough", {
      method: "POST",
      headers: { "idempotency-key": "optiwork-demo-walkthrough-0001" },
      body: JSON.stringify({})
    });
    return;
  }

  // Step-by-step workflow driver (see workflow.mjs).
  if (requestPath === "/api/workflow/steps" && req.method === "GET") {
    sendJson(res, 200, { steps: stepList(), run: currentRun() });
    return;
  }
  if (requestPath === "/api/workspace/state" && req.method === "GET") {
    sendJson(res, 200, { steps: stepList(), run: currentRun() });
    return;
  }
  if (requestPath === "/api/workflow/reset" && req.method === "POST") {
    if (req.headers["x-anchor-role"] !== "COMPANY") {
      sendJson(res, 403, { ok: false, error: "Only the Company portal can start a new shared deal." });
      return;
    }
    sendJson(res, 200, resetRun());
    return;
  }
  const stepMatch = /^\/api\/workflow\/step\/(\d+)$/.exec(requestPath);
  if (stepMatch && req.method === "POST") {
    try {
      const result = await runStep(Number(stepMatch[1]), await readJson(req));
      sendJson(res, result.ok ? 200 : 422, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message ?? error) });
    }
    return;
  }
  const actionMatch = /^\/api\/workflow\/action\/([a-z-]+)$/.exec(requestPath);
  if (actionMatch && req.method === "POST") {
    try {
      const result = await runAction(actionMatch[1], await readJson(req));
      sendJson(res, result.ok ? 200 : 422, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message ?? error) });
    }
    return;
  }
  if (requestPath === "/api/workflow/agreement/download" && req.method === "GET") {
    try {
      const role = new URL(req.url, `http://${HOST}`).searchParams.get("role") === "freelancer" ? "freelancer" : "company";
      await streamPrivateObject(await agreementAccess(role), res, "anchor-agreement.txt");
    } catch (error) {
      sendJson(res, 403, { error: { message: String(error.message ?? error) } });
    }
    return;
  }
  if (requestPath === "/api/workflow/submission/download" && req.method === "GET") {
    try {
      await streamPrivateObject(await submissionAccess(), res, "anchor-deliverable.bin");
    } catch (error) {
      sendJson(res, 403, { error: { message: String(error.message ?? error) } });
    }
    return;
  }

  const safePath = normalize(requestPath === "/" ? "/index.html" : requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Anchor product experience listening on http://${HOST}:${PORT}\n`);
});
