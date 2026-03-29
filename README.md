# VerifyIQ QA Automation

AI-powered QA test-case generation and execution pipeline for the VerifyIQ document-processing API.

## How It Works

1. **Generate test cases** from a PR diff using Claude Code CLI
2. **Execute test cases** against a preview environment via `run_qa.mjs`
3. **Post results** as a PR comment + ClickUp tasks

## Quick Start

### 1. Setup

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Edit .env with your actual tokens
```

### 2. Generate Test Cases (Claude Code CLI)

From the `ai-parser-studio` repo, generate a diff and use Claude Code to create test cases:

```bash
# In the ai-parser-studio repo
gh pr diff <PR_NUMBER> --repo boost-capital/ai-parser-studio > .pr-diff.txt
gsutil ls -r 'gs://qa-automation-dev/**' > .fixture-map.txt
curl -sf "https://<PREVIEW_URL>/openapi.json" -o .api-schema.json
```

Then run Claude Code with the prompt template:

```bash
claude -p "$(cat QA_PROMPT_TEMPLATE.md)

Read .pr-diff.txt for the PR changes.
Read .fixture-map.txt for available fixtures.
Read .api-schema.json for the OpenAPI spec.
Generate test cases and output as JSON." --output-file test-cases.json
```

Or interactively:

```bash
claude
# Then paste the prompt from QA_PROMPT_TEMPLATE.md
# Save the JSON output to test-cases.json
```

### 3. Run Tests

```bash
# Option A: Using the shell script
./qa-run.sh <PR_NUMBER> <PREVIEW_URL> [CLICKUP_TASK_IDS]

# Option B: Direct node execution
export PR_NUMBER=284
export VERIFYIQ_SERVICE_URL=https://pr-284---ai-boostform-api-preview-z6thvhgnxa-uc.a.run.app
node run_qa.mjs
```

### 4. Results

The runner will:
- Execute each test case as an HTTP call against the preview environment
- Create ClickUp tasks with PASS/FAIL status (if `CLICKUP_API_TOKEN` is set)
- Post a summary table as a PR comment (if `GH_TOKEN` is set)

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes TCs, posts results to GitHub + ClickUp |
| `qa-run.sh` | Shell wrapper — loads `.env`, validates config, runs `run_qa.mjs` |
| `QA_PROMPT_TEMPLATE.md` | Reusable prompt for Claude Code to generate test cases |
| `package.json` | Node.js dependencies (axios) |
| `.env.example` | Template for required environment variables |
| `test-cases.json` | Generated test cases (not committed — create per run) |

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `GH_TOKEN` | GitHub PAT with `repo` + PR comment permissions |
| `PR_REPO` | Repository in `owner/repo` format |
| `PR_NUMBER` | PR number for result posting |
| `VERIFYIQ_SERVICE_URL` | Preview environment URL |
| `VERIFYIQ_API_KEY` | API key for the preview service |

### Optional

| Variable | Description |
|---|---|
| `CLICKUP_API_TOKEN` | ClickUp token for task creation |
| `WEBHOOK_SITE_BASE_URL` | webhook.site URL (for batch tests) |
| `WEBHOOK_IDENTITY_TOKEN` | webhook.site identity token |
| `IAP_TOKEN` | GCP IAP token (for `/ai-gateway/` endpoints) |

## Test Case Schema

```json
{
  "summary": "One sentence describing what changed",
  "test_cases": [
    {
      "id": "TC-01",
      "title": "Descriptive test name",
      "type": "positive",
      "endpoint": "/v1/documents/parse",
      "method": "POST",
      "payload": { "file": "gs://...", "fileType": "BankStatement" },
      "expected_status": 200,
      "assertions": [
        { "description": "Check", "path": "field.path", "pattern": "regex" }
      ]
    }
  ]
}
```

## GitHub Actions Integration

This pipeline also runs automatically via `qa-on-pr.yml` in the `ai-parser-studio` repo. When a PR is opened against `main`, the workflow:

1. Generates a diff + fetches fixtures
2. Uses Claude Code Action to generate test cases
3. Validates fixture paths against GCS bucket
4. Runs the test suite via `run_qa.mjs`
5. Posts results as a PR comment + ClickUp tasks
