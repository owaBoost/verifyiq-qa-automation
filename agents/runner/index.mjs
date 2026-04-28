#!/usr/bin/env node
/**
 * Runner Agent
 *
 * Executes test cases by invoking the existing run_qa.mjs.
 * Reads the plan from tasks/running/, runs the tests, and writes
 * raw results to the plan JSON.
 *
 * Input:  tasks/running/<plan>.json (with testCasesFile set)
 * Output: updates plan JSON with run results
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import axios from 'axios';
import { findSchema, validate } from '../../utils/schema-validator.mjs';
import { maskPii } from '../../utils/callback-validator.mjs';

/**
 * Parses auth.spec.js stdout into a results array.
 * Each TC prints:  ✅ TC-ID: message  or  ❌ TC-ID: message
 */
function parseTestResults(rawOutput) {
  if (!rawOutput) return [];

  const results = [];
  const lines = rawOutput.split('\n');

  for (const line of lines) {
    const match = line.match(/\s*(✅|❌)\s+(\S+?):\s+(.*)/);
    if (!match) continue;

    const [, icon, id, message] = match;
    results.push({
      id,
      passed: icon === '✅',
      message: message.trim(),
    });
  }

  return results;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Parse batch test results from run_qa.mjs stdout.
 * Extracts per-test callback outcomes without re-triggering any POST calls.
 */
function parseBatchResults(rawOutput) {
  if (!rawOutput) return [];

  const results = [];
  const lines = rawOutput.split('\n');

  // Track current batch TC context
  let currentTcId = null;
  let currentResult = null;

  for (const line of lines) {
    // Batch TC start: "Running TC-XX (batch) — POST /ai-gateway/batch-upload"
    const tcStart = line.match(/Running\s+(\S+)\s+\(batch\)/);
    if (tcStart) {
      if (currentResult) results.push(currentResult);
      currentTcId = tcStart[1];
      currentResult = {
        id: currentTcId,
        type: 'batch',
        applicationId: null,
        callbacksExpected: 0,
        callbacksReceived: 0,
        documentCallbacks: [],
        applicationCallbacks: [],
        errors: [],
        outcome: 'pending',
      };
      continue;
    }

    if (!currentResult) continue;

    // applicationId from POST response
    const appIdMatch = line.match(/applicationId=(\S+?)[\s,]/);
    if (appIdMatch) currentResult.applicationId = appIdMatch[1];

    // Expected callbacks count
    const expectMatch = line.match(/Waiting for (\d+) callbacks/);
    if (expectMatch) currentResult.callbacksExpected = parseInt(expectMatch[1], 10);

    // Received callbacks count
    const recvMatch = line.match(/Received (\d+) callbacks/);
    if (recvMatch) currentResult.callbacksReceived = parseInt(recvMatch[1], 10);

    // Document callback OK
    const docOk = line.match(/Document callback OK \(docId=(\S+?)\)/);
    if (docOk) {
      currentResult.documentCallbacks.push({ documentId: docOk[1], valid: true, errors: [] });
    }

    // Application callback OK
    const appOk = line.match(/Application callback OK \(appId=(\S+?)\)/);
    if (appOk) {
      currentResult.applicationCallbacks.push({ applicationId: appOk[1], valid: true, errors: [] });
    }

    // Decrypt failure
    if (line.includes('Decrypt failed:')) {
      const msg = line.replace(/.*Decrypt failed:\s*/, '').trim();
      currentResult.errors.push({ type: 'decrypt_failure', message: msg });
    }

    // doc-callback / app-callback field errors
    const cbErr = line.match(/(doc-callback|app-callback):\s+(.+)/);
    if (cbErr) {
      currentResult.errors.push({ type: 'callback_validation', source: cbErr[1], message: cbErr[2] });
    }

    // Timeout
    if (line.includes('Timed out after') && line.includes('callbacks')) {
      currentResult.errors.push({ type: 'callback_timeout', message: line.trim() });
      currentResult.outcome = 'timeout';
    }

    // Fraud-flagged
    if (line.includes('Fraud-flagged document')) {
      const fraudDocId = line.match(/docId=(\S+?)\)/)?.[1] ?? 'unknown';
      currentResult.documentCallbacks.push({ documentId: fraudDocId, valid: true, fraudFlagged: true, errors: [] });
    }

    // Per-callback structured JSON report  [cb-report-json] {...}
    const cbReportJson = line.match(/\[cb-report-json\]\s+(\{.+\})\s*$/);
    if (cbReportJson) {
      try {
        const detail = JSON.parse(cbReportJson[1]);
        if (!currentResult.callbackCheckDetails) currentResult.callbackCheckDetails = [];
        currentResult.callbackCheckDetails.push(detail);
        // Also backfill legacy documentCallbacks / applicationCallbacks arrays
        if (detail.type === 'document') {
          const existing = currentResult.documentCallbacks.find(d => d.documentId === detail.documentId);
          if (!existing) {
            currentResult.documentCallbacks.push({
              documentId: detail.documentId,
              valid: detail.checks && Object.values(detail.checks).every(c => c.passed),
              errors: detail.mismatchDetails ?? [],
            });
          }
        } else if (detail.type === 'application') {
          const existing = currentResult.applicationCallbacks.find(a => a.applicationId === detail.applicationId);
          if (!existing) {
            currentResult.applicationCallbacks.push({
              applicationId: detail.applicationId,
              valid: detail.checks && Object.values(detail.checks).every(c => c.passed),
              errors: detail.mismatchDetails ?? [],
            });
          }
        }
      } catch { /* malformed JSON — skip */ }
    }

    // Skipped
    if (line.includes('SKIPPED') && line.includes('batch')) {
      currentResult.outcome = 'skipped';
    }

    // Final result line for this TC
    const resultLine = line.match(/(✅|❌)\s+(\S+?):\s+(.*)/);
    if (resultLine && resultLine[2] === currentTcId) {
      currentResult.outcome = resultLine[1] === '✅' ? 'passed' : 'failed';
      currentResult.resultMessage = resultLine[3].trim();
    }
  }

  if (currentResult) results.push(currentResult);
  return results;
}

