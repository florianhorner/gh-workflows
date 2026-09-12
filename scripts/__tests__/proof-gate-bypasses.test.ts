import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every case here is a way a PR body could satisfy the proof gate without the
// evidence the gate exists to require. All of them are reachable from a body a
// person would plausibly write, and none of them was covered: the suite had 53
// green tests while each of these walked straight through.
//
// The cited run in the URL cases is deliberately a FAILED one. A verifier that
// recognises the URL must reject it. Acceptance therefore proves the URL was
// never recognised at all and fell into the generic-URL accept behind it, while
// the rendered PR body still links to the same run page.

const SCRIPT = `${import.meta.dir}/../verify-proof-block.ts`;

let servers: ReturnType<typeof Bun.serve>[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function stubApi(conclusion: string, headSha: string): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(JSON.stringify({ conclusion, head_sha: headSha }), {
        headers: { "content-type": "application/json" },
      }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "proof-ws-"));
  dirs.push(d);
  return d;
}

interface Result {
  exitCode: number;
  out: string;
}

async function verify(
  body: string,
  env: Record<string, string> = {},
  cwd?: string
): Promise<Result> {
  const tmp = join(tmpdir(), `proof-body-${Date.now()}-${Math.random()}.md`);
  writeFileSync(tmp, body);
  try {
    const proc = Bun.spawn(["bun", "run", SCRIPT, "--body-file", tmp], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "test-token",
        PR_HEAD_SHA: "cafebabe",
        PR_BASE_REF: "main",
        PR_HEAD_REPO_FULL_NAME: "florianhorner/demo",
        PR_BASE_REPO_FULL_NAME: "florianhorner/demo",
        OWNED_REPOS: "florianhorner/demo",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      ...(cwd ? { cwd } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode: await proc.exited, out: stdout + stderr };
  } finally {
    rmSync(tmp, { force: true });
  }
}

const bodyWith = (line: string, extra = "") =>
  ["A change.", extra, "", "## Proof", "", line, ""].join("\n");

// ---------------------------------------------------------------------------
// 1. The host was matched exactly, case-sensitively, https-only.
//
// DNS hosts are case-insensitive and `www.` is the same page, so each spelling
// below links to the identical run — but only one of them was recognised. The
// rest fell through to the generic-URL accept, which returns unconditionally,
// so the green-run and head_sha checks never ran.
// ---------------------------------------------------------------------------

describe("a CI-run URL is recognised by its path, not by an exact host string", () => {
  const spellings = [
    ["canonical", "https://github.com"],
    ["mixed case", "https://GitHub.com"],
    ["upper case", "https://GITHUB.COM"],
    ["www prefix", "https://www.github.com"],
  ] as const;

  for (const [label, base] of spellings) {
    it(`rejects a failed run cited as ${label}`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(
        bodyWith(
          `- [x] tests: ${base}/florianhorner/demo/actions/runs/123 [proof: tests]`
        ),
        { GITHUB_API_URL: api }
      );
      expect(res.exitCode).not.toBe(0);
      // Assert the SPECIFIC failure. A bare `not.toBe(0)` would also be
      // satisfied by the URL being rejected for some unrelated reason, which
      // would not prove the run was actually looked up.
      expect(res.out).toContain('conclusion is "failure"');
    });
  }

  it("rejects a run cited over plain http instead of accepting it", async () => {
    const res = await verify(
      bodyWith(
        "- [x] tests: http://github.com/florianhorner/demo/actions/runs/123 [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("must use https");
  });

  it("still accepts a non-run github.com URL as a generic artifact", async () => {
    // A release asset lives on github.com but is not a run page. Matching the
    // host must not drag it into the API lookup.
    const res = await verify(
      bodyWith(
        "- [x] runtime: https://github.com/o/r/releases/download/v1/proof.zip [proof: runtime]"
      ),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).toBe(0);
  });

  it("rejects a failed run cited with a trailing path segment", async () => {
    // /actions/runs/123/job/456 is the shape gh prints for a job link.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123/job/456 [proof: tests]"
      ),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
  });

  it("refuses a run-shaped path on a lookalike host instead of accepting it", async () => {
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com.example.test/o/r/actions/runs/1 [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/host|github\.com/i);
  });

  it("still accepts a genuinely green run on the canonical host", async () => {
    const api = stubApi("success", "cafebabe");
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123 [proof: tests]"
      ),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. CRLF bodies dropped every proof line.
//
// GitHub stores browser-authored and browser-edited descriptions with CRLF
// endings. The line regex is not multiline-anchored and `.` excludes \r, so the
// value capture could never reach end-of-string. The failure reported "no
// checkbox lines" plus one dangling token per real claim: three errors, none of
// them the cause. The caller re-runs on `edited`, so this fired the moment
// anyone fixed a typo in the description.
// ---------------------------------------------------------------------------

describe("a CRLF body is parsed like an LF one", () => {
  it("reads proof lines out of a CRLF body", async () => {
    const api = stubApi("success", "cafebabe");
    const body = [
      "A change.", "", "## Proof", "",
      "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123 [proof: tests]",
      "",
    ].join("\r\n");
    const res = await verify(body, { GITHUB_API_URL: api });
    expect(res.out).not.toMatch(/no checkbox lines/i);
    expect(res.out).not.toMatch(/Dangling/i);
    expect(res.exitCode).toBe(0);
  });

  it("still rejects a bad claim in a CRLF body, for the right reason", async () => {
    // Parsing it is only useful if the claim is then JUDGED. Pre-fix this also
    // exited non-zero -- because every line was dropped -- so asserting the
    // exit code alone passed against the bug it was written for.
    const api = stubApi("failure", "cafebabe");
    const body = [
      "A change.", "", "## Proof", "",
      "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123 [proof: tests]",
      "",
    ].join("\r\n");
    const res = await verify(body, { GITHUB_API_URL: api });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/conclusion is "failure"/);
    expect(res.out).not.toMatch(/no checkbox lines/i);
  });
});

// ---------------------------------------------------------------------------
// 3. A checkbox inside a fenced block counted as a real claim.
//
// extractProofSection returned the ORIGINAL slice rather than the stripped one,
// so a template or example block inside the section supplied evidence. The
// comment said the original was needed "for URL validation etc."; nothing in
// the section needed it.
// ---------------------------------------------------------------------------

describe("fenced content inside the Proof section is not evidence", () => {
  it("does not count a checkbox inside a fenced example", async () => {
    // The fenced line is the ONLY checkbox in the section. Pre-fix it was
    // parsed as a real claim, so the section had a proof line and passed; with
    // the fix the section has none, which is an error. An earlier version of
    // this case also carried a real `n/a` line for the same key, so pre-fix
    // main failed on the n/a rule instead and the case proved nothing.
    const body = [
      "A change.", "", "## Proof", "",
      "Template for next time:",
      "```md",
      "- [x] runtime: FakeArtifact [proof: runtime]",
      "```",
      "",
    ].join("\n");
    const res = await verify(body);
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/no checkbox lines/i);
  });

  it("does not let a fenced heading masquerade as the Proof section", async () => {
    const body = [
      "A change.", "",
      "```md",
      "## Proof",
      "- [x] tests: FakeTest [proof: tests]",
      "```",
      "",
    ].join("\n");
    const res = await verify(body);
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/## Proof/);
  });
});

// ---------------------------------------------------------------------------
// 4. An inline triple-backtick span latched the fence state machine.
//
// A line like ```bun test``` opens and closes on itself. The old state machine
// toggled on the opener and never saw a closer, so everything after it looked
// fenced and a real `## Proof` heading became invisible — the validator denied a
// section that was plainly there.
// ---------------------------------------------------------------------------

describe("an inline triple-backtick span is not a fence opener", () => {
  it("finds a Proof section after an inline triple-backtick span", async () => {
    const api = stubApi("success", "cafebabe");
    const body = [
      // At line start: that is where the old ^-anchored regex latched.
      "```bun test``` passes now, so this is ready.",
      "", "## Proof", "",
      "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123 [proof: tests]",
      "",
    ].join("\n");
    const res = await verify(body, { GITHUB_API_URL: api });
    expect(res.out).not.toMatch(/does not contain a ## Proof section/i);
    expect(res.exitCode).toBe(0);
  });

  it("treats a tilde fence the same as a backtick fence for inline tokens", async () => {
    const api = stubApi("success", "cafebabe");
    const body = [
      "A change.",
      "~~~md",
      "see [proof: nonexistent] in the template",
      "~~~",
      "", "## Proof", "",
      "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123 [proof: tests]",
      "",
    ].join("\n");
    const res = await verify(body, { GITHUB_API_URL: api });
    expect(res.out).not.toMatch(/Dangling/i);
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. A file path was resolved against the process cwd first, and never
//    confined to the checkout.
//
// Under the reusable workflow the cwd is the nested gh-workflows checkout, so a
// path that exists THERE satisfied "committed to the PR branch". And with no
// containment check at all, an absolute or traversing path passed outright.
// ---------------------------------------------------------------------------

describe("a file-path artifact must be inside the PR checkout", () => {
  it("rejects a path that exists only in the verifier's own checkout", async () => {
    // Empty workspace: nothing is committed to this "PR". The path below does
    // exist relative to the script's own tree, which is what used to answer.
    //
    // The cwd override is load-bearing and reproduces the workflow exactly:
    // `verify-claims.yml` runs the parser with
    // `working-directory: _gh_workflows/scripts`. Without it this test runs
    // from the repo root, where the path does not resolve either — so it
    // passed against the pre-fix parser and guarded nothing.
    const res = await verify(
      bodyWith("- [x] runtime: __tests__/verify-proof-block.test.ts [proof: runtime]"),
      { GITHUB_WORKSPACE: workspace() },
      `${import.meta.dir}/..`
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/does not exist|escapes/i);
  });

  it("rejects an absolute path even with no GITHUB_WORKSPACE to resolve against", async () => {
    const res = await verify(
      bodyWith("- [x] runtime: /etc/passwd [proof: runtime]"),
      { GITHUB_WORKSPACE: "" }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("repository-relative");
  });

  it("rejects an absolute path outside the checkout", async () => {
    const res = await verify(
      bodyWith("- [x] runtime: /etc/passwd [proof: runtime]"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
  });

  it("rejects a traversal out of the checkout, as a traversal", async () => {
    const res = await verify(
      bodyWith("- [x] runtime: ../../../../etc/hosts [proof: runtime]"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    // The message matters here. The pre-fix parser also rejected this body,
    // but only because `${workspace}/../../../../etc/hosts` happened not to
    // resolve to a real file — it never asked whether the path stayed inside
    // the checkout. Asserting the containment message is what makes this a
    // guard rather than a coincidence.
    expect(res.out).toContain("escapes the repository checkout");
  });

  it("accepts a path the PR actually carries", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "runtime.txt"), "ran it\n");
    const res = await verify(
      bodyWith("- [x] runtime: proof/runtime.txt [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. `n/a` needed an em-dash, so the rule was one keystroke from unenforced,
//    and an unchecked box carrying a real artifact skipped every check.
// ---------------------------------------------------------------------------

describe("n/a and unchecked values are judged, not waved through", () => {
  it("treats an ASCII-hyphen n/a as an n/a on a cross-owner PR", async () => {
    const res = await verify(
      bodyWith("- [ ] runtime: n/a - no device [proof: runtime]"),
      { OWNED_REPOS: "someone-else/demo" }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/runtime/i);
  });

  it("rejects an n/a with no reason at all", async () => {
    const res = await verify(bodyWith("- [ ] schema: n/a [proof: schema]"));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/reason/i);
  });

  it("rejects an n/a whose separator is present but whose reason is empty", async () => {
    const res = await verify(bodyWith("- [ ] schema: n/a — [proof: schema]"));
    expect(res.exitCode).not.toBe(0);
  });

  it("validates an unchecked box that carries a real artifact", async () => {
    // This path used to return unconditionally, so an unchecked line was a
    // silent accept for any value that was not literally "n/a".
    const res = await verify(
      bodyWith("- [ ] runtime: /etc/passwd [proof: runtime]"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
  });

  it("still accepts a well-formed n/a on an owned PR", async () => {
    const res = await verify(
      bodyWith("- [ ] schema: n/a — no interface changes [proof: schema]")
    );
    expect(res.exitCode).toBe(0);
  });
});
