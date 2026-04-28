# bulk-parse

Bulk document parsing tool for VerifyIQ. Discovers PDF fixtures, parses them
via `/v1/documents/batch` (max 4 per call), and generates adaptive reports
that surface all extracted fields regardless of document type.

## Usage

```bash
# Run a predefined suite
node bulk-parse/run-bulk.mjs --suite=aoi-smoke

# Discover fixtures from a GCS prefix
node bulk-parse/run-bulk.mjs --gcs-prefix=gs://test-ai-docs-data-dev/qa-test-data/Payslip --file-type=Payslip
```

## Environment

Requires in `.env`:

| Variable | Required | Description |
|---|---|---|
| `VERIFYIQ_SERVICE_URL` | yes | Target API (e.g. `https://parser-dev.boostkh.com`) |
| `VERIFYIQ_API_KEY` | yes | App-layer API key |
| `USE_IAP` | if IAP | Set `true` for IAP-protected endpoints |
| `IAP_CLIENT_ID` | if IAP | OAuth client ID from GCP IAP settings |
| `GOOGLE_SA_KEY_FILE` | yes | Path to service-account JSON key |

## Outputs

Each run creates a timestamped directory under `bulk-results/`:

| File | Purpose |
|---|---|
| `run-metadata.json` | Run config, timing, counts |
| `summary.md` | Human-scannable pass/fail + anomalies |
| `all-fields.csv` | Every extracted field as a column (adaptive) |
| `field-presence.md` | Which fields appear in which fixtures |
| `raw/<N>_<name>.json` | Full raw response per fixture |

## Suites

Predefined fixture lists live in `suites/`. Each is a JSON file:

```json
{
  "name": "aoi-smoke",
  "description": "Articles of Incorporation - 5 fixture smoke",
  "fileType": "ArticlesOfIncorporation",
  "fixtures": ["gs://bucket/path/file.pdf", ...]
}
```
