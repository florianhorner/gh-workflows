#!/usr/bin/env bun
/**
 * Validates the ## Proof block in a PR body, as GitHub renders it.
 *
 * Usage:
 *   cat pr-body.md | bun verify-proof-block.ts
 *   bun verify-proof-block.ts --body-file pr-body.md
 *
 * Every run sends the body to GitHub's Markdown API (POST /markdown) and
 * validates the returned HTML. Private-resource rendering needs contents: read;
 * some labels also need issues: read or pull-requests: read. Public-resource
 * rendering can run without GITHUB_TOKEN (60 requests/hour).
 *
 * Env vars for full validation of CI-run and file-path artifacts:
 *   GITHUB_TOKEN          - GitHub token with actions: read for run lookups and
 *                           contents: read for private-resource rendering
 *   PR_HEAD_SHA           - SHA of the PR head commit
 *   PR_HEAD_REPO_FULL_NAME - e.g. "florianhorner/govee2mqtt"
 *   PR_BASE_REPO_FULL_NAME - e.g. "some-upstream/govee2mqtt"; the rendering
 *                            context (how `#123` references link) and the
 *                            repository a cited run must have run in. Falls
 *                            back to PR_HEAD_REPO_FULL_NAME
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

import { readFileSync, existsSync, realpathSync, statSync } from "fs";
import { resolve, sep } from "path";
import { parseFragment } from "parse5";
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
  value: string; // the rendered text after "key: "
  raw: string;
  links: string[]; // hrefs of the links on the line
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
//
// The id group is deliberately NOT `\d+`. Requiring digits here meant anything
// else — `runs/123.`, `runs/%31` — simply failed to match, fell through to the
// generic-URL accept and skipped validation. Capture whatever is in the slot and
// judge it separately, so an id we cannot read is an ERROR rather than a pass.
const CI_RUN_PATH_RE = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([^/]*)/;

// Check-run pages: /{owner}/{repo}/runs/{job id} and /{owner}/{repo}/commit/{sha}/checks.
// They show a job's result, but nothing here can look one up (that needs the
// checks API and a permission callers do not grant), so citing one is an error
// rather than a generic link.
const CHECK_PAGE_PATH_RE = /^\/[^/]+\/[^/]+\/(?:runs\/[^/]+|commit\/[^/]+\/checks)/;

// Trailing punctuation GFM's autolink extension excludes from a bare link, so
// `…/runs/123.` at the end of a sentence renders as a link to run 123.
const AUTOLINK_TRAILING = /[?!.,:;*_~)\]]+$/;

type ArtifactUrl =
  | { kind: "ci-run"; owner: string; repo: string; runId: string }
  | { kind: "ci-run-wrong-host"; host: string }
  | { kind: "ci-run-bad-id"; id: string }
  | { kind: "ci-run-insecure" }
  | { kind: "check-page" }
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

  // Decode and collapse before matching. `%2F`, `%61ctions` and `//owner/...`
  // all route to the same page on github.com, so a matcher that reads the raw
  // pathname sees a non-run URL where the reader sees a run link.
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escape: leave it encoded rather than guessing.
  }
  path = path.replace(/\/{2,}/g, "/");

  const runMatch = path.match(CI_RUN_PATH_RE);

  // An empty id slot is `…/actions/runs/`, the runs index. That is not a run
  // claim at all, so it stays a generic URL rather than becoming an error.
  if (runMatch && runMatch[3] !== "") {
    // A non-default port is a different origin than the one the API is asked
    // about, so it is not this run page.
    if (host !== "github.com" || parsed.port !== "") {
      return { kind: "ci-run-wrong-host", host: parsed.host.toLowerCase() };
    }
    if (parsed.protocol !== "https:") return { kind: "ci-run-insecure" };
    const id = runMatch[3]!.replace(AUTOLINK_TRAILING, "");
    if (!/^\d+$/.test(id)) return { kind: "ci-run-bad-id", id: runMatch[3]! };
    // owner/repo come out of the DECODED path and are interpolated into the API
    // URL, so `demo%23` decodes to `demo#` and truncates the request to
    // /repos/{owner}/{repo} — the validator would then judge the repository
    // object as if it were a run. GitHub names cannot contain these characters,
    // so refuse rather than encode: an encoded name is a 404 round trip for a
    // repo that cannot exist.
    const owner = runMatch[1]!;
    const repo = runMatch[2]!;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      return { kind: "ci-run-bad-id", id: `${owner}/${repo}` };
    }
    return { kind: "ci-run", owner, repo, runId: id };
  }

  if (host === "github.com" && CHECK_PAGE_PATH_RE.test(path)) return { kind: "check-page" };
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
// Step 2: have GitHub render the body, then read the rendered HTML
// ---------------------------------------------------------------------------

/**
 * The gate validates the document a reviewer sees, so it asks GitHub for it.
 *
 * Three earlier versions of this file emulated GitHub instead: a line scanner,
 * then a patched line scanner, then remark + rehype-raw. Each one hid text in
 * places GitHub shows it — a raw `<code>` or `<plaintext>` line, a `<!x`
 * declaration, a footnote, an `<xmp>` block — because GitHub renders with
 * cmark-gfm 0.29 and then sanitizes, while the emulation followed CommonMark
 * 0.31 and browser HTML rules. Every disagreement was a way to show reviewers a
 * checked box the gate never validated.
 *
 * `POST /markdown` in gfm mode is the renderer behind a PR's `body_html`
 * (identical output, checked on this repo's PR #15). Private-resource rendering
 * needs contents: read; labels may also need issues: read or pull-requests:
 * read. Public resources can be rendered without a token at 60 requests an
 * hour. Every run makes this call, so it is retried; a body that cannot be
 * rendered is a failure, never a pass.
 */
