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
# Exit codes:
#   0  clean
#   1  editorial violation
#   2  gate error (missing/unreadable pattern source, empty pattern set or
#      grep failure). A failed check must not report clean input.
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
trap 'rm -f "$GREP_ERR" "${STYLE_FILE:-}" "${FOOTER_COPY:-}" "${FOOTER_CUT:-}"' EXIT

# The cloud-session footer (PLATFORM_FOOTER in lint-patterns.sh) is not authored
# text. In body mode every pattern runs on a copy without it. Only trailing lines
# are dropped, so each line number reported below still points into the
# original body; CR is stripped for the comparison only, never from the copy.
LINT_FILE="$BODY_FILE"
if [ "$MODE" = "body" ] && [ -n "${LINT_PLATFORM_FOOTER_LINE:-}" ]; then
  FOOTER_COPY="$(mktemp)"
  FOOTER_CUT="$(mktemp)"
  # The body goes in on stdin, never as an operand: awk reads an operand shaped
  # `name=value` (a relative path such as `body=pr.md`) as a variable assignment,
  # then reads an empty stdin, and every pattern would pass on an empty copy.
  if ! FOOTER_RULE="$LINT_PLATFORM_FOOTER_RULE" FOOTER_LINE="$LINT_PLATFORM_FOOTER_LINE" \
       CUT_FILE="$FOOTER_CUT" awk '
    { raw[NR] = $0; t = $0; sub(/\r$/, "", t); cmp[NR] = t }
    END {
      n = NR
      while (n > 0 && cmp[n] ~ /^[[:space:]]*$/) n--
      last = NR
      if (n > 1 && cmp[n] ~ ENVIRON["FOOTER_LINE"] && cmp[n - 1] ~ ENVIRON["FOOTER_RULE"]) {
        last = n - 2
        print (n - 1) "-" n > ENVIRON["CUT_FILE"]
      }
      for (i = 1; i <= last; i++) print raw[i]
    }' < "$BODY_FILE" > "$FOOTER_COPY"; then
    echo "ERROR: could not separate the platform footer from '$BODY_FILE'." >&2
    exit 2
  fi
  LINT_FILE="$FOOTER_COPY"
  if [ -s "$FOOTER_CUT" ]; then
    echo "NOTE: lines $(cat "$FOOTER_CUT") are the Claude Code platform footer and are not linted."
  fi
fi

for i in "${!PATTERNS[@]}"; do
  PAT="${PATTERNS[$i]}"
  RC=0
  MATCHES="$(grep -nE -- "$PAT" "$LINT_FILE" 2>"$GREP_ERR")" || RC=$?
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

# Prose style runs last, on bodies only. Exempt proof lines so supported
# punctuation such as `- [ ] runtime: n/a — <reason>` remains accepted.
if [ "$MODE" = "body" ] && [ "${#LINT_BASELINE_PROSE_STYLE[@]}" -gt 0 ]; then
  STYLE_FILE="$(mktemp)"
  grep -vE -- "$LINT_PROSE_STYLE_EXEMPT" "$LINT_FILE" > "$STYLE_FILE" || true
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
    # Non-exempt prose matches block the body, just like other editorial rules.
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
