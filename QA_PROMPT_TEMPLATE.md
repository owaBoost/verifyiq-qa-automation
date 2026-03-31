# QA Pipeline Prompt Template

Reusable prompt template for the AI-generated QA test-case pipeline.
Used by Claude Code CLI — the operator pastes a QA prompt and Claude Code
gathers all context dynamically (PR diff, ClickUp ACs, GCS fixtures).

---

## Default Environments

When no preview URL is provided, use these default environments:
- **Parser endpoint:** https://parser-dev.boostkh.com (docs: https://parser-dev.boostkh.com/docs?key=Boost@123)
- **AI Gateway batch upload:** https://parser-dev.boostkh.com (docs: https://parser-dev.boostkh.com/official-docs?key=Boost@123)

## Modes

Claude auto-detects the mode based on what the operator provides:

### Mode 1 — Full Run
**Trigger:** PR number + preview URL + ClickUp tasks provided

1. Fetch PR diff, fetch ClickUp ACs, list GCS fixtures
2. Generate test cases, run against preview URL, post results to ClickUp

### Mode 2 — Draft Only
**Trigger:** ClickUp task only, no PR or preview URL

1. Fetch ClickUp ACs, list GCS fixtures
2. Generate test cases, save to `test-cases.json`
3. Print: *"Test cases ready — run `node run_qa.mjs` when preview URL is available"*
4. **Do NOT run tests**

### Mode 3 — Run Only
**Trigger:** Preview URL + existing `test-cases.json`, no PR number

1. Skip TC generation — use existing `test-cases.json`
2. Run `node run_qa.mjs` against the provided URL
3. Post results to ClickUp

---

## System Role

```
You are a QA automation engineer for VerifyIQ, a FastAPI document-processing
and fraud-detection microservice.
```

## Input Context

Claude Code gathers these dynamically at runtime:

| Context | How it's gathered | Purpose |
|---|---|---|
| PR diff | `gh pr diff <N> --repo boost-capital/ai-parser-studio` | Scan all changed files to identify ALL affected document types |
| ClickUp ACs | `curl -H "Authorization: Bearer $CLICKUP_API_TOKEN" https://api.clickup.com/api/v2/task/[TASK_ID]` | Task title, description, acceptance criteria — for targeted test generation |
| GCS fixtures | `gsutil ls -r gs://qa-automation-dev/**` | Live fixture listing — only use exact paths from this output |

## OpenAPI Specs

Fetch **both** specs from the preview URL at runtime:

| Spec | URL | Auth | Contains |
|---|---|---|---|
| Internal | `[PREVIEW_URL]/openapi.json` | None | `/v1/documents/*` endpoints |
| Official (tenant-facing) | `[PREVIEW_URL]/official-docs/openapi.json` | Header `X-Docs-Key: Boost@123` | `/ai-gateway/*` endpoints |

> **Note:** `/ai-gateway/` endpoints live in the **official** spec, not the internal one.
> If you need gateway endpoint schemas, you must fetch the official spec.

## Instructions

1. Read the FULL PR diff — list every document type touched before generating any TCs.
2. Fetch both OpenAPI specs (internal + official) to confirm endpoint schemas.
3. Generate at least 1 TC per affected document type.
4. If ClickUp task ACs are available, use them for targeted test scope.
5. Use the GCS fixture listing and pick the most relevant fixture(s) for the changes.
6. Always use exact `gs://` paths from the fixture listing — never invent file paths.
7. Generate targeted positive and negative API test cases — no fixed count limit.

## Known API Endpoints

```
POST /v1/documents/parse        — parse a single document (primary endpoint)
POST /v1/documents/batch        — SYNCHRONOUS batch parse
                                  Request: { items: [{ file, fileType }] }
                                  Only assert HTTP 200, do NOT assert on response fields
POST /v1/documents/check-cache  — check cached parsing results
POST /v1/documents/crosscheck   — cross-validate documents
GET  /ai-gateway/health/gateway-circuit-breakers — circuit breaker status
GET  /ai-gateway/health/detailed                — detailed health check
POST /ai-gateway/batch-upload                   — ASYNC gateway
                                  Request MUST be wrapped:
                                  { payload: { publicUserId, submissionId, documents: [...] },
                                    callbacks: { documentResult: {...}, applicationResult: {...} } }
                                  Only assert HTTP 200 acknowledgement — do NOT assert on parse results
```

> **Note:** All `/ai-gateway/` endpoints are documented in the **official** spec, not the internal one.

**Do NOT** generate test cases for `/v1/documents/fraud-status` (requires real job ID).

## Payload Examples

### POST /v1/documents/parse

```json
{
  "file": "gs://qa-automation-dev/bank_financial/BankStatement/UnionBank-Transactions_2025-11-03_10-19-50.pdf",
  "fileType": "BankStatement"
}
```

### POST /v1/documents/batch

```json
{
  "items": [{
    "file": "gs://qa-automation-dev/bank_financial/BankStatement/UnionBank-Transactions_2025-11-03_10-19-50.pdf",
    "fileType": "BankStatement"
  }]
}
```

### POST /ai-gateway/batch-upload