class RenderError extends Error {}

const RENDER_ATTEMPTS = 3;
// A hung request would otherwise leave the check pending until the job's own
// timeout; each attempt gets this long.
const RENDER_TIMEOUT_MS = 20_000;

async function renderBody(body: string): Promise<string> {
  // The context repo only affects how `#123` and `@user` references link.
  const context = PR_BASE_REPO || PR_HEAD_REPO;
  const payload = JSON.stringify({ text: body, mode: "gfm", ...(context ? { context } : {}) });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  let failure = "";
  for (let attempt = 1; attempt <= RENDER_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GITHUB_API_URL}/markdown`, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      });
      if (res.ok) return await res.text();
      failure = `HTTP ${res.status}: ${(await res.text()).trim().slice(0, 200)}`;
      // Only a server error or a throttle can change on retry.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      failure = String(err);
    }
    if (attempt < RENDER_ATTEMPTS) await Bun.sleep(500 * attempt);
  }
  throw new RenderError(
    `could not render the PR body through GitHub's Markdown API (${failure}). ` +
    "The gate validates the body as GitHub displays it and cannot run without that rendering."
  );
}

// The parse5 default tree, reduced to the fields read here.
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode; // <template>
  parentNode?: HtmlNode | null;
}

function childrenOf(node: HtmlNode): HtmlNode[] {
  // A <template>'s children live in `content`. GitHub's sanitizer strips the
  // element today; walking into it anyway means a future sanitizer change
  // cannot hide a checkbox from the gate.
  return [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])];
}

/**
 * Descendants in document order, iteratively: a PR body can nest 30,000 levels
 * deep, and a recursive walk turns that into a stack overflow instead of a
 * verdict. `prune` skips a node together with everything under it.
 */
