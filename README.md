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
| `GOOGLE_SA_KEY_FILE` | yes | Path to GCP service account JSON for IAP auth |
| `CLICKUP_FOLDER_ID` | yes | ClickUp folder ID (use `90147709410`) |
| `GH_TOKEN` | yes | GitHub PAT for fetching PR diffs |
| `IAP_TOKEN` | optional | Pre-generated IAP token (auto-generated if not set) |

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes TCs against preview env, posts results to ClickUp |
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
