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
 *   PR_BASE_REF            - the PR's base branch, e.g. "main". Without it the
 *                            clean-integrate witness cannot anchor a merge and
 *                            refuses, so an integrated branch reads as stale.
 *   GITHUB_WORKSPACE       - a full clone of the PR head; the witness runs git
 *                            here. Also the "we are in CI" signal that makes a
 *                            missing file-path artifact a hard failure.
 *
 * Optional:
 *   GITHUB_API_URL         - API base, default https://api.github.com. Exists so
 *                            the test suite can point at a local stub; see the
 *                            note at its definition for why it is not GHES
 *                            support.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, sep } from "path";
import {
  cleanIntegrateWitness,
  makeGitRunner,
  type WitnessResult,
} from "./clean-integrate-witness";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProofLine {
  key: string;
  checked: boolean;
  value: string; // everything after "key: "
  raw: string;
}

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const PR_HEAD_SHA = process.env.PR_HEAD_SHA ?? "";
const PR_BASE_REF = process.env.PR_BASE_REF ?? "";
const PR_HEAD_REPO = process.env.PR_HEAD_REPO_FULL_NAME ?? "";
const PR_BASE_REPO = process.env.PR_BASE_REPO_FULL_NAME ?? "";
// Honouring GITHUB_API_URL lets the test suite point the verifier at a local
// stub and exercise the CI-run path end to end instead of only its parts.
//
// It is NOT GHES support, and an earlier version of this comment wrongly implied
// it was. classifyArtifactUrl below only accepts `github.com` as a CI-run host, so
// a GHES run URL never reaches validateCIRun at all: it is reported as a wrong-host
// CI-run claim rather than validated.
// Supporting GHES means teaching URL recognition the configured host and mapping
// its API URL to its web URL, which nothing here exercises — so the claim is
// dropped rather than the limitation hidden.
const GITHUB_API_URL = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const OWNED_REPOS = (process.env.OWNED_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PROOF_KEY_RE = /^[a-zA-Z_][\w:]*$/;

// Path shape of a run page: /{owner}/{repo}/actions/runs/{id}
const CI_RUN_PATH_RE = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/|$)/;

type ArtifactUrl =
  | { kind: "ci-run"; owner: string; repo: string; runId: string }
  | { kind: "ci-run-wrong-host"; host: string }
  | { kind: "insecure" }
  | { kind: "url" }
  | { kind: "not-url" };

/**
 * Classifies an artifact value as a URL, canonicalising the host FIRST.
 *
 * This replaces a single anchored regex over the raw string
 * (`/^https:\/\/github\.com\/...\/actions\/runs\/(\d+)/`): host-exact,
 * case-sensitive, https-only. Every near-miss — `GitHub.com`, `http://`,
 * `www.github.com` — missed it and then landed in the generic-URL accept
 * sitting directly behind it, which returns unconditionally. One capital letter
 * therefore skipped the `conclusion === "success"` and head_sha checks that are
 * the only reason this script exists, while the PR body still rendered a live
 * link to the same run page. Hosts are case-insensitive in DNS; the three
 * spellings are the same page.
 *
 * So: any URL whose PATH looks like an Actions run is treated as a CI-run claim
 * and must validate. It is never allowed to fall through to the generic accept.
 * A run-shaped path on some other host is an error, not a generic artifact —
 * `github.com.example.test/o/r/actions/runs/1` is not a run page.
 */
