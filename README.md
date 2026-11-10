# gh-workflows

Reusable GitHub Actions workflows for `florianhorner/*` repositories.

## `checkout-credentials`: audit checkout tokens

The workflow runs zizmor's offline `artipacked` audit on workflows and
composite actions. It reports the file and line when
`actions/checkout` implicitly persists credentials. Set
`persist-credentials: false` unless a later Git operation needs the token.
Set it to `true` explicitly to persist credentials.

Pull requests use `pull_request_target` to load the caller from the trusted
base branch. The audit downloads changed workflow and composite-action YAML
through GitHub's API without checking out or executing pull request code.
Pushes scan the complete checkout. Only `artipacked` findings fail this audit;
other zizmor rules are outside its policy.

Add a SHA-pinned caller without trigger-level path filters. GitHub evaluates a
bounded changed-file list for filtered events, so filters can skip the audit
on oversized pull requests.

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

`pull_request_number` defaults to `0`, which selects the complete checkout.
For a PR, the audit checks the returned file count against the PR's
changed-file count and refuses a partial result.

## `verify-claims`: validate PR proof blocks

Include a `## Proof` section in each PR body. The workflow renders the body
through GitHub's Markdown API and validates the returned HTML. Rendering
failures fail the check. Configure it as a required status check to block
merges with missing or malformed proof.

Draft PRs and PRs authored by `dependabot[bot]`, `pre-commit-ci[bot]` or
`github-actions[bot]` are exempt.

### Caller workflow

Add `.github/workflows/verify-claims.yml` to the consuming repository:

The example pins merged commit
[`9085c9da024edbfd5fafbd8801d996776c4fdbcf`](https://github.com/florianhorner/gh-workflows/commit/9085c9da024edbfd5fafbd8801d996776c4fdbcf),
which contains GitHub-rendered validation and the clean-integration witness.
This commit has no release tag. The latest version tag, `v1.5`, lacks both
features and does not provide the validation described below. Use the full
SHA for these checks; do not substitute `v1.5`.

```yaml
name: verify-claims
on:
  pull_request:
    types: [opened, edited, synchronize, ready_for_review]
jobs:
  verify:
    permissions:
      contents: read
      actions: read
    uses: florianhorner/gh-workflows/.github/workflows/verify-claims.yml@9085c9da024edbfd5fafbd8801d996776c4fdbcf # merged main commit; no release tag
    with:
      owned_repos: "florianhorner/govee2mqtt,florianhorner/mammamiradio"
```

The workflow checks out the code, installs Bun and runs the parser. Keep both
permissions: checkouts and private-resource rendering need `contents: read`,
and run lookups and reusable-workflow ref resolution need `actions: read`.
GitHub rejects a called workflow that requests more access than its caller
allows.

Pin `uses:` to a full 40-character commit SHA, with an optional version comment.
Tags can move and change executed code without a caller diff. Dependabot's
`github-actions` ecosystem can update the SHA and version comment. The workflow
resolves its script checkout to the ref the caller pinned.

### Proof syntax

Replace each placeholder with an artifact or a reason for `n/a`:

```markdown
## Proof

- [x] build: <ci-run-url> [proof: build]
- [x] tests: <ci-run-url> OR TestFunctionName [proof: tests]
- [x] lint: <ci-run-url> [proof: lint]
- [ ] runtime: <artifact-url> OR "n/a — <reason>" [proof: runtime]
- [ ] schema: "n/a — no MQTT or HA interface changes" OR <diff-url> [proof: schema]
```

| Item | Requirement |
|------|-------------|
| Heading | The first recognised Proof heading must be level 2 and read exactly `Proof` |
| Checkbox | Every checkbox after the heading must read `key: value`; keys cannot contain spaces |
| Checked value | An artifact such as an HTTPS URL, test name or repository-relative file path; `n/a` is rejected |
| Unchecked value | A validated artifact, or `n/a` followed by a non-empty reason after `—`, `–` or `-` |
| Cross-owner runtime | `runtime: n/a` is rejected when the head repository is absent from `owned_repos` |
| Inline claim | Each rendered `[proof: key]` token must match a proof-line key |

The validator reads values as GitHub displays them. Backtick file paths:
Markdown can turn `scripts/__tests__/x.ts` into `scripts/tests/x.ts` with bold
text. CRLF and LF bodies render the same way.

The validator checks every task-list checkbox in the section, including nested bullets,
numbered lists, boxes beneath another Proof heading and footnotes. A value may
continue on the next line. Malformed boxes are errors. The key is the text
before the first `: ` in the list item's displayed text, with nested lists
excluded and whitespace collapsed.

Proof lines may contain text, links, code, emphasis, emoji and footnote
references, including GitHub's `<tt>` markup for linked commits. Other markup,
invisible characters and text-direction characters are rejected. Elements such
as `<details>`, ruby and nested `<sup>` or `<sub>` can hide or distort an artifact
and are rejected.

Heading recognition folds compatibility forms, drops default-ignorable
characters and maps a short table of Cyrillic and Greek lookalikes. Case,
punctuation and heading level are then checked. Headings such as `### Proof`,
`## Proof:` or Cyrillic `Ргооf` are errors. Recognition uses the whole text,
including text inside markup such as `<ins>`.

Every recognised Proof heading must sit within the body, lists,
quotes, alerts, tables, divs or visible formatting (`a`, `b`, `em`, `i`,
`strong`, `tt`, `u`), with at most one `code`, `tt` or `pre` ancestor. Other
containers are rejected, including `<details>` even when open, ruby,
`<template>`, `<sup>`, `<sub>`, `<small>`, `<del>`, `<s>`, `<span>` and
footnotes. Collapsible notes without a Proof heading remain allowed.

Inline claim tokens accept case and spacing variants such as `[Proof: x]` and
`[ proof : x ]`. Code examples, comments and HTML attributes do not supply
claims. A raw `<code>` around Markdown blocks still renders as prose and is
checked. The HTML walk uses `parse5` and iterative traversal for deeply nested
bodies.

### CI run artifacts

A cited Actions run must have `conclusion=success`. The API must identify its
repository as the PR's base repository, and the run must describe the PR head's
content. A run
from another repository is rejected even on the same commit. A fork PR's head
repository does not qualify; an old URL for a renamed base repository can.

The validator checks run links throughout the Proof section, including paragraphs,
nested bullets, tables and footnotes. Markdown links, reference links,
autolinks and relative hrefs are resolved by target. A repeated run is fetched
once and reported for every line that cites it. Run links on an unchecked
`n/a` line are context for its reason and are not looked up.

URL matching ignores host case and `www.`, percent-decodes paths, collapses
doubled slashes and removes trailing autolink punctuation (`?!.,:;*_~)]`). A
URL at the start of a value supplies the artifact; following text is a note. Runs in
that note are still checked, including comma-joined URLs. A plain link or
check page in the note remains context. A decoded `#` in an owner or repository
name cannot retarget a run lookup.

Use `https://github.com/{owner}/{repo}/actions/runs/{id}`. A run-shaped URL with
an ID that is not digits, a different host or a non-default port is an error.
Malformed link targets and check-run pages such as `/o/r/runs/<job>` or
`/o/r/commit/<sha>/checks` are rejected. Artifact URLs must use HTTPS.

A run describes the PR head when its `head_sha` equals that head, or when the
head contains only clean base integrations since the run. Git's three-way
merge of the run commit and integrated parent must reproduce the head tree
exactly. The integrated parent must be on the base branch's first-parent
chain. Reachability alone would admit intermediate feature-branch states
that the base branch never held.

Repeated base integrations are allowed, but the head must remain the merge
commit. A later content commit, hand-resolved conflict, extra content in the
merge, `-s ours`, octopus merge, rebase or unrelated run fails this test. So
does a run already contained by the base, a base ref resolving only as a tag,
missing objects, shallow history, an unreadable first-parent chain or an
unavailable `merge-tree`. Failures report why the run is stale.

`scripts/clean-integrate-witness.ts` implements this predicate. The workflow
fetches full PR history only when the body cites a CI run and passes
`PR_BASE_REF` to anchor the integrated parent. Checking whether a file is
tracked needs only a shallow checkout.

### Other artifacts and file paths

Runtime artifacts may be Actions run URLs, timestamped Gist logs, release
assets, screenshot URLs or committed repository-relative files. A `proof/`
directory is a convention, not a requirement.

File paths resolve only against `GITHUB_WORKSPACE`, through `realpath`.
Absolute paths, traversal outside the checkout, escaping symlinks and
directories are rejected. In a Git checkout, both the path and any symlink
target must be tracked; untracked nested checkouts and `node_modules` cannot
supply proof. An unreadable Git checkout fails closed, including Git ownership
or `safe.directory` errors.

### Local use and tests

```bash
cd scripts
bun install --frozen-lockfile
cat your-pr-body.md | bun verify-proof-block.ts
# or
bun verify-proof-block.ts --body-file your-pr-body.md
```

The parser sends the body to `https://api.github.com/markdown` in `gfm` mode
with the base repository as context. Network access is required. Private
rendering needs `contents: read`; some labels may need `issues: read` or
`pull-requests: read`, which the workflow does not grant. Public rendering can
run without a token, subject to GitHub's unauthenticated rate limit.
See [GitHub's Markdown API documentation](https://docs.github.com/en/rest/markdown/markdown).
The parser retries server errors and throttling. Failed retries fail the check;
the workflow stops after 10 minutes.

| Environment variable | Purpose |
|----------------------|---------|
| `GITHUB_TOKEN` | `actions: read` for run lookups; `contents: read` for private rendering |
| `PR_HEAD_SHA` | Expected PR head commit |
| `PR_BASE_REF` | Base branch anchoring clean integrations; for example, `main` |
| `GITHUB_WORKSPACE` | PR checkout at `PR_HEAD_SHA`; the only root for proof-file resolution |
| `GITHUB_API_URL` | Optional API endpoint, default `https://api.github.com`; a test hook, not GHES support, since run URLs must use `github.com` |
| `PR_HEAD_REPO_FULL_NAME` | Head repository; for example, `florianhorner/your-repo` |
| `PR_BASE_REPO_FULL_NAME` | Repository in which a cited run must have run; falls back to the head repository |
| `OWNED_REPOS` | Comma-separated repositories allowed to use `runtime: n/a`; for example, `florianhorner/govee2mqtt,florianhorner/mammamiradio` |
| `PROOF_FETCH_TIMEOUT_MS` | Optional per-request timeout, default `20000` |

Set `GITHUB_TOKEN` and `PR_HEAD_SHA` for CI-run validation. Without
`GITHUB_WORKSPACE`, the parser skips file-existence checks, but still rejects
absolute and escaping paths. With it, a missing proof file is an error and the
witness checks that the checkout is at `PR_HEAD_SHA`.

Run the parser and witness tests from `scripts/`:

```bash
bun test
```

Tests use a local API stub. Markdown compatibility
cases use saved GitHub renderings in
`scripts/__tests__/fixtures/github-renders.json`; missing recordings fail with
a message naming the missing recording. Tests of the HTML walker also inject
synthetic HTML. To record a new or changed Markdown test body:

```bash
RECORD_GITHUB_RENDERS=1 GITHUB_RENDER_TOKEN="$(gh auth token)" bun test
```

Recording sends test bodies to GitHub. Use synthetic test content and a token
appropriate for the public rendering contexts.

### Known limitations

- The gate follows GitHub's Markdown API if its output differs from the PR
  page. It validates the body in the triggering event; an `edited` event uses
  the new body. Unauthenticated local rendering is limited to public resources
  and GitHub's rate limit.
- The heading-confusable table is incomplete. An unrecognised lookalike paired
  with a visible canonical Proof heading can leave boxes before that heading
  unchecked. A hidden canonical heading is rejected.
- A green run is bound to the PR's repository and content, not to a workflow
  that tests the claim. Any successful workflow on that content can qualify,
  including one added or changed by the PR.
- Mermaid and math claims are read as code and skipped. A token pointing to an
  unchecked `n/a` line counts as backed.
- Strict ownership mode keys on the head repository. The cross-owner runtime
  rule recognises only the key `runtime` and a value starting with `n/a`.
  No particular proof key is mandatory.
- Values without a slash can be accepted as test-name or prose artifacts.
  The gate does not establish that those tests ran.

## `body-lint`: check public prose

The workflow flags selected patterns of review narration, agent provenance,
operator telemetry and writing style in PR bodies, issue bodies and
changelogs. Patterns use POSIX ERE and must behave the same under BSD grep on
macOS and GNU grep in CI.

```yaml
jobs:
  pr-body:
    permissions: { contents: read, actions: read }
    uses: florianhorner/gh-workflows/.github/workflows/body-lint.yml@<sha>
    with:
      target: pr-body
      extra_patterns: scripts/lint-patterns.sh   # optional, repo-local additions
```

| Input | Values and default |
|-------|--------------------|
| `target` | Required: `pr-body`, `issue-body` or `changelog` |
| `extra_patterns` | Optional file on the caller's base ref; default empty |
| `changelog_paths` | Space-separated files for `changelog`; default `CHANGELOG.md` |

The caller needs `contents: read` and `actions: read` for checkout and pinned
ref resolution. Extra files supply a `LINT_PATTERNS` array added to the
baseline. Consumers cannot remove baseline patterns through an override.
Files come from the caller's base ref, so a PR cannot weaken the rules judging
it in the same change.

PR and issue bodies use CORE, BODY and PROSE_STYLE patterns. Changelogs use
CORE only. The em-dash style rule blocks body prose; proof checkbox lines and
`n/a — <reason>` lines are exempt. Drafts are linted. The bot authors exempt
from `verify-claims` are also exempt from PR-body lint. Empty bodies and absent
changelog files are skipped; absent changelogs produce a notice. A missing
configured extra-pattern file fails the job.

### Updating patterns

```bash
bash scripts/lint-pattern-report.sh > /tmp/report.tsv
bash tests/test-lint-patterns.sh
```

The report includes each match's class, pattern, synthetic source ID, line,
matched span and full text. It accepts an optional corpus-file argument.
Review changed matches before updating
`tests/expected/lint-pattern-baseline.tsv`. Preserve synthetic positive cases
and legitimate-prose controls for every pattern. A pattern must not ship with
unresolved false-positive (`FP`) rows; acceptable exceptions use `ALLOW`.
Patterns added to CORE must produce zero hits against the consuming
repository's changelogs.

### Claude Code cloud footer

In body mode, the linter excludes this exact pair when it forms the last
non-blank lines:

```text
---
_Generated by [Claude Code](https://claude.ai/code/session_<id>)_
```

It reports the exclusion while preserving original line numbers. The same
words elsewhere, a different host, a missing separator, text after the footer
and every changelog remain subject to lint. The expressions are
`LINT_PLATFORM_FOOTER_RULE` and `LINT_PLATFORM_FOOTER_LINE` in
`scripts/lint-patterns.sh`. The footer has no proof checkbox or run link, so
`verify-claims` needs no exemption.

### Limits

Regexes recognise selected wording. Changing a heading from `## Findings` to
`## Notes` can bypass a heading pattern without changing the content. Semantic
privacy review is still needed; a lint pass does not establish that a body is
appropriate to publish.

## Release notes

### Unreleased: synthetic editorial fixtures and clearer documentation

Synthetic cases check each editorial pattern and record its matched text.
The documentation groups setup instructions and validator limitations by
workflow. Inputs and validation rules are unchanged.

### Unreleased: cloud-footer support

PR and issue bodies can end with the recognised Claude Code cloud footer
without failing editorial lint. Only the trailing pair is excluded; other
provenance text and changelogs retain their existing checks.

### Unreleased: proof after clean base integrations

A successful CI run can remain valid after the PR integrates its base without
adding content. The witness anchors the integrated parent to the base
branch's first-parent history and verifies Git's merge result. Parser and
witness tests run in `workflow-lint.yml`.

### Unreleased: rendered proof validation

The validator checks GitHub-rendered proof sections, including nested boxes,
footnotes and linked run artifacts. Run URLs are canonicalised and tied to the
PR's base repository and content. Malformed URLs, hidden proof markup,
escaping or untracked files and unreadable Git state fail the check. CRLF
bodies, nested fences and comment syntax inside inline code are handled.
`parse5` is the only runtime dependency and is pinned exactly.

### Parser fixes (v1.2)

Artifact paths can carry a trailing `[proof: KEY]` suffix without treating it
as part of the filename. Non-CI HTTPS artifacts are classified as URLs before
file-path checks. Inline claim validation still reads the original body.
These fixes preserve templates, function signatures and tag naming.

### Upgrade and compatibility

- The `verify-claims` caller example pins a merged commit without a release
  tag to provide the checks documented here. Cloud-footer support requires
  updating the separate `body-lint.yml` pin; inputs do not change.
- Clean-integration support passes `PR_BASE_REF` and fetches full history when
  the body cites a CI run. Existing callers need no new inputs.
- Backtick paths that Markdown reformats. Move Proof headings outside
  `<details>` and other disallowed containers, including open disclosures.
  Use a space-free proof key and a non-empty `n/a` reason; real artifacts on
  unchecked lines are validated too.
- Cite an Actions run rather than a check-run page. Fork-head runs cannot
  supply proof for the base repository. A run URL may include a trailing note.

## License

MIT. See [LICENSE](LICENSE).