function* descendants(node: HtmlNode, prune: (n: HtmlNode) => boolean = () => false): Generator<HtmlNode> {
  const stack = [...childrenOf(node)].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (prune(n)) continue;
    yield n;
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Text as a reader takes it in: compatibility forms folded (fullwidth `［` is
 * `[`) and invisible format characters dropped (a soft hyphen or zero-width
 * space inside "Proof" or "[proof:" changes the string, not what anyone sees).
 * Used to recognise headings and claim tokens, never to read artifact values.
 */
const readable = (text: string) =>
  text.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");

// Letters from other scripts that are drawn like the ones in "proof". NFKC does
// not fold these; the table is short because only five letters matter.
const PROOF_LOOKALIKES: Record<string, string> = {
  "\u0440": "p", "\u03C1": "p", // Cyrillic er, Greek rho
  "\u0433": "r", // Cyrillic ghe
  "\u043E": "o", "\u03BF": "o", "\u0585": "o", // Cyrillic o, Greek omicron, Armenian oh
  "\u0192": "f", // Latin f with hook
};

/**
 * Whether a heading reads as "Proof" to a reader: letters only, invisible
 * characters dropped, case folded, lookalike letters mapped. `Proof:`,
 * `Proof ✅`, `PROOF` and a Cyrillic `Ргооf` all do. Decides where the section
 * starts and which headings must be visible; the first one still has to be
 * exactly `## Proof`.
 */
function readsAsProof(text: string): boolean {
  const letters = [...readable(text).toLowerCase()]
    .map((c) => PROOF_LOOKALIKES[c] ?? c)
    .join("")
    .replace(/[^\p{L}]/gu, "");
  return letters === "proof";
}

/**
 * Elements that separate text. Without a break at their edges the text of two
 * paragraphs joins, and `[proof:` at the end of one could pair with `key]` at
 * the start of the next.
 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl",
  "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "td", "th", "tr", "ul",
]);

/**
 * A `<code>` or `<pre>` element is a code example when it holds only inline
 * content. That is what backtick spans, fenced blocks and indented blocks
 * render to, and a `[proof: key]` inside one is the syntax being shown, not a
 * claim. A raw `<code>` wrapped around Markdown blocks renders those blocks —
 * paragraphs, lists, checkboxes — in a monospace font; that is prose a reviewer
 * reads, so its tokens are claims like any other.
 */
function isCodeExample(node: HtmlNode): boolean {
  if (node.tagName !== "code" && node.tagName !== "pre") return false;
  for (const n of descendants(node)) {
    if (n.tagName !== undefined && n.tagName !== "br" && BLOCK_TAGS.has(n.tagName)) return false;
  }
  return true;
}

/**
 * The text of one proof line: its list item, without the lists nested under it
 * (each nested checkbox is a proof line of its own). Links are collected so a
 * run cited as `[CI run](…/actions/runs/1)` is looked up by its target, which is
 * where the rendered link sends the reader.
 */
function lineOf(item: HtmlNode): { text: string; core: string; anchors: HtmlNode[]; foreign: string[] } {
  const text: string[] = [];
  const core: string[] = [];
  const anchors: HtmlNode[] = [];
  const foreign = new Set<string>();
  const outside = new Set<HtmlNode>();
  for (const n of descendants(item, (n) => n.tagName === "ul" || n.tagName === "ol")) {
    const beyond = n.parentNode !== undefined && n.parentNode !== null && outside.has(n.parentNode);
    if (n.tagName !== undefined && (beyond || !allowedInLine(n))) {
      outside.add(n);
      if (!beyond) foreign.add(n.tagName);
    }
    if (n.nodeName === "#text") {
      text.push(n.value ?? "");
      if (!(n.parentNode && outside.has(n.parentNode))) core.push(n.value ?? "");
    }
    if (n.tagName === "a" && attr(n, "href")) anchors.push(n);
  }
  return { text: collapse(text.join("")), core: collapse(core.join("")), anchors, foreign: [...foreign] };
}

/**
 * What a proof line may contain: text, links, code and emphasis, as Markdown
 * writes them. Everything else GitHub's sanitizer keeps can hide, shrink,
 * strike through or overlay text — `<rp>` fallback text and a collapsed
 * `<details>` are hidden, `~~…~~` reads as "not this", eight nested `<sup>`/
 * `<sub>` draw a URL two pixels tall — and each of those let the gate read a
 * value, an `n/a` or a URL the reviewer does not see as the claim. Listing what
 * is allowed, instead of what is not, is the only version of this that does not
 * need a new entry for every trick.
 */
// `tt` is how GitHub renders an auto-linked commit SHA.
const LINE_TAGS = new Set(["p", "input", "a", "code", "tt", "strong", "em", "b", "i", "br", "g-emoji"]);

function allowedInLine(node: HtmlNode): boolean {
  if (LINE_TAGS.has(node.tagName!)) return true;
  // A footnote reference renders as <sup><a data-footnote-ref>n</a></sup>.
  if (node.tagName === "sup") {
    const kids = childrenOf(node).filter((c) => c.nodeName !== "#text" || (c.value ?? "").trim());
    return kids.length === 1 && kids[0]!.tagName === "a" && attr(kids[0]!, "data-footnote-ref") !== undefined;
  }
  return false;
}

/**
 * Invisible or direction-changing characters on a proof line: zero-width
 * joiners and spaces, bidi controls that display a run link before an `n/a` the
 * gate reads first, a joiner inside a URL's host. Emoji sequences use joiners
 * and variation selectors legitimately and are exempt.
 */
function hasInvisible(text: string): boolean {
  const withoutEmoji = text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, "");
  return /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(withoutEmoji);
}

function closestItem(node: HtmlNode): HtmlNode | null {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.tagName === "li") return n;
  }
  return null;
}

