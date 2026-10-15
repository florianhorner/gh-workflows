import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { startApiStub, stubUrl, type RouteHandler } from "./github-api-stub";

// Paths through verify-proof-block.ts that no other test pins. Each case below
// names a guard that could be deleted, or a request detail that could change,
// with the rest of the suite still green:
//
//   - a run counted as proof whenever its conclusion was anything but "failure"
//   - a checked box with no value, or a checked `n/a`, passing
//   - a test identifier such as `parser::tests::roundtrip` read as a URL, and
//     a run URL that GitHub does not link read as a file path
//   - the render and run-lookup requests going out in a shape the local stub
//     never checks (auth header, content type, which repository is asked)
//   - the error paths of both API calls (throttling, an unreachable host, a
//     refused or malformed answer)
//   - a claim written with fullwidth brackets, and content above the Proof
//     heading, being read differently from how a reviewer reads them
//   - the workflow no longer passing the verifier the token or PR head SHA,
//     which turns every run lookup into a silent skip
//
// Nothing here calls GitHub. Cases that need a real rendering reuse bodies that
// are already recorded in fixtures/github-renders.json (the text and the
// rendering context must match a recording exactly, or the stub answers 422);
// the rest hand the verifier synthetic HTML, like the HTML-walk cases in
// proof-gate-bypasses.test.ts.

// Test-only override, so a modified copy of the verifier can be run against
// these cases to prove each one fails without the code it guards.
const SCRIPT = process.env.PROOF_TEST_SCRIPT ?? `${import.meta.dir}/../verify-proof-block.ts`;

let servers: ReturnType<typeof Bun.serve>[] = [];
let files: string[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  for (const f of files) rmSync(f, { recursive: true, force: true });
  files = [];
});

interface Result {
  exitCode: number;
  out: string;
}

/** Starts a server on 127.0.0.1 and returns its base URL. */
function serve(handler: RouteHandler): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handler(req, new URL(req.url)),
  });
  servers.push(server);
  return stubUrl(server);
}

/** POST /markdown from the recordings; every other request goes to `handler`. */
function recorded(handler?: RouteHandler): string {
  const server = startApiStub(handler);
  servers.push(server);
  return stubUrl(server);
}

/** POST /markdown answers with `html`, whatever the body; other requests go to `other`. */
function rendersAs(html: string, other?: RouteHandler): string {
  return serve((req, url) =>
    req.method === "POST" && url.pathname === "/markdown"
      ? new Response(html, { headers: { "content-type": "text/html" } })
      : other
        ? other(req, url)
        : new Response("not found", { status: 404 })
  );
}

async function spawnVerifier(
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<Result> {
  const api = env.GITHUB_API_URL;
  // Everything in this file talks to a local stub. Refuse to run against
  // anything else, so a typo cannot send a request to the real API.
  if (!api || !/^http:\/\/127\.0\.0\.1:\d+$/.test(api)) {
    throw new Error(`GITHUB_API_URL must point at a local stub, got "${api}"`);
  }
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      PR_HEAD_SHA: "cafebabe",
      PR_BASE_REF: "main",
      PR_HEAD_REPO_FULL_NAME: "florianhorner/demo",
      PR_BASE_REPO_FULL_NAME: "florianhorner/demo",
      OWNED_REPOS: "florianhorner/demo",
      // Not inherited: on a runner this is the checkout of the repository
      // under test, and an unset value is the case the cases below rely on.
      GITHUB_WORKSPACE: "",
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, out: stdout + stderr };
}

async function verify(body: string, env: Record<string, string>): Promise<Result> {
  const tmp = join(tmpdir(), `coverage-gaps-${crypto.randomUUID()}.md`);
  files.push(tmp);
  writeFileSync(tmp, body);
  return spawnVerifier(["--body-file", tmp], env);
}

// The markup GitHub's renderer produces for a task-list item and its heading
// (see the recordings), so synthetic pages look like rendered ones.
const taskBox = (text: string, checked = true) =>
  `<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" ` +
  `aria-label="${checked ? "Completed" : "Incomplete"} task"${checked ? ' checked=""' : ""}> ${text}</li>`;

