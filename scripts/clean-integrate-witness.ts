/**
 * Does a cited CI run still describe the PR's content?
 *
 * `verify-proof-block.ts` used to answer that with `run.head_sha === PR head`.
 * That is correct about identity and wrong about content, and the difference is
 * not academic: branch protection on the consuming repos requires a branch to be
 * up to date before it merges, so landing any PR forces every other open PR to
 * integrate the base, which writes a new head SHA and invalidates a proof block
 * nobody touched. Measured on florianhorner/mammamiradio over 1003 real
 * verifications: half of all branches burned at least one proof block, and a PR
 * that had a sibling land while it was open burned 2.8x as many as one that did
 * not. The author's only remedy was to wait a full CI cycle on the new head and
 * repoint the URLs by hand.
 *
 * The repo already answers the same question correctly one layer down. The v2
 * pre-ship receipt accepts a pre-integrate review when git's own three-way merge
 * proves the head is exactly the reviewed content merged with the base
 * (`scripts/landing/evidence.py::_merge_witness_mismatch` in that repo). This is
 * that predicate, applied to CI runs:
 *
 *     merge_tree(run_head, base) produces exactly the PR head's tree,
 *     where `base` is a state the PR's actual base branch has been in
 *
 * That second clause is load-bearing and was missing from the first draft of
 * this file, which an adversarial review caught before it shipped. Without it
 * the predicate only asks whether the head is a merge of the run's commit with
 * *something* — and the author picks the something. `git merge evil-branch`
 * satisfies every other condition by construction, so a head carrying code no
 * CI run ever saw would have been reported as proven. The witness pulls content
 * out of that parent into the accepted answer, so the parent has to be a state
 * the base branch has actually been in. `evidence.py::_assert_landed_base` makes
 * the same argument for the receipt witness, though it settles for reachability;
 * a second adversarial pass showed reachability is not enough when the base
 * branch itself contains merges, which it does in every repo consuming this.
 *
 * Everything else still fails. A commit that changes content after the run, a
 * conflicted or hand-resolved merge, an evil merge, `-s ours`, an octopus merge,
 * a rebase, a run from an unrelated branch, and a shallow clone that cannot
 * prove any of it all fall through to the old SHA equality. The witness only
 * ever widens acceptance for a merge that added no content of its own and took
 * that content from the base branch.
 */

import { execFileSync } from "node:child_process";

/**
 * Runs a git command. `stdout` is the trimmed output of a successful run;
 * `code` is null only when git could not be executed at all.
 *
 * Callers must distinguish "git answered no" from "git could not answer" —
 * conflating them is how a guard fails open. `git merge-base --is-ancestor`
 * answers through the exit code (1 = no) but reports a missing object as 128,
 * so the exit code is the only thing that separates the two.
 */
export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => GitResult;

/**
 * `env` exists for the test suite. The fixtures seal their own git off from the
 * machine's global config, and without passing the same env here the predicate
 * would recompute merges under the developer's `merge.*` / `diff.renames`
 * settings while the fixture built them under defaults — a box with any of those
 * set non-default could turn an accepting case red for a reason no reader would
 * guess. Production passes nothing and inherits the runner's environment.
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
 * Was `commit` ever the tip of `branch`?
 *
 * Not the same question as "is it reachable from `branch`", and the difference
 * is the whole anchor. A base branch built by merging pull requests reaches
 * every commit of every merged branch, including work-in-progress states it was
 * never at — so reachability let an author integrate a previously-merged side
 * branch and have this report "proven" for content the base never carried. The
 * first-parent chain is exactly the sequence of states the branch has been in.
 *
 * null when git could not answer, which every caller treats as a refusal.
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
 * A third candidate — the bare ref — used to sit at the end. It bought nothing
 * (the two explicit namespaces already cover CI and local clones) and cost
 * something: rev-parse resolves a bare name through refs/tags first, so a tag
 * sharing the base branch's name pointed the anchor at whatever the tag pointed
 * at. Narrow to reach, but a PR base is never a tag.
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