const PROOF_LINE_RE = /^(\S+?):\s+(.*)$/;
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * The only elements a Proof heading may sit in. Everything else GitHub's
 * sanitizer keeps can hide it (`<details>`, `<rp>`, `<template>`), shrink it
 * (nested `<sup>`, `<sub>`, `<small>`, `<rt>`) or strike it through, and a
 * heading the reviewer cannot see could stand in for a visible lookalike.
 * Like the proof-line rule, this lists what is allowed: GitHub renders a
 * Markdown heading at the top level, in a list item, a quote or an alert.
 */
const VISIBLE_CONTAINERS = new Set([
  "blockquote", "code", "dd", "div", "dl", "dt", "li", "ol", "pre", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  // GitHub's wrapper around every rendered table.
  "markdown-accessiblity-table",
  // Visible formatting. HTML reopens an unclosed <b>, <a>, … around every later
  // block, so a tag mentioned in the prose without backticks ends up wrapping
  // the Proof heading.
  "a", "b", "em", "i", "strong", "tt", "u",
]);

function parseRenderedBody(html: string): {
  proofLines: ProofLine[] | null;
  malformed: string[];
  sectionLinks: string[];
  tokenText: string;
} {
  const root = parseFragment(html) as unknown as HtmlNode;
  const tokenText: string[] = [];
  let proofSeen = false;
  const boxes: HtmlNode[] = [];
  const sectionAnchors: HtmlNode[] = [];
  const malformed: string[] = [];

  // Iterative pre-order walk; an `exit` frame closes a block element.
  // `container` names the outermost element around the node that a Proof
  // heading may not sit in (see VISIBLE_CONTAINERS), if any.
  const stack: { node: HtmlNode; inExample: boolean; container: string | null; exit?: boolean }[] = [
    { node: root, inExample: false, container: null },
  ];
  while (stack.length > 0) {
    const { node, inExample, container, exit } = stack.pop()!;
    const block = node.tagName !== undefined && BLOCK_TAGS.has(node.tagName);
    if (exit) {
      if (block) tokenText.push("\n");
      continue;
    }
    if (node.nodeName === "#text") {
      if (!inExample) tokenText.push(node.value ?? "");
      continue;
    }
    // The FIRST heading that reads as "Proof" opens the section. Every checkbox
    // after it is a proof line, including any under a second Proof heading, so
    // no box a reviewer can see is left out of validation. "Reads as" is
    // deliberately loose — any level, any case, invisible characters ignored —
    // so a lookalike cannot open a section the gate skips while a real heading
    // further down (say, inside a collapsed <details>) is the one validated. A
    // lookalike is then an error of its own. Its whole text counts, so markup a
    // proof line may not carry (`## <ins>Proof</ins>`) does not hide the word.
    // No Proof heading may sit in anything but a visible container, even after
    // a visible section or in initially open details: a canonical heading the
    // reviewer cannot see could otherwise stand in for a visible lookalike
    // outside our finite table.
    if (node.tagName !== undefined && HEADING_TAGS.has(node.tagName)) {
      const { text: shown, core, foreign } = lineOf(node);
      if (readsAsProof(core) || readsAsProof(shown)) {
        if (container === "details") {
          malformed.push(
            "The Proof heading must be outside <details>; move the ## Proof block outside all collapsible sections."
          );
        } else if (container) {
          malformed.push(
            `The Proof heading must not be inside <${container}>; write ## Proof in the body itself (a list item or a quote is fine). If the body mentions <${container}> as text, put it in backticks.`
          );
        }
        if (!proofSeen) {
          proofSeen = true;
          if (node.tagName !== "h2" || shown !== "Proof" || foreign.length > 0) {
            malformed.push(
              `The heading "${shown}" (${node.tagName}) reads as the Proof heading but is not "## Proof"; write it as ## Proof.`
            );
          }
        }
      }
    }
    // GitHub's sanitizer removes raw <input> elements, so every checkbox in the
    // rendered body comes from task-list syntax.
    if (proofSeen && node.tagName === "input" && attr(node, "type")?.toLowerCase() === "checkbox") {
      boxes.push(node);
    }
    if (proofSeen && node.tagName === "a" && attr(node, "href")) sectionAnchors.push(node);
    if (block) tokenText.push("\n");
    const example = inExample || isCodeExample(node);
    stack.push({ node, inExample, container, exit: true });
    const kids = childrenOf(node);
    const within =
      container ?? (node.tagName !== undefined && !VISIBLE_CONTAINERS.has(node.tagName) ? node.tagName : null);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, inExample: example, container: within });
  }

  const joined = readable(tokenText.join(""));
  if (!proofSeen) return { proofLines: null, malformed: [], sectionLinks: [], tokenText: joined };

  const proofLines: ProofLine[] = [];
  const onLines = new Set<HtmlNode>();
  const seenItems = new Set<HtmlNode>();
  for (const box of boxes) {
    const item = closestItem(box) ?? box.parentNode ?? box;
    if (seenItems.has(item)) continue;
    seenItems.add(item);
    const { text, anchors, foreign } = lineOf(item);
    for (const a of anchors) onLines.add(a);
    if (foreign.length > 0) {
      malformed.push(
        `Proof line contains <${foreign.join(">, <")}> markup, which can hide or restyle part of it: "${text}". ` +
          "A proof line may use only text, links, code and emphasis."
      );
      continue;
    }
    if (hasInvisible(text)) {
      malformed.push(
        `Proof line contains invisible or text-direction characters: "${text}". Remove them so the line reads as it is checked.`
      );
      continue;
    }
    const match = text.match(PROOF_LINE_RE);
    if (!match) {
      malformed.push(
        `Proof checkbox is not in "key: value" form with a key that has no spaces (e.g. "tests: ..."): "${text}". Every checkbox after ## Proof is a proof line.`
      );
      continue;
    }
    proofLines.push({
      key: match[1]!,
      checked: attr(box, "checked") !== undefined,
      value: stripTrailingProofTag(match[2]!.trim()),
      raw: text,
      links: anchors.map((a) => attr(a, "href")!),
    });
  }
  // Links in the section that no proof line carries: nested bullets, paragraphs,
  // tables, footnotes, a bullet with an emoji where the checkbox should be. A
  // run linked there reads as evidence as much as one on a checkbox line does.
  const sectionLinks = sectionAnchors.filter((a) => !onLines.has(a)).map((a) => attr(a, "href")!);
  return { proofLines, malformed, sectionLinks, tokenText: joined };
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
 * file: `proof:` in any case, whitespace allowed around the word and the key.
 * Inline-token validation (validateInlineTokens) still scans the rendered
 * body text, so the self-reference tags are still counted there — stripping
 * here only affects artifact validation.
 */
