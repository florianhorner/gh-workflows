# gh-workflows

Reusable GitHub Actions workflows for `florianhorner/*` repositories.

## `checkout-credentials` — focused checkout-token audit

This reusable workflow runs zizmor's offline `artipacked` audit over a caller's
workflow and composite-action definitions. It fails when `actions/checkout`
implicitly persists credentials and points to the exact file and line. Explicit
`persist-credentials: true` remains an intentional opt-in; all other checkout
steps should set it to `false`.

Add a SHA-pinned caller that runs whenever workflow or composite-action files
change:

```yaml
name: checkout-credentials
on:
  pull_request:
    paths: [".github/workflows/**", ".github/actions/**"]
  push:
    branches: [main]
    paths: [".github/workflows/**", ".github/actions/**"]
permissions:
  contents: read
jobs:
  audit:
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
| CI run URLs | Must resolve to `conclusion=success` **and** `head_sha == PR head SHA` |
| Cross-owner PRs | `runtime: n/a` forbidden when head repo not in `owned_repos` |
| Inline `[proof: key]` tokens | Must match an existing proof line key |
| Draft PRs | Exempt |
| Bot authors | `dependabot[bot]`, `pre-commit-ci[bot]`, `github-actions[bot]` exempt |

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
    uses: florianhorner/gh-workflows/.github/workflows/verify-claims.yml@f93889a64ff7b501182e5c988b992672ca857ea9 # v1.3
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

## Release notes (unreleased)

### Parser fixes (will land in v1.2)

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
