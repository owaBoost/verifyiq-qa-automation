# VerifyIQ QA Automation

AI-powered QA pipeline — generates and runs test cases against PR preview environments using Claude Code CLI.

## How It Works

1. Dev posts a PR number + preview URL in Slack
2. Open Claude Code in this folder and paste the QA prompt with PR details
3. Claude fetches the diff, ClickUp ACs, and GCS fixtures automatically
4. Claude generates test cases, runs them, and posts results to ClickUp

## One-Time Setup

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your actual values — see Environment Variables below
```

## Running QA for Any PR

Open Claude Code in this folder:

```bash
cd E:\verifyiq-qa-automation
claude
```

Then paste this prompt with the 3 values filled in:

```
You are a QA automation engineer for VerifyIQ. Run the full QA pipeline:

PR Number: [PR_NUMBER] from boost-capital/ai-parser-studio
Preview URL: [PREVIEW_URL]
ClickUp Tasks: [TASK_IDS] (comma separated)

Steps:
1. gh pr diff [PR_NUMBER] --repo boost-capital/ai-parser-studio
2. Fetch each ClickUp task: curl -H "Authorization: Bearer $CLICKUP_API_TOKEN" https://api.clickup.com/api/v2/task/[TASK_ID]
3. gsutil ls -r gs://qa-automation-dev/**
4. Assess testability — if not testable via API, explain why and recommend another approach
5. Generate test cases covering ALL AC scenarios — no count limit. Use wildcard paths array.*.field never numeric index. Save to test-cases.json
6. Generate IAP token: node E:/verifyiq-playwright/scripts/gen-iap-token.js with audience [PREVIEW_URL]
7. Run: node run_qa.mjs with VERIFYIQ_SERVICE_URL=[PREVIEW_URL]
8. Report results and post to ClickUp folder 90147709410
```

Example for PR #289:

```
PR Number: 289
Preview URL: https://pr-289---ai-boostform-api-preview-z6thvhgnxa-uc.a.run.app
ClickUp Tasks: 86b919n51
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VERIFYIQ_API_KEY` | yes | VerifyIQ tenant API key |
| `CLICKUP_API_TOKEN` | yes | ClickUp API token for posting results |
| `CLICKUP_FOLDER_ID` | yes | ClickUp folder ID (use `90147709410`) |
| `GH_TOKEN` | yes | GitHub PAT with repo + PR comment permissions |
| `IAP_TOKEN` | optional | Pre-generated IAP token (auto-generated if not set) |

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