const proofSection = (...items: string[]) =>
  `<h2>Proof</h2>\n<ul class="contains-task-list">\n${items.join("\n")}\n</ul>\n`;

const RUN = "https://github.com/florianhorner/demo/actions/runs/123";
// Both bodies are recorded under the context "florianhorner/demo".
const RUN_BODY = `A change.\n\n\n## Proof\n\n- [x] tests: ${RUN} [proof: tests]\n`;
const PLAIN_BODY = "A change.\n\n\n## Proof\n\n- [x] tests: TestThing\n";

/** The API's answer for a run; `conclusion` is null while it is still going. */
const runIs =
  (conclusion: string | null): RouteHandler =>
  () =>
    Response.json({
      status: conclusion === null ? "in_progress" : "completed",
      conclusion,
      head_sha: "cafebabe",
    });

describe("verify-proof-block: paths no other test pins", () => {
  it("accepts a cited run only when its conclusion is success", async () => {
    // The API reports null while a run is going, and cancelled, skipped,
    // neutral, timed_out and the rest for runs that proved nothing. Only
    // `failure` was ever tried, so a check that turned away just that one
    // value would have passed everything else.
    const notSuccess = [
      null, "cancelled", "skipped", "neutral", "timed_out", "action_required", "startup_failure", "stale",
    ] as const;
    const verdicts = Object.fromEntries(
      await Promise.all(
        [...notSuccess, "success"].map(async (conclusion) => {
          const res = await verify(RUN_BODY, { GITHUB_API_URL: recorded(runIs(conclusion)) });
          return [
            String(conclusion),
            {
              rejected: res.exitCode !== 0,
              named: res.out.includes(`conclusion is "${conclusion}", expected "success"`),
            },
          ] as const;
        })
      )
    );
    expect(verdicts).toEqual({
      ...Object.fromEntries(notSuccess.map((c) => [String(c), { rejected: true, named: true }])),
      success: { rejected: false, named: false },
    });
  }, 60_000);

  it("judges a proof line's value by its shape: empty, n/a, a test identifier, an unlinked run URL", async () => {
    // Run with no workspace, so a guard that is missing shows up as a pass
    // instead of as a missing file further down.
    //   - A value that is only the line's own `[proof: key]` tag is empty once
    //     the tag is stripped; without the guards it reaches the terminal accept.
    //     `n/a` on a checked box is the same story.
    //   - `parser::tests::roundtrip` parses as a URL with the scheme "parser:",
    //     and is a test name. Reading it as a URL turns it into "must use https".
    //   - `https:/host/...` and a run URL ending in a period (here with no link
    //     around it, as GitHub leaves text it does not autolink) are run
    //     citations to URL parsers: they must be looked up, not read as a path.
    //   - `n/a: reason` has no separator the rule reads, so it is not a reason.
    //   - An en dash ends an artifact's description like an em dash does (this
    //     one needs a checkout to look the file up in), and with no checkout at
    //     all a relative path is accepted unlooked-at: local usage.
    const checkout = mkdtempSync(join(tmpdir(), "coverage-gaps-ws-"));
    files.push(checkout);
    mkdirSync(join(checkout, "proof"));
    writeFileSync(join(checkout, "proof", "real.txt"), "ran it\n");

    const run = "github.com/florianhorner/demo/actions/runs/123";
    const failed = '[tests] CI run 123 conclusion is "failure"';
    const cases: {
      name: string;
      item: string;
      rejected: boolean;
      message: string;
      env?: Record<string, string>;
    }[] = [
      { name: "checkedEmpty", item: taskBox("tests: [proof: tests]"), rejected: true, message: "[tests] Checked box has no artifact value." },
      { name: "uncheckedEmpty", item: taskBox("schema: [proof: schema]", false), rejected: true, message: "[schema] Unchecked box must have a value" },
      {
        name: "checkedNa",
        item: taskBox("schema: n/a \u{2014} no schema changes [proof: schema]"),
        rejected: true,
        message: "[schema] Checked box cannot have n/a value.",
      },
      { name: "naWithColon", item: taskBox("schema: n/a: not applicable", false), rejected: true, message: '[schema] Unchecked "n/a" needs a reason' },
      { name: "naWithEnDash", item: taskBox("schema: n/a \u{2013} no schema changes", false), rejected: false, message: "1 proof line(s) checked" },
      { name: "testIdentifier", item: taskBox("tests: parser::tests::roundtrip"), rejected: false, message: "1 proof line(s) checked" },
      { name: "singleSlashRunUrl", item: taskBox(`tests: https:/${run}`), rejected: true, message: failed },
      { name: "runUrlWithPeriod", item: taskBox(`tests: https://${run}.`), rejected: true, message: failed },
      {
        name: "enDashDescription",
        item: taskBox("runtime: proof/real.txt \u{2013} parity check"),
        rejected: false,
        message: "was not verified",
        env: { GITHUB_WORKSPACE: checkout },
      },
      { name: "relativePathWithoutCheckout", item: taskBox("runtime: proof/local.log"), rejected: false, message: "1 proof line(s) checked" },
    ];
    const verdicts = Object.fromEntries(
      await Promise.all(
        cases.map(async ({ name, item, message, env }) => {
          const res = await verify("(body)", {
            GITHUB_API_URL: rendersAs(proofSection(item), runIs("failure")),
            ...env,
          });
          return [name, { rejected: res.exitCode !== 0, named: res.out.includes(message) }] as const;
        })
      )
    );
    expect(verdicts).toEqual(
      Object.fromEntries(cases.map(({ name, rejected }) => [name, { rejected, named: true }]))
    );
  }, 60_000);

  it("retries a throttled render, and fails closed when the render is unreachable or refused", async () => {
    // README: "The call is retried on server errors and throttling". Only 5xx
    // retries were exercised.
    const real = recorded();
    let renderCalls = 0;
    const throttledOnce = serve(async (req, url) => {
      renderCalls++;
      if (renderCalls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return fetch(`${real}${url.pathname}`, {
        method: req.method,
        headers: req.headers,
        body: await req.text(),
      });
    });
    // A port nothing listens on: bind one, remember its address, release it.
    const idle = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const nothingListening = stubUrl(idle);
    idle.stop(true);
    const rateLimited = serve(
      () =>
        new Response('{"message":"API rate limit exceeded for user ID 1."}', {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        })
    );

    const [retried, unreachable, refused] = await Promise.all([
      verify(PLAIN_BODY, { GITHUB_API_URL: throttledOnce }),
      verify(PLAIN_BODY, { GITHUB_API_URL: nothingListening }),
      verify(PLAIN_BODY, { GITHUB_API_URL: rateLimited }),
    ]);

    expect(retried.exitCode).toBe(0);
    expect(renderCalls).toBe(2);

    // A transport failure is a gate error with the gate's own message. Without
    // the catch around fetch it escapes as an unexpected crash.
    expect(unreachable.exitCode).not.toBe(0);
    expect(unreachable.out).toContain("could not render the PR body through GitHub's Markdown API");
    expect(unreachable.out).not.toContain("Unexpected error");

    // A primary rate limit arrives as a 403; the check fails and says why.
    expect(refused.exitCode).not.toBe(0);
    expect(refused.out).toContain("could not render the PR body through GitHub's Markdown API (HTTP 403");
    expect(refused.out).toContain("rate limit exceeded");
    expect(refused.out).not.toContain("Unexpected error");
  }, 60_000);

  it("rejects a cited run when the API refuses it or answers with something unreadable", async () => {
    // The stub answers a run lookup with a 404 for anything it was not told
    // about, but no test asserted that message, and a token without
    // `actions: read` gets a 403 in production.
    const cases = {
      notFound: [() => Response.json({ message: "Not Found" }, { status: 404 }), "[tests] CI run URL returned HTTP 404: florianhorner/demo/runs/123"],
      forbidden: [() => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }), "[tests] CI run URL returned HTTP 403"],
      serverError: [() => Response.json({ message: "boom" }, { status: 500 }), "[tests] CI run URL returned HTTP 500"],
      notJson: [() => new Response("<html>maintenance</html>", { headers: { "content-type": "text/html" } }), "[tests] Failed to fetch CI run:"],
    } as const satisfies Record<string, readonly [RouteHandler, string]>;
    const verdicts = Object.fromEntries(
      await Promise.all(
        Object.entries(cases).map(async ([name, [handler, message]]) => {
          const res = await verify(RUN_BODY, { GITHUB_API_URL: recorded(handler) });
          return [
            name,
            {
              rejected: res.exitCode !== 0,
              named: res.out.includes(message),
              crashed: res.out.includes("Unexpected error"),
            },
          ] as const;
        })
      )
    );
    const rejectedAndNamed = { rejected: true, named: true, crashed: false };
    expect(verdicts).toEqual({
      notFound: rejectedAndNamed,
      forbidden: rejectedAndNamed,
      serverError: rejectedAndNamed,
      notJson: rejectedAndNamed,
    });
  }, 60_000);

  it("sends the render request GitHub's API needs, with the token only when there is one", async () => {
    // The local stub reads the JSON body and ignores every header, so a lost
    // Content-Type, a changed mode or a wrong context repository would not
    // show up as anything but a production failure.
    const real = recorded();
    const seen: { method: string; path: string; headers: Record<string, string>; json: unknown }[] = [];
    const capturing = serve(async (req, url) => {
      const text = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        json: JSON.parse(text),
      });
      return fetch(`${real}${url.pathname}`, { method: req.method, headers: req.headers, body: text });
    });

    // Base and head repositories differ: the recording exists only under the
    // base, so a pass shows the base repository was the rendering context.
    const withToken = await verify(PLAIN_BODY, {
      GITHUB_API_URL: capturing,
      PR_BASE_REPO_FULL_NAME: "florianhorner/demo",
      PR_HEAD_REPO_FULL_NAME: "someone/fork",
      OWNED_REPOS: "florianhorner/demo,someone/fork",
    });
    expect(withToken.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.path).toBe("/markdown");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer test-token");
    expect(seen[0]!.headers["content-type"]).toContain("application/json");
    expect(seen[0]!.headers["accept"]).toBe("application/vnd.github+json");
    expect(seen[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(seen[0]!.json).toEqual({ text: PLAIN_BODY, mode: "gfm", context: "florianhorner/demo" });

    // No token: public resources render without one, and a bare "Bearer " is
    // not the same request. The head repository is the context when there is
    // no base.
    seen.length = 0;
    const withoutToken = await verify(PLAIN_BODY, {
      GITHUB_API_URL: capturing,
      GITHUB_TOKEN: "",
      PR_BASE_REPO_FULL_NAME: "",
    });
    expect(withoutToken.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
    expect((seen[0]!.json as { context: string }).context).toBe("florianhorner/demo");

    // Neither repository known: the payload carries no context at all, rather
    // than an empty one (recorded under the empty context).
    seen.length = 0;
    const noProofBody = "## Summary\n\nThis PR fixes things.\n\n## Changes\n\n- Did something";
    const noContext = await verify(noProofBody, {
      GITHUB_API_URL: capturing,
      PR_BASE_REPO_FULL_NAME: "",
      PR_HEAD_REPO_FULL_NAME: "",
      OWNED_REPOS: "",
    });
    expect(noContext.out).toContain("does not contain a ## Proof section");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.json).toEqual({ text: noProofBody, mode: "gfm" });
  }, 60_000);

  it("looks a run up in the repository its URL names, once, with the token", async () => {
    // Every other run-lookup stub answers by id or for any path, so asking
    // about the head repository instead of the cited one would go unnoticed.
    // A PR from a fork cites the base repository's run 999 on two lines, the
    // second time with owner and repository spelled in another case: GitHub
    // reads both case-insensitively, so that is one run and one lookup.
    const lookups: { method: string; path: string; headers: Record<string, string> }[] = [];
    const res = await verify("(body)", {
      GITHUB_API_URL: rendersAs(
        proofSection(
          taskBox("build: https://github.com/upstream/govee2mqtt/actions/runs/999"),
          taskBox("tests: TestMQTT"),
          taskBox("lint: https://github.com/Upstream/Govee2mqtt/actions/runs/999")
        ),
        (req, url) => {
          lookups.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers) });
          return Response.json({ conclusion: "success", head_sha: "cafebabe" });
        }
      ),
      PR_HEAD_REPO_FULL_NAME: "fork-user/govee2mqtt",
      PR_BASE_REPO_FULL_NAME: "upstream/govee2mqtt",
      OWNED_REPOS: "florianhorner/govee2mqtt",
    });

    expect(res.out).toContain("3 proof line(s) checked");
    expect(res.exitCode).toBe(0);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.method).toBe("GET");
    expect(lookups[0]!.path).toBe("/repos/upstream/govee2mqtt/actions/runs/999");
    expect(lookups[0]!.headers["authorization"]).toBe("Bearer test-token");
    expect(lookups[0]!.headers["accept"]).toBe("application/vnd.github+json");
    expect(lookups[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
  }, 60_000);

  it("accepts a proof line only for the markup it lists, and rejects any other element", async () => {
    // The rule is an allow-list ("lists what is allowed, not what is banned"):
    // only a handful of elements, among them the g-emoji GitHub draws for
    // `:tada:`, were ever fed to it, and the rejected ones were all elements a
    // deny-list written from those examples would also have named.
    const allowed =
      `tests: <g-emoji class="g-emoji" alias="tada">\u{1F389}</g-emoji> <strong>TestThing</strong> ` +
      `<em>passes</em> <b>b</b><i>i</i> <code>code</code> <tt>c31eb57</tt> ` +
      `<a href="https://example.com/x">link</a><br>more` +
      `<sup><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup>`;
    const foreign = [
      ["span", "<span>x</span>"],
      ["u", "<u>x</u>"],
      ["s", "<s>x</s>"],
      ["kbd", "<kbd>x</kbd>"],
      ["mark", "<mark>x</mark>"],
      ["small", "<small>x</small>"],
      ["font", "<font size=1>x</font>"],
      ["img", '<img src="https://example.com/a.png" alt="x">'],
    ] as const;

    const [accepted, ...rejected] = await Promise.all([
      verify("(body)", { GITHUB_API_URL: rendersAs(proofSection(taskBox(allowed))) }),
      ...foreign.map(([, markup]) =>
        verify("(body)", {
          GITHUB_API_URL: rendersAs(proofSection(taskBox(`tests: TestThing ${markup}`))),
        })
      ),
    ]);

    expect(accepted!.out).toContain("1 proof line(s) checked");
    expect(accepted!.exitCode).toBe(0);
    expect(
      rejected.map((res) => ({
        rejected: res.exitCode !== 0,
        named: /Proof line contains <(\w+)> markup, which can hide or restyle part of it/.exec(res.out)?.[1],
      }))
    ).toEqual(foreign.map(([tag]) => ({ rejected: true, named: tag })));
  }, 120_000);

  it("reads its input from stdin, and reports a missing or unreadable body file as an error", async () => {
    // `cat pr-body.md | bun verify-proof-block.ts` is the first usage the file
    // header gives; only --body-file was ever run.
    const api = recorded();
    const piped = await spawnVerifier([], { GITHUB_API_URL: api }, PLAIN_BODY);
    expect(piped.out).toContain("1 proof line(s) checked");
    expect(piped.exitCode).toBe(0);

    const noPath = await spawnVerifier(["--body-file"], { GITHUB_API_URL: api });
    expect(noPath.exitCode).toBe(1);
    expect(noPath.out).toContain("--body-file requires a path argument");

    const missing = await spawnVerifier(["--body-file", "/nonexistent/coverage-gaps/body.md"], {
      GITHUB_API_URL: api,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.out).toContain("Unexpected error");
    expect(missing.out).toContain("ENOENT");
  }, 60_000);

  it("reads claims from the whole body but takes evidence only from the Proof section", async () => {
    // A PR template usually carries a checklist and prose before ## Proof. Those
    // boxes are not proof lines (none is `key: value`), and a run linked there
    // is not looked up, even though the stub would fail it.
    const lookups: string[] = [];
    const html =
      '<p>The previous attempt, <a href="https://github.com/florianhorner/demo/actions/runs/99">run 99</a>, failed.</p>\n' +
      `<ul class="contains-task-list">\n${taskBox("Updated the docs", false)}\n${taskBox("Read the contributing guide")}\n</ul>\n` +
      proofSection(taskBox("tests: TestThing"));
    const api = rendersAs(html, (_req, url) => {
      lookups.push(url.pathname);
      return Response.json({ conclusion: "failure", head_sha: "cafebabe" });
    });
    const evidence = await verify("(body)", { GITHUB_API_URL: api });

    expect(evidence.out).toContain("1 proof line(s) checked");
    expect(evidence.exitCode).toBe(0);
    expect(lookups).toEqual([]);

    // A claim is read as the reader sees it, wherever it stands: with fullwidth
    // brackets it still has to name a proof line that exists.
    const claim = await verify("(body)", {
      GITHUB_API_URL: rendersAs(
        `<p>Fixes the freeze \u{FF3B}proof: missing\u{FF3D}.</p>\n${proofSection(taskBox("tests: TestThing"))}`
      ),
    });
    expect(claim.exitCode).not.toBe(0);
    expect(claim.out).toContain("Dangling [proof: missing]");
  }, 60_000);

  it("hands the verifier the token, the PR head and the checkout, or every run lookup is skipped", () => {
    // Without GITHUB_TOKEN or PR_HEAD_SHA the verifier skips every CI-run
    // lookup (the local-usage path) and says nothing about it, so a workflow
    // that stopped passing either would report green for any cited run. The
    // workflow tests elsewhere pin only PR_BASE_REF and the checkout depth.
    const workflow = parseYaml(
      readFileSync(join(import.meta.dir, "../../.github/workflows/verify-claims.yml"), "utf8")
    );
    const steps = workflow.jobs.verify.steps as Array<Record<string, any>>;
    const validate = steps.find((s) => s.name === "Validate proof block");
    const fetchBody = steps.find((s) => s.name === "Fetch PR body");
    expect(validate).toBeDefined();
    expect(fetchBody).toBeDefined();

    const wired = {
      GITHUB_TOKEN: "secrets.GITHUB_TOKEN",
      PR_HEAD_SHA: "pull_request.head.sha",
      PR_HEAD_REPO_FULL_NAME: "pull_request.head.repo.full_name",
      PR_BASE_REPO_FULL_NAME: "pull_request.base.repo.full_name",
      OWNED_REPOS: "inputs.owned_repos",
      GITHUB_WORKSPACE: "github.workspace",
    };
    const env = (validate!.env ?? {}) as Record<string, unknown>;
    expect(
      Object.fromEntries(Object.entries(wired).map(([name, expr]) => [name, String(env[name] ?? "").includes(expr)]))
    ).toEqual(Object.fromEntries(Object.keys(wired).map((name) => [name, true])));

    // The step reads the file the previous step wrote, from the directory the
    // dependencies were installed into.
    expect(String(validate!.run)).toContain("verify-proof-block.ts --body-file /tmp/pr-body.md");
    expect(validate!["working-directory"]).toBe("_gh_workflows/scripts");
    expect(String(fetchBody!.with.script)).toContain("/tmp/pr-body.md");
    expect(String(fetchBody!.with.script)).toContain("pull_request.body");

    // Run lookups need actions: read, the body render needs contents: read.
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  });
});