/**
 * Save batch callback artifacts to reports/callbacks/<planId>/.
 */
function saveBatchArtifacts(planId, batchResults) {
  if (!batchResults.length) return null;

  const dir = join(ROOT, 'reports', 'callbacks', planId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const summary = {
    planId,
    savedAt: new Date().toISOString(),
    batchTests: batchResults.map(br => ({
      id: br.id,
      applicationId: br.applicationId,
      outcome: br.outcome,
      callbacksExpected: br.callbacksExpected,
      callbacksReceived: br.callbacksReceived,
      documentCallbackCount: br.documentCallbacks.length,
      applicationCallbackCount: br.applicationCallbacks.length,
      errorCount: br.errors.length,
      errors: br.errors,
      // Per-callback deep validation detail (populated from [cb-report-json] lines)
      callbackCheckDetails: (br.callbackCheckDetails ?? []).map(d => ({
        index: d.index,
        type: d.type,
        documentId: d.documentId ?? null,
        applicationId: d.applicationId ?? null,
        decryptOk: d.decryptOk,
        callbackReceived: true,
        checks: {
          schemaValidation:   { passed: d.checks?.schemaValidation?.passed   ?? false, errors: d.checks?.schemaValidation?.errors   ?? [] },
          structureValidation: { passed: d.checks?.structureValidation?.passed ?? false, errors: d.checks?.structureValidation?.errors ?? [] },
          keyFieldsMatched:   { passed: d.checks?.keyFieldsMatched?.passed   ?? false, errors: d.checks?.keyFieldsMatched?.errors   ?? [] },
          contentValidation:  { passed: d.checks?.contentValidation?.passed  ?? false, errors: d.checks?.contentValidation?.errors  ?? [] },
        },
        mismatchDetails: d.mismatchDetails ?? [],
        overallPassed: d.checks ? Object.values(d.checks).every(c => c.passed) : false,
      })),
    })),
  };

  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

/**
 * Schema validation pass — for each unique GET endpoint in test-cases.json
 * that has a matching schema in schemas/, make one request and validate
 * the response shape. POST/batch endpoints are validated if the main run
 * already succeeded (we don't re-POST).
 */
async function runSchemaValidation(plan) {
  const results = [];

  const testCasesPath = join(ROOT, plan.testCasesFile);
  if (!existsSync(testCasesPath)) return results;

  let testCases;
  try {
    testCases = JSON.parse(readFileSync(testCasesPath, 'utf8')).test_cases || [];
  } catch { return results; }

  // Collect unique endpoints that have schemas (only GET — don't re-POST)
  const seen = new Set();
  const toValidate = [];

  // Health endpoints return a plain string/status body that doesn't conform to
  // any structured schema — skip them to avoid false schema failures on batch runs.
  const SKIP_SCHEMA = new Set(['/health', '/health/detailed']);

  for (const tc of testCases) {
    if (!tc.endpoint || tc.method !== 'GET') continue;
    if (seen.has(tc.endpoint)) continue;
    if (SKIP_SCHEMA.has(tc.endpoint)) continue;
    const schema = findSchema(tc.endpoint);
    if (!schema) continue;
    seen.add(tc.endpoint);
    toValidate.push({ endpoint: tc.endpoint, schema });
  }

  if (toValidate.length === 0) return results;

  const previewUrl = (process.env.VERIFYIQ_SERVICE_URL || '').trim().replace(/\/$/, '');
  if (!previewUrl) return results;

  console.log(`[runner] Running schema validation on ${toValidate.length} endpoint(s)...`);

  for (const { endpoint, schema } of toValidate) {
    try {
      const res = await axios.get(`${previewUrl}${endpoint}`, {
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
        timeout: 15_000,
      });

      if (res.status !== 200) {
        results.push({
          endpoint,
          valid: false,
          httpStatus: res.status,
          errors: [`HTTP ${res.status} (expected 200)`],
        });
        continue;
      }

      const errors = validate(res.data, schema);
      const valid = errors.length === 0;

      results.push({ endpoint, valid, httpStatus: res.status, errors });

      if (valid) {
        console.log(`  ✓ ${endpoint} — schema valid`);
      } else {
        console.log(`  ✗ ${endpoint} — ${errors.length} violation(s): ${errors[0]}`);
      }
    } catch (err) {
      results.push({
        endpoint,
        valid: false,
        httpStatus: null,
        errors: [`Request failed: ${err.message}`],
      });
    }
  }

  return results;
}

/**
 * Parse completeness score lines emitted by run_qa.mjs.
 * Format: "  [completeness] TC-ID score=X/Y status=STATUS [missing_required=...] [missing_optional=...]"
 */
function parseCompletenessResults(rawOutput) {
  if (!rawOutput) return [];
  const results = [];
  for (const line of rawOutput.split('\n')) {
    const m = line.match(/\[completeness\]\s+(\S+)\s+score=(\d+)\/(\d+)\s+status=(\S+)/);
    if (!m) continue;
    const [, tcId, scoreStr, maxStr, status] = m;
    const missingReq = line.match(/missing_required=([^\s]+)/)?.[1]?.split(',').filter(Boolean) ?? [];
    const missingOpt = line.match(/missing_optional=([^\s]+)/)?.[1]?.split(',').filter(Boolean) ?? [];
    results.push({
      tcId,
      score:           parseInt(scoreStr, 10),
      maxScore:        parseInt(maxStr, 10),
      status,
      missingRequired: missingReq,
      missingOptional: missingOpt,
    });
  }
  return results;
}

export async function run(planFile) {
  const runningPath = join(ROOT, 'tasks', 'running', planFile);

  if (!existsSync(runningPath)) {
    throw new Error(`Plan not found in running: ${runningPath}`);
  }

  const plan = JSON.parse(readFileSync(runningPath, 'utf8'));
  const testType = plan.testType || 'full-regression';

  // ── Auth-boundary: execute auth.spec.js only, skip run_qa.mjs entirely ─────
  if (testType === 'auth-boundary') {
    console.log(`[runner] auth-boundary mode — executing auth.spec.js only`);
    console.log(`  Target: ${plan.previewUrl}`);

    const startTime = Date.now();
    let exitCode = 0;
    let output = '';

    try {
      output = execSync('node auth.spec.js', {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      console.log(output);
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout || '') + '\n' + (err.stderr || '');
      console.log(output);
      console.warn(`[runner] auth.spec.js exited with code ${exitCode}`);
    }

    const duration = Date.now() - startTime;
    const authResults = parseTestResults(output);
    const doneMatch = output.match(/(\d+)\/(\d+) passed/);
    const passed = doneMatch ? parseInt(doneMatch[1], 10) : authResults.filter(r => r.passed).length;
    const total = doneMatch ? parseInt(doneMatch[2], 10) : authResults.length;

    plan.runResult = {
      exitCode,
      durationMs: duration,
      ranAt: new Date().toISOString(),
      authBoundary: {
        passed,
        failed: total - passed,
        total,
        rawOutput: output,
        results: authResults,
      },
    };

    writeFileSync(runningPath, JSON.stringify(plan, null, 2));
    console.log(`[runner] Done in ${(duration / 1000).toFixed(1)}s — ${passed}/${total} auth boundary tests passed`);
    return { planFile, ...plan.runResult };
  }
  // ── End auth-boundary ───────────────────────────────────────────────────────

  if (!plan.testCasesFile) {
    throw new Error('Plan has no testCasesFile — run generator first');
  }

  const testCasesPath = join(ROOT, plan.testCasesFile);
  if (!existsSync(testCasesPath)) {
    throw new Error(`Test cases file not found: ${testCasesPath}`);
  }

  const runBatchValidation = testType === 'batch-upload' || testType === 'full-regression';

  const skippedSuites = [];
  if (!runBatchValidation) skippedSuites.push('batch-upload');

  console.log(`[runner] Executing test cases from ${plan.testCasesFile} (testType: ${testType})`);
  console.log(`  Target: ${plan.previewUrl}`);
  if (skippedSuites.length) {
    console.log(`  Skipping suites: ${skippedSuites.join(', ')}`);
  }

  const startTime = Date.now();
  let exitCode = 0;
  let output = '';

  try {
    output = execSync('node run_qa.mjs', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min max
      env: {
        ...process.env,
        ...(plan.disableClickUp  ? { DISABLE_CLICKUP: 'true' }         : {}),
        ...((plan.disableRemote || plan.disableClickUp)
          ? { DISABLE_REMOTE_POSTING: 'true' } : {}),
      },
    });
    console.log(output);
  } catch (err) {
    exitCode = err.status ?? 1;
    output = (err.stdout || '') + '\n' + (err.stderr || '');
    console.log(output);
    console.warn(`[runner] run_qa.mjs exited with code ${exitCode}`);
  }

  const duration = Date.now() - startTime;

  // Parse pass/fail counts from the summary line printed at the end of run_qa.mjs.
  // If the process crashed before printing it, doneMatch will be null.
  const doneMatch = output.match(/(\d+)\/(\d+) passed/);
  let passed = doneMatch ? parseInt(doneMatch[1], 10) : 0;
  let total   = doneMatch ? parseInt(doneMatch[2], 10) : 0;
  let partialExecution = false;
  let crashedAt        = null;
  let expectedTotal    = null;
  let crashPhase       = null;

  if (!doneMatch) {
    // No summary line — run_qa.mjs crashed before reaching it.
    // Recover partial results from individual ✅/❌ lines emitted before the crash.
    const partialResults = parseTestResults(output);
    passed = partialResults.filter(r => r.passed).length;
    total  = partialResults.length;

    // Load expected total so we can report X/N completed
    try {
      const tcData = JSON.parse(readFileSync(testCasesPath, 'utf8'));
      expectedTotal = tcData.test_cases?.length ?? null;
    } catch { /* ignore — best effort */ }

    if (exitCode !== 0) {
      // Identify crash point: last TC that was started (had a "Running TC-ID" line)
      const startedMatches = [...output.matchAll(/Running\s+(\S+)\s+\(\w+\)/g)];
      if (startedMatches.length > 0) {
        crashedAt = startedMatches[startedMatches.length - 1][1];
        partialExecution = true;
      } else if (total > 0) {
        partialExecution = true;
      }

      if (partialExecution) {
        console.error(`[runner] ❌ Execution stopped at ${crashedAt ?? 'unknown'}`);
        console.error(`[runner] ❌ Partial run: ${total}/${expectedTotal ?? '?'} completed`);
      } else {
        // No TCs started — crash happened in a setup phase before test execution
        if (output.includes('Fetching PR metadata')) {
          crashPhase = 'PR metadata fetch';
        } else if (output.includes('Creating fresh webhook token')) {
          crashPhase = 'webhook token creation';
        } else if (output.includes('Baseline health check')) {
          crashPhase = 'baseline health check';
        } else {
          crashPhase = 'setup';
        }
        console.error(`[runner] ❌ Crashed during setup phase: ${crashPhase}`);
        console.error('[runner] ❌ No test cases executed');
      }
    }
  }

  // Schema validation pass — skip if run crashed before any tests ran (no data to validate)
  const isPreTestCrash = exitCode !== 0 && total === 0 && !partialExecution && crashPhase !== null;
  const schemaResults = isPreTestCrash ? [] : await runSchemaValidation(plan);

  // Parse batch callback results — only for batch-upload and full-regression
  const batchResults = runBatchValidation ? parseBatchResults(output) : [];
  let batchArtifactsDir = null;
  if (batchResults.length > 0) {
    batchArtifactsDir = saveBatchArtifacts(plan.id, batchResults);
  }

  // Parse completeness score results emitted by run_qa.mjs [completeness] lines
  const completenessResults = parseCompletenessResults(output);

  plan.runResult = {
    exitCode,
    passed,
    total,
    failed: total - passed,
    durationMs: duration,
    ranAt: new Date().toISOString(),
    rawOutput: output,
    skippedSuites: skippedSuites.length > 0 ? skippedSuites : undefined,
    partialExecution: partialExecution || undefined,
    crashedAt: crashedAt || undefined,
    crashPhase: crashPhase || undefined,
    expectedTotal: expectedTotal ?? undefined,
    schemaValidation: schemaResults,
    batchResults: batchResults.length > 0 ? batchResults : undefined,
    batchArtifactsDir: batchArtifactsDir ?? undefined,
    completenessResults: completenessResults.length > 0 ? completenessResults : undefined,
  };

  writeFileSync(runningPath, JSON.stringify(plan, null, 2));

  const schemaFails = schemaResults.filter(r => !r.valid).length;
  const schemaTotal = schemaResults.length;
  console.log(`[runner] Done in ${(duration / 1000).toFixed(1)}s — ${passed}/${total} passed`);
  if (schemaTotal > 0) {
    console.log(`[runner] Schema validation: ${schemaTotal - schemaFails}/${schemaTotal} endpoints valid`);
  }
  if (batchResults.length > 0) {
    const batchPassed = batchResults.filter(r => r.outcome === 'passed').length;
    console.log(`[runner] Batch callbacks: ${batchPassed}/${batchResults.length} passed`);
    if (batchArtifactsDir) console.log(`[runner] Callback artifacts: ${batchArtifactsDir}`);
  }
  return { planFile, ...plan.runResult };
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes('runner')) {
  const planFile = process.argv[2];
  if (!planFile) {
    console.error('Usage: node agents/runner/index.mjs <plan-file.json>');
    process.exit(1);
  }
  run(planFile).catch(err => {
    console.error(`[runner] Fatal: ${err.message}`);
    process.exit(1);
  });
}
