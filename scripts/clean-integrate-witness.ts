/**
 * Accepts a cited CI run when the PR head contains only clean base integrations
 * after that run. Git's three-way merge must reproduce the head's exact tree,
 * and the integrated parent must be on the base branch's first-parent chain.
 * Reachability alone would admit intermediate states of merged feature branches.
 *
 * Refuse changes after the run, conflicts or manual merge resolutions, extra
 * merge content, -s ours, octopus merges, rebases and unrelated run commits.
 * Missing objects, shallow history and failed Git commands cannot establish
 * acceptance. The caller retains strict SHA equality as its fallback.
 */

import { execFileSync } from "node:child_process";

/**
 * Runs a git command. `stdout` is the trimmed output of a successful run;
 * `code` is null only when git could not be executed at all.
 *
 * Callers must distinguish a negative answer from an execution failure.
 * `git merge-base --is-ancestor` returns 1 for no and 128 for a missing object.
 */
export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => GitResult;

/**
 * Tests pass the fixture's isolated Git environment so merge.* and diff.renames
 * settings match during construction and verification. Production inherits the
 * runner's environment.
 */
export function makeGitRunner(cwd?: string, env?: NodeJS.ProcessEnv): GitRunner {
  return (args: string[]): GitResult => {
    try {
      const stdout = execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      return { ok: true, code: 0, stdout: stdout.trim(), stderr: "" };
    } catch (err) {
      const e = err as { status?: number | null; stderr?: string | Buffer };
      return {
        ok: false,
        // `status` is null when the process was killed (timeout, OOM) rather
        // than exiting — which is "could not answer", never "no".
        code: typeof e.status === "number" ? e.status : null,
        stdout: "",
        stderr: String(e.stderr ?? "").trim(),
      };
    }
  };
}

const FULL_OID = /^[0-9a-f]{40}$/;

/** Resolves a rev to a full object id, or null when it is not in this clone. */
function resolve(git: GitRunner, rev: string): string | null {
  const r = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return r.ok && FULL_OID.test(r.stdout) ? r.stdout : null;
}

