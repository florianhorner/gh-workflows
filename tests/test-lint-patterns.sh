#!/usr/bin/env bash
# Regression test for the baseline editorial patterns.
#
#   bash tests/test-lint-patterns.sh
#
# Five assertions, in the order that a failure is cheapest to diagnose:
#
#   1. COMPILE  - every pattern compiles with EMPTY STDERR. Exit code alone is
#                 not enough: a dialect can accept a malformed pattern, warn on
#                 stderr, and then match something nobody intended. This is the
#                 assertion that catches PCRE constructs like `(?:...)` leaking
#                 into a POSIX ERE file.
#   2. RECALL   - every line of lint-known-bad.txt is caught by >=1 pattern.
#   3. PRECISION- every line of lint-known-good.txt is caught by 0 patterns.
#   4. EXEMPT   - the proof-block `n/a — <reason>` form survives the prose rule,
#                 because the proof gate and this gate run on the same body.
#   5. DRIFT    - re-running the patterns over the frozen corpus reproduces the
#                 adjudicated baseline exactly. A new hit means "adjudicate it";
#                 a lost hit means "coverage lost".
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

# shellcheck source=scripts/lint-patterns.sh
source scripts/lint-patterns.sh

ALL_PATTERNS=(
  "${LINT_BASELINE_CORE[@]}"
  "${LINT_BASELINE_BODY[@]}"
  "${LINT_BASELINE_PROSE_STYLE[@]}"
)

echo "grep in use: $(grep --version 2>&1 | head -1)"
echo

# --- 1. COMPILE ------------------------------------------------------------
echo "[1/5] compile, empty stderr"
for pat in "${ALL_PATTERNS[@]}"; do
  err="$(printf 'probe\n' | grep -nE -- "$pat" 2>&1 >/dev/null)" || true
  if [ -n "$err" ]; then bad "pattern emits diagnostics: $pat -> $err"; else ok; fi
done
echo "      ${#ALL_PATTERNS[@]} patterns checked"

# Applies every pattern to one line. Echoes the first pattern that matches.
match_any() {
  local line="$1" pat
  for pat in "${ALL_PATTERNS[@]}"; do
    if printf '%s\n' "$line" | grep -qE -- "$pat" 2>/dev/null; then
      printf '%s' "$pat"; return 0
    fi
  done
  return 1
}

# --- 2. RECALL -------------------------------------------------------------
echo "[2/5] recall: known-bad lines must all be caught"
n=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  n=$((n+1))
  if match_any "$line" >/dev/null; then ok
  else bad "uncaught known-bad line: $line"; fi
done < tests/fixtures/lint-known-bad.txt
echo "      $n known-bad lines checked"

# --- 3. PRECISION ----------------------------------------------------------
echo "[3/5] precision: known-good lines must all be clean"
n=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  # The em-dash exemption is a property of check-body-lint.sh, not of the
  # pattern; exempt lines are asserted separately in step 4.
  if printf '%s\n' "$line" | grep -qE -- "$LINT_PROSE_STYLE_EXEMPT" 2>/dev/null; then
    continue
  fi
  n=$((n+1))
  if hit="$(match_any "$line")"; then
    bad "known-good line matched [$hit]: $line"
  else ok; fi
done < tests/fixtures/lint-known-good.txt
echo "      $n known-good lines checked"

# --- 4. EXEMPT -------------------------------------------------------------
echo "[4/5] proof-block n/a lines survive the prose rule"
TMP_BODY="$(mktemp)"
{
  echo "Adds a retry guard to the fetcher."
  echo ""
  echo "## Proof"
  echo "- [x] tests: proof/pytest.log"
  echo "- [ ] runtime: n/a — no runtime surface changed"
} > "$TMP_BODY"
if bash scripts/check-body-lint.sh --mode body "$TMP_BODY" >/dev/null 2>&1; then ok
else
  bad "a clean body carrying a proof-block em dash was rejected:"
  bash scripts/check-body-lint.sh --mode body "$TMP_BODY" 2>&1 | sed 's/^/        /'
fi
rm -f "$TMP_BODY"

# --- 5. DRIFT --------------------------------------------------------------
echo "[5/5] corpus drift vs adjudicated baseline"
BASELINE=tests/expected/lint-pattern-baseline.tsv
if [ ! -r "$BASELINE" ]; then
  bad "missing adjudicated baseline $BASELINE"
else
  CUR="$(mktemp)"; EXP="$(mktemp)"
  bash scripts/lint-pattern-report.sh 2>/dev/null \
    | tail -n +2 | cut -f1,3,4,5 | sort > "$CUR"
  grep -v '^#' "$BASELINE" | grep -v '^[[:space:]]*$' \
    | cut -f2,3,4,5 | sort > "$EXP"
  if diff -q "$EXP" "$CUR" >/dev/null 2>&1; then
    ok
    echo "      $(wc -l < "$CUR" | tr -d ' ') corpus hits reproduce the baseline"
  else
    NEW="$(comm -13 "$EXP" "$CUR" | head -5)"
    LOST="$(comm -23 "$EXP" "$CUR" | head -5)"
    [ -n "$NEW" ]  && bad "new corpus hit - adjudicate it into $BASELINE:"$'\n'"$NEW"
    [ -n "$LOST" ] && bad "coverage lost - a baseline hit no longer matches:"$'\n'"$LOST"
  fi
  rm -f "$CUR" "$EXP"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED: $FAIL assertion(s), $PASS passed."
  exit 1
fi
echo "PASSED: $PASS assertions."
exit 0
