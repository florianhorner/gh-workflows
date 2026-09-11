# gh-workflows

Reusable GitHub Actions workflows for `florianhorner/*` repositories.

## `checkout-credentials` — focused checkout-token audit

This reusable workflow runs zizmor's offline `artipacked` audit over a caller's
workflow and composite-action definitions. It fails when `actions/checkout`
implicitly persists credentials and points to the exact file and line. Explicit
`persist-credentials: true` remains an intentional opt-in; all other checkout
steps should set it to `false`.

Pull requests use `pull_request_target`, so GitHub loads the caller from the
trusted base branch. The reusable workflow downloads only changed workflow and
composite-action YAML through GitHub's API and never checks out or executes pull
request code. Pushes still scan the complete checked-out repository.

Add a SHA-pinned caller. Do not add trigger-level path filters: GitHub evaluates
only a bounded changed-file list for filtered events, while this security gate
must run and fail closed even for oversized pull requests.

```yaml
name: checkout-credentials
on:
  pull_request_target:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read
jobs:
  audit-pr:
    if: github.event_name == 'pull_request_target'
    uses: florianhorner/gh-workflows/.github/workflows/checkout-credentials.yml@<full-commit-sha>
    with:
      pull_request_number: ${{ github.event.pull_request.number }}
  audit-push:
    if: github.event_name == 'push'
    uses: florianhorner/gh-workflows/.github/workflows/checkout-credentials.yml@<full-commit-sha>
```

The workflow deliberately filters out every other zizmor rule. Broader GitHub
Actions hardening belongs in a separately reviewed policy, so adopting this
guard cannot unexpectedly expose unrelated legacy findings.

## `verify-claims` — PR Proof Block Enforcement

Every PR body must end with a `## Proof` block listing artifacts for each claim. This workflow validates that block server-side and blocks merge if it's missing or malformed.

### What it checks

| Rule | Detail |
|------|--------|
| Block present | PR body must contain `## Proof` at end-of-body |
| Not in code fence / HTML comment | Fake `## Proof` in fenced blocks is ignored |
| Checked boxes have real artifacts | URL, test name, file path, or `n/a — <reason>` |
| CI run URLs | Must resolve to `conclusion=success` **and** describe the PR head's content (see below) |
| Cross-owner PRs | `runtime: n/a` forbidden when head repo not in `owned_repos` |
| Inline `[proof: key]` tokens | Must match an existing proof line key |
| Draft PRs | Exempt |
| Bot authors | `dependabot[bot]`, `pre-commit-ci[bot]`, `github-actions[bot]` exempt |

### A cited CI run and the PR head

A run is accepted when its `head_sha` **is** the PR head, or when the PR head is
that commit with base integrations on top and no content of its own. Git's own
three-way merge of the run's commit with the integrated parent must produce
exactly the head's tree, and that parent must be content the PR's base branch
already carries. Repeated integrations are fine; the head itself has to be the
merge commit, so a commit pushed after the merge invalidates the block again.

This exists because two rules were in direct conflict. Branch protection that
requires a branch to be up to date means landing any PR forces every other open
PR to integrate the base, which writes a new head SHA. Under strict SHA equality
that invalidated a proof block the author never touched, and the only remedy was
to wait a full CI cycle on the new head and repoint the URLs by hand. Measured
across 1003 verifications on one repo: half of all branches burned at least one
proof block, and a PR with a sibling landing while it was open burned 2.8x as
many as one without.

Anchoring the merged-in parent to the base branch is the condition that makes
the rest safe, and it is worth being explicit about why. Without it the check
only asks whether the head is a merge of the run's commit with *something*, and
the author chooses the something: `git merge any-branch` satisfies every other
condition by construction, so a head carrying code no run ever saw would be
reported as proven.

Still refused, each with its reason named in the message: content changed after
the run, a conflicted or hand-resolved merge, an evil merge, `-s ours`, an
octopus merge, a rebase, a run from an unrelated branch, a merge of a branch
that is not the base, a run whose commit the base already contained (which would
make the comparison vacuous), and any state git cannot adjudicate — a shallow
clone, a missing object, a `merge-tree` too old to answer. Every one of those
fails closed.

