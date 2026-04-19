#!/usr/bin/env bun
/**
 * Validates the ## Proof block in a PR body.
 *
 * Usage:
 *   cat pr-body.md | bun verify-proof-block.ts
 *   bun verify-proof-block.ts --body-file pr-body.md
 *
 * Required env vars (when validating CI run URLs):
 *   GITHUB_TOKEN          - GitHub token with repo read access
 *   PR_HEAD_SHA           - SHA of the PR head commit
 *   PR_HEAD_REPO_FULL_NAME - e.g. "florianhorner/govee2mqtt"
 *   PR_BASE_REPO_FULL_NAME - e.g. "some-upstream/govee2mqtt"
 *   OWNED_REPOS            - comma-separated list of repos Florian owns
 */

import { remark } from "remark";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { readFileSync } from "fs";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProofLine {
  key: string;
  checked: boolean;
  value: string; // everything after "key: "
  raw: string;
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const PR_HEAD_SHA = process.env.PR_HEAD_SHA ?? "";
const PR_HEAD_REPO = process.env.PR_HEAD_REPO_FULL_NAME ?? "";
const PR_BASE_REPO = process.env.PR_BASE_REPO_FULL_NAME ?? "";
const OWNED_REPOS = (process.env.OWNED_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// CI run URL pattern: https://github.com/{owner}/{repo}/actions/runs/{id}
const CI_RUN_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/;

const PROOF_KEY_RE = /^[a-zA-Z_][\w:]*$/;

// ---------------------------------------------------------------------------
// Step 1: read body
// ---------------------------------------------------------------------------

function readBody(): string {
  const args = process.argv.slice(2);
  const bodyFileIdx = args.indexOf("--body-file");
  if (bodyFileIdx !== -1) {
    const path = args[bodyFileIdx + 1];
    if (!path) {
      console.error("--body-file requires a path argument");
      process.exit(1);
    }
    return readFileSync(path, "utf8");
  }
  // stdin
  return readFileSync("/dev/stdin", "utf8");
}

// ---------------------------------------------------------------------------
// Step 2: strip HTML comments and code fences, then find ## Proof section
// ---------------------------------------------------------------------------

/**
 * Returns the raw markdown content of the ## Proof section, anchored
 * to end-of-body. The section starts at the last `## Proof` heading that
 * is NOT inside an HTML comment or code fence.
 */
function extractProofSection(body: string): string | null {
  // Strip HTML comments to prevent fake ## Proof inside <!-- -->
  const noComments = body.replace(/<!--[\s\S]*?-->/g, "");

  // Strip code fences (``` or ~~~)
  const noFences = noComments.replace(/`{3,}[\s\S]*?`{3,}/g, "").replace(/~{3,}[\s\S]*?~{3,}/g, "");

  // Find the last ## Proof heading (case-sensitive, per spec)
  const lines = noFences.split("\n");
  let proofStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^##\s+Proof\s*$/.test(lines[i].trim())) {
      proofStart = i;
      break;
    }
  }
  if (proofStart === -1) return null;

  // The proof section is everything from proofStart to end-of-body in the
  // ORIGINAL body (we need original text for URL validation etc.)
  // Re-locate in original body by finding the same ## Proof occurrence.
  const originalLines = body.split("\n");
  // We need to find the corresponding line in original body.
  // Strategy: walk original body lines counting ## Proof occurrences that
  // are NOT inside comments or code fences, and take the last one.
  let inComment = false;
  let inFence = false;
  let lastProofLine = -1;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];

    // Track HTML comments (multiline)
    const openComments = (line.match(/<!--/g) ?? []).length;
    const closeComments = (line.match(/-->/g) ?? []).length;
    if (inComment) {
      if (closeComments > 0) inComment = false;
      continue;
    }
    if (openComments > closeComments) {
      inComment = true;
      continue;
    }

    // Track code fences
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^##\s+Proof\s*$/.test(line.trim())) {
      lastProofLine = i;
    }
  }

  if (lastProofLine === -1) return null;
  return originalLines.slice(lastProofLine).join("\n");
}

// ---------------------------------------------------------------------------
// Step 3: parse proof lines
// ---------------------------------------------------------------------------

