#!/usr/bin/env bash
# Regression test for the baseline editorial patterns.
#
#   bash tests/test-lint-patterns.sh
#
# Checks:
#
#   1. COMPILE  - patterns compile without stderr diagnostics, including warnings
#                 from grep dialects that accept unsupported syntax.
#   2. RECALL   - every line of lint-known-bad.txt is caught by >=1 pattern.
#   3. PRECISION- every line of lint-known-good.txt is caught by 0 patterns.
#   4. EXEMPT   - the proof-block `n/a — <reason>` form survives the prose rule,
#                 because the proof gate and this gate run on the same body.
#   5. DRIFT    - corpus matches reproduce the reviewed baseline. Inspect added
#                 and lost matches before updating it.
#   6. FOOTER   - exempt the trailing cloud footer. Mid-body copies, near-matches
#                 and changelog copies still fail.
#   7. COVERAGE - each pattern matches a line of the synthetic corpus and does
#                 not match one neutral sentence. That sentence is a sanity
#                 check; per-rule near-misses are lint-known-good.txt (step 3).
#   8. REPORT   - preserve columns, source IDs, line numbers and heading matches.
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
echo "[1/8] compile, empty stderr"
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
echo "[2/8] recall: known-bad lines must all be caught"
n=0
while IFS= read -r line; do
  case "$line" in ''|'#'|'# '*) continue ;; esac
  n=$((n+1))
  if match_any "$line" >/dev/null; then ok
  else bad "uncaught known-bad line: $line"; fi
done < tests/fixtures/lint-known-bad.txt
echo "      $n known-bad lines checked"

# --- 3. PRECISION ----------------------------------------------------------
echo "[3/8] precision: known-good lines must all be clean"
n=0
while IFS= read -r line; do
  case "$line" in ''|'#'|'# '*) continue ;; esac
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
echo "[4/8] proof-block n/a lines survive the prose rule"
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
echo "[5/8] corpus drift vs adjudicated baseline"
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

# --- 6. FOOTER -------------------------------------------------------------
echo "[6/8] cloud footer: exempt at the end of a body, nowhere else"
FOOTER='_Generated by [Claude Code](https://claude.ai/code/session_01ExampleSessionId00000000)_'
EXTRA_PATTERNS="$(mktemp)"
# A consuming repo's own list bans the same words; the exemption must cover
# patterns passed as extras, not only the baseline.
printf '%s\n' "LINT_PATTERNS=('\\bClaude Code\\b' '🤖 Generated with')" > "$EXTRA_PATTERNS"

# footer_case <label> <expected exit> <mode> <body printf format> [args...]
footer_case() {
  local label="$1" want="$2" mode="$3" fmt="$4"; shift 4
  local body rc=0 out
  body="$(mktemp)"
  # shellcheck disable=SC2059
  printf "$fmt" "$@" > "$body"
  out="$(bash scripts/check-body-lint.sh --mode "$mode" "$body" "$EXTRA_PATTERNS" 2>&1)" || rc=$?
  if [ "$rc" -eq "$want" ]; then ok
  else
    bad "$label: expected exit $want, got $rc"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
  rm -f "$body"
}

footer_case "footer with session URL" 0 body \
  'Adds a retry guard.\n\n## Proof\n- [x] tests: proof/pytest.log\n\n---\n%s' "$FOOTER"
footer_case "footer with bare claude.ai/code URL" 0 body \
  'Adds a retry guard.\n\n---\n%s\n' '_Generated by [Claude Code](https://claude.ai/code)_'
footer_case "footer followed by blank lines" 0 body \
  'Adds a retry guard.\n\n---\n%s\n\n\n' "$FOOTER"
footer_case "CRLF body from the web editor" 0 body \
  'Adds a retry guard.\r\n\r\n---\r\n%s\r\n' "$FOOTER"
footer_case "footer with text after it" 1 body \
  'Adds a retry guard.\n\n---\n%s\n\nMore text.\n' "$FOOTER"
footer_case "footer line without the rule above it" 1 body \
  'Adds a retry guard.\n\n%s\n' "$FOOTER"
footer_case "footer pointing at another host" 1 body \
  'Adds a retry guard.\n\n---\n%s\n' '_Generated by [Claude Code](https://example.com/code)_'
footer_case "authored provenance above a valid footer" 1 body \
  'Written with Claude Code.\n\n---\n%s\n' "$FOOTER"
footer_case "footer in a changelog" 1 changelog \
  '## 1.0.0\n\n- Adds a retry guard.\n\n---\n%s\n' "$FOOTER"