/** true / false / null, where null means git could not answer. */
function isAncestor(git: GitRunner, ancestor: string, descendant: string): boolean | null {
  const r = git(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (r.ok) return true;
  if (r.code === 1) return false;
  return null; // 128 (missing object), killed process, git absent
}

/**
 * Checks whether `commit` was a tip of `branch`, using its first-parent chain.
 * Reachable feature-branch commits need not have been base-branch states.
 * Returns null when Git cannot answer; callers must refuse acceptance.
 */
function isOnFirstParentChain(
  git: GitRunner,
  commit: string,
  branch: string
): boolean | null {
  const r = git(["rev-list", "--first-parent", "--format=%H", branch]);
  if (!r.ok) return null;
  return r.stdout.split("\n").some((line) => line.trim() === commit);
}

export interface WitnessResult {
  /** True only when the run's content is the PR head's content. */
  accepted: boolean;
  /** Stable short reason, for tests and for the failure message. */
  reason:
    | "accepted"
    | "bad-sha"
    | "unresolvable"
    | "not-ancestor"
    | "head-not-a-merge"
    | "vacuous"
    | "base-not-on-base-branch"
    | "conflicts"
    | "merge-tree-unavailable"
    | "drift";
  /** git's own words, when it produced any on the deciding call. */
  detail?: string;
}

function no(reason: WitnessResult["reason"], detail?: string): WitnessResult {
  return detail ? { accepted: false, reason, detail } : { accepted: false, reason };
}

export interface WitnessInput {
  /** Commit the cited CI run actually ran on (from the API). */
  runHead: string;
  /** Commit the PR head is now. */
  prHead: string;
  /** The PR's base branch name, e.g. "main". */
  baseRef: string;
}

/**
 * Resolves the PR's base branch inside the checkout.
 *
 * A fork PR is checked out from the BASE repository, so `origin` is the base
 * repo in both cases and `refs/remotes/origin/<ref>` is the right answer. The
 * fallback covers a local invocation, where the checkout may have the branch only
 * as a local head. Nothing is guessed: if neither resolves, the caller fails
 * closed.
 *
 * The bare ref is deliberately not a candidate. The two explicit namespaces
 * already cover CI and local clones, and rev-parse resolves a bare name through
 * refs/tags first, so a tag sharing the base branch's name would point the
 * anchor at whatever the tag points at. A PR base is never a tag.
 */
function resolveBaseBranch(git: GitRunner, baseRef: string): string | null {
  for (const candidate of [`refs/remotes/origin/${baseRef}`, `refs/heads/${baseRef}`]) {
    const oid = resolve(git, candidate);
    if (oid) return oid;
  }
  return null;
}

/**
 * True when `prHead` is `runHead` with a clean integration of the PR's base
 * branch on top and nothing else.
 *
 * The conditions, each one closing a way the answer could be yes for the wrong
 * reason. Every one of them fails closed when git cannot answer:
 *
 *  1. both SHAs are well-formed object ids — `head_sha` arrives from an HTTP
 *     response, and `HEAD^{commit}` is a rev that resolves to a trivially
 *     self-satisfying answer;
 *  2. both commits are in this clone — a shallow checkout must not read as
 *     "clean";
 *  3. `runHead` is an ancestor of `prHead` — a run from an unrelated branch
 *     that happens to produce the same tree is not evidence about this PR;
 *  4. `prHead` is a two-parent merge — with no merge there was no integration,
 *     and an octopus merge is not one either;
 *  5. the merged-in parent is a state the PR's base branch has actually been in
 *     — its first-parent chain, not merely something the branch can reach.
 *     Without any anchor the author chooses what gets merged in and any branch
 *     satisfies condition 7; with mere reachability the choice is still wide
 *     enough to pull in any previously-merged side branch;
 *  6. `runHead` is NOT already contained in that parent — otherwise merge_tree
 *     collapses to the base's tree and the comparison is vacuous, accepting a
 *     run that predates the PR's own work;
 *  7. merge_tree(runHead, base) is exactly `prHead`'s tree — a conflict, an
 *     evil merge, `-s ours`, or any post-run content change fails here.
 */
export function cleanIntegrateWitness(git: GitRunner, input: WitnessInput): WitnessResult {
  const { runHead, prHead, baseRef } = input;

  if (!FULL_OID.test(runHead) || !FULL_OID.test(prHead)) return no("bad-sha");
  if (!baseRef) return no("unresolvable", "no base ref was provided");

  const run = resolve(git, runHead);
  const head = resolve(git, prHead);
  if (!run || !head) return no("unresolvable", "run or head commit is not in this clone");

  const runIsAncestor = isAncestor(git, run, head);
  if (runIsAncestor !== true) {
    return no(runIsAncestor === null ? "unresolvable" : "not-ancestor");
  }

  const parentLine = git(["rev-list", "--parents", "-n", "1", head]);
  if (!parentLine.ok) return no("unresolvable", parentLine.stderr);
  const parents = parentLine.stdout.split(/\s+/).filter(Boolean).slice(1);
  if (parents.length !== 2) return no("head-not-a-merge");

  // `git merge <base>` and GitHub's "Update branch" both record the branch as
  // the first parent and the integrated base second. Condition 5 then pins that
  // second parent to the base branch, so a merge recorded the other way round
  // is refused rather than silently reinterpreted.
  const base = resolve(git, parents[1]!);
  if (!base) return no("unresolvable", "the merged-in parent is not in this clone");

  const baseBranch = resolveBaseBranch(git, baseRef);
  if (!baseBranch) {
    return no("unresolvable", `base branch ${baseRef} does not resolve in this clone`);
  }
  const baseIsLanded = isOnFirstParentChain(git, base, baseBranch);
  if (baseIsLanded !== true) {
    // The detail must not assert what git declined to determine: when the
    // answer is null, git could not read the chain, which is a different
    // statement from "your parent is not on it".
    return baseIsLanded === null
      ? no("unresolvable", `cannot read the first-parent chain of ${baseRef}`)
      : no(
          "base-not-on-base-branch",
          `merged-in parent ${base} was never a state of ${baseRef}`
        );
  }

  const runInBase = isAncestor(git, run, base);
  if (runInBase !== false) {
    return no(runInBase === null ? "unresolvable" : "vacuous");
  }

  // `--write-tree` writes the merged tree to the object database and prints its
  // id; a conflict exits 1. Any other non-zero exit is git being unable to
  // answer (unrelated histories exit 128, and `--write-tree` needs git >= 2.38),
  // which must not be reported to an author as "your merge conflicts". It is a
  // pure object-database operation: no index, no working tree, nothing to clean
  // up, and safe to run inside a checked-out repo.
  const merged = git(["merge-tree", "--write-tree", "--no-messages", run, base]);
  if (!merged.ok) {
    return merged.code === 1
      ? no("conflicts")
      : no("merge-tree-unavailable", merged.stderr);
  }

  const headTree = git(["rev-parse", `${head}^{tree}`]);
  if (!headTree.ok) return no("unresolvable", headTree.stderr);

  // Every other rev in this file is shape-checked; this is the comparison that
  // decides the verdict, and "" === "" would read as accepted.
  return FULL_OID.test(merged.stdout) && merged.stdout === headTree.stdout
    ? { accepted: true, reason: "accepted" }
    : no("drift");
}
