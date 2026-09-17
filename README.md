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
| Markdown structure | Headings and checkboxes must be real Markdown nodes that survive HTML parsing. Fenced or indented examples, raw HTML lookalikes, and commented-out claims do not count |
| Checked boxes have real artifacts | `https://` URL, test name, repo-relative file path, or `n/a — <reason>` |
| Unchecked boxes | Either `n/a — <reason>` with a non-empty reason, or a real artifact, which is then validated like a checked one. `—`, `–` and a spaced `-` all separate the reason |
| CI run URLs | Must resolve to `conclusion=success` **and** describe the PR head's content (see below). The URL is canonicalised before matching: host case-insensitive, `www.` stripped, path percent-decoded, doubled slashes collapsed, and trailing autolink punctuation (`.,:;!~)`) ignored — so every spelling that renders as a link to the run is looked up rather than waved through |
| Malformed run URLs | A run-shaped path whose id is not readable as digits, or whose host is not `github.com`, or which carries a non-default port, is an **error** — never a generic artifact |
| Artifact URL scheme | `http://` is rejected |
| File paths | Resolved **only** against `GITHUB_WORKSPACE`, via `realpath`, and confined to it — absolute paths, `../` traversal and symlinks pointing out are rejected, and the process cwd is never consulted. Must name a **file**, not a directory. Existence is not enough: when the workspace is a git checkout the path must be **tracked**, which is what excludes the nested `_gh_workflows/` checkout and its `node_modules`. If `.git` is present but git cannot be queried (`safe.directory`, dubious ownership) the check fails **closed** and says why |
| Line endings | CRLF bodies (anything authored or edited in the GitHub web UI) parse identically to LF |
| Cross-owner PRs | `runtime: n/a` forbidden when head repo not in `owned_repos` |
| Inline `[proof: key]` tokens | Must match an existing proof line key, including references visible in raw HTML text. Code examples, HTML attributes, and comments are excluded |
| Draft PRs | Exempt |
| Bot authors | `dependabot[bot]`, `pre-commit-ci[bot]`, `github-actions[bot]` exempt |

### A cited CI run and the PR head

A run is accepted when its `head_sha` **is** the PR head, or when the PR head is
that commit with base integrations on top and no content of its own. Git's own
three-way merge of the run's commit with the integrated parent must produce
exactly the head's tree, and that parent must be a state the PR's base branch
has actually been in — a commit on its first-parent chain. Repeated integrations
are fine; the head itself has to be the merge commit, so a commit pushed after
the merge invalidates the block again.

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

Reachability is not a strong enough anchor either, which cost a second round to
learn. A base branch built from merged pull requests *reaches* every commit of
every merged branch, including work-in-progress states it was never at, so
`git merge some-previously-merged-branch` would have passed. The anchor is
membership of the base branch's first-parent chain: the states the branch has
actually been in.

Still refused, each with its reason named in the message: content changed after
the run, a conflicted or hand-resolved merge, an evil merge, `-s ours`, an
octopus merge, a rebase, a run from an unrelated branch, a merge of anything the
base branch was never at (including a branch it merely reaches), a base ref that
resolves only as a tag, a run whose commit the base already contained (which
would make the comparison vacuous), and any state git cannot adjudicate — a
shallow clone, a missing object, an unreadable first-parent chain, a
`merge-tree` too old to answer. Every one of those fails closed.

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

All URL forms must be `https://`. File paths must be repository-relative and
**committed** — they are resolved against the PR checkout (`GITHUB_WORKSPACE`)
and checked against `git ls-files`, so an uncommitted file sitting in the
checkout is an error, as is a path that escapes it.

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
                                         # this checkout is actually PR_HEAD_SHA.
                                         # NOTE: this is also the ONLY root that
                                         # file-path proof lines resolve against,
                                         # and the "we are in CI" signal that
                                         # makes a missing proof file a hard
                                         # failure. Unset, existence is not
                                         # checked at all, but an absolute or
                                         # escaping path is still rejected
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

### Gate-bypass fixes (v1.3)

Six inputs made the validator exit 0 when it should have exited 1. Each was
reproduced against the previous parser before being fixed, and each has a
regression test that fails against it.

- **CI-run URLs are recognised by canonical host, not by exact string.** The old
  pattern was host-exact, case-sensitive and `https`-only, and the generic
  `^https?://` accept sat directly behind it returning unconditionally. So
  `https://GitHub.com/o/r/actions/runs/1` skipped the `conclusion=success` and
  head_sha checks entirely — one capital letter — while the PR body still
  rendered a live link to the same run page. `http://` is now rejected, and a
  run-shaped path on a lookalike host is an error rather than a generic artifact.
- **The unchecked branch is exhaustive.** `if (value && value !== "n/a") return;`
  was a silent accept that skipped every check. Once the `[proof: KEY]` strip
  shortened `n/a — [proof: runtime]` to `n/a —`, the `n/a` classifier stopped
  recognising it and it fell into that hole, taking the cross-owner `runtime: n/a`
  prohibition with it. An `n/a` now needs a non-empty reason, a spaced ASCII
  hyphen counts as a separator, and an unchecked box carrying a real artifact is
  validated instead of waved through.
