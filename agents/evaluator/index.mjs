#!/usr/bin/env node
/**
 * Evaluator Agent
 *
 * Reads run results from the plan JSON and produces a structured evaluation:
 *   - Pass/fail/total counts and pass rate
 *   - Verdict: PASS / UNSTABLE / BLOCKER
 *   - Failure categorization: api_error, assertion_mismatch, timeout, unknown
 *   - Top failing endpoints and test names
 *
 * Input:  tasks/running/<plan>.json (with runResult set)
 * Output: reports/<plan-id>-eval.json, reports/<plan-id>-eval.md
 *         updates plan JSON with evaluation
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Output parsing ──────────────────────────────────────────────────────────

/**
 * Parse individual test-case results from run_qa.mjs stdout.
 * Each TC prints:  ✅ TC-ID: message  or  ❌ TC-ID: message
 */
function parseTestResults(rawOutput) {
  if (!rawOutput) return [];

  const results = [];
  const lines = rawOutput.split('\n');

  for (const line of lines) {
    // Match "  ✅ TC-01: ..." or "  ❌ TC-01: ..."
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

/**
 * Parse endpoint info from "Running TC-ID (type) — METHOD /path" lines.
 */
function parseEndpoints(rawOutput) {
  if (!rawOutput) return {};

  const map = {};
  const lines = rawOutput.split('\n');

  for (const line of lines) {
    const match = line.match(/Running\s+(\S+)\s+\(\w+\)\s+—\s+(\w+)\s+(\S+)/);
    if (!match) continue;
    map[match[1]] = { method: match[2], endpoint: match[3] };
  }

  return map;
}

/**
 * Categorize a failure message into one of:
 *   api_error, assertion_mismatch, timeout, unknown
 */
function categorizeFailure(message) {
  const lower = (message || '').toLowerCase();

  // Timeout patterns
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout') || lower.includes('econnaborted')) {
    return 'timeout';
  }

  // API / HTTP error patterns
  if (lower.includes('request error') || lower.includes('post error') ||
      lower.includes('econnrefused') || lower.includes('enotfound') ||
      lower.includes('socket hang up') || lower.includes('network error') ||
      /expected http \d+, got [45]\d\d/i.test(lower)) {
    return 'api_error';
  }

  // 5xx detected in message body (e.g. "got 500", "got 502")
  if (/got 5\d\d/i.test(lower) || /http 5\d\d/i.test(lower)) {
    return 'api_error';
  }

  // Assertion mismatch patterns
  if (lower.includes('did not match') || lower.includes('not found') ||
      lower.includes('assertion') || lower.includes('expected') ||
      lower.includes('anyof failed') || lower.includes('field not found')) {
    return 'assertion_mismatch';
  }

  return 'unknown';
}

/**
 * Core endpoints — failures on these are always critical.
 */
const CORE_ENDPOINT_PATTERNS = [
  /\/health/i,
  /\/ai-gateway\//i,
  /\/verify/i,
  /\/submit/i,
];

function isCoreEndpoint(endpoint) {
  if (!endpoint) return false;
  return CORE_ENDPOINT_PATTERNS.some(re => re.test(endpoint));
}

/**
 * Detect whether any failures are "critical":
 *   - Auth / login failures
 *   - Core endpoint failures (/health, /ai-gateway/, /verify, /submit)
 *   - 5xx responses
 *   - Network-level failures
 *   - More than 3 timeouts total
 */
function hasCriticalErrors(failedTests) {
  let timeoutCount = 0;

  for (const ft of failedTests) {
    const lower = (ft.message || '').toLowerCase();

    // Auth / login failures
    if (lower.includes('401') || lower.includes('403') ||
        lower.includes('unauthorized') || lower.includes('forbidden') ||
        lower.includes('auth') || lower.includes('login') ||
        lower.includes('iap token') || lower.includes('identity token')) {
      return true;
    }

    // 5xx responses
    if (/got 5\d\d/i.test(lower) || /http 5\d\d/i.test(lower)) return true;

    // Network-level failures
    if (ft.category === 'api_error' &&
        (lower.includes('econnrefused') || lower.includes('enotfound') ||
         lower.includes('socket hang up') || lower.includes('network error'))) {
      return true;
    }

    // Core endpoint failures (any category)
    if (isCoreEndpoint(ft.endpoint)) return true;

    // Callback decrypt failures are always critical
    if (lower.includes('callback decrypt failed') || lower.includes('decrypt failed')) return true;

    // Callback timeout with zero callbacks received (complete failure)
    if (lower.includes('callback timeout') && lower.includes('waited')) return true;

    // Count timeouts
    if (ft.category === 'timeout') timeoutCount++;
  }

  // More than 3 timeouts is critical
  if (timeoutCount > 3) return true;

  return false;
}

/**
 * Determine verdict:
 *   exitCode ≠ 0 AND (total=0 OR partial)  → CRASHED           (process died before finishing)
 *   total = 0                              → INVALID            (no tests ran, not a crash)
 *   0 failures, all completeness ≥ 90      → PASS
 *   0 failures, some completeness 70–89    → PASS_WITH_WARNINGS (extraction quality gaps)
 *   >0 failures, rate ≤20%, no critical    → FAIL
 *   rate >20% OR critical errors detected  → BLOCKED
 *
 * Critical errors: auth/login failures, core endpoint failures
 * (/health, /ai-gateway/, /verify, /submit), 5xx, network errors,
 * or >3 timeouts.
 */
function getVerdict(passed, total, failedTests, exitCode = 0, partialExecution = false) {
  // Crashed: process exited non-zero without completing all (or any) tests
  if (exitCode !== 0 && (total === 0 || partialExecution)) return 'CRASHED';
  // Invalid: no tests executed and no crash (e.g. empty test suite)
  if (total === 0) return 'INVALID';
  const failed = total - passed;
  if (failed === 0) return 'PASS';
  const failureRate = failed / total;
  if (failureRate > 0.2 || hasCriticalErrors(failedTests)) return 'BLOCKED';
  return 'FAIL';
}

/**
 * Aggregate completeness scores from plan.runResult.completenessResults.
 *
 * Returns null when no completeness data is available.
 * Returns:
 *   {
 *     avgScore,             — average score across all test cases (rounded)
 *     lowestScore,          — minimum score across all test cases
 *     warnCount,            — count of WARN cases (score ≥ 70 and < 90)
 *     failCount,            — count of FAIL cases (score < 70)
 *     completenessVerdict,  — 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL'
 *     worstCase,            — { tcId, score, maxScore, missingRequired }
 *   }
 */
function summarizeCompleteness(completenessResults) {
  if (!completenessResults?.length) return null;

  const scores    = completenessResults.map(cr => cr.score);
  const avgScore  = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const lowestScore = Math.min(...scores);
  const warnCount = completenessResults.filter(cr => cr.status === 'WARN').length;
  const failCount = completenessResults.filter(cr => cr.status === 'FAIL').length;

  const completenessVerdict = failCount > 0
    ? 'FAIL'
    : warnCount > 0
      ? 'PASS_WITH_WARNINGS'
      : 'PASS';

  const worstCase = completenessResults.reduce((prev, curr) =>
    curr.score < prev.score ? curr : prev
  );

  return { avgScore, lowestScore, warnCount, failCount, completenessVerdict, worstCase };
}

// ── Auth-boundary evaluation ────────────────────────────────────────────────

function buildAuthBoundaryMarkdown(ev) {
  const icon = ev.verdict === 'PASS' ? '✅'
    : ev.verdict === 'CRASHED' || ev.verdict === 'INVALID' ? '💥'
    : ev.verdict === 'FAIL' ? '⚠️' : '🚨';
  const timestamp = ev.evaluatedAt.replace('T', ' ').slice(0, 16) + ' UTC';

  const lines = [
    `# ${icon} Auth Boundary Evaluation — PR #${ev.prNumber}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Verdict | **${ev.verdict}** |`,
    `| Total tests | ${ev.total} |`,
    `| Passed | ${ev.passed} |`,
    `| Failed | ${ev.failed} |`,
    `| Pass rate | ${ev.passRate} |`,
    `| Duration | ${(ev.durationMs / 1000).toFixed(1)}s |`,
    '',
    '## Auth Boundary Results',
    '',
    '| Test ID | Result | Message |',
    '|---------|--------|---------|',
  ];

  for (const r of (ev.authBoundary?.results || [])) {
    const rIcon = r.passed ? '✅' : '❌';
    lines.push(`| \`${r.id}\` | ${rIcon} | ${r.message} |`);
  }

  if (ev.topFailingTests?.length) {
    lines.push('', '## Failed Tests', '', '| Test ID | Message |', '|---------|---------|');
    for (const { id, message } of ev.topFailingTests) {
      lines.push(`| \`${id}\` | ${message} |`);
    }
  }

  lines.push('', '---', `Evaluated at ${timestamp}`);
  return lines.join('\n');
}

async function evaluateAuthBoundary(plan, planFile, runningPath) {
  const authBoundary = plan.runResult.authBoundary;
  if (!authBoundary) {
    throw new Error('Plan has no runResult.authBoundary — runner did not produce auth results');
  }

  const { passed, failed, total, results } = authBoundary;
  const { durationMs, exitCode } = plan.runResult;

  console.log(`[evaluator] Evaluating auth-boundary results for ${plan.id}`);

  const failedTests = (results || [])
    .filter(r => !r.passed)
    .map(r => ({ id: r.id, message: r.message, category: 'auth_boundary', endpoint: null }));

  const verdict = exitCode !== 0 && total === 0 ? 'CRASHED'
    : total === 0 ? 'INVALID'
    : failed === 0 ? 'PASS'
    : failed / total > 0.2 ? 'BLOCKED'
    : 'FAIL';
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
  const failureRate = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0';

  const evaluation = {
    planId: plan.id,
    prNumber: plan.prNumber,
    previewUrl: plan.previewUrl,
    testType: 'auth-boundary',
    verdict,
    passRate: `${passRate}%`,
    failureRate: `${failureRate}%`,
    passed,
    failed,
    total,
    durationMs,
    exitCode,
    authBoundary: { results: results || [] },
    topFailingTests: failedTests.slice(0, 10).map(ft => ({
      id: ft.id,
      category: ft.category,
      message: ft.message.length > 120 ? ft.message.slice(0, 120) + '...' : ft.message,
    })),
    evaluatedAt: new Date().toISOString(),
  };

  const evalJsonFile = `${plan.id}-eval.json`;
  writeFileSync(join(ROOT, 'reports', evalJsonFile), JSON.stringify(evaluation, null, 2));

  const evalMdFile = `${plan.id}-eval.md`;
  writeFileSync(join(ROOT, 'reports', evalMdFile), buildAuthBoundaryMarkdown(evaluation));

  plan.evaluation = evaluation;
  plan.resultsFile = evalJsonFile;
  writeFileSync(runningPath, JSON.stringify(plan, null, 2));

  const verdictIcon = verdict === 'PASS' ? '✅'
    : verdict === 'CRASHED' || verdict === 'INVALID' ? '💥'
    : verdict === 'FAIL' ? '⚠️' : '🚨';
  console.log(`[evaluator] ${verdictIcon} Verdict: ${verdict} (${passRate}% pass — ${passed}/${total})`);
  console.log(`  Reports: reports/${evalJsonFile}, reports/${evalMdFile}`);

  return { planFile, evaluation };
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export async function evaluate(planFile) {
  const runningPath = join(ROOT, 'tasks', 'running', planFile);

  if (!existsSync(runningPath)) {
    throw new Error(`Plan not found in running: ${runningPath}`);
  }

  const plan = JSON.parse(readFileSync(runningPath, 'utf8'));

  if (!plan.runResult) {
    throw new Error('Plan has no runResult — run the runner first');
  }

  const testType = plan.testType || 'full-regression';

  // Auth-boundary: evaluate only authBoundary results, skip schema/batch/health
  if (testType === 'auth-boundary') {
    return evaluateAuthBoundary(plan, planFile, runningPath);
  }

  const { passed, total, failed, durationMs, exitCode, rawOutput } = plan.runResult;
  const partialExecution = plan.runResult.partialExecution ?? false;
  const crashedAt        = plan.runResult.crashedAt ?? null;
  const crashPhase       = plan.runResult.crashPhase ?? null;
  const expectedTotal    = plan.runResult.expectedTotal ?? null;
  const skippedSuites    = plan.runResult.skippedSuites || [];

  console.log(`[evaluator] Evaluating results for ${plan.id} (testType: ${testType})`);

  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
  const failureRate = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0';

  // Parse individual test results from runner output
  const testResults = parseTestResults(rawOutput);
  const endpointMap = parseEndpoints(rawOutput);

  // Categorize failures
  const failureCategories = { api_error: 0, assertion_mismatch: 0, contract_violation: 0, timeout: 0, unknown: 0 };
  const failedTests = [];

  for (const tr of testResults) {
    if (tr.passed) continue;
    const category = categorizeFailure(tr.message);
    failureCategories[category]++;
    failedTests.push({
      id: tr.id,
      message: tr.message,
      category,
      endpoint: endpointMap[tr.id]
        ? `${endpointMap[tr.id].method} ${endpointMap[tr.id].endpoint}`
        : null,
    });
  }

  // If we got no parsed results but runner reported failures, mark them as unknown
  if (failedTests.length === 0 && failed > 0) {
    failureCategories.unknown = failed;
  }

  // Incorporate schema validation results from the runner
  const schemaValidation = plan.runResult.schemaValidation || [];
  const schemaViolations = [];

  for (const sv of schemaValidation) {
    if (sv.valid) continue;
    failureCategories.contract_violation++;
    schemaViolations.push({
      endpoint: sv.endpoint,
      httpStatus: sv.httpStatus,
      errors: sv.errors,
    });
    failedTests.push({
      id: `SCHEMA:${sv.endpoint}`,
      message: `Contract violation: ${(sv.errors || [])[0] || 'schema mismatch'}`,
      category: 'contract_violation',
      endpoint: `GET ${sv.endpoint}`,
    });
  }

  // Incorporate batch callback results — only if the batch suite actually ran
  const batchResults = skippedSuites.includes('batch-upload') ? [] : (plan.runResult.batchResults || []);
  const callbackFailures = [];

  for (const br of batchResults) {
    if (br.outcome === 'passed' || br.outcome === 'skipped') continue;

    for (const err of (br.errors || [])) {
      if (err.type === 'decrypt_failure') {
        // Decryption failure → BLOCKED-level severity
        failureCategories.api_error++;
        callbackFailures.push({
          testId: br.id,
          applicationId: br.applicationId,
          type: 'decrypt_failure',
          message: err.message,
          severity: 'blocked',
        });
        failedTests.push({
          id: br.id,
          message: `Callback decrypt failed: ${err.message}`,
          category: 'api_error',
          endpoint: 'POST /ai-gateway/batch-upload',
        });
      } else if (err.type === 'callback_timeout') {
        failureCategories.timeout++;
        callbackFailures.push({
          testId: br.id,
          applicationId: br.applicationId,
          type: 'callback_timeout',
          message: err.message,
          severity: br.callbacksReceived === 0 ? 'blocked' : 'fail',
        });
        failedTests.push({
          id: br.id,
          message: `Callback timeout: ${err.message}`,
          category: 'timeout',
          endpoint: 'POST /ai-gateway/batch-upload',
        });
      } else if (err.type === 'callback_validation') {
        failureCategories.contract_violation++;
        callbackFailures.push({
          testId: br.id,
          applicationId: br.applicationId,
          type: 'contract_violation',
          source: err.source,
          message: err.message,
          severity: 'fail',
        });
        failedTests.push({
          id: `${br.id}:${err.source}`,
          message: `Callback ${err.source}: ${err.message}`,
          category: 'contract_violation',
          endpoint: 'POST /ai-gateway/batch-upload',
        });
      }
    }
  }

  // Verdict (needs failedTests for critical-error detection)
  let verdict = getVerdict(passed, total, failedTests, exitCode, partialExecution);

  // Overlay completeness quality — a PASS with WARN completeness scores is not a silent PASS
  const completeness = summarizeCompleteness(plan.runResult?.completenessResults);
  if (verdict === 'PASS' && completeness) {
    if (completeness.completenessVerdict === 'PASS_WITH_WARNINGS') verdict = 'PASS_WITH_WARNINGS';
    else if (completeness.completenessVerdict === 'FAIL')           verdict = 'FAIL';
  }

  // Top failing endpoints (sorted by frequency)
  const endpointCounts = {};
  for (const ft of failedTests) {
    if (!ft.endpoint) continue;
    endpointCounts[ft.endpoint] = (endpointCounts[ft.endpoint] || 0) + 1;
  }
  const topFailingEndpoints = Object.entries(endpointCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([endpoint, count]) => ({ endpoint, count }));

  // Top failing test names (all failed, capped at 10)
  const topFailingTests = failedTests.slice(0, 10).map(ft => ({
    id: ft.id,
    category: ft.category,
    message: ft.message.length > 120 ? ft.message.slice(0, 120) + '...' : ft.message,
  }));

  const hasCritical = hasCriticalErrors(failedTests);

  const evaluation = {
    planId: plan.id,
    prNumber: plan.prNumber,
    previewUrl: plan.previewUrl,
    testType,
    skippedSuites: skippedSuites.length > 0 ? skippedSuites : undefined,
    verdict,
    passRate: `${passRate}%`,
    failureRate: `${failureRate}%`,
    passed,
    failed,
    total,
    durationMs,
    exitCode,
    partialExecution: partialExecution || undefined,
    crashedAt: crashedAt || undefined,
    crashPhase: crashPhase || undefined,
    expectedTotal: expectedTotal ?? undefined,
    criticalErrorsDetected: hasCritical,
    failureCategories,
    completeness: completeness ?? undefined,
    schemaViolations: schemaViolations.length > 0 ? schemaViolations : undefined,
    callbackFailures: callbackFailures.length > 0 ? callbackFailures : undefined,
    topFailingEndpoints,
    topFailingTests,
    evaluatedAt: new Date().toISOString(),
  };

  // Write eval JSON
  const evalJsonFile = `${plan.id}-eval.json`;
  writeFileSync(join(ROOT, 'reports', evalJsonFile), JSON.stringify(evaluation, null, 2));

  // Write eval markdown
  const evalMdFile = `${plan.id}-eval.md`;
  writeFileSync(join(ROOT, 'reports', evalMdFile), buildMarkdown(evaluation));

  // Update plan (store evaluation without rawOutput to keep it lean)
  plan.evaluation = evaluation;
  plan.resultsFile = evalJsonFile;
  writeFileSync(runningPath, JSON.stringify(plan, null, 2));

  const verdictIcon = verdict === 'PASS' ? '✅'
    : verdict === 'PASS_WITH_WARNINGS' ? '⚠️'
    : verdict === 'CRASHED' || verdict === 'INVALID' ? '💥'
    : verdict === 'FAIL' ? '⚠️' : '🚨';
  console.log(`[evaluator] ${verdictIcon} Verdict: ${verdict} (${passRate}% pass — ${passed}/${total})`);
  if (completeness && completeness.completenessVerdict !== 'PASS') {
    console.log(`  Completeness: avg=${completeness.avgScore} lowest=${completeness.lowestScore} warn=${completeness.warnCount} fail=${completeness.failCount}`);
    if (completeness.worstCase?.missingRequired?.length) {
      console.log(`  Worst fixture: ${completeness.worstCase.tcId} (score ${completeness.worstCase.score}/${completeness.worstCase.maxScore}) — missing required: ${completeness.worstCase.missingRequired.join(', ')}`);
    }
  }
  if (crashPhase) {
    console.error(`[evaluator] ❌ Crashed during setup phase: ${crashPhase} — no test cases executed`);
  } else if (partialExecution) {
    console.error(`[evaluator] ❌ Crashed at ${crashedAt ?? 'unknown'} — ${total}/${expectedTotal ?? '?'} tests completed before crash`);
  }

  if (Object.values(failureCategories).some(v => v > 0)) {
    console.log(`  Failure breakdown: ${formatCategories(failureCategories)}`);
  }
  if (topFailingEndpoints.length) {
    console.log(`  Top failing endpoints: ${topFailingEndpoints.map(e => e.endpoint).join(', ')}`);
  }

  console.log(`  Reports: reports/${evalJsonFile}, reports/${evalMdFile}`);

  return { planFile, evaluation };
}

// ── Markdown report ─────────────────────────────────────────────────────────

function formatCategories(cats) {
  return Object.entries(cats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.replace('_', ' ')}=${v}`)
    .join(', ');
}

function buildMarkdown(ev) {
  const icon = ev.verdict === 'PASS' ? '✅'
    : ev.verdict === 'PASS_WITH_WARNINGS' ? '⚠️'
    : ev.verdict === 'CRASHED' || ev.verdict === 'INVALID' ? '💥'
    : ev.verdict === 'FAIL' ? '⚠️' : '🚨';
  const timestamp = ev.evaluatedAt.replace('T', ' ').slice(0, 16) + ' UTC';

  const lines = [
    `# ${icon} Evaluation — PR #${ev.prNumber}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Verdict | **${ev.verdict}** |`,
    `| Total tests | ${ev.total} |`,
    `| Passed | ${ev.passed} |`,
    `| Failed | ${ev.failed} |`,
    `| Pass rate | ${ev.passRate} |`,
    `| Failure rate | ${ev.failureRate} |`,
    `| Duration | ${(ev.durationMs / 1000).toFixed(1)}s |`,
    `| Exit code | ${ev.exitCode} |`,
  ];

  if (ev.crashPhase) {
    lines.push(`| Execution | 💥 CRASHED — setup phase: \`${ev.crashPhase}\` |`);
    lines.push(`| Tests completed | 0 — no test cases ran |`);
  } else if (ev.partialExecution) {
    lines.push(`| Execution | ❌ PARTIAL — crashed at \`${ev.crashedAt ?? 'unknown'}\` |`);
    if (ev.expectedTotal != null) {
      lines.push(`| Tests completed | ${ev.total}/${ev.expectedTotal} |`);
    }
  }

  lines.push('');

  // Failure categories
  const hasFailures = Object.values(ev.failureCategories).some(v => v > 0);
  if (hasFailures) {
    lines.push('## Failure Categories', '');
    lines.push('| Category | Count |');
    lines.push('|----------|-------|');
    for (const [cat, count] of Object.entries(ev.failureCategories)) {
      if (count > 0) {
        lines.push(`| ${cat.replace('_', ' ')} | ${count} |`);
      }
    }
    lines.push('');
  }

  // Completeness quality summary
  if (ev.completeness) {
    const c = ev.completeness;
    const cv = c.completenessVerdict;
    const cvIcon = cv === 'PASS' ? '✅' : cv === 'PASS_WITH_WARNINGS' ? '⚠️' : '❌';
    lines.push('## Completeness Quality', '');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Verdict | ${cvIcon} **${cv}** |`);
    lines.push(`| Avg score | ${c.avgScore} |`);
    lines.push(`| Lowest score | ${c.lowestScore} |`);
    lines.push(`| WARN cases | ${c.warnCount} |`);
    lines.push(`| FAIL cases | ${c.failCount} |`);
    lines.push('');
    if (c.worstCase) {
      const wc = c.worstCase;
      lines.push(`**Worst fixture:** \`${wc.tcId}\` — score ${wc.score}/${wc.maxScore ?? 100}`);
      if (wc.missingRequired?.length) {
        lines.push(`**Missing required fields:** ${wc.missingRequired.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Callback failures
  if (ev.callbackFailures?.length) {
    lines.push('## Callback Failures', '');
    lines.push('| Test | Type | Severity | Message |');
    lines.push('|------|------|----------|---------|');
    for (const cf of ev.callbackFailures) {
      const msg = cf.message.length > 100 ? cf.message.slice(0, 100) + '...' : cf.message;
      lines.push(`| \`${cf.testId}\` | ${cf.type} | ${cf.severity} | ${msg} |`);
    }
    lines.push('');
  }

  // Schema violations
  if (ev.schemaViolations?.length) {
    lines.push('## Schema Violations (Contract)', '');
    lines.push('| Endpoint | HTTP | Errors |');
    lines.push('|----------|------|--------|');
    for (const sv of ev.schemaViolations) {
      const errSummary = (sv.errors || []).slice(0, 3).join('; ');
      lines.push(`| \`${sv.endpoint}\` | ${sv.httpStatus ?? '—'} | ${errSummary} |`);
    }
    lines.push('');
  }

  // Top failing endpoints
  if (ev.topFailingEndpoints.length) {
    lines.push('## Top Failing Endpoints', '');
    lines.push('| Endpoint | Failures |');
    lines.push('|----------|----------|');
    for (const { endpoint, count } of ev.topFailingEndpoints) {
      lines.push(`| \`${endpoint}\` | ${count} |`);
    }
    lines.push('');
  }

  // Top failing tests
  if (ev.topFailingTests.length) {
    lines.push('## Failed Tests', '');
    lines.push('| Test ID | Category | Message |');
    lines.push('|---------|----------|---------|');
    for (const { id, category, message } of ev.topFailingTests) {
      lines.push(`| \`${id}\` | ${category.replace('_', ' ')} | ${message} |`);
    }
    lines.push('');
  }

  lines.push('---', `Evaluated at ${timestamp}`);
  return lines.join('\n');
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes('evaluator')) {
  const planFile = process.argv[2];
  if (!planFile) {
    console.error('Usage: node agents/evaluator/index.mjs <plan-file.json>');
    process.exit(1);
  }
  evaluate(planFile).catch(err => {
    console.error(`[evaluator] Fatal: ${err.message}`);
    process.exit(1);
  });
}
