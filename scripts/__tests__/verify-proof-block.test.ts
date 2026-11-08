import { describe, it, expect } from "bun:test";
import { unlink } from "node:fs/promises";
import { startApiStub, stubUrl } from "./github-api-stub";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT = `${import.meta.dir}/../verify-proof-block.ts`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runParser(
  body: string,
  env: Record<string, string> = {}
): Promise<RunResult> {
  // randomUUID, not Date.now(): two fixtures written in the same millisecond
  // collided silently.
  const tmp = `/tmp/proof-test-${crypto.randomUUID()}.md`;
  await Bun.write(tmp, body);
  // The verifier renders every body through GitHub's Markdown API; the stub
  // answers from recorded renderings (see github-api-stub.ts).
  const api = env.GITHUB_API_URL ? undefined : startApiStub();

  try {
    const proc = Bun.spawn(
      ["bun", "run", SCRIPT, "--body-file", tmp],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: "", // no real token in tests
          PR_HEAD_SHA: "",
          PR_HEAD_REPO_FULL_NAME: "",
          PR_BASE_REPO_FULL_NAME: "",
          OWNED_REPOS: "",
          ...env,
          ...(api ? { GITHUB_API_URL: stubUrl(api) } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return { exitCode, stdout, stderr };
  } finally {
    // Remove the temporary fixture after each parser invocation.
    await unlink(tmp).catch(() => {});
    api?.stop(true);
  }
}

// ---------------------------------------------------------------------------
// Sample PR bodies
// ---------------------------------------------------------------------------

const VALID_BODY = `
## Summary

This PR fixes the MQTT reconnect freeze. [proof: runtime]

## Changes

- Rewrote reconnect loop
- Added soak test

## Proof

- [x] build: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: build]
- [x] tests: TestMQTTReconnect [proof: tests]
- [x] lint: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: lint]
- [x] runtime: https://gist.github.com/florianhorner/abc123 [proof: runtime]
- [ ] schema: n/a — no MQTT interface changes [proof: schema]
`.trim();

const MISSING_PROOF_BODY = `
## Summary

This PR fixes things.

## Changes

- Did something
`.trim();

const PROOF_IN_CODE_FENCE = `
## Summary

Some docs:

\`\`\`markdown
## Proof

- [x] build: https://github.com/example/repo/actions/runs/1
- [x] tests: TestFoo
- [x] lint: https://github.com/example/repo/actions/runs/1
- [x] runtime: https://gist.github.com/example/abc
- [ ] schema: n/a — no changes
\`\`\`
`.trim();

const PROOF_IN_HTML_COMMENT = `
## Summary

Some docs.

<!--
## Proof

- [x] build: https://github.com/example/repo/actions/runs/1
- [x] tests: TestFoo
-->
`.trim();

const RUNTIME_NA_OWN_REPO = `
## Proof

- [x] build: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: build]
- [x] tests: TestMQTT [proof: tests]
- [x] lint: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: lint]
- [ ] runtime: n/a — local dev only, no device available [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

const RUNTIME_NA_UPSTREAM = `
## Proof

- [x] build: https://github.com/upstream/govee2mqtt/actions/runs/999 [proof: build]
- [x] tests: TestMQTT [proof: tests]
- [x] lint: https://github.com/upstream/govee2mqtt/actions/runs/999 [proof: lint]
- [ ] runtime: n/a — local dev only [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

const DANGLING_TOKEN_BODY = `
## Summary

This fixes the freeze. [proof: nonexistent]

## Proof

- [x] build: SomeBuildJob [proof: build]
- [x] tests: TestFreeze [proof: tests]
- [x] lint: LintJob [proof: lint]
- [x] runtime: https://gist.github.com/florianhorner/abc [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

const STALE_CI_BODY = `
## Proof

- [x] build: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: build]
- [x] tests: TestMQTT [proof: tests]
- [x] lint: https://github.com/florianhorner/govee2mqtt/actions/runs/999 [proof: lint]
- [x] runtime: https://gist.github.com/florianhorner/abc [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-proof-block", () => {
  it("passes a valid proof block (own-repo, no token)", async () => {
    const result = await runParser(VALID_BODY, {
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/govee2mqtt",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("fails when ## Proof section is missing", async () => {
    const result = await runParser(MISSING_PROOF_BODY);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("## Proof");
  });

  it("ignores ## Proof inside a code fence", async () => {
    const result = await runParser(PROOF_IN_CODE_FENCE);
    expect(result.exitCode).toBe(1);
    // The only ## Proof is inside a fence — should be treated as missing
    expect(result.stderr).toContain("## Proof");
  });

  it("ignores ## Proof inside an HTML comment", async () => {
    const result = await runParser(PROOF_IN_HTML_COMMENT);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("## Proof");
  });

  it("allows runtime: n/a for own-repo PRs", async () => {
    const result = await runParser(RUNTIME_NA_OWN_REPO, {
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/govee2mqtt",
    });
    expect(result.exitCode).toBe(0);
  });

  it("rejects runtime: n/a for cross-owner (upstream) PRs", async () => {
    const result = await runParser(RUNTIME_NA_UPSTREAM, {
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "fork-user/govee2mqtt",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime");
    expect(result.stderr).toContain("cross-owner");
  });

  it("fails on dangling [proof: key] token", async () => {
    const result = await runParser(DANGLING_TOKEN_BODY, {
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/govee2mqtt",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nonexistent");
    expect(result.stderr).toContain("Dangling");
  });

  it("skips CI URL validation when no GITHUB_TOKEN provided", async () => {
    // STALE_CI_BODY has CI run URLs but no token → should skip validation → pass
    const result = await runParser(STALE_CI_BODY, {
      GITHUB_TOKEN: "",
      PR_HEAD_SHA: "",
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/govee2mqtt",
    });
    expect(result.exitCode).toBe(0);
  });

  // clean-integrate-witness.test.ts covers stale runs with a local API stub
  // and temporary Git repositories.

  // Remove trailing proof tokens before validating the artifact value.
  // URL recognition must precede file-path validation because URLs contain /.

  it("strips trailing [proof: KEY] tag from a file-path artifact", async () => {
    // Use this test file's own path so existsSync() succeeds at the
    // workspace root. The backticks keep GitHub from rendering `__tests__`
    // as bold "tests", which would change the path the verifier reads.
    const FILE_PATH_BODY = `
## Summary

Bootstrap. [proof: runtime]

## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: \`scripts/__tests__/verify-proof-block.test.ts\` [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(FILE_PATH_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      // Anchor existsSync at the repo root so the path resolves.
      GITHUB_WORKSPACE: `${import.meta.dir}/../..`,
    });
    expect(result.exitCode).toBe(0);
    // Should NOT see the dirty path (with suffix) in any error message.
    expect(result.stderr).not.toContain("[proof: runtime]");
    expect(result.stderr).not.toContain("does not exist");
  });

  it("rejects a missing file-path artifact AFTER stripping the [proof: KEY] tag", async () => {
    const MISSING_PATH_BODY = `
## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: this/file/does/not/exist.txt [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(MISSING_PATH_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    // Error should reference the CLEAN path (no suffix) — proves the
    // strip ran before existsSync().
    expect(result.stderr).toContain("this/file/does/not/exist.txt");
    expect(result.stderr).not.toContain("[proof: runtime]");
  });

  it("accepts a non-CI URL artifact with trailing [proof: KEY] tag, even with GITHUB_WORKSPACE set", async () => {
    // Pre-fix: GITHUB_WORKSPACE + URL-with-suffix routed through the
    // file-path branch (URL contains `/`), failed existsSync(), errored.
    const URL_BODY = `
## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: https://gist.github.com/florianhorner/abc123 [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(URL_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: "/tmp",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("does not exist");
  });

  it("accepts a prose / test-name artifact with trailing [proof: KEY] tag (workaround path still works)", async () => {
    // Plain values without / or :// retain the parser's existing acceptance.
    const PROSE_BODY = `
## Proof

- [x] build: TestBuildJob [proof: build]
- [x] tests: TestRunner [proof: tests]
- [x] lint: TestLintJob [proof: lint]
- [x] runtime: proof in branch commit message [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(PROSE_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: "/tmp",
    });
    expect(result.exitCode).toBe(0);
  });

  // An artifact description after an em dash is excluded from path lookup.

  it("accepts a file-path artifact annotated with an em-dash description", async () => {
    const DESC_BODY = `
## Summary

Bootstrap. [proof: runtime]

## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: \`scripts/__tests__/verify-proof-block.test.ts\` — parity check confirms the file exists [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(DESC_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: `${import.meta.dir}/../..`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("does not exist");
  });

  it("rejects a missing file-path artifact, reporting the clean path without the em-dash description", async () => {
    const MISSING_DESC_BODY = `
## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: this/file/does/not/exist.txt — what it would prove [proof: runtime]
- [ ] schema: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(MISSING_DESC_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: "/tmp",
    });
    expect(result.exitCode).toBe(1);
    // Error references the CLEAN path only — proves the description was split off.
    expect(result.stderr).toContain("this/file/does/not/exist.txt");
    expect(result.stderr).not.toContain("what it would prove");
    expect(result.stderr).not.toContain("[proof: runtime]");
  });

  it("still accepts unchecked n/a — <reason> (em-dash split does not affect the n/a path)", async () => {
    const NA_BODY = `
## Proof

- [x] build: TestBuild [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint: TestLint [proof: lint]
- [x] runtime: \`scripts/__tests__/verify-proof-block.test.ts\` [proof: runtime]
- [ ] schema: n/a — no schema changes in this PR [proof: schema]
`.trim();

    const result = await runParser(NA_BODY, {
      OWNED_REPOS: "florianhorner/example",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/example",
      GITHUB_WORKSPACE: `${import.meta.dir}/../..`,
    });
    expect(result.exitCode).toBe(0);
  });

  // Inline tokens must match complete proof keys. A short key cannot stand in
  // for a compound key such as lint/fmt.
  it("fails when proof line uses compound key but inline token uses short form", async () => {
    const MISMATCH_BODY = `
## Summary

Fixes the freeze. [proof: lint]

## Proof

- [x] build: SomeJob [proof: build]
- [x] tests: TestFoo [proof: tests]
- [x] lint/fmt: SomeJob [proof: lint]
- [x] runtime: https://gist.github.com/example/abc [proof: runtime]
- [ ] schema/topic: n/a — no changes [proof: schema]
`.trim();

    const result = await runParser(MISMATCH_BODY, {
      OWNED_REPOS: "florianhorner/govee2mqtt",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/govee2mqtt",
    });
    expect(result.exitCode).toBe(1);
    // Parser should flag `[proof: lint]` as dangling because the proof line
    // key is `lint/fmt`, not `lint`. Same for schema.
    expect(result.stderr).toContain("Dangling");
    expect(result.stderr).toContain("lint");
  });
});
