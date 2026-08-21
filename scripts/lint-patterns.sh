#!/usr/bin/env bash
# Baseline editorial pattern source for PR bodies, issue bodies and changelogs.
#
# Sourced by scripts/check-body-lint.sh. Consuming repos add their own
# project-specific patterns in their own scripts/lint-patterns.sh; the two sets
# are applied as a union. A repo may only ADD patterns — removing a baseline
# pattern is a PR to this file, not a local override.
#
# ---------------------------------------------------------------------------
# THESE ARE SHAPES, NOT PHRASES.
#
# The predecessor of this file was a literal-phrase denylist grown one incident
# at a time. It held `findings (raised|confirmed|refuted)` and still passed
# "Findings from review"; it held `adversarially verif` and still passed
# "mutation testing found". Every escape was a novel wording of a class that was
# already banned. Patterns here match the grammatical frame of a violation so
# that paraphrase does not walk through.
#
# Two things follow from that, and both are load-bearing:
#   1. A new pattern is not shipped until it has been run over
#      tests/fixtures/lint-corpus-*.txt and every hit adjudicated into
#      tests/expected/lint-pattern-baseline.tsv. Guessing produces gates that
#      fire on legitimate prose and then get disabled.
#   2. A pattern that hits nothing in the corpus is UNFALSIFIED, not validated.
#      It needs hand-written paraphrases in tests/fixtures/lint-known-bad.txt
#      before it counts as covered.
#
# ---------------------------------------------------------------------------
# DIALECT: POSIX ERE only, and it must behave identically under BSD grep
# (macOS /usr/bin/grep, which is what the local PreToolUse hook resolves) and
# GNU grep (ubuntu-latest, which is what CI runs). That means:
#   - no lookahead/lookbehind, no non-capturing groups `(?:...)`, no `\d`,
#     no non-greedy `*?`, no `\K`, no PCRE classes.
#   - `\b` is used; both dialects support it.
# The regression test asserts every pattern compiles with EMPTY STDERR under
# the available grep. A pattern that errors is a gate that reports nothing.

# ---------------------------------------------------------------------------
# CORE — safe to apply anywhere, including public changelogs and docs.
# Admission rule: a pattern belongs here only if it produces ZERO hits against
# the consuming repo's changelogs. One hit turns main red on merge day.
# shellcheck disable=SC2034
LINT_BASELINE_CORE=(
  # Agent / tool provenance. Naming the machinery that produced the change.
  '/autoplan'
  '\b[Cc]odex (review|independent review)\b'
  '\bClaude (review|Code)\b'
  # "Conductor session" and "Conductor agent" name the harness and are always
  # provenance. "Conductor workspace" is different: mammamiradio SHIPS workspace
  # support as a feature, so "Conductor workspace support with lifecycle
  # scripts" is legitimate changelog copy, and the bare noun produced four false
  # positives against the real CHANGELOG.md. For that one term the violation is
  # the prepositional frame — the work happened *in* a workspace — not the word.
  '\bConductor (session|agent)\b'
  '\b(in|from|on|inside) (this |the |a |my )?Conductor workspace\b'
  '🤖 Generated with'
  '\bCLAUDE\.md\b'

  # Workspace archaeology: local machine state leaking into a public artifact.
  'stash@\{'
  '\b[Uu]n-?pushed branch'
  '\b[Uu]ntracked (code|files)\b'
)

