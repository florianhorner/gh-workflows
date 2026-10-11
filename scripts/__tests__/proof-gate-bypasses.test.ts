import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResponse, runsById, startApiStub, stubUrl } from "./github-api-stub";

// Every case here is a way a PR body could satisfy the proof gate without the
// evidence the gate exists to require. All of them are reachable from a body a
// person would plausibly write, and none of them was covered: the suite had 53
// green tests while each of these walked straight through.
//
// The cited run in the URL cases is deliberately a FAILED one. A verifier that
// recognises the URL must reject it. Acceptance therefore proves the URL was
// never recognised at all and fell into the generic-URL accept behind it, while
// the rendered PR body still links to the same run page.

// Test-only override for proving regressions against an immutable old parser.
const SCRIPT = process.env.PROOF_TEST_SCRIPT ?? `${import.meta.dir}/../verify-proof-block.ts`;

// Fixture repositories ignore the machine's git config, so a global hooks path,
// template directory or signing setup cannot run, or wait for input, inside a
// test. execFileSync blocks the event loop, so the timeout is git's own.
const GIT_OPTS = {
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  timeout: 20_000,
};

let servers: ReturnType<typeof Bun.serve>[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function stubApi(conclusion: string, headSha: string): string {
  const server = startApiStub(runResponse(conclusion, headSha));
  servers.push(server);
  return stubUrl(server);
}

/** Renders from the recordings; any run lookup is a 404. */
function renderOnlyApi(): string {
  const server = startApiStub();
  servers.push(server);
  return stubUrl(server);
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
        GITHUB_API_URL: env.GITHUB_API_URL ?? renderOnlyApi(),
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
    // /actions/runs/123/job/456 is the shape gh prints for a job link. This is
    // a no-regression control, not a guard: the old prefix-matching regex read
    // a slash terminator too. The non-slash terminators below are the guards.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123/job/456 [proof: tests]"
      ),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('conclusion is "failure"');
  });

  // A run id that is not bare digits must be an ERROR, never a pass. Requiring
  // `\d+` in the path pattern meant `runs/123.` simply did not match, fell into
  // the generic-URL accept and skipped the run lookup entirely — while GFM
  // strips the trailing period from a bare autolink, so the body still rendered
  // a live link to the real run.
  const RUN_ID_TERMINATORS = [".", ",", ":", "!", "~", ")"] as const;

  for (const suffix of RUN_ID_TERMINATORS) {
    it(`still looks the run up when the URL ends in "${suffix}"`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(
        bodyWith(
          `- [x] tests: https://github.com/florianhorner/demo/actions/runs/123${suffix} [proof: tests]`
        ),
        { GITHUB_API_URL: api }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('conclusion is "failure"');
    });
  }

  it("decodes a percent-encoded run id rather than treating it as a generic URL", async () => {
    // github.com routes %31 to run 1, so the reader and the validator must
    // agree on which run was cited.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/%31 [proof: tests]"
      ),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('conclusion is "failure"');
  });

  it("collapses a doubled slash rather than treating the URL as a generic one", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com//florianhorner/demo/actions/runs/123 [proof: tests]"
      ),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('conclusion is "failure"');
  });

  it("rejects a run id it cannot read instead of accepting the URL", async () => {
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/12a [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("unreadable run id");
  });

  it("rejects a run URL on a non-default port", async () => {
    // A different port is a different origin than the api.github.com lookup.
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com:444/florianhorner/demo/actions/runs/123 [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("must be on github.com");
  });

  it("refuses a run-shaped path on a lookalike host instead of accepting it", async () => {
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com.example.test/o/r/actions/runs/1 [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    // The exact message: the URL itself contains "github.com", so a looser
    // match would pass on any rejection at all.
    expect(res.out).toContain('must be on github.com, got host "github.com.example.test"');
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
      bodyWith("- [x] runtime: `__tests__/verify-proof-block.test.ts` [proof: runtime]"),
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
    expect(res.out).toContain("escapes the repository checkout: /etc/passwd");
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
    expect(res.out).toContain("runtime: n/a is not allowed for cross-owner PRs");
  });

  it("rejects an n/a with no reason at all", async () => {
    const res = await verify(bodyWith("- [ ] schema: n/a [proof: schema]"));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toMatch(/reason/i);
  });

  it("rejects an n/a whose separator is present but whose reason is empty", async () => {
    const res = await verify(bodyWith("- [ ] schema: n/a — [proof: schema]"));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('[schema] Unchecked "n/a" needs a reason');
  });

  it("validates an unchecked box that carries a real artifact", async () => {
    // This path used to return unconditionally, so an unchecked line was a
    // silent accept for any value that was not literally "n/a".
    const res = await verify(
      bodyWith("- [ ] runtime: /etc/passwd [proof: runtime]"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("[runtime] File path escapes the repository checkout");
  });

  it("still accepts a well-formed n/a on an owned PR", async () => {
    const res = await verify(
      bodyWith("- [ ] schema: n/a — no interface changes [proof: schema]")
    );
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Markdown-stripper holes in the first fix. Each of these was a way to
//    make the gate read a different document than the one GitHub renders.
// ---------------------------------------------------------------------------

describe("the stripper reads the same document GitHub renders", () => {
  it("does not parse a proof block hidden after a second comment opener", async () => {
    // `<!-- a --> <!--` contains `-->`, so an includes() check called the line
    // closed and never entered comment mode. GitHub renders nothing after the
    // dangling opener; the gate was counting it as verified evidence.
    const res = await verify(
      [
        "A change with no evidence at all.",
        "",
        "<!-- template start --> <!--",
        "",
        "## Proof",
        "",
        "- [x] tests: FakeTest",
        "",
        "-->",
        "",
      ].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  it("reports an unfinished comment as a gate error, not as a crash", async () => {
    // The rejection is right, but it used to surface as "Unexpected error:"
    // followed by a Bun stack trace. A developer reading CI should get the
    // same ERROR line and template hint as a missing ## Proof section.
    const res = await verify(
      ["A change.", "", "<!-- a --> <!--", "", "## Proof", "", "- [x] tests: FakeTest", ""].join("\n")
    );
    // GitHub renders nothing after the dangling opener, so there is no Proof
    // section to find, and the message says so.
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("ERROR: PR body does not contain a ## Proof section");
    expect(res.out).toContain("Every PR must end with a ## Proof block");
    expect(res.out).not.toContain("Unexpected error");
    expect(res.out).not.toMatch(/^\s+at /m);
  });

  it("treats a tilde fence with tildes in its info string as a fence", async () => {
    // CommonMark forbids backticks inside a backtick fence's info string but
    // ALLOWS tildes inside a tilde fence's, so the inline-span shortcut was
    // wrong for `~~~`: the fenced line stayed in as a live claim while GitHub
    // rendered it as code.
    const res = await verify(
      ["## Proof", "", "~~~ template ~~~", "- [x] tests: FakeTest", "~~~", ""].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("no checkbox lines");
  });

  it("does not treat a 4-space-indented triple backtick as a fence opener", async () => {
    // At 4 spaces CommonMark makes it an indented code block. Reading it as a
    // fence blanked everything after it, which both hid the LAST `## Proof`
    // section and deleted its claims — so the gate validated an earlier block
    // while the reviewer read the later one.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof",
        "",
        "- [x] tests: FakeTest",
        "",
        "An indented code sample:",
        "",
        "    ```",
        "",
        "## Proof",
        "",
        "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123",
        "",
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('conclusion is "failure"');
  });
});

// ---------------------------------------------------------------------------
// 8. "Committed to the PR branch" is a git question, not an existsSync one.
// ---------------------------------------------------------------------------

describe("a file-path artifact must be committed to the PR branch", () => {
  function gitRepo(): string {
    const d = workspace();
    execFileSync("git", ["init", "-q"], { cwd: d, ...GIT_OPTS });
    writeFileSync(join(d, "README.md"), "hi\n");
    execFileSync("git", ["add", "README.md"], { cwd: d, ...GIT_OPTS });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "chore: init"],
      { cwd: d, ...GIT_OPTS }
    );
    return d;
  }

  it("rejects a path that exists only in the nested gh-workflows checkout", async () => {
    // The reusable workflow checks gh-workflows out at `_gh_workflows/` INSIDE
    // github.workspace and runs `bun install` there, so those files are inside
    // the workspace and in no PR commit. Lexical containment alone accepted
    // them; git does not.
    const ws = gitRepo();
    mkdirSync(join(ws, "_gh_workflows", "scripts", "__tests__"), { recursive: true });
    writeFileSync(join(ws, "_gh_workflows", "scripts", "__tests__", "x.test.ts"), "x\n");
    const res = await verify(
      bodyWith("- [x] runtime: `_gh_workflows/scripts/__tests__/x.test.ts` [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("not committed to the PR branch");
  });

  it("rejects an untracked file the PR merely left lying in the checkout", async () => {
    // Note the directory: a value with no `/` never reaches the file-path
    // branch at all, it lands in the terminal prose accept. That gap is
    // pre-existing and documented in README "Known gaps"; this test is about
    // the tracked check, so it uses a path that actually routes there.
    const ws = gitRepo();
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "scratch.txt"), "x\n");
    const res = await verify(
      bodyWith("- [x] runtime: proof/scratch.txt [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("not committed to the PR branch");
    expect(res.out).toContain("put paths in backticks");
  });

  it("accepts a file the PR actually committed", async () => {
    const res = await verify(
      bodyWith("- [x] runtime: README.md [proof: runtime]"),
      { GITHUB_WORKSPACE: gitRepo() }
    );
    expect(res.exitCode).toBe(0);
  });

  it("rejects a symlink that points out of the checkout", async () => {
    // resolve() is lexical and existsSync follows links, so a committed
    // `etc-link -> /etc` made `etc-link/passwd` look like checkout content.
    const ws = workspace();
    symlinkSync("/etc", join(ws, "etc-link"));
    const res = await verify(
      bodyWith("- [x] runtime: etc-link/passwd [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("escapes the repository checkout");
  });
});

// ---------------------------------------------------------------------------
// 9. Holes in the corrections themselves. The first correction moved
//    comment detection ahead of fence detection and thereby
//    reopened the same hidden-block class through the other door, so these
//    pin the ORDER and the remaining artifact-shape holes.
// ---------------------------------------------------------------------------

describe("a fence opener is a fence even when it carries a comment marker", () => {
  for (const marker of ["```", "~~~"] as const) {
    it(`does not enter comment mode on \`${marker} <!--\``, async () => {
      // GitHub reads `${marker} <!--` as a fence opener whose info string is
      // `<!--`, so everything below is code and the rendered body has no proof
      // block. Checking comments first made one `-->` reopen the document.
      const res = await verify(
        [
          "A change with no evidence at all.",
          "",
          `${marker} <!--`,
          "-->",
          "",
          "## Proof",
          "",
          "- [x] tests: FakeTest",
          "",
        ].join("\n")
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });
  }
});

describe("an artifact must name a committed file, not a container", () => {
  function gitRepoWithProof(): string {
    const d = workspace();
    execFileSync("git", ["init", "-q"], { cwd: d, ...GIT_OPTS });
    mkdirSync(join(d, "proof"), { recursive: true });
    writeFileSync(join(d, "proof", "real.txt"), "ok\n");
    execFileSync("git", ["add", "proof/real.txt"], { cwd: d, ...GIT_OPTS });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "chore: init"],
      { cwd: d, ...GIT_OPTS }
    );
    return d;
  }

  for (const dir of [".", "./", "proof/"] as const) {
    it(`rejects "${dir}" instead of letting a directory satisfy the tracked check`, async () => {
      // `git ls-files --error-unmatch` takes a PATHSPEC and succeeds for
      // anything covering at least one tracked file, so a single dot cleared
      // the tracked-file check on its own.
      const res = await verify(
        bodyWith(`- [x] runtime: ${dir} [proof: runtime]`),
        { GITHUB_WORKSPACE: gitRepoWithProof() }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("must be a file, not a directory");
    });
  }

  it("rejects an absolute path even when it points inside the checkout", async () => {
    // A fixed path, not a mkdtemp one: the body is looked up in the recorded
    // GitHub renderings by its exact text, so it cannot change between runs.
    const ws = "/tmp/proof-gate-absolute-inside";
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    dirs.push(ws);
    execFileSync("git", ["init", "-q"], { cwd: ws, ...GIT_OPTS });
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "real.txt"), "ok\n");
    execFileSync("git", ["add", "proof/real.txt"], { cwd: ws, ...GIT_OPTS });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "chore: init"],
      { cwd: ws, ...GIT_OPTS }
    );
    const res = await verify(
      bodyWith(`- [x] runtime: ${ws}/proof/real.txt [proof: runtime]`),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("repository-relative");
  });

  it("accepts the committed file itself", async () => {
    const res = await verify(
      bodyWith("- [x] runtime: proof/real.txt [proof: runtime]"),
      { GITHUB_WORKSPACE: gitRepoWithProof() }
    );
    expect(res.exitCode).toBe(0);
  });

  it("fails closed when .git is present but git cannot answer", async () => {
    // Keying "cannot answer" on the exit code meant ANY git failure read as
    // "not a checkout" and accepted. The everyday CI cause is safe.directory
    // / dubious ownership on container and self-hosted runners, which would
    // have silently reopened the whole tracked check with nothing in the log.
    const ws = workspace();
    writeFileSync(join(ws, ".git"), "gitdir: /nonexistent-gitdir\n");
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "fabricated.txt"), "x\n");
    const res = await verify(
      bodyWith("- [x] runtime: proof/fabricated.txt [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("not committed to the PR branch");
  });

  it("says out loud when it could not verify a workspace that is no checkout", async () => {
    // Local usage keeps working, but the skipped check is announced rather
    // than silently passing as if it had run.
    const ws = workspace();
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "plain.txt"), "x\n");
    const res = await verify(
      bodyWith("- [x] runtime: proof/plain.txt [proof: runtime]"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("was not verified");
  });
});

describe("decoding the run path must not retarget the API request", () => {
  it("rejects an owner or repo that decodes to something GitHub cannot name", async () => {
    // `demo%23` decodes to `demo#`, which truncated the interpolated request to
    // /repos/{owner}/{repo} — so the validator judged the REPOSITORY object as
    // if it were a run, and a repo object has no conclusion to fail on.
    const res = await verify(
      bodyWith(
        "- [x] tests: https://github.com/florianhorner/demo%23/actions/runs/1 [proof: tests]"
      )
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("unreadable run id");
  });

  it("treats the runs index as a generic URL, not a malformed run", async () => {
    // `…/actions/runs/` has an empty id slot. It is not a run claim at all, so
    // erroring on it would be a false rejection.
    const res = await verify(
      bodyWith(
        "- [x] runtime: https://github.com/florianhorner/demo/actions/runs/ [proof: runtime]"
      ),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).toBe(0);
  });
});

// Every test in this group fails against 9353434. Keep controls that already
// passed there in the separate compatibility group below, so a filtered run
// proves each regression independently of the current parser implementation.
describe("CommonMark regressions", () => {
  const proofAfter = (prefix: string) =>
    `${prefix}\n\n## Proof\n- [x] tests: TestThing`;

  const validBodies = [
    [
      "a token inside a nested-list tilde fence",
      proofAfter("- outer\n  - inner\n\n    ~~~\n    [proof: missing]\n    ~~~"),
    ],
    [
      "a token inside a blockquote tilde fence",
      proofAfter("> ~~~\n> [proof: missing]\n> ~~~"),
    ],
    ["a token inside indented code", proofAfter("    [proof: missing]")],
    ["a comment opener inside inline code", proofAfter("Use `<!--` to begin a comment.")],
    ["a comment opener inside a double-backtick span", proofAfter("Use ``<!--`` syntax.")],
    ["an escaped comment opener", proofAfter("Use \\<!-- as literal text.")],
    ["a comment marker inside an HTML attribute", proofAfter('<div title="<!--">Notes</div>')],
    ["a token inside an HTML attribute", proofAfter('<div title="[proof: missing]">Notes</div>')],
    ["a token inside raw HTML code", proofAfter("<div><code>[proof: missing]</code></div>")],
    ["a token inside raw HTML preformatted text", proofAfter("<div><pre>[proof: missing]</pre></div>")],
    ["a matching token split by inline HTML", proofAfter("<div>[proof: <em>tests</em>]</div>")],
  ] as const;

  for (const [label, body] of validBodies) {
    it(`accepts ${label} before real proof`, async () => {
      const res = await verify(body);
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });
  }

  it("accepts a nested-list code token in a CRLF body", async () => {
    const body = proofAfter(
      "- outer\n  - inner\n\n    ~~~\n    [proof: missing]\n    ~~~"
    ).replace(/\n/g, "\r\n");
    const res = await verify(body);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  for (const marker of ["```", "~~~"] as const) {
    it(`rejects a hidden Proof heading after an over-indented ${marker} closer`, async () => {
      const res = await verify(
        [marker, `    ${marker}`, "## Proof", "- [x] tests: TestThing"].join("\n")
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });

    it(`rejects a hidden checkbox after an over-indented ${marker} closer`, async () => {
      const res = await verify(
        ["## Proof", marker, `    ${marker}`, "- [x] tests: TestThing"].join("\n")
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("no checkbox lines");
    });
  }

  it("rejects a hidden Proof heading after a CRLF over-indented closer", async () => {
    const res = await verify(
      ["```", "    ```", "## Proof", "- [x] tests: TestThing"].join("\r\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  for (const [label, indent] of [["four spaces", "    "], ["a tab", "\t"]] as const) {
    it(`rejects an indented-code Proof heading with ${label}`, async () => {
      const res = await verify(`${indent}## Proof\n\n- [x] tests: TestThing`);
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });
  }

  for (const tag of ["div", "script"] as const) {
    it(`rejects a Proof block contained in raw ${tag} HTML`, async () => {
      const res = await verify(
        [`<${tag}>`, "## Proof", "- [x] tests: TestThing", `</${tag}>`].join("\n")
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });

    it(`rejects the only checkbox when it is raw ${tag} HTML`, async () => {
      const res = await verify(
        ["## Proof", `<${tag}>`, "- [x] tests: TestThing", `</${tag}>`].join("\n")
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("no checkbox lines");
    });
  }

  for (const [label, prefix] of [
    ["unequal backtick delimiters", "``[proof: missing]`"],
    ["escaped backticks", "\\`[proof: missing]\\`"],
  ] as const) {
    it(`rejects a visible dangling token surrounded by ${label}`, async () => {
      const res = await verify(proofAfter(prefix));
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("Dangling [proof: missing]");
    });
  }

  it("rejects a visible token whose marker is split by inline HTML", async () => {
    const res = await verify(proofAfter("<div>[pro<strong>of</strong>: missing]</div>"));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("Dangling [proof: missing]");
  });

  it("rejects a Proof heading inside pre across blank lines", async () => {
    // A raw <pre> block keeps its content as literal text: GitHub shows
    // "## Proof" as preformatted characters, not as a heading.
    const res = await verify(
      ["<pre>", "", "## Proof", "- [x] tests: TestThing", "", "</pre>"].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  it("rejects Proof swallowed by an unfinished HTML attribute", async () => {
    const res = await verify(proofAfter('<div title="'));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  for (const [label, prefix, suffix] of [
    ["a multiline comment", "<!-- start\nclosed --> <!--", "-->"],
    ["mixed raw HTML", "<div><!-- start\nclosed --> <!--", "-->\n</div>"],
  ] as const) {
    it(`rejects Proof hidden by a second comment opener after ${label}`, async () => {
      const res = await verify(`${proofAfter(prefix)}\n${suffix}`);
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });
  }
});

describe("CommonMark compatibility", () => {
  const runUrl = "https://github.com/florianhorner/demo/actions/runs/123";

  // Any spelling GitHub renders as a level-2 heading reading "Proof" opens the
  // section, and the boxes after it are validated. The emulating parser
  // required the literal source line `## Proof`, so a reviewer could see a
  // Proof section whose failed run the gate never looked up.
  for (const [label, heading] of [
    ["a list-prefixed heading", "- ## Proof"],
    ["a blockquote-prefixed heading", "> ## Proof"],
    ["closing heading hashes", "## Proof ##"],
    ["a setext heading", "Proof\n-----"],
    ["an emphasized heading", "## **Proof**"],
    ["an inline-code heading label", "## `Proof`"],
  ] as const) {
    it(`validates the boxes under ${label}`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(`${heading}\n\n- [x] tests: ${runUrl}`, { GITHUB_API_URL: api });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('conclusion is "failure"');
    });
  }

  it("does not take an inline-code example of a heading for the heading", async () => {
    const res = await verify("`## Proof`\n\n- [x] tests: TestThing");
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  for (const eol of ["\n", "\r\n"] as const) {
    it(`accepts an existing list-continuation Proof heading with ${JSON.stringify(eol)}`, async () => {
      const api = stubApi("success", "cafebabe");
      const res = await verify(
        ["- item", "  ## Proof", "", `- [x] tests: ${runUrl} [proof: tests]`].join(eol),
        { GITHUB_API_URL: api }
      );
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });
  }

  it("validates the boxes under every Proof heading, not only the last", async () => {
    // A reviewer sees both sections. Validating only the last one let a failed
    // run under the first stand unchecked in plain view.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof", `- [x] old: ${runUrl}`, "",
        "## Proof", "- [x] tests: TestThing",
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('[old] CI run 123 conclusion is "failure"');
  });

  it("continues validating through EOF after an unrelated later heading", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof", "- [x] tests: TestThing", "",
        "## Later", `- [ ] later: ${runUrl}`,
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('[later] CI run 123 conclusion is "failure"');
  });

  for (const box of ["x", "X", " "] as const) {
    it(`validates a failed run carried by a [${box}] checkbox`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(bodyWith(`- [${box}] tests: ${runUrl}`), {
        GITHUB_API_URL: api,
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('conclusion is "failure"');
    });
  }

  it("keeps unchecked n/a with a reason and checked test-name artifacts", async () => {
    const res = await verify(
      [
        "## Proof", "- [x] tests: TestThing [proof: tests]",
        "- [ ] schema: n/a — no schema changes [proof: schema]",
      ].join("\n")
    );
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("2 proof line(s) checked");
  });

  // Each of these renders as a run URL or a link to one. The emulating parser
  // read the source spelling, missed the run and failed the line as a missing
  // file path; the rendered line carries the URL (or its link target), so the
  // run is looked up like any other.
  for (const [label, artifact] of [
    ["backticks", `\`${runUrl}\``],
    ["a Markdown link", `[run](${runUrl})`],
    ["a reference link", "[run][r]\n\n[r]: " + runUrl],
    ["an angle autolink", `<${runUrl}>`],
  ] as const) {
    it(`looks up a run cited in ${label}`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(bodyWith(`- [x] tests: ${artifact}`), {
        GITHUB_API_URL: api,
        GITHUB_WORKSPACE: workspace(),
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('CI run 123 conclusion is "failure"');
    });
  }

  const htmlPreambles = [
    ["adjacent complete comments", "<!-- first --> <!-- second -->"],
    ["a multiline complete comment", "<!-- first\nsecond -->"],
    ["a prose-inline comment", "Text <!-- [proof: missing] --> continues."],
    ["a mixed HTML comment", "<div><!-- [proof: missing] --></div>"],
    ["an ordinary HTML attribute", '<div title="Notes">Text</div>'],
    ["complete comment text inside an attribute", '<div title="<!-- marker -->">Text</div>'],
    ["details markup", "<details>\n<summary>More</summary>\n\nNotes.\n</details>"],
  ] as const;

  for (const [label, prefix] of htmlPreambles) {
    it(`accepts ${label} before real proof`, async () => {
      const res = await verify(`${prefix}\n\n## Proof\n- [x] tests: TestThing`);
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });
  }

  it("preserves inline comments in a visible heading and artifact", async () => {
    const res = await verify(
      "## Pro<!-- heading -->of\n- [x] tests: Test<!-- artifact -->Thing"
    );
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  for (const [label, html] of [
    ["a div", "<div>[proof: missing]</div>"],
    ["details", "<details><summary>[proof: missing]</summary></details>"],
    ["a table", "<table><tr><td>[proof: missing]</td></tr></table>"],
    ["an inline tag inside the key", "<div>[proof: <em>missing</em>]</div>"],
  ] as const) {
    it(`rejects a visible dangling token in ${label}`, async () => {
      const res = await verify(`${html}\n\n## Proof\n- [x] tests: TestThing`);
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("Dangling");
    });
  }

  it("rejects actual Markdown proof inside details separated by blank lines", async () => {
    const api = stubApi("success", "cafebabe");
    const res = await verify(
      [
        "<details>", "<summary>Proof details</summary>", "", "## Proof",
        `- [x] tests: ${runUrl}`, "", "</details>",
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("The Proof heading must be outside <details>");
  });

  for (const [label, prefix] of [
    ["adjacent comment openers", "<!-- first --> <!--"],
    ["a raw HTML comment opener", "<div><!--"],
    ["a comment followed by mixed HTML", "<!-- first --><div><!--"],
  ] as const) {
    it(`rejects hidden proof after ${label}`, async () => {
      const res = await verify(`${prefix}\n\n## Proof\n- [x] tests: TestThing\n-->`);
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("does not contain a ## Proof section");
    });
  }
});

// ---------------------------------------------------------------------------
// 10. The gate validates the body GitHub renders, not an emulation of it.
//
// Every body here got past the remark + rehype-raw parser while GitHub showed
// reviewers a checked box, a run link or a claim the gate never looked at. The
// renderings come from GitHub itself (fixtures/github-renders.json).
// ---------------------------------------------------------------------------

describe("the gate validates the body GitHub renders", () => {
  const runUrl = "https://github.com/florianhorner/demo/actions/runs/123";

  it("rejects Proof swallowed by a comment marker inside escaped script text", async () => {
    // GitHub's tag filter escapes `<script>` to text, which leaves the `<!--`
    // inside it as a real comment opener: everything after it disappears from
    // the rendered body. The emulating parser treated the marker as script
    // text and validated a Proof section no reviewer could see.
    const res = await verify('<script>const marker = "<!--";</script>\n\n## Proof\n- [x] tests: TestThing');
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  for (const tag of ["template", "code"] as const) {
    it(`validates a Proof section GitHub displays inside raw ${tag} tags`, async () => {
      // GitHub renders the Markdown between these tags: a heading and a real
      // checked box (it strips <template> and keeps <code> as a monospace
      // wrapper). The emulating parser hid both, so a failed run cited here
      // was shown to reviewers and never looked up.
      const api = stubApi("failure", "cafebabe");
      const res = await verify(
        [
          `<${tag}>`, "", "## Proof",
          "- [x] tests: https://github.com/florianhorner/demo/actions/runs/123",
          "", `</${tag}>`,
        ].join("\n"),
        { GITHUB_API_URL: api }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('conclusion is "failure"');
    });
  }

  it("validates a checkbox and a claim that a raw <code> line wraps", async () => {
    // GitHub renders the Markdown inside as paragraphs and a checkbox list in
    // a monospace wrapper. That is prose, not a code example, so the claim in
    // it is checked like any other.
    const res = await verify(
      [
        "## Proof", "", "- [x] tests: some_test", "", "<code>", "",
        "- [x] runtime: proof/does-not-exist.txt", "",
        "Fixes the leak [proof: hidden_in_code]", "", "</code>",
      ].join("\n"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: proof/does-not-exist.txt");
    expect(res.out).toContain("Dangling [proof: hidden_in_code]");
  });

  it("validates what follows a raw <plaintext> line, which GitHub prints as text", async () => {
    const res = await verify(
      [
        "## Proof", "", "- [x] tests: some_test", "", "<plaintext>", "",
        "- [x] runtime: proof/does-not-exist.txt", "",
        "Fixes the freeze [proof: nonexistent_key]",
      ].join("\n"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: proof/does-not-exist.txt");
    expect(res.out).toContain("Dangling [proof: nonexistent_key]");
  });

  it("validates a run cited after prose that mentions <pre> and <code>", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof", "", "- [x] tests: test_freeze_regression", "",
        "The fix removes the `<pre>` wrapper, see the <code> element in the template.", "",
        "Fixes the freeze [proof: runtime]", "",
        `- [x] runtime: ${runUrl}`,
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('[runtime] CI run 123 conclusion is "failure"');
  });

  it("validates what follows a `<!x` line, which GitHub prints as text", async () => {
    const res = await verify(
      [
        "## Proof", "", "- [x] tests: some_test", "", "<!x", "",
        "- [x] runtime: proof/does-not-exist.txt", "",
        "Fixes the freeze [proof: nonexistent_key]", "", ">",
      ].join("\n"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: proof/does-not-exist.txt");
    expect(res.out).toContain("Dangling [proof: nonexistent_key]");
  });

  it("looks up a run hidden behind a comment GitHub does not close", async () => {
    // `--->` does not end a comment for GitHub's renderer, so the whole thing
    // is shown as text with the run URL linked.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      bodyWith(`- [x] runtime: test_freeze <!-- ${runUrl} --->`),
      { GITHUB_API_URL: api, GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('CI run 123 conclusion is "failure"');
  });

  it("checks a claim inside <xmp>, which GitHub escapes to text", async () => {
    const res = await verify(
      ["<xmp>", "Fixes the freeze [proof: hidden3]", "</xmp>", "", "## Proof", "", "- [x] tests: some_test"].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("Dangling [proof: hidden3]");
  });

  it("checks claims and boxes in a footnote", async () => {
    const res = await verify(
      [
        "Fixes the freeze.[^1]", "", "[^1]: Details", "",
        "    Also fixes the leak [proof: nonexistent_key]", "",
        "    - [x] runtime: proof/does-not-exist.txt", "",
        "## Proof", "", "- [x] tests: some_test",
      ].join("\n"),
      { GITHUB_WORKSPACE: workspace() }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("Dangling [proof: nonexistent_key]");
    expect(res.out).toContain("File path does not exist: proof/does-not-exist.txt");
  });

  it("validates every list marker GitHub renders as a checkbox", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof", "",
        `* [x] star: ${runUrl}`, "",
        `+ [x] plus: ${runUrl}`, "",
        `1. [x] ordered: ${runUrl}`, "",
        "- [ ] outer: n/a — grouping only",
        `  - [x] nested: ${runUrl}`,
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    for (const key of ["star", "plus", "ordered", "nested"]) {
      expect(res.out).toContain(`[${key}] CI run 123 conclusion is "failure"`);
    }
  });

  it("reads a nested checkbox as its own line, not as part of its parent", async () => {
    // Folding the nested item into its parent would make the parent's value
    // "proof/runtime.txt tests: TestThing", a file that does not exist.
    const ws = workspace();
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "runtime.txt"), "ran it\n");
    const res = await verify(
      ["## Proof", "", "- [x] runtime: proof/runtime.txt", "  - [x] tests: TestThing"].join("\n"),
      { GITHUB_WORKSPACE: ws }
    );
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("2 proof line(s) checked");
  });

  it("joins a proof line GitHub renders across a soft line break", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      ["## Proof", "", "- [x] ci:", `  ${runUrl}`, `- [x] sep: x\u2028${runUrl}`].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('[ci] CI run 123 conclusion is "failure"');
    expect(res.out).toContain('[sep] CI run 123 conclusion is "failure"');
  });

  it("rejects a checkbox after the Proof heading that is not a key: value line", async () => {
    // These used to be skipped without a word while GitHub showed each one as
    // a checked box linking the cited run.
    const res = await verify(
      ["## Proof", "", "- [x] tests: some_test", `- [x] runtime:${runUrl}`, `- [x] e2e : ${runUrl}`, "- [x] done"].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain(`(e.g. "tests: ..."): "runtime:${runUrl}"`);
    expect(res.out).toContain(`(e.g. "tests: ..."): "e2e : ${runUrl}"`);
    expect(res.out).toContain('(e.g. "tests: ..."): "done"');
  });

  it("does not let raw <input> HTML forge a checkbox", async () => {
    // GitHub's sanitizer removes raw inputs, so only task-list syntax makes a
    // checkbox.
    const res = await verify(
      '## Proof\n\n<ul><li><input type="checkbox" checked> tests: forged</li></ul>'
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("no checkbox lines");
  });

  it("reads a file path as GitHub displays it, and says how to keep it intact", async () => {
    // `__tests__` renders as bold "tests", so the displayed path does not exist.
    const res = await verify(
      bodyWith("- [x] runtime: scripts/__tests__/verify-proof-block.test.ts [proof: runtime]"),
      { GITHUB_WORKSPACE: `${import.meta.dir}/../..` }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: scripts/tests/verify-proof-block.test.ts");
    expect(res.out).toContain("put paths in backticks");
  });

  it("fails closed when GitHub cannot render the body", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("upstream unavailable", { status: 502 }),
    });
    servers.push(server);
    const res = await verify(bodyWith("- [x] tests: TestThing"), {
      GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("could not render the PR body through GitHub's Markdown API (HTTP 502");
    expect(res.out).not.toContain("Unexpected error");
  });

  it("reports what GitHub keeps of a body nested past its depth limit", async () => {
    // GitHub stops nesting at 256 blockquotes and drops what lies deeper,
    // including this Proof section.
    const res = await verify(">".repeat(20000) + " x\n\n## Proof\n\n- [x] tests: TestThing");
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("does not contain a ## Proof section");
  });

  const runUrl2 = "https://github.com/florianhorner/demo/actions/runs/124";

  for (const [label, link] of [
    ["a root-relative link", "[CI run](/florianhorner/demo/actions/runs/123)"],
    ["a protocol-relative link", "[CI run](//github.com/florianhorner/demo/actions/runs/123)"],
    ["a link relative to the PR page", "[CI run](../actions/runs/123)"],
    ["a raw HTML anchor", '<a href="/florianhorner/demo/actions/runs/123">CI run</a>'],
  ] as const) {
    it(`looks up a run cited through ${label}`, async () => {
      // GitHub keeps relative hrefs in the rendered body, and on the PR page
      // each of these opens run 123. Resolving only absolute URLs let a failed
      // run through.
      const api = stubApi("failure", "cafebabe");
      const res = await verify(bodyWith(`- [x] runtime: ${link}`), { GITHUB_API_URL: api });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('[runtime] CI run 123 conclusion is "failure"');
    });
  }

  it("looks up the run a link opens, not only the run its text names", async () => {
    const runs = runsById({
      "123": { conclusion: "success", head_sha: "cafebabe" },
      "124": { conclusion: "failure", head_sha: "cafebabe" },
    });
    const server = startApiStub(runs.handler);
    servers.push(server);
    const res = await verify(bodyWith(`- [x] tests: [${runUrl}](${runUrl2})`), {
      GITHUB_API_URL: stubUrl(server),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('CI run 124 conclusion is "failure"');
  });

  it("looks up each cited run once, however often a line names it", async () => {
    const runs = runsById({ "123": { conclusion: "success", head_sha: "cafebabe" } });
    const server = startApiStub(runs.handler);
    servers.push(server);
    const res = await verify(
      ["## Proof", "", `- [x] tests: ${runUrl}`, `- [x] build: ${runUrl}`].join("\n"),
      { GITHUB_API_URL: stubUrl(server) }
    );
    expect(res.exitCode).toBe(0);
    expect(runs.calls["123"]).toBe(1);
  });

  it("reports a failed run once when it is both a line's text and its link", async () => {
    const api = stubApi("failure", "cafebabe");
    const res = await verify(bodyWith(`- [x] tests: ${runUrl}`), { GITHUB_API_URL: api });
    expect(res.exitCode).not.toBe(0);
    expect(res.out.match(/\[tests\] CI run 123 conclusion/g)?.length).toBe(1);
  });

  it("reads a run URL followed by a note as the run", async () => {
    // `…/runs/123 (head cafebabe, success)`: a URL ends at the first space.
    const api = stubApi("success", "cafebabe");
    const res = await verify(bodyWith(`- [x] tests: ${runUrl} (head cafebabe, success)`), {
      GITHUB_API_URL: api,
    });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  it("opens the section at a lookalike heading and says it is not ## Proof", async () => {
    // A soft hyphen after "Proof" is invisible. Matching the heading text
    // exactly skipped this section and validated the real one hidden in a
    // collapsed <details> below, while reviewers read the failed run above.
    const api = stubApi("failure", "cafebabe");
    const res = await verify(
      [
        "## Proof\u00AD", "", `- [x] runtime: ${runUrl}`, "",
        "<details><summary>Notes</summary>", "", "## Proof", "", "- [x] tests: TestThing", "", "</details>",
      ].join("\n"),
      { GITHUB_API_URL: api }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('reads as the Proof heading but is not "## Proof"');
    expect(res.out).toContain('[runtime] CI run 123 conclusion is "failure"');
  });

  it("does not accept a Proof heading at another level", async () => {
    const res = await verify("### Proof\n\n- [x] tests: TestThing");
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('The heading "Proof" (h3) reads as the Proof heading but is not "## Proof"');
  });

  for (const [label, section] of [
    ["a nested bullet under a proof line", `- [x] runtime: CI green, run below\n  - ${runUrl}`],
    ["a paragraph", `- [x] tests: TestThing\n\nCI: ${runUrl}`],
    ["a table", `- [x] tests: TestThing\n\n| check | run |\n|---|---|\n| CI | ${runUrl} |`],
    ["a footnote", `- [x] tests: TestThing[^ci]\n\n[^ci]: ${runUrl}`],
    ["a bullet with an emoji for a checkbox", `- [x] tests: TestThing\n- :white_check_mark: runtime: ${runUrl}`],
  ] as const) {
    it(`looks up a run linked from ${label} in the Proof section`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(`## Proof\n\n${section}`, { GITHUB_API_URL: api });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('[Proof section] CI run 123 conclusion is "failure"');
    });
  }

  it("does not look up a run cited as context on an unchecked n/a line", async () => {
    // The render-only stub answers every run lookup with a 404, so a lookup
    // would show up as an error.
    const res = await verify(bodyWith(`- [ ] runtime: n/a — device lab down, see ${runUrl}`));
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  describe("a proof line cannot hide part of itself", () => {
    const run1 = "https://github.com/florianhorner/demo/actions/runs/1";
    const run666 = "https://github.com/florianhorner/demo/actions/runs/666";
    function runs() {
      const r = runsById({
        "1": { conclusion: "success", head_sha: "cafebabe" },
        "666": { conclusion: "failure", head_sha: "cafebabe" },
      });
      const server = startApiStub(r.handler);
      servers.push(server);
      return stubUrl(server);
    }
    const CONCEALING = "markup, which can hide or restyle part of it";

    // GitHub keeps <rp>, the fallback parenthesis of a ruby annotation, and
    // browsers do not display it. Read as part of the line, a hidden value in
    // front stood in for the visible one, and a hidden n/a excused a visible
    // run link. Each of these renders as an ordinary-looking proof line.
    for (const [label, line] of [
      ["a hidden URL in front of a path", "- [x] runtime: <ruby><rp>https://x </rp></ruby>`proof/fabricated.txt`"],
      ["a hidden green run in front of a failed one", `- [x] tests: <ruby><rp>${run1} </rp></ruby>\`${run666}\``],
      ["a hidden path before an em dash", "- [x] tests: <ruby><rp>proof/real.txt — </rp></ruby>`proof/fake.txt`"],
      ["a hidden n/a in front of a run link", `- [ ] tests: <ruby><rp>n/a — x</rp></ruby>[CI run on head](${run666})`],
      ["an <rp> outside <ruby>, which some engines hide", "- [x] runtime: <rp>`proof/fake.txt`</rp>"],
      ["a collapsed <details>", `- [ ] tests: <details><summary></summary>n/a — x</details>[CI run on head](${run666})`],
    ] as const) {
      it(`rejects ${label}`, async () => {
        const res = await verify(bodyWith(line), { GITHUB_API_URL: runs(), GITHUB_WORKSPACE: workspace() });
        expect(res.exitCode).not.toBe(0);
        expect(res.out).toContain(CONCEALING);
      });
    }

    for (const [label, line] of [
      ["a struck-through URL in front of a path", "- [x] runtime: ~~https://x.example~~ proof/fabricated-runtime.log"],
      [
        "a URL shrunk to a speck by nested <sup>/<sub>",
        "- [x] runtime: <sup><sup><sub><sub>https://x.example</sub></sub></sup></sup> proof/fabricated-runtime.log",
      ],
      ["a struck-through n/a in front of a run link", `- [ ] tests: ~~n/a — x~~ [CI run on head](${run666})`],
    ] as const) {
      it(`rejects ${label}`, async () => {
        const res = await verify(bodyWith(line), { GITHUB_API_URL: runs(), GITHUB_WORKSPACE: workspace() });
        expect(res.exitCode).not.toBe(0);
        expect(res.out).toContain(CONCEALING);
      });
    }

    for (const [label, line] of [
      ["a zero-width joiner in a run URL's host", `- [x] tests: https://github.com\u200C/florianhorner/demo/actions/runs/666`],
      ["a right-to-left override", `- [ ] tests: \u202Bn/a — x\u202C [CI run](${run666})`],
    ] as const) {
      it(`rejects ${label}`, async () => {
        const res = await verify(bodyWith(line), { GITHUB_API_URL: runs() });
        expect(res.exitCode).not.toBe(0);
        expect(res.out).toContain("invisible or text-direction characters");
      });
    }

    it("accepts emoji, a footnote reference and emphasis on a proof line", async () => {
      const res = await verify(
        ["Fixes it.[^1]", "", "## Proof", "", "- [x] tests: ✔️ **TestThing** passes[^1]", "", "[^1]: Ran twice."].join("\n")
      );
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });

    it("accepts a commit SHA GitHub links on a proof line", async () => {
      // GitHub renders a known SHA as <a><tt>c31eb57</tt></a>; tt is allowed.
      const res = await verify(bodyWith("- [x] tests: TestThing on c31eb57"), {
        PR_BASE_REPO_FULL_NAME: "florianhorner/gh-workflows",
        PR_HEAD_REPO_FULL_NAME: "florianhorner/gh-workflows",
        OWNED_REPOS: "florianhorner/gh-workflows",
      });
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });

    it("rejects a run link whose address cannot be parsed", async () => {
      // No invisible character in the text: only the link target is broken.
      const res = await verify(
        bodyWith("- [x] tests: [CI run](https://github.com%E2%80%8C/florianhorner/demo/actions/runs/666)"),
        { GITHUB_API_URL: runs() }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("URL cannot be parsed");
    });

    it("looks up a run joined to another URL by a comma", async () => {
      const res = await verify(
        bodyWith(`- [x] tests: https://gist.github.com/florianhorner/0123abcd,${run666}`),
        { GITHUB_API_URL: runs() }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('CI run 666 conclusion is "failure"');
    });

    it("treats a plain link in a note as context", async () => {
      const res = await verify(
        bodyWith(
          `- [x] tests: ${run1} (captured from http://localhost:8100/admin; checks: https://github.com/florianhorner/demo/commit/abc1234/checks)`
        ),
        { GITHUB_API_URL: runs() }
      );
      expect(res.exitCode).toBe(0);
      expect(res.out).toContain("1 proof line(s) checked");
    });

    it("reads a bare www. value as the run it links to", async () => {
      const res = await verify(bodyWith("- [x] tests: www.github.com/florianhorner/demo/actions/runs/666"), {
        GITHUB_API_URL: runs(),
        GITHUB_WORKSPACE: workspace(),
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('CI run 666 conclusion is "failure"');
      expect(res.out).not.toContain("File path");
    });

    it("validates every URL a value shows, not only the first", async () => {
      const res = await verify(bodyWith(`- [x] tests: ${run1} \`${run666}\``), {
        GITHUB_API_URL: runs(),
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('CI run 666 conclusion is "failure"');
    });
  });

  for (const [label, heading] of [
    ["a combining grapheme joiner", "## Pro\u034Fof"],
    ["Cyrillic lookalike letters", "## \u0420\u0433\u043E\u043Ef"],
    ["trailing punctuation", "## Proof:"],
    ["a trailing braille blank", "## Proof\u2800"],
    ["a trailing Hangul filler, a letter that draws nothing", "## Proof\u3164"],
    ["a suffix shrunk to a speck", "## Proof<sup><sup><sub><sub>s</sub></sub></sup></sup>"],
  ] as const) {
    it(`opens the section at a heading with ${label} and says it is not ## Proof`, async () => {
      const api = stubApi("failure", "cafebabe");
      const res = await verify(
        [
          heading, "", `- [x] tests: [CI green on head](${runUrl})`, "",
          "<details><summary>notes</summary>", "", "## Proof", "", "- [ ] tests: n/a — see above", "", "</details>",
        ].join("\n"),
        { GITHUB_API_URL: api }
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain('reads as the Proof heading but is not "## Proof"');
      expect(res.out).toContain('[tests] CI run 123 conclusion is "failure"');
    });
  }

  it("rejects a check-run page cited as an artifact or linked in the section", async () => {
    const res = await verify(
      [
        "## Proof", "", "- [x] tests: https://github.com/florianhorner/demo/runs/666", "",
        "Checks: [all green](https://github.com/florianhorner/demo/commit/abc123/checks)",
      ].join("\n")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("[tests] A check-run page cannot be verified");
    expect(res.out).toContain("[Proof section] A check-run page cannot be verified");
  });

  it("follows a www. run link to the https page instead of rejecting it", async () => {
    const r = runsById({ "123": { conclusion: "success", head_sha: "cafebabe" } });
    const server = startApiStub(r.handler);
    servers.push(server);
    const res = await verify(
      "## Proof\n\n- [x] tests: TestThing\n\nCI: www.github.com/florianhorner/demo/actions/runs/123",
      { GITHUB_API_URL: stubUrl(server) }
    );
    expect(res.exitCode).toBe(0);
    expect(r.calls["123"]).toBe(1);
  });

  it("reads claim tokens in any case and spacing", async () => {
    const res = await verify(bodyWith("- [x] tests: TestThing", "Fixes it [Proof: missing] and [ proof : missing ]."));
    expect(res.exitCode).not.toBe(0);
    expect(res.out.match(/Dangling \[proof: missing\]/g)?.length).toBe(1);
  });

  it("reads a claim token through an invisible character", async () => {
    const res = await verify(bodyWith("- [x] tests: TestThing", "Fixes it [pro\u200Bof: missing]."));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("Dangling [proof: missing]");
  });
});

// ---------------------------------------------------------------------------
// The HTML walk itself. These feed hand-written HTML on purpose: they pin
// defensive paths no GitHub rendering reaches today (a deep tree, a surviving
// <template>, two boxes in one item), so a future renderer change cannot turn
// them into a crash or a hidden checkbox.
// ---------------------------------------------------------------------------

describe("the rendered-HTML walk", () => {
  function htmlApi(html: string): string {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/markdown"
          ? new Response(html, { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }
  const box = (text: string) =>
    `<li class="task-list-item"><input type="checkbox" disabled checked> ${text}</li>`;

  for (const [label, heading] of [
    ["Coptic", "\u2CA2roof"],
    ["small capitals", "\u1D18\u0280\u1D0F\u1D0F\uA730"],
    ["Cherokee", "\u13E2roof"],
  ] as const) {
    it(`rejects a ${label} heading steering validation into collapsed details`, async () => {
      // These letters are deliberately outside the lookalike table. The
      // structural rule must reject the hidden canonical heading regardless.
      const html =
        `<h2>${heading}</h2><ul>${box("runtime: proof/missing.txt")}</ul>` +
        `<details><summary>Notes</summary><h2>Proof</h2><ul>${box("tests: TestThing")}</ul></details>`;
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("The Proof heading must be outside <details>");
      expect(res.out).not.toContain("does not contain a ## Proof section");
    });
  }

  for (const [label, wrapper] of [
    ["initially open details", (html: string) => `<details open><summary>Proof</summary>${html}</details>`],
    ["nested details", (html: string) => `<details><summary>Notes</summary><div><details><summary>More</summary>${html}</details></div></details>`],
    ["template content inside details", (html: string) => `<details><summary>Notes</summary><template>${html}</template></details>`],
  ] as const) {
    it(`rejects a Proof heading in ${label}`, async () => {
      const html = wrapper(`<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`);
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("The Proof heading must be outside <details>");
    });
  }

  it("rejects a later hidden Proof heading after a visible Proof section", async () => {
    const html =
      `<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>` +
      `<details><summary>Notes</summary><h2>Proof</h2><ul>${box("schema: TestSchema")}</ul></details>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("The Proof heading must be outside <details>");
  });

  it("rejects a lookalike Proof heading inside details after visible proof", async () => {
    const html =
      `<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>` +
      "<details><summary>Notes</summary><h3>Proof:</h3></details>";
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("The Proof heading must be outside <details>");
  });

  it("allows collapsible notes before and after a visible Proof section", async () => {
    const html =
      "<details><summary>Notes</summary><h2>Background</h2><p>Context</p></details>" +
      `<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>` +
      "<details><summary>More notes</summary><p>Context</p></details>";
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  for (const [tag, wrap] of [
    ["ruby", (html: string) => `<ruby>x<rp>${html}</rp><rt>y</rt></ruby>`],
    ["template", (html: string) => `<template>${html}</template>`],
    ["sup", (html: string) => "<sup>".repeat(8) + html + "</sup>".repeat(8)],
    ["sub", (html: string) => `<sub>${html}</sub>`],
    ["small", (html: string) => "<small>".repeat(24) + html + "</small>".repeat(24)],
    ["del", (html: string) => `<del>${html}</del>`],
    ["section", (html: string) => `<section data-footnotes class="footnotes">${html}</section>`],
  ] as const) {
    it(`rejects a heading steering validation into <${tag}>`, async () => {
      // Ruby fallback text and template content are never drawn, nested
      // <sup>, <sub> or <small> shrink a heading to nothing, and a struck or
      // footnoted one is easy to pass over: the same steering as a collapsed
      // <details>, through a different container.
      const html =
        `<h2>\u2CA2roof</h2><ul>${box("runtime: proof/missing.txt")}</ul>` +
        wrap(`<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`);
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain(`The Proof heading must not be inside <${tag}>`);
    });
  }

  for (const tag of ["span", "mark", "kbd", "s", "ins", "abbr", "figure"]) {
    it(`rejects a Proof heading inside <${tag}>, which is not on the allowed list`, async () => {
      const html = `<${tag}><h2>Proof</h2><ul>${box("tests: TestThing")}</ul></${tag}>`;
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain(`The Proof heading must not be inside <${tag}>`);
    });
  }

  for (const tag of ["a", "b", "code", "em", "i", "strong", "tt", "u"]) {
    it(`accepts a Proof heading that an unclosed <${tag}> above it wraps`, async () => {
      // A tag named in the prose without backticks stays open, and HTML reopens
      // it around every later block, the Proof heading included. This is the
      // shape GitHub returns (recorded for <code>): closed at the end of the
      // paragraph, reopened once around what follows.
      const html =
        `<p>Replaces the <${tag}> wrapper in the header.</${tag}></p>` +
        `<${tag}><h2>Proof</h2><ul>${box("tests: TestThing")}</ul></${tag}>`;
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
      expect(res.out).toContain("1 proof line(s) checked");
      expect(res.exitCode).toBe(0);
    });
  }

  for (const [label, wrap] of [
    ["two <code>", (html: string) => `<code><code>${html}</code></code>`],
    ["<code> in <tt>", (html: string) => `<tt><code>${html}</code></tt>`],
    ["twenty <code>", (html: string) => "<code>".repeat(20) + html + "</code>".repeat(20)],
    ["<code> in <pre>", (html: string) => `<pre><code>${html}</code></pre>`],
  ] as const) {
    it(`rejects a Proof heading drawn smaller by ${label}`, async () => {
      // GitHub draws <code>, <tt> and <pre> at 85% of their parent, so nesting
      // shrinks a heading out of sight while every container is allowed.
      const html =
        `<h2>\u2CA2roof</h2><ul>${box("runtime: proof/missing.txt")}</ul>` +
        wrap(`<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`);
      const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
      expect(res.exitCode).not.toBe(0);
      expect(res.out).toContain("The Proof heading must not be inside more than one <code>, <tt> or <pre>");
    });
  }

  it("accepts a Proof heading in a list item, a quote, an alert or a table", async () => {
    const section = `<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`;
    const [listed, quoted, alert, table] = await Promise.all([
      verify("(body)", { GITHUB_API_URL: htmlApi(`<ul><li>${section}</li></ul>`) }),
      verify("(body)", { GITHUB_API_URL: htmlApi(`<blockquote>${section}</blockquote>`) }),
      verify("(body)", {
        GITHUB_API_URL: htmlApi(`<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p>${section}</div>`),
      }),
      // GitHub wraps every table it renders in <markdown-accessiblity-table>.
      verify("(body)", {
        GITHUB_API_URL: htmlApi(
          `<markdown-accessiblity-table><table role="table"><tbody><tr><td>${section}</td></tr></tbody></table></markdown-accessiblity-table>`
        ),
      }),
    ]);
    for (const res of [listed, quoted, alert, table]) {
      expect(res.out).toContain("1 proof line(s) checked");
      expect(res.exitCode).toBe(0);
    }
  });

  it("reads a heading as Proof by what it shows, even through markup a proof line may not carry", async () => {
    // `<ins>` keeps "Proof" on screen. The gate used to read only the text
    // outside such markup, found nothing, and opened the section at the
    // canonical heading below, so the claim under the visible one went unread.
    const html =
      `<h2><ins>Proof</ins></h2><ul>${box("runtime: proof/missing.txt")}</ul>` +
      `<h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('The heading "Proof" (h2) reads as the Proof heading but is not "## Proof"');
    expect(res.out).toContain("File path does not exist: proof/missing.txt");
  });

  it("checks a file artifact against git as a literal path, not a pathspec", async () => {
    // An untracked file named `*` next to a tracked one matched it as a glob.
    const ws = workspace();
    mkdirSync(join(ws, "proof"), { recursive: true });
    writeFileSync(join(ws, "proof", "real.txt"), "ok\n");
    writeFileSync(join(ws, "proof", "*"), "not committed\n");
    execFileSync("git", ["init", "-q"], { cwd: ws, ...GIT_OPTS });
    execFileSync("git", ["add", "proof/real.txt"], { cwd: ws, ...GIT_OPTS });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "chore: init"],
      { cwd: ws, ...GIT_OPTS }
    );
    const verdict = (artifact: string) =>
      verify("(body)", {
        GITHUB_API_URL: htmlApi(`<h2>Proof</h2><ul>${box(`runtime: <code>${artifact}</code>`)}</ul>`),
        GITHUB_WORKSPACE: ws,
      });
    const [glob, real] = await Promise.all([verdict("proof/*"), verdict("proof/real.txt")]);
    expect(glob.exitCode).not.toBe(0);
    expect(glob.out).toContain("File path is not committed to the PR branch: proof/*");
    expect(real.exitCode).toBe(0);
  });

  function htmlAndRuns(html: string, onRun: (path: string) => Response): string {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/markdown") return new Response(html, { headers: { "content-type": "text/html" } });
        return onRun(path);
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  it("accepts a cited run only from this PR's own repository", async () => {
    // Any other repository can run the PR's head commit: push it there, add an
    // always-green workflow, and head_sha and conclusion both check out. That
    // includes a fork PR's head repository, whose workflows its author controls.
    const lookups: string[] = [];
    const green = (repository?: string) => (path: string) => {
      lookups.push(path);
      return Response.json({
        conclusion: "success",
        head_sha: "cafebabe",
        ...(repository ? { repository: { full_name: repository } } : {}),
      });
    };
    const citing = (repo: string) =>
      `<h2>Proof</h2><ul>${box(`tests: <a href="https://github.com/${repo}/actions/runs/7">https://github.com/${repo}/actions/runs/7</a>`)}</ul>`;
    const fork = { PR_BASE_REPO_FULL_NAME: "florianhorner/demo", PR_HEAD_REPO_FULL_NAME: "someone/fork" };

    const [elsewhere, head, base, renamed, unknown] = await Promise.all([
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("attacker/anything"), green()), ...fork }),
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("someone/fork"), green()), ...fork }),
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("Florianhorner/Demo"), green()), ...fork }),
      // An old URL of a renamed repository redirects to the same run; the API's
      // answer names the repository as it is now.
      verify("(body)", {
        GITHUB_API_URL: htmlAndRuns(citing("florianhorner/old-demo"), green("florianhorner/demo")),
        ...fork,
      }),
      verify("(body)", {
        GITHUB_API_URL: htmlAndRuns(citing("florianhorner/demo"), green()),
        PR_BASE_REPO_FULL_NAME: "",
        PR_HEAD_REPO_FULL_NAME: "",
      }),
    ]);

    expect(elsewhere.exitCode).not.toBe(0);
    expect(elsewhere.out).toContain("CI run 7 ran in attacker/anything, not in this PR's repository florianhorner/demo");
    expect(head.exitCode).not.toBe(0);
    expect(head.out).toContain("CI run 7 ran in someone/fork, not in this PR's repository florianhorner/demo");
    expect(base.exitCode).toBe(0);
    expect(renamed.exitCode).toBe(0);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.out).toContain("CI run 7 cannot be attributed: PR_BASE_REPO_FULL_NAME is not set");
    // A run that cannot be attributed is not looked up.
    expect(lookups).toHaveLength(4);
  });

  it("decides a run's repository by the API's answer, and uses the head repository only without a base", async () => {
    const answering = (repository: string) => () =>
      Response.json({ conclusion: "success", head_sha: "cafebabe", repository: { full_name: repository } });
    const citing = (repo: string) =>
      `<h2>Proof</h2><ul>${box(`tests: <a href="https://github.com/${repo}/actions/runs/7">https://github.com/${repo}/actions/runs/7</a>`)}</ul>`;
    const headOnly = { PR_BASE_REPO_FULL_NAME: "", PR_HEAD_REPO_FULL_NAME: "florianhorner/demo" };
    const [moved, viaHead, notHead] = await Promise.all([
      // The URL names this PR's repository, but the API says the run is elsewhere.
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("florianhorner/demo"), answering("someone/fork")) }),
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("florianhorner/demo"), answering("florianhorner/demo")), ...headOnly }),
      verify("(body)", { GITHUB_API_URL: htmlAndRuns(citing("attacker/anything"), answering("attacker/anything")), ...headOnly }),
    ]);
    expect(moved.exitCode).not.toBe(0);
    expect(moved.out).toContain("CI run 7 ran in someone/fork, not in this PR's repository florianhorner/demo");
    expect(viaHead.exitCode).toBe(0);
    expect(notHead.exitCode).not.toBe(0);
    expect(notHead.out).toContain("CI run 7 ran in attacker/anything, not in this PR's repository florianhorner/demo");
  });

  it("walks a 20,000-deep tree without overflowing the stack", async () => {
    const html =
      "<div>".repeat(20000) + "x" + "</div>".repeat(20000) +
      `<h2>Proof</h2><ul>${box("runtime: proof/missing.txt")}</ul>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: proof/missing.txt");
    expect(res.out).not.toContain("RangeError");
    // parse5 grows faster than linearly with depth; a slow shared runner must
    // not turn this into a timeout.
  }, 30_000);

  it("reads a checkbox inside a <template> element", async () => {
    const html = `<h2>Proof</h2><template><ul>${box("runtime: proof/missing.txt")}</ul></template>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html), GITHUB_WORKSPACE: workspace() });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("File path does not exist: proof/missing.txt");
  });

  it("reads two boxes in one list item as one line", async () => {
    const html =
      '<h2>Proof</h2><ul><li><input type="checkbox" checked> tests: TestThing ' +
      '<input type="checkbox" checked></li></ul>';
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  it("treats code with a line break as a code example", async () => {
    const html = `<p><code>a<br>[proof: missing]</code></p><h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("1 proof line(s) checked");
  });

  it("does not join claim text across adjacent blocks", async () => {
    // Without a break at block edges "[proof: te" + "sts]" reads as a valid
    // claim for the key "tests".
    const html = `<div>Fixes [proof: te</div><div>sts] it</div><h2>Proof</h2><ul>${box("tests: TestThing")}</ul>`;
    const res = await verify("(body)", { GITHUB_API_URL: htmlApi(html) });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("Dangling [proof: te");
  });
});

// ---------------------------------------------------------------------------
// 11. Guards that nothing pinned: each could be deleted with the suite green.
// ---------------------------------------------------------------------------

describe("guards no other test pinned", () => {
  function proxyTo(target: string, answer: (n: number, req: Request) => Response | null) {
    const seen = { calls: 0, auth: [] as (string | null)[] };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.calls++;
        seen.auth.push(req.headers.get("authorization"));
        const early = answer(seen.calls, req);
        if (early) return early;
        const url = new URL(req.url);
        return fetch(`${target}${url.pathname}`, {
          method: req.method,
          headers: req.headers,
          body: await req.text(),
        });
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, seen };
  }

  it("retries a render that fails with a server error, and then succeeds", async () => {
    const proxy = proxyTo(renderOnlyApi(), (n) =>
      n <= 2 ? new Response("upstream unavailable", { status: 500 }) : null
    );
    const res = await verify(bodyWith("- [x] tests: TestThing"), { GITHUB_API_URL: proxy.url });
    expect(res.exitCode).toBe(0);
    expect(proxy.seen.calls).toBe(3);
  });

  it("does not retry a render refused with a client error", async () => {
    const proxy = proxyTo(renderOnlyApi(), () => new Response("bad request", { status: 400 }));
    const res = await verify(bodyWith("- [x] tests: TestThing"), { GITHUB_API_URL: proxy.url });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("(HTTP 400: bad request)");
    expect(proxy.seen.calls).toBe(1);
  });

  it("sends the token with the render call", async () => {
    const proxy = proxyTo(renderOnlyApi(), () => null);
    const res = await verify(bodyWith("- [x] tests: TestThing"), { GITHUB_API_URL: proxy.url });
    expect(res.exitCode).toBe(0);
    expect(proxy.seen.auth[0]).toBe("Bearer test-token");
  });

  it("names each malformed box instead of claiming there are none", async () => {
    const res = await verify("## Proof\n\n- [x] done\n- [x] also done");
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain('"key: value" form with a key that has no spaces');
    expect(res.out).toContain('"also done"');
    expect(res.out).not.toContain("contains no checkbox lines");
  });

  it("rejects a generic artifact URL over plain http", async () => {
    const res = await verify(bodyWith("- [x] runtime: http://example.com/screenshot.png [proof: runtime]"));
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("must use https");
  });

  it("reports a dangling token once, however often it is cited", async () => {
    const res = await verify(
      bodyWith("- [x] tests: TestThing", "Fixes it [proof: missing]. Also [proof: missing].")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out.match(/Dangling \[proof: missing\]/g)?.length).toBe(1);
  });

  it("rejects a relative traversal even with no GITHUB_WORKSPACE to resolve against", async () => {
    const res = await verify(bodyWith("- [x] runtime: ../../../../etc/hosts [proof: runtime]"), {
      GITHUB_WORKSPACE: "",
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("repository-relative");
  });

  it("reports a malformed percent-escape in a run id as a gate error", async () => {
    const res = await verify(
      bodyWith("- [x] tests: https://github.com/florianhorner/demo/actions/runs/100%gg [proof: tests]")
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("unreadable run id");
    expect(res.out).not.toContain("Unexpected error");
  });
});
