# VerifyIQ QA Automation

AI-powered QA pipeline — generates and runs test cases against PR preview environments using Claude Code CLI.

## How It Works

1. Dev posts PR number + preview URL in Slack
2. Open Claude Code in this folder
3. Paste the QA prompt with PR details filled in
4. Claude fetches PR diff, ClickUp ACs, GCS fixtures -> generates TCs -> runs them -> posts results to ClickUp

## Setup (one time only)

```bash
git clone https://github.com/owaBoost/verifyiq-qa-automation.git
cd verifyiq-qa-automation
npm install
cp .env.example .env
# Fill in .env with your actual values
```

## Running QA for a PR

Open Claude Code in this folder:

```bash
cd E:\verifyiq-qa-automation
claude
```

Paste this prompt with values filled in:

---

You are a QA automation engineer for VerifyIQ. Run the full QA pipeline:
PR Number: [PR_NUMBER] from boost-capital/ai-parser-studio
Preview URL: [PREVIEW_URL]
ClickUp Tasks: [TASK_IDS]

Steps:
1. `gh pr diff [PR_NUMBER] --repo boost-capital/ai-parser-studio`
2. Fetch each ClickUp task: `curl -H "Authorization: Bearer $CLICKUP_API_TOKEN" https://api.clickup.com/api/v2/task/[TASK_ID]`
3. `gsutil ls -r gs://qa-automation-dev/**`
4. Assess testability — if not testable via API, explain why and recommend another approach
5. Generate test cases covering ALL AC scenarios — no count limit. Save to test-cases.json
6. Generate IAP token using E:/verifyiq-playwright/scripts/gen-iap-token.js with audience [PREVIEW_URL]. Set as IAP_TOKEN env var.
7. Run: `node run_qa.mjs`
8. Report results and post to ClickUp folder 90147709410

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `VERIFYIQ_API_KEY` | VerifyIQ tenant API key |
| `CLICKUP_API_TOKEN` | ClickUp API token |
| `GH_TOKEN` | GitHub PAT |
| `GOOGLE_SA_KEY_FILE` | Path to GCP service account JSON (e.g. `C:\Users\Admin\Downloads\qa-api-tester-key.json`) |
| `CLICKUP_FOLDER_ID` | ClickUp folder ID (default: `90147709410`) |
| `IAP_TOKEN` | Optional — generated at runtime if not set |

## Files

| File | Purpose |
|---|---|
| `run_qa.mjs` | Test runner: executes TCs, posts results to ClickUp |
| `QA_PROMPT_TEMPLATE.md` | Full prompt template with all rules |
| `qa-run.sh` | Shell wrapper |
| `.env.example` | Environment variable template |

## Results

- Each TC gets a ClickUp task with pass/fail status
- Payload and curl command in task description
- Assertion details posted as task comment (activity feed)
- Summary posted to source ClickUp tasks
