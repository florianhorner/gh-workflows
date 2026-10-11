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
| Rendered, not parsed | The body is rendered through GitHub's Markdown API (`POST /markdown`, the renderer behind the PR page) and the returned HTML is what gets validated. Whatever GitHub hides (code blocks, comments, escaped HTML) supplies no evidence; whatever it shows is validated. If the body cannot be rendered, the check fails |
| Block present | The section opens at the first heading that reads as "Proof" — any level, any case, letters only, invisible characters dropped, Cyrillic and Greek lookalike letters mapped — and that heading must be a level-2 heading reading exactly `Proof` (`## Proof`, setext, inside a list or quote are all fine). A lookalike (`### Proof`, `## Proof:`, a soft hyphen or combining joiner inside the word, `Ргооf` in Cyrillic) is an error. A heading reads as Proof by the text it shows, including text inside markup a proof line may not carry (`## <ins>Proof</ins>`). Every recognised Proof heading, whether it opens the section or appears later, must be outside every element that hides or shrinks it: `<details>` (nested or initially open too), ruby fallback `<rp>`, `<template>`, `<sup>` and `<sub>`. Collapsible notes without a Proof heading remain allowed |
| Every box is a proof line | Every checkbox after that heading is a proof line, whatever list marker or nesting produced it, including boxes under a second `Proof` heading or in footnotes. Each must read `key: value` with a key that has no spaces; a box that does not is an error, never skipped |
| Values as displayed | A line's value is its text as GitHub displays it. Markdown can change a file path: `scripts/__tests__/x.ts` displays as `scripts/tests/x.ts` with "tests" in bold. Put paths in backticks |
| Plain proof lines | A proof line may contain only text, links, code (including the `<tt>` GitHub uses for a linked commit SHA), emphasis, emoji and footnote references. Any other markup GitHub keeps can hide, shrink, strike through or overlay part of the line — `<details>`, ruby, `~~…~~`, nested `<sup>`/`<sub>` — and is an error, as are invisible and text-direction characters. The rule lists what is allowed, not what is banned |
| Checked boxes have real artifacts | `https://` URL, test name, or repo-relative file path. `n/a` on a checked box is an error |
| Unchecked boxes | Either `n/a` with a non-empty reason after `—`, `–` or `-` (spacing optional), or a real artifact, which is then validated like a checked one |
| CI run URLs | Must resolve to `conclusion=success` **and** describe the PR head's content (see below), and must be in the PR's base repository or its head repository: a run anywhere else is an error, even a green one on the same commit. The URL is canonicalised before matching: host case-insensitive, `www.` stripped, path percent-decoded, doubled slashes collapsed, and trailing autolink punctuation (`?!.,:;*_~)]`) ignored. In a value that starts with a URL (or a bare `www.` address) that URL is the artifact and the rest is a note, so `…/runs/1 (head abc, success)` is run 1; any run in the note is still looked up, even one joined to another URL by a comma, while a plain link or check page there is context. A link whose address cannot be parsed is an error. A check-run page (`/o/r/runs/<job>`, `/o/r/commit/<sha>/checks`) is an error: nothing here can look one up, so cite the Actions run. Every link to a run anywhere in the Proof section is looked up by its target: on a proof line or off one (nested bullets, paragraphs, tables, footnotes), written as `[CI run](…)`, a reference link, `<…>` or a relative href (`/o/r/actions/runs/1`, `../actions/runs/1`), which is resolved the way the PR page resolves it. Links on an unchecked `n/a` line are context for the reason and are not looked up. A run cited several times is fetched once and reported under every line that cites it |
| Malformed run URLs | A run-shaped path whose id is not readable as digits, or whose host is not `github.com`, or which carries a non-default port, is an **error** — never a generic artifact |
| Artifact URL scheme | `http://` is rejected |
| File paths | Resolved **only** against `GITHUB_WORKSPACE`, via `realpath`, and confined to it — absolute paths, `../` traversal and symlinks pointing out are rejected, and the process cwd is never consulted. Must name a **file**, not a directory. Existence is not enough: when the workspace is a git checkout the path must be **tracked**, which is what excludes the nested `_gh_workflows/` checkout and its `node_modules`. If `.git` is present but git cannot be queried (`safe.directory`, dubious ownership) the check fails **closed** and says why |
| Line endings | CRLF bodies (anything authored or edited in the GitHub web UI) render identically to LF |
| Cross-owner PRs | `runtime: n/a` forbidden when head repo not in `owned_repos` |
| Inline `[proof: key]` tokens | Every token in the rendered text must match a proof line key; `proof:` is read in any case and spacing (`[Proof: x]`, `[ proof : x ]`). Code examples (backtick spans, fenced and indented blocks) are excluded; a raw `<code>` wrapped around Markdown blocks renders as prose and is checked. Comments and HTML attributes are never rendered text |
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
- A repository-relative file committed to the PR branch (a `proof/` directory is the convention, not a requirement)
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