function classifyArtifactUrl(value: string): ArtifactUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { kind: "not-url" };
  }
  // A bare test name parses as a URL: `TestThing::sub_case` has protocol
  // "testthing:". Only http(s) is a URL for our purposes.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { kind: "not-url" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const runMatch = parsed.pathname.match(CI_RUN_PATH_RE);

  if (runMatch) {
    if (host !== "github.com") return { kind: "ci-run-wrong-host", host };
    if (parsed.protocol !== "https:") return { kind: "insecure" };
    return {
      kind: "ci-run",
      owner: runMatch[1]!,
      repo: runMatch[2]!,
      runId: runMatch[3]!,
    };
  }

  if (parsed.protocol !== "https:") return { kind: "insecure" };
  return { kind: "url" };
}

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
 * Blanks HTML comments and fenced code blocks, keeping the line count intact.
 *
 * One stripper for all three call sites. There used to be three, and they
 * disagreed:
 *
 *  - extractProofSection ran a paired-fence regex to FIND the heading, then a
 *    separate line-state machine to RE-LOCATE it in the original body;
 *  - validateInlineTokens ran a third variant that handled ``` but not ~~~,
 *    so a proof token inside a `~~~` block was reported as dangling on a body
 *    that is perfectly valid markdown.
 *
 * The state machine also latched on a line that merely STARTS with an inline
 * triple-backtick span (`` ```bun test``` passes now ``): it set inFence and
 * never found a closer, so a `## Proof` heading further down became invisible
 * and the validator denied a section it could plainly see. An opener that
 * closes on its own line is inline code, not a fence.
 */
function blankMarkdownNoise(body: string): string {
  const out: string[] = [];
  let inComment = false;
  let fence: string | null = null;

  for (const raw of body.split("\n")) {
    // CRLF bodies: see parseProofLines.
    const line = raw.replace(/\r+$/, "");
    const trimmed = line.trim();

    if (inComment) {
      out.push("");
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }

    if (fence !== null) {
      out.push("");
      // Closer: same character, at least as long, alone on the line.
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) {
        fence = null;
      }
      continue;
    }

    const opener = trimmed.match(/^(`{3,}|~{3,})/);
    if (opener) {
      const marker = opener[1]!;
      if (new RegExp(`${marker[0]}{${marker.length},}`).test(trimmed.slice(marker.length))) {
        // Inline span, not a fence opener.
        out.push(line.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, ""));
      } else {
        fence = marker;
        out.push("");
      }
      continue;
    }

    if (trimmed.includes("<!--") && !trimmed.includes("-->")) {
      inComment = true;
      out.push("");
      continue;
    }

    out.push(line.replace(/<!--.*?-->/g, ""));
  }

  return out.join("\n");
}

/**
 * Returns the markdown content of the ## Proof section, anchored to
 * end-of-body, with comments and fenced blocks blanked out. The section starts
 * at the last `## Proof` heading that is NOT inside an HTML comment or code
 * fence.
 *
 * The returned text is the BLANKED text, not the original. The old version
 * returned the original slice "because we need original text for URL
 * validation etc." — but nothing in the section needs it, and returning it
 * meant a checkbox line inside a fence *within* the section was parsed as a
 * real proof claim. A `- [x] runtime: FakeArtifact` inside a block labelled
 * "Template:" counted as satisfied runtime evidence.
 */
function extractProofSection(body: string): string | null {
  const lines = blankMarkdownNoise(body).split("\n");

  let lastProofLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Proof\s*$/.test(lines[i]!.trim())) lastProofLine = i;
  }
  if (lastProofLine === -1) return null;

  return lines.slice(lastProofLine).join("\n");
}

// ---------------------------------------------------------------------------
// Step 3: parse proof lines
// ---------------------------------------------------------------------------

function parseProofLines(section: string): ProofLine[] {
  const lines = section.split("\n");
  const result: ProofLine[] = [];

  for (const raw of lines) {
    // Strip a trailing CR before matching. GitHub stores browser-authored and
    // browser-edited PR bodies with CRLF endings, and in JS `.` excludes \r
    // while `$` here is not multiline-anchored — so on a CRLF body the value
    // capture could never reach end-of-string and EVERY proof line was
    // dropped. The heading survived (it is matched against line.trim()), so
    // the failure reported "no checkbox lines" plus a dangling token for each
    // real claim: three errors, none of them the cause. The caller's
    // `types: [edited]` re-runs the gate the moment someone fixes a typo in
    // the description, which is exactly when this fired.
    const line = raw.replace(/\r+$/, "");
    // Match: - [x] key: value  OR  - [ ] key: value
    const m = line.match(/^-\s+\[([ xX])\]\s+(\S+?):\s+(.*)$/);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const key = m[2];
    const value = stripTrailingProofTag(m[3].trim());
    result.push({ key, checked, value, raw: line });
  }
  return result;
}

/**
 * Strip a trailing `[proof: <KEY>]` self-reference tag from the artifact value.
 *
 * The PR template uses inline `[proof: <KEY>]` tokens both (a) in prose to
 * reference a proof line ("fixes the freeze [proof: runtime]") AND (b) as a
 * self-reference at the end of each proof line itself, e.g.
 *
 *   - [x] runtime: proof/bootstrap.txt [proof: runtime]
 *
 * Without stripping, the captured value becomes
 * `proof/bootstrap.txt [proof: runtime]` — `existsSync` then fails because
 * no file is literally named that. The same trap fires for non-CI URL
 * artifacts when GITHUB_WORKSPACE is set: the value contains `/` so it
 * routes through the file-path branch before the URL branch, and existsSync
 * rejects the dirty string.
 *
 * Tag format mirrors the [proof: KEY] inline-token regex elsewhere in this
 * file: case-sensitive `proof:`, allow whitespace around the key.
 * Inline-token validation (validateInlineTokens) still scans the original
 * body text, so the self-reference tags are still counted there — stripping
 * here only affects artifact validation.
 */
function stripTrailingProofTag(value: string): string {
  return value.replace(/\s*\[proof:\s*[^\]]+\]\s*$/, "").trim();
}

