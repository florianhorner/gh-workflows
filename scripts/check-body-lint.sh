#!/usr/bin/env bash
# Editorial lint for a PR body, issue body or changelog file.
#
#   check-body-lint.sh --mode <body|changelog> <file> [extra-patterns.sh ...]
#
# --mode body        CORE + BODY + PROSE_STYLE   (PR and issue bodies)
# --mode changelog   CORE only                    (public changelogs, docs)
#
# Extra pattern files are sourced after the baseline and their LINT_PATTERNS
# array (the shape consuming repos already use) is unioned in. Repos may only
# ADD; there is no suppression knob by design.
#
# Exit codes, and the distinction matters:
#   0  clean
#   1  editorial violation
#   2  gate error (missing/unreadable pattern source, empty pattern set, grep
#      failure). Never let a broken gate read as clean — that is how a lint
#      dies silently and nobody notices for four months.
set -euo pipefail

MODE=""
BODY_FILE=""
EXTRA_SOURCES=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *)
      if [ -z "$BODY_FILE" ]; then BODY_FILE="$1"; else EXTRA_SOURCES+=("$1"); fi
      shift ;;
  esac
done

[ -z "$MODE" ] && MODE="body"
case "$MODE" in
  body|changelog) ;;
  *) echo "ERROR: --mode must be 'body' or 'changelog' (got '$MODE')." >&2; exit 2 ;;
esac

if [ -z "$BODY_FILE" ] || [ ! -f "$BODY_FILE" ]; then
  echo "ERROR: body file '${BODY_FILE:-<none>}' not found." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE="$SCRIPT_DIR/lint-patterns.sh"

# Readability is checked before sourcing: bash aborts a non-interactive shell
# outright when `source` targets a missing file, so an if-guard around the
# source alone can never catch that case.
if [ ! -r "$BASELINE" ]; then
  echo "ERROR: baseline pattern source '$BASELINE' is missing or unreadable." >&2
  exit 2
fi
# shellcheck source=scripts/lint-patterns.sh
if ! source "$BASELINE"; then
  echo "ERROR: could not load '$BASELINE'." >&2
  exit 2
fi

PATTERNS=()
CLASSES=()
add_set() { # $1 = class label, rest = patterns
  local label="$1"; shift
  local p
  for p in "$@"; do PATTERNS+=("$p"); CLASSES+=("$label"); done
}

add_set "provenance/archaeology" "${LINT_BASELINE_CORE[@]}"
if [ "$MODE" = "body" ]; then
  add_set "body-editorial" "${LINT_BASELINE_BODY[@]}"
fi

for extra in ${EXTRA_SOURCES+"${EXTRA_SOURCES[@]}"}; do
  if [ ! -r "$extra" ]; then
    echo "ERROR: extra pattern source '$extra' is missing or unreadable." >&2
    exit 2
  fi
  # Each extra file is sourced in a way that cannot clobber the baseline arrays.
  unset LINT_PATTERNS
  # shellcheck disable=SC1090
  if ! source "$extra"; then
    echo "ERROR: could not load extra pattern source '$extra'." >&2
    exit 2
  fi
  if [ "${#LINT_PATTERNS[@]}" -gt 0 ]; then
    add_set "project-specific" "${LINT_PATTERNS[@]}"
  fi
done

if [ "${#PATTERNS[@]}" -eq 0 ]; then
  echo "ERROR: no patterns loaded — nothing would be linted." >&2
  exit 2
fi

FAIL=0
HITS=0
GREP_ERR="$(mktemp)"
trap 'rm -f "$GREP_ERR" "${STYLE_FILE:-}"' EXIT

for i in "${!PATTERNS[@]}"; do
  PAT="${PATTERNS[$i]}"
  RC=0
  MATCHES="$(grep -nE -- "$PAT" "$BODY_FILE" 2>"$GREP_ERR")" || RC=$?
  # A pattern that the local grep dialect rejects must fail loudly. Checking the
  # exit code alone is not enough; some dialects accept a malformed pattern,
  # warn on stderr, and match something unintended.
  if [ -s "$GREP_ERR" ]; then
    echo "ERROR: pattern '$PAT' produced grep diagnostics:" >&2
    cat "$GREP_ERR" >&2
    exit 2
  fi
  [ "$RC" -eq 1 ] && continue
  if [ "$RC" -gt 1 ]; then
    echo "ERROR: pattern '$PAT' failed against '$BODY_FILE' (grep exit $RC)." >&2
    exit 2
  fi
  while IFS= read -r line; do
    echo "FAIL: [${CLASSES[$i]}] $line  [pattern: $PAT]"
    HITS=$((HITS + 1))
  done <<< "$MATCHES"
  FAIL=1
done

# Prose style runs last and only on bodies, against an exempted copy. The
# proof-block format `- [ ] runtime: n/a — <reason>` requires an em dash, so
# linting the raw file would put this gate in permanent conflict with the proof
# gate that runs on the same body.
if [ "$MODE" = "body" ] && [ "${#LINT_BASELINE_PROSE_STYLE[@]}" -gt 0 ]; then
  STYLE_FILE="$(mktemp)"
  grep -vE -- "$LINT_PROSE_STYLE_EXEMPT" "$BODY_FILE" > "$STYLE_FILE" || true
  for PAT in "${LINT_BASELINE_PROSE_STYLE[@]}"; do
    RC=0
    MATCHES="$(grep -nE -- "$PAT" "$STYLE_FILE" 2>"$GREP_ERR")" || RC=$?
    if [ -s "$GREP_ERR" ]; then
      echo "ERROR: prose pattern '$PAT' produced grep diagnostics:" >&2
      cat "$GREP_ERR" >&2
      exit 2
    fi
    [ "$RC" -eq 1 ] && continue
    if [ "$RC" -gt 1 ]; then
      echo "ERROR: prose pattern '$PAT' failed (grep exit $RC)." >&2
      exit 2
    fi
    # Blocking. Shipped advisory first because the rule matched 141 of 161
    # historical bodies; that number describes bodies written before the rule
    # existed, and holding a stated preference to an advisory tier forever
    # because it was once violated often is how a rule stays decorative.
    #
    # The proof-block carve-out above is what makes blocking safe: `n/a — …`
    # lines are exempt, so this gate cannot contradict the proof gate that runs
    # on the same body in the same hook invocation.
    while IFS= read -r line; do
      echo "FAIL: [prose-style] $line  [pattern: $PAT]"
      HITS=$((HITS + 1))
    done <<< "$MATCHES"
    FAIL=1
  done
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Found $HITS editorial violation(s) in '$BODY_FILE'."
  echo "Public bodies describe user-visible outcomes. Review archaeology,"
  echo "agent provenance, operator telemetry and process narrative belong in"
  echo "the private durable record, not here."
  exit 1
fi

echo "Editorial lint clean ($MODE, ${#PATTERNS[@]} patterns)."
exit 0