function parseProofLines(section: string): ProofLine[] {
  const lines = section.split("\n");
  const result: ProofLine[] = [];

  for (const line of lines) {
    // Match: - [x] key: value  OR  - [ ] key: value
    const m = line.match(/^-\s+\[([ xX])\]\s+(\S+?):\s+(.*)$/);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const key = m[2];
    const value = m[3].trim();
    result.push({ key, checked, value, raw: line });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 4: validate each proof line
// ---------------------------------------------------------------------------

async function validateProofLine(
  line: ProofLine,
  isUpstream: boolean,
  errors: string[]
): Promise<void> {
  const { key, checked, value } = line;

  if (!checked) {
    // Unchecked: must be n/a — <reason> (reason non-empty)
    if (/^n\/a\s*—\s*.+/.test(value)) {
      // runtime: n/a is forbidden for upstream PRs
      if (key === "runtime" && isUpstream) {
        errors.push(
          `[${key}] runtime: n/a is not allowed for cross-owner PRs. Provide a real runtime artifact.`
        );
      }
      return; // valid n/a
    }
    // Also accept checked=false with a real artifact (author chose not to check it):
    // treat same as checked for validation purposes if it has content
    if (value && value !== "n/a") {
      // unchecked but has a value — warn but don't fail (author may still be filling it)
      return;
    }
    errors.push(
      `[${key}] Unchecked box must have a value like "n/a — <reason>" or a real artifact. Got: "${value}"`
    );
    return;
  }

  // Checked: must have a real artifact
  if (!value) {
    errors.push(`[${key}] Checked box has no artifact value.`);
    return;
  }

  // n/a on a checked box is contradictory
  if (/^n\/a/.test(value)) {
    errors.push(`[${key}] Checked box cannot have n/a value.`);
    return;
  }

  // CI run URL?
  const ciMatch = value.match(CI_RUN_RE);
  if (ciMatch) {
    await validateCIRun(key, ciMatch[1], ciMatch[2], ciMatch[3], errors);
    return;
  }

  // Test name? /^[a-zA-Z_][\w:]*$/
  if (PROOF_KEY_RE.test(value)) {
    return; // valid test name
  }

  // File path? Must exist on disk within repo
  if (value.startsWith(".") || value.startsWith("/") || value.includes("/")) {
    if (!existsSync(value)) {
      // Soft: don't fail on file paths in CI (path relative to repo root may differ)
      // Only fail if GITHUB_WORKSPACE is set (we're in CI)
      if (process.env.GITHUB_WORKSPACE) {
        const fullPath = `${process.env.GITHUB_WORKSPACE}/${value}`;
        if (!existsSync(fullPath)) {
          errors.push(`[${key}] File path does not exist: ${value}`);
        }
      }
    }
    return;
  }

  // URL (http/https)?
  if (/^https?:\/\//.test(value)) {
    return; // non-CI URL: accept (gist, screenshot, release asset, etc.)
  }

  // Anything else: accept (test name list, comma-separated, etc.)
}

async function validateCIRun(
  key: string,
  owner: string,
  repo: string,
  runId: string,
  errors: string[]
): Promise<void> {
  if (!GITHUB_TOKEN) {
    // No token: skip URL validation (local usage)
    return;
  }
  if (!PR_HEAD_SHA) {
    return; // No SHA context: skip
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!res.ok) {
      errors.push(
        `[${key}] CI run URL returned HTTP ${res.status}: ${owner}/${repo}/runs/${runId}`
      );
      return;
    }

    const data = (await res.json()) as {
      conclusion: string | null;
      head_sha: string;
    };

    if (data.conclusion !== "success") {
      errors.push(
        `[${key}] CI run ${runId} conclusion is "${data.conclusion}", expected "success".`
      );
    }

    if (data.head_sha !== PR_HEAD_SHA) {
      errors.push(
        `[${key}] CI run ${runId} head_sha "${data.head_sha}" does not match PR head "${PR_HEAD_SHA}". Run is stale.`
      );
    }
  } catch (err) {
    errors.push(`[${key}] Failed to fetch CI run: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Step 5: validate [proof: key] inline tokens
// ---------------------------------------------------------------------------

function validateInlineTokens(
  body: string,
  proofLines: ProofLine[],
  errors: string[]
): void {
  const proofKeys = new Set(proofLines.map((l) => l.key));
  const tokenRe = /\[proof:\s*([^\]]+)\]/g;

  // Find all [proof: key] tokens in the body (skip inside code fences / comments)
  const strippedBody = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`{3,}[\s\S]*?`{3,}/g, "")
    .replace(/`[^`]+`/g, ""); // inline code too

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(strippedBody)) !== null) {
    const ref = m[1].trim();
    if (!proofKeys.has(ref)) {
      errors.push(
        `Dangling [proof: ${ref}] token — no proof line with key "${ref}" found.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const body = readBody();
  const errors: string[] = [];

  // 1. Find proof section
  const proofSection = extractProofSection(body);
  if (!proofSection) {
    console.error(
      "ERROR: PR body does not contain a ## Proof section anchored to end-of-body."
    );
    console.error(
      'Every PR must end with a ## Proof block. See https://github.com/florianhorner/gh-workflows for the template.'
    );
    process.exit(1);
  }

  // 2. Parse proof lines
  const proofLines = parseProofLines(proofSection);
  if (proofLines.length === 0) {
    errors.push(
      "## Proof section found but contains no checkbox lines. Add at least one proof entry."
    );
  }

  // 3. Determine if upstream
  const isUpstream =
    OWNED_REPOS.length > 0 &&
    PR_HEAD_REPO !== "" &&
    !OWNED_REPOS.includes(PR_HEAD_REPO);

  if (isUpstream) {
    console.log(
      `ℹ Cross-owner PR detected (head: ${PR_HEAD_REPO}, owned: ${OWNED_REPOS.join(", ")}). Strict mode active.`
    );
  }

  // 4. Validate each proof line
  await Promise.all(
    proofLines.map((line) => validateProofLine(line, isUpstream, errors))
  );

  // 5. Validate inline [proof: key] tokens
  validateInlineTokens(body, proofLines, errors);

  // 6. Report
  if (errors.length > 0) {
    console.error(`\nProof block validation FAILED (${errors.length} error(s)):\n`);
    for (const e of errors) {
      console.error(`  • ${e}`);
    }
    process.exit(1);
  }

  console.log(
    `✓ Proof block valid. ${proofLines.length} proof line(s) checked.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