/**
 * Strip a trailing " — <description>" annotation from a real artifact value.
 *
 * Authors frequently annotate an artifact with a human description after an
 * em-dash (or en-dash), e.g.
 *
 *   - [x] runtime: proof/expand-light-groups-desc.txt — parity check confirms X [proof: runtime]
 *
 * After stripTrailingProofTag removes the `[proof: KEY]` suffix the value is
 * `proof/expand-light-groups-desc.txt — parity check confirms X`, which still
 * contains `/` and gets misrouted into the file-path branch, where
 * existsSync() fails on the whole dirty string even though the file exists.
 *
 * Take only the text before the first em-dash / en-dash separator (surrounded
 * by whitespace) as the artifact to validate; the description is informational.
 *
 * This runs ONLY on the checked-artifact path. The unchecked `n/a — <reason>`
 * form is validated separately on the full value, so its em-dash is untouched.
 * A spaced ASCII hyphen is deliberately NOT a separator (file paths contain
 * hyphens, e.g. `proof/expand-light-groups-desc.txt`); only `—`/`–` split.
 */
function stripArtifactDescription(value: string): string {
  return value.split(/\s+[—–]\s+/)[0]!.trim();
}

// ---------------------------------------------------------------------------
// Step 4: validate each proof line
// ---------------------------------------------------------------------------

/** An `n/a` value, however its reason is (or is not) attached. */
const NA_PREFIX_RE = /^n\/a\b/i;

/**
 * Parses an `n/a` value into its reason.
 *
 * Returns the reason, `""` for an `n/a` with no reason at all (`n/a`, `n/a —`),
 * or `null` when the value is an `n/a` whose reason is not attached in a form
 * we recognise.
 *
 * A spaced ASCII hyphen counts as a separator here even though
 * stripArtifactDescription deliberately excludes it. The two are not the same
 * question: an `n/a` reason is prose, while a real artifact may be a file path
 * full of hyphens. Requiring an em-dash left the rule one keystroke from
 * unenforced — `n/a - no device` was silently accepted on a cross-owner PR.
 */