function stripTrailingProofTag(value: string): string {
  return value.replace(/\s*\[\s*proof\s*:\s*[^\]]+\]\s*$/i, "").trim();
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
 * An ASCII hyphen counts as a separator here, with or without spaces around
 * it, even though stripArtifactDescription deliberately excludes it. The two are not the same
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
// The path is read from the rendered line, so `scripts/__tests__/x.ts` arrives
// as `scripts/tests/x.ts` with "tests" in bold — which is also what the
// reviewer sees. Say how to keep a path intact wherever a path is refused.
const PATH_HINT =
  "(read as GitHub displays it; put paths in backticks so Markdown formatting cannot change them)";

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

  // realpath, not just resolve: resolve() is lexical, and existsSync follows
  // symlinks, so a committed `etc-link -> /etc` made `etc-link/passwd` look
  // like it lived inside the checkout.
  const root = realpathOrSelf(resolve(workspace));
  const full = realpathOrSelf(resolve(root, artifact));
  if (full !== root && !full.startsWith(root + sep)) {
    errors.push(`[${key}] File path escapes the repository checkout: ${artifact}`);
    return;
  }
  if (!existsSync(full)) {
    errors.push(`[${key}] File path does not exist: ${artifact} ${PATH_HINT}`);
    return;
  }

  // A directory is not an artifact. `git ls-files --error-unmatch` treats its
  // argument as a PATHSPEC and succeeds for anything covering at least one
  // tracked file, so `.` — or `proof/` — satisfied the tracked check on its own.
  if (!statSync(full).isFile()) {
    errors.push(`[${key}] File-path artifact must be a file, not a directory: ${artifact}`);
    return;
  }

  // "Repository-relative" has to be enforced, not just documented: an absolute
  // path inside the workspace passed both containment and the tracked check.
  if (artifact.startsWith("/")) {
    errors.push(
      `[${key}] File-path artifact must be repository-relative, got: ${artifact}`
    );
    return;
  }

  // Existing inside the checkout directory is not the claim. The claim is
  // "committed to the PR branch", and only git can answer it. This is what
  // excludes the nested gh-workflows checkout: the reusable workflow puts it at
  // `_gh_workflows/` INSIDE github.workspace and then runs `bun install` there,
  // so `_gh_workflows/scripts/__tests__/...` and `_gh_workflows/scripts/
  // node_modules/<anything>` are inside the workspace yet in no PR commit.
  const git = makeGitRunner(workspace);
  // --literal-pathspecs: an untracked file named `*` or `:(glob)x` must not
  // match a tracked sibling.
  if (git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", artifact]).ok) return;

  // git said no. Distinguish "untracked" from "cannot answer": a workspace that
  // is not a git checkout (local usage, tests) leaves existence as the only
  // available evidence, which is the behaviour this function started from.
  //
  // "Cannot answer" is decided by the presence of `.git`, NOT by the exit code.
  // Keying on `rev-parse` returning exactly "true" meant any git failure read as
  // "not a checkout" and accepted — and the everyday cause of that in CI is
  // `detected dubious ownership` (safe.directory) on container and self-hosted
  // runners, which would silently reopen this hole with nothing in the log.
  const looksLikeRepo = existsSync(resolve(root, ".git"));
  const insideRepo = git(["rev-parse", "--is-inside-work-tree"]);
  const answered = insideRepo.ok && insideRepo.stdout === "true";

  if (answered || looksLikeRepo) {
    errors.push(
      `[${key}] File path is not committed to the PR branch: ${artifact} ${PATH_HINT}`
    );
    if (!answered) {
      console.error(
        `  (git could not be queried in ${root}: ${insideRepo.stderr || "no reason given"})`
      );
    }
    return;
  }

  console.log(
    `ℹ [${key}] ${artifact} exists but ${root} is not a git checkout, so "committed to the PR branch" was not verified.`
  );
}

