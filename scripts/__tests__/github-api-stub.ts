import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A local stand-in for the two GitHub endpoints the verifier calls.
//
// POST /markdown answers from renderings GitHub actually produced, recorded in
// fixtures/github-renders.json. The verifier's whole premise is that it judges
// the body GitHub displays, so a test that fed it hand-written HTML would test
// the author's idea of GitHub instead. A body with no recording fails the test
// loudly (the verifier cannot render, so it exits 1 and names the stub's reason).
//
// Re-record after adding or changing a test body:
//
//   RECORD_GITHUB_RENDERS=1 GITHUB_RENDER_TOKEN="$(gh auth token)" bun test
//
// Recording sends each test body to api.github.com/markdown. The endpoint needs
// no token permission; the token only lifts the rate limit from 60 an hour.

const FIXTURE = `${import.meta.dir}/fixtures/github-renders.json`;
const RECORD = process.env.RECORD_GITHUB_RENDERS === "1";

interface Rendering {
  context: string;
  text: string;
  html: string;
}

let renders: Record<string, Rendering> | undefined;

function recorded(): Record<string, Rendering> {
  renders ??= existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};
  return renders!;
}

function renderKey(text: string, context: string): string {
  return createHash("sha256").update(JSON.stringify([context, text])).digest("hex");
}

async function record(text: string, context: string, key: string): Promise<Response> {
  const token = process.env.GITHUB_RENDER_TOKEN;
  if (!token) {
    return new Response("RECORD_GITHUB_RENDERS=1 needs GITHUB_RENDER_TOKEN", { status: 501 });
  }
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ text, mode: "gfm", ...(context ? { context } : {}) }),
  });
  const html = await res.text();
  if (!res.ok) {
    return new Response(`recording failed: HTTP ${res.status} ${html}`, { status: 502 });
  }
  const all = recorded();
  all[key] = { context, text, html };
  mkdirSync(dirname(FIXTURE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + "\n");
  return new Response(html, { headers: { "content-type": "text/html" } });
}

async function renderMarkdown(req: Request): Promise<Response> {
  const { text = "", mode, context = "" } = (await req.json()) as {
    text?: string;
    mode?: string;
    context?: string;
  };
  if (mode !== "gfm") {
    return new Response(`this stub only renders mode "gfm", got "${mode}"`, { status: 400 });
  }
  const key = renderKey(text, context);
  const hit = recorded()[key];
  if (hit) return new Response(hit.html, { headers: { "content-type": "text/html" } });
  if (RECORD) return record(text, context, key);
  return new Response(
    `no recorded GitHub rendering for this body (${key.slice(0, 12)}); ` +
      'record it with RECORD_GITHUB_RENDERS=1 GITHUB_RENDER_TOKEN="$(gh auth token)" bun test',
    { status: 501 }
  );
}

export type RouteHandler = (req: Request, url: URL) => Response | Promise<Response>;

/**
 * Starts a stub API on 127.0.0.1. POST /markdown is always served from the
 * recordings; every other request goes to `handler`, or is a 404.
 */
export function startApiStub(handler?: RouteHandler): ReturnType<typeof Bun.serve> {
  // 127.0.0.1, not the default wildcard: a test has no business listening on
  // every interface of a shared runner.
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/markdown") return renderMarkdown(req);
      if (handler) return handler(req, url);
      return new Response("not found", { status: 404 });
    },
  });
}

/** A handler that answers every run lookup with the same run. */
export function runResponse(conclusion: string, headSha: string): RouteHandler {
  return () =>
    new Response(JSON.stringify({ conclusion, head_sha: headSha }), {
      headers: { "content-type": "application/json" },
    });
}

export const stubUrl = (server: ReturnType<typeof Bun.serve>) =>
  `http://127.0.0.1:${server.port}`;