The predicate is `scripts/clean-integrate-witness.ts`. It reads the head's
ancestry with git, so the reusable workflow checks the PR head out with full
history and passes the base ref on your behalf; callers need no change. That
deep fetch is only paid when the body cites a CI run at all — on a large repo it
is the expensive part of the job, and a body with no run URL never asks git
anything.

### Proof block template (own-repo PR)

```markdown
## Proof

- [x] build: <ci-run-url> [proof: build]
- [x] tests: <ci-run-url> OR TestFunctionName [proof: tests]
- [x] lint: <ci-run-url> [proof: lint]
- [ ] runtime: <artifact-url> OR "n/a — <reason>" [proof: runtime]
- [ ] schema: "n/a — no MQTT or HA interface changes" OR <diff-url> [proof: schema]
```

For **cross-owner / upstream PRs**, `runtime:` must be checked with a real artifact — `n/a` is not accepted.

### Caller workflow (5-line setup per repo)

Add `.github/workflows/verify-claims.yml` to your repo:

```yaml
name: verify-claims
on:
  pull_request:
    types: [opened, edited, synchronize, ready_for_review]
jobs:
  verify:
    uses: florianhorner/gh-workflows/.github/workflows/verify-claims.yml@fde64f42deb15511c2c71cb9798c2d6685379e38 # v1.5
    with:
      owned_repos: "florianhorner/govee2mqtt,florianhorner/mammamiradio"
```

That's it. The reusable workflow handles checkout, Bun setup, and parser execution.

### Pin to a SHA, not a tag

Pin the `uses:` line to a full 40-character commit SHA with the version in a trailing
comment, as above. Dependabot updates both halves — add the `github-actions` ecosystem to
`.github/dependabot.yml` and bumps arrive as reviewable PRs.

A tag is mutable: anyone who gains write access to this repo can move `v1` or `v1.3` to
different code, and every consumer picks it up on its next run with no diff in their own
repository. That is exactly how `tj-actions/changed-files` (CVE-2025-30066) and
`aquasecurity/trivy-action` were exploited. A SHA cannot be moved.

Earlier revisions of this README recommended `@v1`. That is no longer advised — it gives the
consumer no audit trail when the code underneath changes.

### Accepted artifact types for `runtime:`

- GitHub Actions run URL (`https://github.com/{owner}/{repo}/actions/runs/{id}`)
- Gist URL with timestamped log
- Release asset URL
- File path in `.context/proof/` committed to the PR branch
- Screenshot URL (for UI/HA dashboard changes)

### Running the parser locally

```bash
cd scripts
bun install
cat your-pr-body.md | bun verify-proof-block.ts
# or
bun verify-proof-block.ts --body-file your-pr-body.md
```

Required env vars for full CI URL validation:

```
GITHUB_TOKEN=...
PR_HEAD_SHA=<commit sha>
PR_BASE_REF=main                         # base branch; the clean-integrate
                                         # witness anchors a merge's integrated
                                         # parent to it and refuses without it
GITHUB_WORKSPACE=/path/to/a/full/clone   # the witness runs git here, and checks
                                         # this checkout is actually PR_HEAD_SHA
GITHUB_API_URL=https://api.github.com    # optional; override for GHES
PR_HEAD_REPO_FULL_NAME=florianhorner/your-repo
PR_BASE_REPO_FULL_NAME=florianhorner/your-repo
OWNED_REPOS=florianhorner/govee2mqtt,florianhorner/mammamiradio
```

### Running tests

```bash
cd scripts
bun install
bun test
```

## `body-lint` — editorial boundary for PR bodies, issue bodies and changelogs

Public bodies describe user-visible outcomes. Review archaeology, agent
provenance, operator telemetry and process narrative belong in the private
durable record. `body-lint` enforces that server-side.

It exists because the local `PreToolUse` hook only runs on the maintainer's
machine: the GitHub web UI, cloud agents and MCP clients all reach a public body
with no gate at all unless CI holds the line.

### Shapes, not phrases

The predecessor was a literal-phrase denylist grown one incident at a time. It
held `findings (raised|confirmed|refuted)` and still passed "Findings from
review"; it held `adversarially verif` and still passed "mutation testing
found". Every escape was a new wording of an already-banned class.

