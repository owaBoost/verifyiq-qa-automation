# VerifyIQ QA Automation

AI-powered QA pipeline for the VerifyIQ document-processing API. Uses Claude Code CLI to generate test cases from a PR diff, execute them against a preview environment, and post results to GitHub + ClickUp.

## Setup

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your actual credentials
```

## Usage

1. Open Claude Code in this repo directory
2. Paste the QA prompt (example below) and let it run

That's it. Claude Code handles everything: fetching the PR diff, reading ClickUp acceptance criteria, listing GCS fixtures, generating test cases, producing an IAP token, running the test suite, and posting results.

### Example Prompt

```
You are a QA automation engineer for VerifyIQ. Run the full QA pipeline for this PR:
PR Number: 284 from boost-capital/ai-parser-studio
Preview URL: https://pr-284---ai-boostform-api-preview-z6thvhgnxa-uc.a.run.app
ClickUp Tasks: 86b8pud4e, 86b8pucz7
Steps:

gh pr diff 284 --repo boost-capital/ai-parser-studio
Fetch both ClickUp tasks for ACs using CLICKUP_API_TOKEN from .env
gsutil ls -r gs://qa-automation-dev/**
Generate test cases covering ALL AC scenarios — no count limit. Save to test-cases.json
Generate IAP token using E:/verifyiq-playwright/scripts/gen-iap-token.js with audience <preview-url>
Run: node run_qa.mjs
Report results and post to ClickUp folder 90147709410
```

### What Happens

1. **PR diff** is fetched via `gh pr diff` to identify all changed files and document types
2. **ClickUp tasks** are read for acceptance criteria and test scope
3. **GCS fixtures** are listed from `gs://qa-automation-dev/` to map available test documents
4. **Test cases** are generated as `test-cases.json` covering all AC scenarios
5. **IAP token** is generated for authenticated endpoints (`/ai-gateway/`, `/api/v1/applications/`)
6. **`run_qa.mjs`** executes each test case against the preview URL and:
   - Creates a ClickUp list + tasks with full payload/curl info in the description
   - Posts pass/fail results as ClickUp task comments with assertion details
   - Posts a summary table as a GitHub PR comment

## Environment Variables

Create `.env` from `.env.example`. All variables below are required:

| Variable | Description |
|---|---|
| `VERIFYIQ_API_KEY` | API key for the VerifyIQ preview service |
| `CLICKUP_API_TOKEN` | ClickUp API token for creating QA result tasks |
| `GOOGLE_SA_KEY_FILE` | Path to GCP service account JSON key (for IAP token generation) |
| `CLICKUP_FOLDER_ID` | ClickUp folder ID where QA result lists are created |
| `GH_TOKEN` | GitHub PAT with `repo` scope for posting PR comments |

The following are set dynamically by Claude Code at runtime (not in `.env`):

- `PR_REPO`, `PR_NUMBER`, `VERIFYIQ_SERVICE_URL` — from the QA prompt
- `IAP_TOKEN` — generated via `gen-iap-token.js`
- `WEBHOOK_TOKEN_ID` — created per batch test run via webhook.site API

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes test cases, posts results to GitHub + ClickUp |
| `QA_PROMPT_TEMPLATE.md` | Reference prompt template for test case generation |
| `test-cases.json` | Generated per run (not committed) |
| `.env.example` | Template for required credentials |

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
        { "description": "Check field", "path": "field.path", "pattern": "regex" }
      ]
    }
  ]
}
```
