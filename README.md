# VerifyIQ QA Automation

AI-powered QA pipeline — generates and runs test cases against PR preview environments using Claude Code CLI.

## How It Works

1. QA runs `node run_qa.mjs --pr owner/repo#42` from the CLI
2. The runner fetches the PR diff, generates test cases via Claude Code CLI, executes them against the target environment, and posts results as a PR comment
3. Results are also posted to ClickUp (when `CLICKUP_API_TOKEN` is set)

## One-Time Setup

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your actual values — see Environment Variables below
```

**Prerequisites:** Node 20+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Running QA

Requires at least one of `--pr` or `--clickup` (unless `--skip-generation`).

```bash
# PR + ClickUp (full context — diff + acceptance criteria)
node run_qa.mjs --pr owaBoost/verifyiq-Dev#42 --clickup 86b94t6av

# PR only (diff-driven)
node run_qa.mjs --pr owaBoost/verifyiq-Dev#42

# ClickUp only (ticket-driven, runs against dev env)
node run_qa.mjs --clickup 86b94t6av

# Multiple ClickUp tasks
node run_qa.mjs --clickup 86b94t6av --clickup 86b94t6bx

# Dry run: same pipeline but skip posting the PR comment
node run_qa.mjs --pr owaBoost/verifyiq-Dev#42 --dry-run

# Re-run existing test cases (skip TC generation)
node run_qa.mjs --skip-generation

# Explicit environment override (auto-detected by default)
node run_qa.mjs --pr owaBoost/verifyiq-Dev#42 --env dev
node run_qa.mjs --pr owaBoost/verifyiq-Dev#42 --env preview

# Local diff testing (from a clone of the parser repo)
node run_qa.mjs --diff-source local

# Show all options
node run_qa.mjs --help
```

### Manual Claude Code workflow (alternative)

Open Claude Code in this folder and paste a QA prompt with PR details:

```
PR Number: 289
Preview URL: https://ai-parser-pr-289-z6thvhgnxa-uc.a.run.app
ClickUp Tasks: 86b919n51
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VERIFYIQ_API_KEY` | yes | VerifyIQ tenant API key |
| `GH_TOKEN` | yes (with `--pr`) | GitHub PAT with repo + PR comment permissions |
| `USE_IAP` | yes | Set to `true` for IAP-protected environments |
| `IAP_CLIENT_ID` | yes | OAuth client ID from GCP IAP settings |
| `DEV_URL` | optional | Dev environment URL (defaults to `https://parser-dev.boostkh.com`) |
| `VERIFYIQ_SERVICE_URL` | optional | Preview URL candidate (probed during `--env auto`) |
| `PREVIEW_URL_PATTERN` | optional | Preview URL template, e.g. `https://ai-parser-pr-{NUMBER}-z6thvhgnxa-uc.a.run.app` |
| `CLICKUP_API_TOKEN` | optional | ClickUp API token (for `--clickup` context + result posting) |
| `CLICKUP_FOLDER_ID` | optional | ClickUp folder ID (defaults to `90147709410`) |
| `PR_REPO` | optional | Default PR repo (overridden by `--pr` flag) |
| `PR_NUMBER` | optional | Default PR number (overridden by `--pr` flag) |

**Optional — only needed for batch test cases (`/ai-gateway/` endpoints):**

| Variable | Description |
|---|---|
| `GOOGLE_SA_KEY_FILE` | Path to GCP service account JSON for IAP auth |
| `WEBHOOK_SERVER_URL` | Webhook server URL for async batch callbacks |
| `WEBHOOK_TOKEN_ID` | Webhook token ID (auto-created at runtime if not set) |

## Multi-Agent Pipeline

The repo also supports a structured multi-agent pipeline that chains five stages:

```
planner → generator → runner → evaluator → reporter
```

Run the full pipeline:

```bash
node pipeline.mjs [clickup_task_id ...]
# or
npm run pipeline -- [clickup_task_id ...]
```

Run a specific test type directly:

```bash
npm run pipeline:parse   -- [clickup_task_id ...]   # parse-only tests
npm run pipeline:batch   -- [clickup_task_id ...]   # batch-upload tests
npm run pipeline:auth    -- [clickup_task_id ...]   # auth-boundary tests
npm run pipeline:full    -- [clickup_task_id ...]   # full regression
```

### Running the pipeline watcher

The watcher polls `tasks/pending/` every 10 seconds and automatically runs the pipeline for any new plan JSON it finds:

```bash
node watcher.mjs
# or
npm run watch:pipeline
```

Drop a plan into `tasks/pending/` (via the planner agent or manually) and the watcher picks it up, runs all stages, and moves it to `tasks/completed/`. Plans that fail are also moved to `tasks/completed/` with `status: "failed"` and an error report in `reports/`. Lock files prevent duplicate execution and auto-expire after 10 minutes.

Each stage can also run standalone:

```bash
node agents/planner/index.mjs 86b91ztdx          # creates tasks/pending/<plan>.json
node agents/generator/index.mjs <plan-file>.json  # generates test-cases.json
node agents/runner/index.mjs <plan-file>.json     # runs run_qa.mjs
node agents/evaluator/index.mjs <plan-file>.json  # writes reports/<plan>-eval.json
node agents/reporter/index.mjs <plan-file>.json   # writes reports/<plan>-report.md
```

### Pipeline folder structure

```
agents/
  planner/index.mjs      — reads PR + env, creates plan JSON
  generator/index.mjs     — generates or reuses test-cases.json
  runner/index.mjs        — executes run_qa.mjs
  evaluator/index.mjs     — summarizes pass/fail into eval JSON
  reporter/index.mjs      — writes markdown report, posts to ClickUp
tasks/
  pending/                — new plan JSONs land here
  running/                — plans move here during execution
  completed/              — finished plans end up here
reports/                  — eval JSON + markdown reports
memory/                   — reserved for future agent memory
```

The pipeline does **not** replace the existing `run_qa.mjs` CLI — it wraps it. You can still run `node run_qa.mjs` directly as before.

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes TCs against preview env, posts results to ClickUp |
| `pipeline.mjs` | Multi-agent pipeline orchestrator |
| `watcher.mjs` | Auto-processes plans from tasks/pending/ on a 10s poll |
| `QA_PROMPT_TEMPLATE.md` | Full prompt template with all rules, fixtures, and examples |
| `qa-run.sh` | Shell wrapper — loads `.env` and runs `run_qa.mjs` |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies (axios) |

## ClickUp Results

Each TC gets a ClickUp task with:

- **Description** — endpoint, payload JSON, fixture path, steps
- **Activity comment** — PASSED or FAILED, assertion details, HTTP status, curl command, response body
- **Tags** — `qa-auto` + `positive`/`negative` + `needs-fixture` if fixture missing

## Test Case Schema

```json
{
  "test_cases": [
    {
      "id": "TC-01",
      "title": "Test name",
      "type": "positive",
      "endpoint": "/v1/documents/parse",
      "method": "POST",
      "payload": { "file": "gs://qa-automation-dev/...", "fileType": "BankStatement" },
      "expected_status": 200,
      "assertions": [
        { "description": "Check field", "path": "field.*.subfield", "pattern": "^regex$" }
      ]
    }
  ]
}
```
