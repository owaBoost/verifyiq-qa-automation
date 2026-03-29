# VerifyIQ QA Automation

Automated QA pipeline driven entirely by Claude Code CLI. Generates test cases from a PR diff and ClickUp acceptance criteria, runs them against a preview environment, and posts results to ClickUp + GitHub.

## Setup

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your credentials
```

## How It Works

1. A dev posts a PR number + preview URL in Slack
2. You open Claude Code in this folder and paste the QA prompt
3. Claude fetches the PR diff, ClickUp ACs, and GCS fixtures automatically
4. Claude generates test cases, runs them against the preview env, and posts results to ClickUp

Open `QA_PROMPT_TEMPLATE.md`, fill in the PR details, and paste it into Claude Code.

## Environment Variables

All in `.env` (see `.env.example`):

| Variable | Description |
|---|---|
| `VERIFYIQ_API_KEY` | API key for the preview service |
| `CLICKUP_API_TOKEN` | ClickUp API token for creating QA result tasks |
| `GOOGLE_SA_KEY_FILE` | Path to GCP service account JSON key (IAP token generation) |
| `CLICKUP_FOLDER_ID` | ClickUp folder ID for QA result lists |
| `GH_TOKEN` | GitHub PAT with `repo` scope (PR comments) |

Runtime variables (`PR_REPO`, `PR_NUMBER`, `VERIFYIQ_SERVICE_URL`, `IAP_TOKEN`) are set dynamically by Claude Code from the prompt context.

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner — executes test cases, posts results to GitHub + ClickUp |
| `QA_PROMPT_TEMPLATE.md` | Prompt template — fill in PR details and paste into Claude Code |
| `.env.example` | Template for required credentials |
| `test-cases.json` | Generated per run (not committed) |
