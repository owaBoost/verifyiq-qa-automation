# VerifyIQ QA Automation

AI-powered QA pipeline — generates and runs test cases against PR preview environments using Claude Code CLI.

## How It Works

1. Dev posts PR number + preview URL in Slack
2. QA opens Claude Code in this folder
3. Claude fetches the PR diff, ClickUp acceptance criteria, and GCS test fixtures
4. Claude generates test cases, runs them against the preview environment, and posts results to ClickUp

## Setup (one time only)

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your actual values
```

## Running QA for a PR

**Step 1:** Open Claude Code in this folder

```bash
cd E:\verifyiq-qa-automation
claude
```

**Step 2:** Paste this prompt with the 3 values filled in (`[PR_NUMBER]`, `[PREVIEW_URL]`, `[TASK_IDS]`):

```
You are a QA automation engineer for VerifyIQ. Run the full QA pipeline:
PR Number: [PR_NUMBER] from boost-capital/ai-parser-studio
Preview URL: [PREVIEW_URL]
ClickUp Tasks: [TASK_IDS]

Steps:
1. gh pr diff [PR_NUMBER] --repo boost-capital/ai-parser-studio
2. curl -H 'Authorization: Bearer $CLICKUP_API_TOKEN' https://api.clickup.com/api/v2/task/[TASK_ID]
3. gsutil ls -r gs://qa-automation-dev/**
4. Assess testability. If not via API, explain why.
5. Generate test cases covering ALL AC scenarios, save to test-cases.json
6. Generate IAP token using E:/verifyiq-playwright/scripts/gen-iap-token.js with audience [PREVIEW_URL]
7. node run_qa.mjs
8. Post results to ClickUp folder 90147709410
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `VERIFYIQ_API_KEY` | VerifyIQ tenant API key |
| `CLICKUP_API_TOKEN` | ClickUp API token |
| `GOOGLE_SA_KEY_FILE` | Path to GCP service account JSON key |
| `CLICKUP_FOLDER_ID` | ClickUp folder ID for QA results (default: `90147709410`) |
| `GH_TOKEN` | GitHub PAT with `repo` scope |

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes TCs, posts results to ClickUp + GitHub |
| `QA_PROMPT_TEMPLATE.md` | Full prompt template with all generation rules |
| `qa-run.sh` | Shell wrapper for manual runs |
| `.env.example` | Environment variable template |
| `test-cases.json` | Generated per run (not committed) |

## ClickUp Results

- A **list** is created per PR inside folder `90147709410`
- A **task** is created per test case with pass/fail status
- Task **description** contains the endpoint, JSON payload, fixture path, and curl command
- Task **comment** (activity feed) contains the result: pass/fail, assertion details (expected vs actual), HTTP status, and timestamp
- A **summary comment** is posted on the source ClickUp tasks

## Test Case Schema

```json
{
  "summary": "One sentence describing what changed",
  "test_cases": [
    {
      "id": "TC-01",
      "title": "Descriptive test name",
      "type": "positive | negative | batch",
      "preconditions": "Environment or data setup required",
      "steps": "Numbered steps",
      "expected_result": "What the response should contain",
      "endpoint": "/v1/documents/parse",
      "method": "POST",
      "payload": { "file": "gs://...", "fileType": "BankStatement" },
      "expected_status": 200,
      "assertions": [
        {
          "description": "Human-readable check",
          "path": "dot.notation.field.path",
          "pattern": "JS-compatible regex"
        }
      ]
    }
  ]
}
```