Every run sends the body to `https://api.github.com/markdown` to have it
rendered, so it needs network access. [GitHub's Markdown API documentation](https://docs.github.com/en/rest/markdown/markdown)
requires `contents: read` for private-resource rendering. Some labels may also
need `issues: read` or `pull-requests: read`. Public-resource rendering can run
without `GITHUB_TOKEN`, with the unauthenticated limit of 60 requests an hour.

Env vars for full validation of CI-run and file-path artifacts:

```
GITHUB_TOKEN=...                         # actions: read for run lookups;
                                         # contents: read for private rendering
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
GITHUB_API_URL=https://api.github.com    # optional; where the body is rendered
                                         # and runs are looked up. A hook for
                                         # the test suite, not GHES support:
                                         # run URLs must be on github.com
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

Normal test runs never call GitHub. The Markdown compatibility tests use a
local stub that answers `POST /markdown` with GitHub renderings recorded in
`scripts/__tests__/fixtures/github-renders.json`. A body without a recording
fails its test and names the fix. HTML-walk boundary tests also inject synthetic
HTML; those cases are not recordings of GitHub output. After adding or changing
a recorded test body:

```bash
RECORD_GITHUB_RENDERS=1 GITHUB_RENDER_TOKEN="$(gh auth token)" bun test
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

### Unreleased — the gate fails closed and reads the body GitHub renders

A set of inputs made the validator exit 0 when it should have exited 1, and a
smaller set made it exit 1 on valid markdown. Each was reproduced against the
previous parser before being fixed, and each has a regression test that fails
against it.

**Fail-open inputs, now rejected:**

- **CI-run URLs are recognised by canonical host, not by exact string.** The old
  pattern was host-exact, case-sensitive and `https`-only, and the generic
  `^https?://` accept sat directly behind it returning unconditionally. So
  `https://GitHub.com/o/r/actions/runs/1` skipped the `conclusion=success` and
  head_sha checks entirely — one capital letter — while the PR body still
  rendered a live link to the same run page. `http://` is now rejected, and a
  run-shaped path on a lookalike host or a non-default port is an error rather
  than a generic artifact. The run-id slot captures anything and is judged
  separately: readable ids are looked up, unreadable ones (`…/runs/123.` with
  the period GFM strips from an autolink) are errors. Percent-encoding and
  doubled slashes are normalised the way github.com routes them, and a decoded
  `#` in an owner or repo name cannot retarget the API request.
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
  both passed. Resolution is now only ever against `GITHUB_WORKSPACE`, through
  `realpath`, so a committed symlink pointing out is rejected too. The path must
  name a tracked file: `git ls-files` is queried with a literal pathspec (a lone
  `.`, or an untracked file named `*` beside a tracked one, used to satisfy it),
  directories are rejected, and when git cannot answer
  the check fails closed and says why.
- **CRLF bodies are read.** `.` excludes `\r` and `$` was not multiline-anchored, so
  on a CRLF body every proof line was dropped while the heading survived — the
  error blamed a missing checkbox list. GitHub stores web-UI-authored and
  web-UI-edited bodies with CRLF, and the caller's `types: [edited]` re-runs the
  gate the moment someone fixes a typo in the description.
- **The gate reads the body GitHub renders.** The line scanner and the parser
  that briefly replaced it both disagreed with GitHub, and each disagreement
  was a bypass: a checkbox inside a code fence, a tilde fence with tildes in its
  info string, a 4-space-indented fence, raw HTML lookalikes and claims after a
  dangling `<!--` counted while GitHub showed none of them; a raw `<code>` or
  `<plaintext>` line, a `<!x` declaration, an `<xmp>` block or a footnote hid
  boxes and claims GitHub shows. The body is now rendered by GitHub itself; see
  "How the body is read" below.
- **No box after `## Proof` is skipped.** `* [x]`, `+ [x]`, `1. [x]`, nested
  boxes, a box whose URL sits on the next line, boxes under a second `Proof`
  heading and boxes in footnotes all used to be ignored while GitHub rendered
  them as checked boxes. Each is now validated, and a box that does not read
  `key: value` (`runtime:URL`, `e2e : URL`, `done`) is an error.
- **Run links are looked up by their target.** A run cited as
  `[CI run](…/actions/runs/1)`, a reference link, `<…/actions/runs/1>` or a
  relative href used to miss run recognition and fail as a missing file path;
  now the run is checked, and so is a run linked from anywhere else in the
  section: a nested bullet, a paragraph, a table, a footnote.
- **A lookalike heading cannot redirect the gate.** `## Proof` with an invisible
  soft hyphen or combining joiner, `### Proof`, `## Proof:` or a Cyrillic
  `Ргооf` used to be passed over while a real `## Proof` hidden in a collapsed
  `<details>` further down was validated instead.
- **A proof line cannot hide part of itself.** GitHub keeps markup that hides
  or shrinks text: `<rp>` fallback text, a collapsed `<details>`, a URL struck
  through or nested eight `<sup>`/`<sub>` deep until it is two pixels tall.
  Hidden text in front of a value stood in for the visible artifact, and a
  hidden `n/a` excused a visible run link. A proof line may now contain only
  text, links, code, emphasis, emoji and footnote references, and no invisible
  or text-direction characters.
- **A Proof heading cannot be hidden.** Every recognised Proof heading must be
  outside `<details>` (nested and initially open ones included), ruby fallback
  `<rp>`, `<template>`, `<sup>` and `<sub>`, and so must a second Proof heading
  after a visible one. A heading counts as Proof by the text it shows, so
  `## <ins>Proof</ins>` can no longer be passed over either. This prevents a
  visible lookalike from steering validation to a hidden canonical heading.
  Notes-only disclosures remain allowed.
- **A cited run must belong to the PR.** A run was looked up in whatever
  repository its URL named, so the PR's head commit pushed to any other public
  repository, with an always-green workflow, produced a run that passed both
  the `conclusion=success` and the head_sha check. A cited run must now be in
  the PR's base repository or its head repository.
- **Check-run pages are not generic links.** `…/runs/<job>` and
  `…/commit/<sha>/checks` show a result the gate cannot look up, so citing one is
  an error instead of a pass.

**Behaviour changes for existing bodies:** a file path is read as displayed, so
a path Markdown reformats (`__tests__` renders as bold "tests") fails until it
is put in backticks, and the error says so. A checkbox after `## Proof` whose
key has a space (`- [x] python compile: …`) used to be skipped and is now an
error. A `Proof` heading written any way GitHub renders as a level-2 heading
now opens the section, and a failed claim under an earlier `Proof` heading is
no longer ignored. A run URL followed by a note (`…/runs/1 (head abc)`) is read
as the run. A Proof section previously wrapped in `<details>` must be moved
outside the disclosure, even if it uses the `open` attribute; the same holds for
`<rp>`, `<template>`, `<sup>` and `<sub>`.

**False rejections, now accepted:** a fence at a nested list item's content
column, a closing fence indented more than three spaces (CommonMark does not
treat it as a closer), and an unbalanced `<!--` inside inline code, which used
to swallow the rest of the body so a PR that *discusses* comment stripping could
not pass.

**Dependencies:** `parse5` is the only runtime dependency of `scripts/`, exactly
pinned. `remark`, `remark-parse`, `unified` and `unist-util-visit`, declared on
`main` and imported but never used, are gone.

### How the body is read

The verifier sends the PR body to GitHub's Markdown API (`POST /markdown`, mode
`gfm`, with the base repository as context) and validates the HTML it gets back.
That is the renderer behind a PR's `body_html`: for this repository's PR #15 the
two were identical byte for byte when checked. Private-resource rendering uses
the workflow's existing `contents: read`. GitHub documents additional
`issues: read` or `pull-requests: read` access for some label rendering; the
workflow does not grant those optional permissions. Public resources can be
rendered without a token. The call is retried on server errors and throttling;
when it still fails, the check fails.

