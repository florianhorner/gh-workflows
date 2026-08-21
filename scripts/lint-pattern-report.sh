#!/usr/bin/env bash
# Run every baseline pattern over the frozen corpus and emit adjudicatable TSV.
#
#   lint-pattern-report.sh [corpus-file]
#
# Output columns: class, pattern, source, line, matched_text, full_line
#
# `matched_text` is emitted SEPARATELY from `full_line` on purpose. Every
# narrowing decision comes from reading the span the regex actually matched, not
# the line it happened to sit on — a report that only shows lines hides the
# reason a pattern is too broad.
#
# This is a local tuning tool. It is not run in CI: the regression test diffs
# against the adjudicated baseline instead, so CI never needs the corpus
# regenerated or the network touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CORPUS="${1:-}"
if [ -z "$CORPUS" ]; then
  CORPUS="$(ls "$REPO_ROOT"/tests/fixtures/lint-corpus-*.txt 2>/dev/null | head -1)"
fi
if [ -z "$CORPUS" ] || [ ! -r "$CORPUS" ]; then
  echo "ERROR: no readable corpus (looked for tests/fixtures/lint-corpus-*.txt)." >&2
  exit 2
fi

# shellcheck source=scripts/lint-patterns.sh
source "$SCRIPT_DIR/lint-patterns.sh"

# The corpus stores provenance as a "#<pr>:" line prefix. Grepping it directly
# makes every ^-anchored pattern structurally unable to match — a heading rule
# like `^#{1,6}[[:space:]]*Findings` would be reported as "zero hits" when it was
# never given a chance to fire. Strip the prefix into a parallel file, match
# against that, and map line numbers back through an index.
STRIPPED="$(mktemp)"
INDEX="$(mktemp)"
trap 'rm -f "$STRIPPED" "$INDEX"' EXIT
sed 's/^#[0-9]*://' "$CORPUS" > "$STRIPPED"
sed -n 's/^\(#[0-9]*\):.*/\1/p' "$CORPUS" > "$INDEX"

if [ "$(wc -l < "$STRIPPED")" -ne "$(wc -l < "$INDEX")" ]; then
  echo "ERROR: corpus line/index mismatch — every line must carry a #<pr>: prefix." >&2
  exit 2
fi

printf 'class\tpattern\tsource\tline\tmatched_text\tfull_line\n'

emit() { # $1 class, $2 pattern
  local class="$1" pat="$2" rc=0 out
  out="$(grep -nE -- "$pat" "$STRIPPED" 2>/dev/null)" || rc=$?
  [ "$rc" -ne 0 ] && return 0
  while IFS= read -r hit; do
    local lineno="${hit%%:*}"
    local text="${hit#*:}"
    local src
    src="$(sed -n "${lineno}p" "$INDEX")"
    local matched
    matched="$(printf '%s' "$text" | grep -oE -- "$pat" 2>/dev/null | head -1)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$class" "$pat" "$src" "$lineno" "$matched" "$text"
  done <<< "$out"
}

for p in "${LINT_BASELINE_CORE[@]}";        do emit "CORE"        "$p"; done
for p in "${LINT_BASELINE_BODY[@]}";        do emit "BODY"        "$p"; done
for p in "${LINT_BASELINE_PROSE_STYLE[@]}"; do emit "PROSE_STYLE" "$p"; done