function parseNotApplicable(value: string): string | null {
  const m = value.match(/^n\/a(?:\s*[\u2014\u2013-]\s*(.*))?$/i);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function looksLikeFilePath(artifact: string): boolean {
  return (
    artifact.startsWith(".") || artifact.startsWith("/") || artifact.includes("/")
  );
}

/**
 * Validates a file-path artifact and confines it to the PR checkout.
 *
 * Two defects this replaces, both of which let a path that is nowhere in the PR
 * pass as "committed to the PR branch":
 *
 *  - `existsSync(artifact)` was tried BARE first, i.e. against the process cwd.
 *    Under the reusable workflow that cwd is the nested gh-workflows checkout
 *    (`working-directory: _gh_workflows/scripts`), so
 *    `__tests__/verify-proof-block.test.ts` or `node_modules/<anything>`
 *    satisfied the check. The `${GITHUB_WORKSPACE}/${value}` fallback was
 *    correct — it just never ran, because the wrong tree answered first.
 *  - There was no containment check at all, despite the comment claiming
 *    "must exist on disk within repo". `/etc/passwd` and `../../../../etc/hosts`
 *    both passed.
 *
 * Resolution is now only ever against GITHUB_WORKSPACE, which the workflow
 * points at the PR head checkout.
 */
function validateFilePath(key: string, artifact: string, errors: string[]): void {
  const workspace = process.env.GITHUB_WORKSPACE;

  if (!workspace) {
    // Local usage: no checkout root to resolve against, so existence is
    // unknowable and stays soft, as before. An escape is still an escape
    // though, and saying so needs no filesystem.
    if (artifact.startsWith("/") || artifact.split("/").includes("..")) {
      errors.push(
        `[${key}] File-path artifact must be repository-relative, got: ${artifact}`
      );
    }
    return;
  }

  const root = resolve(workspace);
  const full = resolve(root, artifact);
  if (full !== root && !full.startsWith(root + sep)) {
    errors.push(`[${key}] File path escapes the repository checkout: ${artifact}`);
    return;
  }
  if (!existsSync(full)) {
    errors.push(`[${key}] File path does not exist: ${artifact}`);
  }
}

/**
 * Validates one artifact value — the part of a proof line that is supposed to
 * BE the evidence. Shared by the checked and the unchecked path so the two
 * cannot drift apart.
 */
async function validateArtifact(
  key: string,
  value: string,
  errors: string[]
): Promise<void> {
  // Strip an optional " — <description>" annotation so only the artifact
  // itself is validated (e.g. "proof/foo.txt — what it proves" → "proof/foo.txt").
  const artifact = stripArtifactDescription(value);

  const url = classifyArtifactUrl(artifact);
  switch (url.kind) {
    case "ci-run":
      await validateCIRun(key, url.owner, url.repo, url.runId, errors);
      return;
    case "ci-run-wrong-host":
      errors.push(
        `[${key}] CI run URL must be on github.com, got host "${url.host}": ${artifact}`
      );
      return;
    case "insecure":
      errors.push(`[${key}] Artifact URL must use https, not http: ${artifact}`);
      return;
    case "url":
      return; // non-CI URL: accept (gist, screenshot, release asset, etc.)
    case "not-url":
      break;
  }

  // Test name? /^[a-zA-Z_][\w:]*$/
  if (PROOF_KEY_RE.test(artifact)) {
    return; // valid test name
  }

  if (looksLikeFilePath(artifact)) {
    validateFilePath(key, artifact, errors);
    return;
  }

  // Anything else: accept (test name list, comma-separated, etc.)
}

async function validateProofLine(
  line: ProofLine,
  isUpstream: boolean,
  errors: string[]
): Promise<void> {
  const { key, checked, value } = line;

  if (!checked) {
    if (NA_PREFIX_RE.test(value)) {
      const reason = parseNotApplicable(value);
      if (!reason) {
        errors.push(
          `[${key}] Unchecked "n/a" needs a reason in the form "n/a — <reason>". Got: "${value}"`
        );
        return;
      }
      // runtime: n/a is forbidden for upstream PRs
      if (key === "runtime" && isUpstream) {
        errors.push(
          `[${key}] runtime: n/a is not allowed for cross-owner PRs. Provide a real runtime artifact.`
        );
      }
      return; // valid n/a
    }

    if (!value) {
      errors.push(
        `[${key}] Unchecked box must have a value like "n/a — <reason>" or a real artifact. Got: "${value}"`
      );
      return;
    }

    // Unchecked but carrying a real artifact: validate it exactly as a checked
    // one. This used to be an unconditional `return` guarded only by
    // `value !== "n/a"` — a silent accept that skipped every check, and the
    // hole that `n/a —` with an empty reason fell into once the
    // [proof: KEY] strip shortened the value to something the n/a classifier
    // no longer recognised. The classifier and the fallthrough disagreed, and
    // the strip moved the boundary between them.
    await validateArtifact(key, value, errors);
    return;
  }

  // Checked: must have a real artifact
  if (!value) {
    errors.push(`[${key}] Checked box has no artifact value.`);
    return;
  }

  // n/a on a checked box is contradictory
  if (NA_PREFIX_RE.test(value)) {
    errors.push(`[${key}] Checked box cannot have n/a value.`);
    return;
  }

  await validateArtifact(key, value, errors);
}

/**
 * Asks the clean-integrate witness, but only once the environment has been
 * proved to be the one the question is about.
 *
 * Two preconditions, both fail-closed, both cheap:
 *
 *  - the checkout must actually BE the PR head. The witness runs git in
 *    GITHUB_WORKSPACE; if that is unset the runner falls back to the process
 *    cwd, which under the reusable workflow is the nested gh-workflows
 *    checkout — a different repository that would answer about the wrong
 *    history. Comparing HEAD to PR_HEAD_SHA is the one check that cannot be
 *    satisfied by the wrong repo.
 * An absent PR_BASE_REF is refused by the witness itself, which owns that
 * message; stating it here too gave one refusal three different sentences.
 *
 * A failed precondition is never an error of its own: it just leaves the
 * original strict "Run is stale" verdict standing, which is the behaviour this
 * change started from.
 */
function witnessCleanIntegrate(runHeadSha: string): WitnessResult {
  const git = makeGitRunner(process.env.GITHUB_WORKSPACE);

  const checkoutHead = git(["rev-parse", "HEAD"]);
  if (!checkoutHead.ok || checkoutHead.stdout !== PR_HEAD_SHA) {
    return {
      accepted: false,
      reason: "unresolvable",
      detail: "the checkout is not the PR head, so git cannot be asked about it",
    };
  }

  return cleanIntegrateWitness(git, {
    runHead: runHeadSha,
    prHead: PR_HEAD_SHA,
    baseRef: PR_BASE_REF,
  });
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
      `${GITHUB_API_URL}/repos/${owner}/${repo}/actions/runs/${runId}`,
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
      // Not the same commit. Before calling it stale, ask whether it is the
      // same *content*: a branch that integrated its base and changed nothing
      // else is the case branch protection forces on every PR that is not the
      // next one to land. See scripts/clean-integrate-witness.ts.
      const witness = witnessCleanIntegrate(data.head_sha);
      if (!witness.accepted) {
        const detail = witness.detail ? ` — ${witness.detail}` : "";
        errors.push(
          `[${key}] CI run ${runId} head_sha "${data.head_sha}" does not match PR head "${PR_HEAD_SHA}". Run is stale (${witness.reason})${detail}.`
        );
      } else {
        console.log(
          `ℹ [${key}] CI run ${runId} ran on ${data.head_sha}, which this head integrates from ${PR_BASE_REF} without changing content — accepted.`
        );
      }
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

  // Find all [proof: key] tokens in the body (skip inside code fences /
  // comments). Uses the same stripper as extractProofSection so the two can
  // never disagree about what counts as a fence; inline single-backtick code
  // is stripped only here, because a proof line's value may legitimately be
  // wrapped in backticks and must survive parseProofLines.
  const strippedBody = blankMarkdownNoise(body).replace(/`[^`]+`/g, "");

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