# The NOTE names the footer's own line numbers, and a violation above it keeps
# its original number.
NOTE_BODY="$(mktemp)"
printf 'Adds a retry guard.\nWritten with Claude Code.\n\n---\n%s\n' "$FOOTER" > "$NOTE_BODY"
NOTE_OUT="$(bash scripts/check-body-lint.sh --mode body "$NOTE_BODY" 2>&1)" || true
case "$NOTE_OUT" in
  *"NOTE: lines 4-5 are the Claude Code platform footer"*"FAIL: [provenance/archaeology] 2:Written with Claude Code."*) ok ;;
  *) bad "footer note or original line number missing:"; printf '%s\n' "$NOTE_OUT" | sed 's/^/        /' ;;
esac
rm -f "$NOTE_BODY" "$EXTRA_PATTERNS"

# A relative body path shaped `name=value` is a file, not an awk assignment: the
# copy must still carry the body, so a violation in it still fails. Stdin is
# /dev/null so a regression fails here instead of waiting on a terminal.
EQ_DIR="$(mktemp -d)"
printf 'Written with Claude Code.\n' > "$EQ_DIR/body=pr.md"
EQ_RC=0
(cd "$EQ_DIR" && bash "$REPO_ROOT/scripts/check-body-lint.sh" --mode body "body=pr.md" </dev/null >/dev/null 2>&1) || EQ_RC=$?
if [ "$EQ_RC" -eq 1 ]; then ok
else bad "relative body path 'body=pr.md': expected exit 1, got $EQ_RC"; fi
rm -rf "$EQ_DIR"

# --- 7. COVERAGE -----------------------------------------------------------
echo "[7/8] each pattern has a synthetic positive and passes a neutral sentence"
CORPUS_TEXT="$(mktemp)"
sed 's/^#[0-9]*://' tests/fixtures/lint-corpus-synthetic.txt > "$CORPUS_TEXT"
for pat in "${ALL_PATTERNS[@]}"; do
  if grep -qE -- "$pat" "$CORPUS_TEXT"; then ok
  else bad "pattern has no synthetic positive: $pat"; fi
  if printf '%s\n' 'The parser rejects an empty record.' | grep -qE -- "$pat"; then
    bad "pattern rejects the synthetic control: $pat"
  else ok; fi
done
rm -f "$CORPUS_TEXT"

# --- 8. REPORT -------------------------------------------------------------
echo "[8/8] report contract and source mapping"
REPORT_INPUT="$(mktemp)"
REPORT_OUTPUT="$(mktemp)"
REPORT_EXPECTED="$(mktemp)"
printf '#41:Clean configuration defaults.\n#41:## Findings\n#42:The review found a missing field\n' > "$REPORT_INPUT"
REPORT_RC=0
bash scripts/lint-pattern-report.sh "$REPORT_INPUT" > "$REPORT_OUTPUT" || REPORT_RC=$?
if [ "$REPORT_RC" -eq 0 ] && \
   [ "$(head -1 "$REPORT_OUTPUT")" = $'class\tpattern\tsource\tline\tmatched_text\tfull_line' ]; then ok
else bad "report header or exit code changed"; fi
printf 'BODY\t#41\t2\t## Findings\t## Findings\nBODY\t#42\t3\treview found\tThe review found a missing field\n' > "$REPORT_EXPECTED"
if tail -n +2 "$REPORT_OUTPUT" | cut -f1,3-6 | sort | diff -u "$REPORT_EXPECTED" -; then ok
else bad "report lost a heading match, source ID, line number or matched span"; fi

# Reject corpora without numeric case prefixes.
printf '## Findings\n' > "$REPORT_INPUT"
REPORT_RC=0
bash scripts/lint-pattern-report.sh "$REPORT_INPUT" > "$REPORT_OUTPUT" 2>&1 || REPORT_RC=$?
if [ "$REPORT_RC" -eq 2 ]; then ok
else bad "malformed corpus: expected exit 2, got $REPORT_RC"; fi
# An empty case ID (`#:`) is not numeric and must be rejected too.
printf '#:## Findings\n' > "$REPORT_INPUT"
REPORT_RC=0
bash scripts/lint-pattern-report.sh "$REPORT_INPUT" > "$REPORT_OUTPUT" 2>&1 || REPORT_RC=$?
if [ "$REPORT_RC" -eq 2 ]; then ok
else bad "empty case ID: expected exit 2, got $REPORT_RC"; fi
REPORT_RC=0
bash scripts/lint-pattern-report.sh "$REPORT_INPUT.missing" > "$REPORT_OUTPUT" 2>&1 || REPORT_RC=$?
if [ "$REPORT_RC" -eq 2 ]; then ok
else bad "missing corpus: expected exit 2, got $REPORT_RC"; fi
rm -f "$REPORT_INPUT" "$REPORT_OUTPUT" "$REPORT_EXPECTED"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED: $FAIL assertion(s), $PASS passed."
  exit 1
fi
echo "PASSED: $PASS assertions."
exit 0