`scripts/lint-patterns.sh` matches the *grammatical frame* instead — a review
noun near a discovery verb, a review actor mid-action, a telemetry possessive —
so paraphrase does not walk through. Patterns are POSIX ERE and must behave
identically under BSD grep (the local hook) and GNU grep (CI).

### Caller workflow

```yaml
jobs:
  pr-body:
    permissions: { contents: read, actions: read }   # both lines required
    uses: florianhorner/gh-workflows/.github/workflows/body-lint.yml@<sha>
    with:
      target: pr-body
      extra_patterns: scripts/lint-patterns.sh   # optional, repo-local additions
```

`target` is `pr-body`, `issue-body` or `changelog`. Repo-local patterns are
**unioned** with the baseline — a repo may only ADD. Removing a baseline pattern
is a PR to this repo, not a local override. The workflow checks out the caller's
**base** ref, so a PR cannot weaken the gate judging it in the same change.

### Adding or changing a pattern

A pattern is not shipped until it has been measured. Guessing produces gates
that fire on legitimate prose and then get disabled.

```bash
bash scripts/lint-pattern-report.sh > /tmp/report.tsv   # every hit, with the matched span
bash tests/test-lint-patterns.sh                        # compile / recall / precision / drift
```

- **Ship gate:** no pattern ships while any row for it is marked `FP` in
  `tests/expected/lint-pattern-baseline.tsv`. That is a count on an adjudicated
  column, not a hit-rate threshold, so it is immune to the "four counts, four
  answers" problem.
- **Admission to `LINT_BASELINE_CORE`** (the set applied to changelogs and docs)
  requires **zero** hits against the consuming repo's real changelogs. One hit
  turns `main` red on merge day.
- **The em-dash rule blocks.** It shipped advisory first, since it matched 141 of 161
  historical bodies — but that counts bodies written before the rule existed. The
  proof-block carve-out (`n/a — <reason>` lines are exempt) is what makes blocking
  safe, since the proof gate and this gate run on the same body.
- **A pattern with zero corpus hits is unfalsified, not validated.** It needs
  hand-written paraphrases in `tests/fixtures/lint-known-bad.txt` before it
  counts as covered — that is the exact profile the old denylist had the day
  before it failed.

### What it cannot catch

Regex reaches lexical tells, not meaning. Of six phrases that escaped the old
gate, five are now caught; `two guards that needed teeth` is pure metaphor with
no lexical signal and is not reachable this way. Renaming a `## Findings`
section to `## Notes` also defeats the heading rule, which matches the label and
never the content. Treat a pass as a tripwire on habitual violations, not as
evidence that a body is clean.

## Release notes

### Unreleased — a cited CI run may be the head minus a clean base integration

`verify-claims` no longer requires a cited run's `head_sha` to equal the PR head
exactly. A run whose commit the head integrates its base on top of, changing no
content of its own, is accepted; the integrated parent must be content the base
branch already carries. Everything else still reports `Run is stale`, now with
the reason named. The reusable workflow's PR-head checkout moved to
`fetch-depth: 0` and it passes `PR_BASE_REF`; callers need no change. See
"A cited CI run and the PR head" above and `scripts/clean-integrate-witness.ts`.

`scripts/__tests__` now runs in CI (`workflow-lint.yml`), which it did not before.

### Parser fixes (v1.2)

- **strip trailing `[proof: <KEY>]` suffix from the artifact value before
  validation.** Pre-fix, the parser captured the self-reference tag (e.g.
  `proof/bootstrap.txt [proof: runtime]`) as part of the file path,
  causing `existsSync()` to fail. This blocked every commit-message-
  standards bootstrap PR. Inline `[proof: KEY]` token validation is
  unaffected — it still scans the original PR body.
- **check URL artifacts before file-path artifacts.** Non-CI URLs
  (gist links, screenshots, release assets) contain `/` and were
  previously misrouted into the file-path branch, then failed
  `existsSync()` whenever `GITHUB_WORKSPACE` was set (i.e. always in CI).
  Reordering the branches makes the URL fast-path match before the
  file-path branch.

Both fixes are backwards-compatible — no template change required, no
function signature change, no tag scheme change.

## License

MIT — see [LICENSE](LICENSE).