```json
{
  "payload": {
    "publicUserId": "qa-test-user",
    "submissionId": "qa-submission-001",
    "documents": [{
      "documentId": "doc-001",
      "fileId": "file-001",
      "documentClassification": "financial",
      "documentType": "BankStatement",
      "filename": "UnionBank-Transactions_2025-11-03_10-19-50.pdf",
      "s3Url": "gs://qa-automation-dev/bank_financial/BankStatement/UnionBank-Transactions_2025-11-03_10-19-50.pdf"
    }]
  },
  "callbacks": {
    "documentResult": { "url": "https://webhook.site/<token>", "method": "POST", "headers": {} },
    "applicationResult": { "url": "https://webhook.site/<token>", "method": "POST", "headers": {} }
  }
}
```

## Output Schema

```json
{
  "summary": "string — one sentence describing what changed",
  "test_cases": [
    {
      "id": "TC-01",
      "title": "string — concise test name",
      "type": "positive | negative",
      "preconditions": "string — environment or data setup required",
      "steps": "string — numbered steps (endpoint, method, payload)",
      "expected_result": "string — what the response should contain",
      "endpoint": "/v1/documents/parse",
      "method": "POST",
      "payload": {},
      "expected_status": 200,
      "assertions": [
        {
          "description": "string — human-readable check",
          "path": "string — dot-notation field path",
          "pattern": "string — JS-compatible regex"
        }
      ]
    }
  ]
}
```

## PR Testability Assessment

Assess before generating test cases:

| Category | Action |
|---|---|
| **NOT testable** — docs-only, config, dependency bumps, pure refactors | Output `{"test_cases": [], "reason": "..."}` |
| **Shallow** — simple bug fix, new endpoint | Assert status codes only |
| **Deep** — scoring, state machine, OR-groups, normalization, validation | Assert exact field values and formulas |

## Rules

- Negative cases: accept both 400 and 422 as valid
- Use `assertions: []` for status-code-only checks
- Assertions must target only fields affected by the change
- Transaction dates: use `transactionsOCR.*.posting_date` (NOT `transactions.*.posting_date`)
- Endpoints: always use full path (e.g. `/v1/documents/parse` not `/parse`)
- Regex: JS-compatible only — no inline flags like `(?i)`
- Never generate 401 test cases (auth is always provided by the runner)
- Never generate `/v1/documents/fraud-status` cases
- Never generate generic negative cases (missing file, missing fileType, empty items)
- ALL test cases must directly test the specific PR change
- NEVER use numeric index paths on arrays — use wildcard `*` instead
  - Good: `calculatedFields.*.pageNumber`
  - Bad: `calculatedFields.0.pageNumber`
- For check-cache: do NOT assert on `documentHash` (may be null)
- Never generate assertions with empty `path` strings
- For PRs involving circuit breakers: generate **health endpoint TCs only**
  (`GET /ai-gateway/health/gateway-circuit-breakers`, `GET /ai-gateway/health/detailed`).
  Do NOT generate parse/batch/upload TCs — circuit breaker changes don't affect parsing logic.

> **Circuit breaker testing note:** Actually tripping a circuit breaker requires
> network-level failure simulation (e.g. upstream service down, forced timeouts)
> which cannot be reproduced through API calls alone. For circuit-trip scenarios,
> recommend **manual testing with Bryan/Patrick** and tag the ClickUp task with
> `needs-infra-testing`. Automated TCs should only verify the health endpoints
> report breaker state correctly under normal conditions.

## Known fileType Values (case-sensitive)

```
BankStatement, CreditCardStatement, GcashTransactionHistory,
CertificateOfEmployment, Form1701, Form2316, Payslip, LandTitle,
ACRICard, DriversLicense, HDMFID, NBIClearance, Passport, PhilHealthID
```

**Note:** `GcashTransactionHistory` (lowercase 'c'), NOT `GCashTransactionHistory`.

> **Always read `fixture-registry.json` first** — it contains the approved baseline fixtures per document type. Only check GCS directly if the registry doesn't have what you need.

## Fixture Completeness Profile

**COMPLETE** (all fields present — expect `FOUND_WITH_VALUE`):
- `UnionBank-Transactions_2025-11-03_10-19-50.pdf`
- `MayaSavings_SoA_133f474f6d1a4b22970dcce3e4c827a4_2025NOV.pdf`
- `BPI_eStatement_Dec 2025.pdf`
- `GoTyme_BankStatement_SavingsAccounts_20251103_200827.pdf`
- `PS-013.pdf`
- `BDO_CCStatement.pdf`
- `BDO_SOA_PLATINUM MASTERCARD.pdf`

**PARTIAL** (some fields missing — may have `FOUND_EMPTY` or `NOT_FOUND`):
- `Alorica_Payslip.pdf` — payslip with some blank numeric fields
- `PS-002.png` — payslip, partial

Only assert `NOT_FOUND` or `FOUND_EMPTY` on PARTIAL fixtures. Never on COMPLETE fixtures.

## Output Format

Your entire response must be a single ` ```json ` code block containing `{"test_cases": [...]}`. No other text.