# ---------------------------------------------------------------------------
# BODY — PR and issue bodies only. Deliberately NOT applied to changelogs:
# a changelog legitimately says "29 of 30 paths covered", and review vocabulary
# appears in release notes describing what a release contains.
# shellcheck disable=SC2034
LINT_BASELINE_BODY=(
  # R1 — review archaeology by shape: a review noun near a discovery verb.
  # Catches "mutation testing found", "the audit surfaced", "review caught",
  # "a reviewer flagged" and the wordings nobody has written yet. Past tense
  # only, so "the linter flags a bare except" stays legal.
  '\b([Rr]eviewers?|[Rr]eview|[Aa]udit|[Mm]utation testing|[Ff]uzzing)\b[^.]{0,40}\b([Ff]ound|[Cc]aught|[Ff]lagged|[Ss]urfaced|[Rr]evealed|[Tt]urned up)\b'

  # R1b — a review actor caught mid-action, with no discovery verb to anchor on.
  # "a reviewer ticking the box" escaped R1 because "ticking" is not a discovery
  # verb and never will be enumerable. Matching the actor plus any progressive
  # verb covers the frame instead of the vocabulary. Present tense without -ing
  # ("the page a reviewer opens") is deliberately still legal.
  '\b[Aa] (reviewer|review pass|reviewer bot) [a-z]+ing\b'

  # R2 — the reverse order: discovery verb first, review noun after.
  # "found by review", "caught in the audit", "surfaced during review".
  '\b([Ff]ound|[Cc]aught|[Ss]urfaced|[Ff]lagged|[Rr]aised)\b[^.]{0,20}\b(by|in|during)\b[^.]{0,15}\b([Rr]eview|[Aa]udit|the reviewer)\b'

  # R3 — review-artifact section headings. Catches the label, never the content:
  # renaming the section to "## Notes" defeats it, and that is a known limit.
  '^#{1,6}[[:space:]]*(Findings|Pre-?Landing Review|Review (notes|findings)|What I (cut|removed|changed))'
  '\bFindings from (review|the review|code review)\b'

  # R4 — first-person debrief register. A PR body describes the change, not the
  # author's process of arriving at it.
  '(^|[[:space:]])(What I cut|I should have|I drafted|I rewrote the|I initially)\b'

  # R5 — process tallies. "two findings", "3 of 5 reviewers", "N review rounds".
  '\b([0-9]+|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive) ([Ff]indings?|[Rr]eview (passes|rounds))\b'
  '\b[0-9]+ of [0-9]+ ([Rr]eviewers|models|agents)\b'
  '\b[Ff]indings (raised|confirmed|refuted|applied)\b'
  '\b[Aa]dversarial(ly)? verif'

  # R6 — operator telemetry. Usage data about real listeners is not release
  # copy, and on a public repo it is a privacy leak, not just an editorial one.
  "\\b([Ss]tation|[Aa]pp|[Pp]roduct|[Ss]ervice)'?s own\\b[^.]{0,30}\\bdata\\b"
  '\b([Uu]sage|[Ll]istening|[Oo]perator preference|[Tt]elemetry) data\b[^.]{0,20}\b([Ss]howed|[Rr]evealed|[Ss]aid|[Rr]ejected|[Cc]onfirmed)\b'
  '\b[Oo]perator preference data\b'

  # R7 — product judgement dressed as a statement of fact. One grammatical
  # frame only; the space of evaluative claims is unbounded and this is a
  # tripwire on the commonest shape, not coverage of the class.
  '\b[Nn]obody (had |has )?(chosen|picked|asked for|wanted)\b'
)

# ---------------------------------------------------------------------------
# PROSE_STYLE — PR bodies only, and never changelogs. The em-dash rule lives
# here and nowhere else: it matches ~46% of merged PR bodies and hundreds of
# changelog lines, so promoting it to CORE turns main red immediately.
#
# The carve-out is mandatory, not cosmetic: the proof-block format
# `- [ ] runtime: n/a — <reason>` REQUIRES an em dash, and the proof gate and
# this gate run on the same body in the same hook invocation. A rule that makes
# the two contradict each other is unshippable.
# shellcheck disable=SC2034
LINT_BASELINE_PROSE_STYLE=(
  '—'
)

# Lines exempt from PROSE_STYLE. Applied as `grep -vE` before the style pass.
# shellcheck disable=SC2034
LINT_PROSE_STYLE_EXEMPT='n/a[[:space:]]*—|^[[:space:]]*- \[[ x]\]'

# ---------------------------------------------------------------------------
# Human-readable message per pattern index is deliberately NOT modelled here.
# check-body-lint.sh prints the class name from the array it fired in, which is
# the smallest thing that tells an author what to do without a parallel array
# that silently falls out of sync with the patterns.
