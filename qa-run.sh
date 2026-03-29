#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# qa-run.sh — Run the QA pipeline locally against a preview environment
#
# Usage:
#   ./qa-run.sh <PR_NUMBER> <PREVIEW_URL> [CLICKUP_TASKS]
#
# Examples:
#   ./qa-run.sh 284 https://pr-284---ai-boostform-api-preview-z6thvhgnxa-uc.a.run.app
#   ./qa-run.sh 284 https://pr-284---...uc.a.run.app "86b8pud4e,86b8pucz7"
#
# Prerequisites:
#   - .env file in repo root (see below for required vars)
#   - Node.js 20+
#   - npm install in repo root
#   - gcloud CLI authenticated (for IAP token + GCS fixture listing)
#   - test-cases.json already generated in repo root
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $0 <PR_NUMBER> <PREVIEW_URL> [CLICKUP_TASKS]"
  echo ""
  echo "  PR_NUMBER     — GitHub PR number (e.g. 284)"
  echo "  PREVIEW_URL   — Cloud Run preview URL"
  echo "  CLICKUP_TASKS — Comma-separated ClickUp task IDs (optional)"
  echo ""
  echo "Required .env vars (see .env.example):"
  echo "  GH_TOKEN              — GitHub PAT with repo + PR comment permissions"
  echo "  VERIFYIQ_API_KEY      — API key for the preview service"
  echo "  CLICKUP_API_TOKEN     — ClickUp API token (optional, for task creation)"
  echo "  GOOGLE_SA_KEY_FILE    — Path to GCP service account JSON key"
  echo "  CLICKUP_FOLDER_ID     — ClickUp folder ID for QA result lists"
  exit 1
fi

PR_NUMBER="$1"
PREVIEW_URL="${2%/}"  # strip trailing slash
CLICKUP_TASKS="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QA_DIR="$SCRIPT_DIR"

# ── Load .env ───────────────────────────────────────────────────────────────

ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "→ Loading .env from $ENV_FILE"
  set -a
  # Source .env but only export QA-relevant vars (skip comments and blank lines)
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Trim whitespace
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    export "$key"="$value"
  done < "$ENV_FILE"
  set +a
else
  echo "⚠ No .env file found at $ENV_FILE — using existing environment"
fi

# ── Set pipeline env vars ──────────────────────────────────────────────────

export PR_NUMBER="$PR_NUMBER"
export VERIFYIQ_SERVICE_URL="$PREVIEW_URL"
export PR_REPO="${PR_REPO:-boost-capital/ai-parser-studio}"

# ── Validate required vars ──────────────────────────────────────────────────

MISSING=""
[ -z "${GH_TOKEN:-}" ] && MISSING="$MISSING GH_TOKEN"
[ -z "${VERIFYIQ_API_KEY:-}" ] && MISSING="$MISSING VERIFYIQ_API_KEY"

if [ -n "$MISSING" ]; then
  echo "✗ Missing required environment variables:$MISSING"
  echo "  Add them to .env or export them before running."
  exit 1
fi

# ── Ensure dependencies are installed ──────────────────────────────────────

if [ ! -d "$QA_DIR/node_modules" ]; then
  echo "→ Installing QA runner dependencies..."
  (cd "$QA_DIR" && npm install)
fi

# ── Check for test-cases.json ──────────────────────────────────────────────

TC_FILE="$QA_DIR/test-cases.json"
if [ ! -f "$TC_FILE" ]; then
  echo "✗ No test-cases.json found at $TC_FILE"
  echo ""
  echo "  Generate test cases first using Claude Code:"
  echo "    1. Open Claude Code in the repo directory"
  echo "    2. Paste the QA prompt (see README.md for example)"
  echo "    3. Claude Code will generate test-cases.json automatically"
  exit 1
fi

TC_COUNT=$(python3 -c "import json; d=json.load(open('$TC_FILE')); print(len(d.get('test_cases', [])))" 2>/dev/null || echo "?")

# ── Print run summary ──────────────────────────────────────────────────────

echo ""
echo "┌─────────────────────────────────────────────────────────"
echo "│  QA Pipeline — Local Run"
echo "├─────────────────────────────────────────────────────────"
echo "│  PR:          #$PR_NUMBER"
echo "│  Preview:     $PREVIEW_URL"
echo "│  Test cases:  $TC_COUNT (from $TC_FILE)"
echo "│  Repo:        $PR_REPO"
[ -n "$CLICKUP_TASKS" ] && echo "│  ClickUp:     $CLICKUP_TASKS"
echo "│  ClickUp:     ${CLICKUP_API_TOKEN:+enabled}${CLICKUP_API_TOKEN:-disabled (no token)}"
echo "└─────────────────────────────────────────────────────────"
echo ""

# ── Run the QA runner ──────────────────────────────────────────────────────

echo "→ Running QA test suite..."
echo ""

cd "$QA_DIR"
node run_qa.mjs
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ QA run complete — all tests passed"
else
  echo "❌ QA run complete — some tests failed (exit code: $EXIT_CODE)"
fi

exit $EXIT_CODE