/** realpath, falling back to the lexical path when it does not exist yet. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolves an href the way the PR page does. GitHub keeps relative hrefs in the
 * rendered body, so `[CI run](/o/r/actions/runs/1)` and `../actions/runs/1`
 * open a run page from https://github.com/<base>/pull/<n>, and a classifier
 * that only reads absolute URLs would wave them through.
 */
function resolveHref(href: string): string {
  const repo = PR_BASE_REPO || PR_HEAD_REPO;
  const page = repo ? `https://github.com/${repo}/pull/` : "https://github.com/";
  try {
    const url = new URL(href, page);
    // A bare `www.github.com/…` is autolinked as http://; github.com answers
    // it with a redirect to the https page, so that is where the link leads.
    if (url.protocol === "http:" && url.hostname.toLowerCase().replace(/^www\./, "") === "github.com") {
      url.protocol = "https:";
    }
    return url.href;
  } catch {
    return href;
  }
}

/**
 * Validates a URL that looks like an Actions run and ignores any other kind.
 * `looked` holds the runs this line (or the section outside the lines) has
 * already reported, so a run that is both a line's text and its link is
 * reported once. Shared by artifact values and by links.
 */
async function validateRunUrl(
  key: string,
  url: ArtifactUrl,
  shown: string,
  looked: Set<string>,
  errors: string[]
): Promise<void> {
  switch (url.kind) {
    case "ci-run": {
      const run = `${url.owner}/${url.repo}/${url.runId}`.toLowerCase();
      if (looked.has(run)) return;
      looked.add(run);
      await validateCIRun(key, url.owner, url.repo, url.runId, errors);
      return;
    }
    case "ci-run-wrong-host":
      errors.push(`[${key}] CI run URL must be on github.com, got host "${url.host}": ${shown}`);
      return;
    case "ci-run-bad-id":
      errors.push(`[${key}] CI run URL has an unreadable run id "${url.id}": ${shown}`);
      return;
    case "ci-run-insecure":
      errors.push(`[${key}] Artifact URL must use https, not http: ${shown}`);
      return;
    case "check-page":
      errors.push(
        `[${key}] A check-run page cannot be verified; cite the Actions run (…/actions/runs/<id>) instead: ${shown}`
      );
      return;
    case "not-url":
      // Shown as a link but not a URL anything can open or look up — an
      // invisible character in the host does that. Not something to wave on.
      if (/^https?:\/\//i.test(shown)) errors.push(`[${key}] URL cannot be parsed: ${shown}`);
      return;
  }
}

async function validateUrlArtifact(
  key: string,
  artifact: string,
  looked: Set<string>,
  errors: string[]
): Promise<void> {
  const url = classifyArtifactUrl(artifact);
  switch (url.kind) {
    case "ci-run":
    case "ci-run-wrong-host":
    case "ci-run-bad-id":
    case "ci-run-insecure":
    case "check-page":
      await validateRunUrl(key, url, artifact, looked, errors);
      return;
    case "insecure":
      errors.push(`[${key}] Artifact URL must use https, not http: ${artifact}`);
      return;
    case "not-url":
      await validateRunUrl(key, url, artifact, looked, errors);
      return;
    case "url":
      return; // non-CI URL: accept (gist, screenshot, release asset, etc.)
  }
}

/**
 * Validates one artifact value — the part of a proof line that is supposed to
 * BE the evidence — and every link on the line that points at an Actions run.
 * Shared by the checked and the unchecked path so the two cannot drift apart.
 *
 * The links matter because the value is the rendered TEXT. `[CI run](…/runs/1)`
 * renders as the text "CI run", which is prose, while the reader clicking it
 * lands on run 1. So a run a line links to is looked up whatever the text says,
 * and a run that is both the text and the link is looked up once.
 */
async function validateArtifact(
  key: string,
  value: string,
  links: string[],
  errors: string[]
): Promise<void> {
  const looked = new Set<string>();
  // When the value itself is a URL, it is the artifact and the line's other
  // links are notes: a run among them is still looked up, a check page is
  // context. When the value is prose, a link is the artifact.
  const valueIsUrl = /^(?:https?:\/\/|www\.)/i.test(stripArtifactDescription(value));
  for (const href of links) {
    const target = resolveHref(href);
    const url = classifyArtifactUrl(target);
    if (valueIsUrl && url.kind === "check-page") continue;
    await validateRunUrl(key, url, target, looked, errors);
  }

  // Strip an optional " — <description>" annotation so only the artifact
  // itself is validated (e.g. "proof/foo.txt — what it proves" → "proof/foo.txt").
  let artifact = stripArtifactDescription(value);
  // A bare `www.` value is autolinked; read it as the URL it links to.
  if (/^www\./i.test(artifact)) artifact = `https://${artifact}`;

  // A value that starts with a URL is that URL plus notes:
  // `…/actions/runs/1 (head abc123, success)` is run 1, not a run whose id is
  // "1 (head abc123, success)". Any other URL in the notes is split out even
  // when no space separates it (GitHub autolinks `a,b` as one link that reads
  // as two), and every run among them is looked up; a generic link in a note
  // is context and is not judged.
  if (/^https?:\/\//i.test(artifact)) {
    const urls = artifact.split(/\s+/).flatMap((t) => t.split(/(?=https?:\/\/)/i)).filter((t) => /^https?:\/\//i.test(t));
    await validateUrlArtifact(key, urls[0]!, looked, errors);
    for (const note of urls.slice(1)) {
      const url = classifyArtifactUrl(note);
      if (url.kind.startsWith("ci-run") || url.kind === "not-url") {
        await validateRunUrl(key, url, note, looked, errors);
      }
    }
    return;
  }
  if (classifyArtifactUrl(artifact).kind !== "not-url") {
    await validateUrlArtifact(key, artifact, looked, errors);
    return;
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
  const { key, checked, value, links } = line;

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
    await validateArtifact(key, value, links, errors);
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

  await validateArtifact(key, value, links, errors);
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

/**
 * One lookup per run, however many lines cite it; every citing line still
 * reports the run's problems under its own key.
 */
const runVerdicts = new Map<string, Promise<{ problems: string[]; notes: string[] }>>();

async function validateCIRun(
  key: string,
  owner: string,
  repo: string,
  runId: string,
  errors: string[]
): Promise<void> {
  const id = `${owner}/${repo}/${runId}`.toLowerCase();
  let verdict = runVerdicts.get(id);
  if (!verdict) {
    verdict = checkRun(owner, repo, runId);
    runVerdicts.set(id, verdict);
  }
  const { problems, notes } = await verdict;
  for (const problem of problems) errors.push(`[${key}] ${problem}`);
  for (const note of notes) console.log(`ℹ [${key}] ${note}`);
}

async function checkRun(
  owner: string,
  repo: string,
  runId: string
): Promise<{ problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!GITHUB_TOKEN) {
    // No token: skip URL validation (local usage)
    return { problems, notes };
  }
  if (!PR_HEAD_SHA) {
    return { problems, notes }; // No SHA context: skip
  }

  // A run says something about this PR only if it ran in the PR's own
  // repository. Any other repository can run the same commit: push it there,
  // add an always-green workflow, and head_sha and conclusion both check out.
  // That includes the head repository of a fork PR, whose author controls its
  // workflows; checks for a fork PR run in the base repository. With no
  // repository to compare against, the run cannot be attributed: fail closed.
  const prRepo = PR_BASE_REPO || PR_HEAD_REPO;
  if (!prRepo) {
    problems.push(
      `CI run ${runId} cannot be attributed: PR_BASE_REPO_FULL_NAME is not set, so the PR's repository is unknown.`
    );
    return { problems, notes };
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
      problems.push(`CI run URL returned HTTP ${res.status}: ${owner}/${repo}/runs/${runId}`);
      return { problems, notes };
    }

    const data = (await res.json()) as {
      conclusion: string | null;
      head_sha: string;
      repository?: { full_name?: string };
    };

    // The API's answer names the repository, so an old URL of a renamed or
    // transferred repository, which redirects to the same run, still counts.
    const runRepo = data.repository?.full_name ?? `${owner}/${repo}`;
    if (runRepo.toLowerCase() !== prRepo.toLowerCase()) {
      problems.push(
        `CI run ${runId} ran in ${runRepo}, not in this PR's repository ${prRepo}; cite a run of this PR's checks.`
      );
      return { problems, notes };
    }

    if (data.conclusion !== "success") {
      problems.push(`CI run ${runId} conclusion is "${data.conclusion}", expected "success".`);
    }

    if (data.head_sha !== PR_HEAD_SHA) {
      // Not the same commit. Before calling it stale, ask whether it is the
      // same *content*: a branch that integrated its base and changed nothing
      // else is the case branch protection forces on every PR that is not the
      // next one to land. See scripts/clean-integrate-witness.ts.
      const witness = witnessCleanIntegrate(data.head_sha);
      if (!witness.accepted) {
        const detail = witness.detail ? ` — ${witness.detail}` : "";
        problems.push(
          `CI run ${runId} head_sha "${data.head_sha}" does not match PR head "${PR_HEAD_SHA}". Run is stale (${witness.reason})${detail}.`
        );
      } else {
        notes.push(
          `CI run ${runId} ran on ${data.head_sha}, which this head integrates from ${PR_BASE_REF} without changing content — accepted.`
        );
      }
    }
  } catch (err) {
    problems.push(`Failed to fetch CI run: ${String(err)}`);
  }
  return { problems, notes };
}

// ---------------------------------------------------------------------------
// Step 5: validate [proof: key] inline tokens
// ---------------------------------------------------------------------------

function validateInlineTokens(
  tokenText: string,
  proofLines: ProofLine[],
  errors: string[]
): void {
  const proofKeys = new Set(proofLines.map((l) => l.key));
  const seen = new Set<string>();
  // As loose as a reader: `[Proof: x]` and `[ proof : x ]` are claims too.
  const tokenRe = /\[\s*proof\s*:\s*([^\]]+)\]/gi;

  // The text comes from the same rendering that produced the proof lines, with
  // code examples already left out; escaped or mismatched backticks are text.
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(tokenText)) !== null) {
    const ref = m[1].trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
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

  // 1. Render the body through GitHub and find the proof section in the result
  let html: string;
  try {
    html = await renderBody(body);
  } catch (err) {
    if (!(err instanceof RenderError)) throw err;
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  const { proofLines, malformed, sectionLinks, tokenText } = parseRenderedBody(html);
  if (proofLines === null) {
    console.error(
      "ERROR: PR body does not contain a ## Proof section as GitHub renders it (a level-2 heading reading exactly \"Proof\")."
    );
    console.error(
      'Every PR must end with a ## Proof block. See https://github.com/florianhorner/gh-workflows for the template.'
    );
    process.exit(1);
  }

  // 2. Every checkbox after the heading must be a readable proof line, and
  //    there must be at least one
  errors.push(...malformed);
  if (proofLines.length === 0 && malformed.length === 0) {
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

  // 4. Validate each proof line, then any run linked elsewhere in the section.
  //    Links on an unchecked `n/a` line are context for the reason given, not
  //    evidence, and are not looked up.
  await Promise.all(
    proofLines.map((line) => validateProofLine(line, isUpstream, errors))
  );
  const sectionLooked = new Set<string>();
  for (const href of sectionLinks) {
    const target = resolveHref(href);
    await validateRunUrl("Proof section", classifyArtifactUrl(target), target, sectionLooked, errors);
  }

  // 5. Validate inline [proof: key] tokens
  validateInlineTokens(tokenText, proofLines, errors);

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