Earlier versions emulated GitHub instead: a line scanner, then
`unified`/`remark-parse`/`rehype-raw`. GitHub renders with cmark-gfm on
CommonMark 0.29 and then sanitizes the HTML; the emulation followed CommonMark
0.31 and browser HTML rules. Wherever the two disagreed, the gate and the
reviewer read different documents. Asking GitHub removes that whole class
rather than patching its members one at a time.

From the rendered HTML:

- the section opens at the first heading of any level whose letters, with
  compatibility forms folded, default-ignorable characters dropped and a short
  table of Cyrillic and Greek lookalikes mapped, spell "proof" in any case;
  unless it is an `<h2>` reading exactly `Proof`, that is an error;
- a heading is recognised by the text it shows, markup included; every
  recognised Proof heading must be outside `<details>`, `<rp>`, `<template>`,
  `<sup>` and `<sub>`, whether it opens the section or appears later. The HTML
  walk carries that ancestry through nested elements and template content;
- every task-list checkbox after it is a proof line. GitHub's sanitizer strips
  raw `<input>` elements, so a checkbox can only come from task-list syntax;
- a proof line's text is its list item without the lists nested under it, with
  whitespace collapsed; the key is the text before the first `: `. The line may
  contain only text, links, code, emphasis, emoji and footnote references, and
  no invisible or text-direction characters; anything else is an error;