- **File paths are confined to the checkout.** `existsSync(value)` was tried bare
  first, i.e. against the process cwd — which under the reusable workflow is the
  nested gh-workflows checkout, so `__tests__/...` or `node_modules/<anything>`
  satisfied "committed to the PR branch". There was no containment check at all
  despite the code claiming one, so `/etc/passwd` and `../../../../etc/hosts`
  both passed. Resolution is now only ever against `GITHUB_WORKSPACE`.
- **CRLF bodies parse.** `.` excludes `\r` and `$` was not multiline-anchored, so
  on a CRLF body every proof line was dropped while the heading survived — the
  error blamed a missing checkbox list. GitHub stores web-UI-authored and
  web-UI-edited bodies with CRLF, and the caller's `types: [edited]` re-runs the
  gate the moment someone fixes a typo in the description.
- **Shared Markdown interpretation.** The initial fix consolidated three
  disagreeing strippers. That scanner has since been replaced by the parser
  pipeline described below; headings, checkbox eligibility, and token checks
  now use one parsed document.
- **Parser dependencies are used.** The initial fix removed four unused imports.
  `unified` and `remark-parse` are now used with `remark-rehype`, `rehype-raw`,
  and `parse5`; the unused `remark` wrapper and `unist-util-visit` remain removed.

### Adversarial follow-up (same branch, two passes)

A cross-model adversarial pass over the fixes above found that two of them were
themselves wrong, and both are corrected here:

- **Requiring `\d+` in the run-URL path made every other spelling fail open.**
  `…/actions/runs/123.` did not match, so it fell into the generic-URL accept and
  skipped the run lookup — and GFM strips a trailing period from a bare autolink,
  so the body rendered a live link to the real run. A period ending a sentence is
  ordinary authoring, not an attack. The id slot now captures anything and is
  judged separately: readable ids are looked up, unreadable ones are errors.
  Percent-encoding (`%31`, `actions%2Fruns`) and doubled slashes are normalised
  the way github.com routes them, and a non-default port is rejected.
- **Testing `line.includes("-->")` for comment state let a comment hide a whole
  proof block.** `<!-- a --> <!--` contains `-->`, so comment mode was never
  entered and the claims after the dangling opener were parsed as real, while
  GitHub rendered none of them. The intermediate fix counted markers; the
  parser pipeline below now rejects incomplete HTML before recovery can expose
  the hidden claims.

Three further holes in the same pass, all now closed: a tilde fence whose info
string contains tildes (`~~~ template ~~~`) was misread as inline code, so its
fenced claims stayed live; a 4-space-indented triple backtick was treated as a
fence, blanking a later `## Proof` section and its claims; and lexical
containment plus `existsSync` accepted a committed symlink pointing out of the
checkout.

A second adversarial pass over those corrections found that moving comment
detection ahead of fence detection had reopened the hidden-block class through
the other door (`` ``` <!-- `` followed by `-->` made a fenced, unrendered proof
block read as live evidence). That intermediate ordering fix is superseded
by structural parsing below. The same pass found that `git ls-files`
takes a *pathspec*, so a lone `.` satisfied the tracked check; that artifacts
must now be files and repository-relative; that a decoded `#` in an owner or
repo name retargeted the API request at the repository object instead of the
run; and that keying "git cannot answer" on an exit code made every git failure
fail open.

### Markdown and HTML parsing

The verifier parses Markdown once with `unified` and `remark-parse`, converts
it with `remark-rehype`, and resolves raw HTML with `rehype-raw`. A heading or
checkbox can supply evidence only if it originates in Markdown and survives
HTML parsing. Source positions connect the trees; artifact values come from
original source lines, with the existing comment and trailing-tag removal.
Markdown links and code-wrapped artifacts are not silently unwrapped.

This closes the scanner's nested-list fence, over-indented closing fence,
indented fake-heading, and inline-comment-literal failures. Escaped or unequal
backticks remain ordinary text, so they cannot conceal dangling proof tokens.
Visible references inside raw HTML are checked too; attributes, comments, and
code containers do not supply references.

`rehype-raw` recovers from unfinished HTML tokens when it reaches a structured
Markdown node. That recovery alone would reopen the `<!-- a --> <!--` bypass.
Before conversion, `parse5` checks each actual HTML node and rejects incomplete
comments, tags, and other end-of-input parse errors. Complete comments, literal
comment markers inside attributes or code, and normal `<details>` markup remain
supported. The verifier parses HTML without executing or displaying it.

The existing source grammar is preserved: select the last matching `## Proof`
heading and validate checkbox entries through the end of the body, including
entries after an unrelated later heading. Parsing failures reject the body.

### Known gaps

The parser enforces CommonMark and HTML structure; it does not claim complete
parity with GitHub's additional Markdown extensions or final HTML sanitization.
Incomplete raw HTML fragments are rejected even if later fragments might let a
browser recover; close each comment and tag within its Markdown HTML node.

**Also open, unchanged:** strict mode keys on the *head* repo rather than the
base (`PR_BASE_REPO_FULL_NAME` is plumbed through the workflow and unused);
nothing requires any given proof key to be present; the terminal
`// Anything else: accept` still passes arbitrary prose, including a value with
no `/` in it, which never reaches the file-path branch at all; and a run URL
written as a markdown link (`[text](url)`) or an angle autolink (`<url>`) is not
recognised as a run at all, so in CI it fails as a missing file path. All change
semantics for existing PR bodies and are tracked separately.

## License

MIT — see [LICENSE](LICENSE).