- every link in the section that points at an Actions run is looked up, after
  resolving it against `https://github.com/<base>/pull/`, and must be in the
  PR's base or head repository;
- `[proof: key]` tokens are read from all rendered text, folded the same way as
  headings, except code examples: a `<code>` or `<pre>` holding only inline
  content.

The HTML is parsed with `parse5` and walked iteratively, so a deeply nested
body gets a verdict rather than a stack overflow.

### Known gaps

The gate trusts GitHub's Markdown API to render the body the way the PR page
does. The two matched when checked; if GitHub's renderers ever diverge, the gate
follows the API. It renders the body from the triggering event, which for an
`edited` event is the new body. Local runs without `GITHUB_TOKEN` can render
public resources only and are limited to 60 renders an hour.

Heading lookalikes are matched with a short table, not Unicode's full
confusables data. A heading spelled with letters outside it (Coptic, small
capitals, Cherokee, digits drawn like `o`) may still read as "Proof" to a person
but is not recognised by the gate. It cannot supply the required canonical
heading, and pairing it with a canonical heading in a hiding container is
rejected. Paired with a visible canonical `## Proof` further down, the boxes under
the lookalike are not validated: the reviewer sees two Proof sections and only
the second one is checked.
Claims inside a mermaid diagram or math are read as code and not checked.
A claim that points at an unchecked `n/a` line counts as backed.

**Also open, unchanged:** strict mode keys on the *head* repo rather than the
base (`PR_BASE_REPO_FULL_NAME` is only the rendering context), and the
cross-owner `runtime` rule only recognises the key spelled `runtime` and a
value starting with `n/a`; nothing requires any given proof key to be present;
and the terminal `// Anything else: accept` still passes arbitrary prose,
including a value with no `/` in it, which never reaches the file-path branch at
all. These change semantics for existing PR bodies and are tracked separately.

## License

MIT — see [LICENSE](LICENSE).
