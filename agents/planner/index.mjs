#!/usr/bin/env node
/**
 * Planner Agent
 *
 * Reads environment config (PR number, preview URL, ClickUp task IDs) and
 * produces a plan JSON that downstream agents consume.
 *
 * Input:  .env + CLI args (ClickUp task IDs)
 * Output: tasks/pending/<timestamp>-plan.json
 */

import 'dotenv/config';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveMapping } from '../../mappings/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const VALID_TEST_TYPES = ['parse', 'batch-upload', 'auth-boundary', 'full-regression'];

// ── Document type inference ──────────────────────────────────────────────────

const DOC_TYPES = JSON.parse(
  readFileSync(join(ROOT, 'config', 'document-types.json'), 'utf8'),
);

/**
 * Infer document category from free text (ClickUp title + description).
 * Returns { documentCategory, parseFileType, batchDocumentType, selectedTestReason } or nulls.
 */
function inferDocumentType(text) {
  if (!text) return { documentCategory: null, parseFileType: null, batchDocumentType: null, selectedTestReason: null };
  const lower = text.toLowerCase();
  for (const [category, entry] of Object.entries(DOC_TYPES)) {
    if (category === '_comment') continue;
    for (const alias of entry.aliases) {
      if (lower.includes(alias)) {
        return {
          documentCategory: category,
          parseFileType: entry.parseFileType,
          batchDocumentType: entry.batchDocumentType,
          selectedTestReason: `Matched alias "${alias}" in ClickUp task text`,
        };
      }
    }
  }
  return { documentCategory: null, parseFileType: null, batchDocumentType: null, selectedTestReason: null };
}

/**
 * Universal field focus rules — apply to all document types regardless of mapping.
 * Document-type-specific rules (payslip income/deductions, etc.) live in each
 * mapping's fieldFocusRules and are merged in inferAffectedFields().
 *
 * Path conventions:
 *   - transactionsOCR.*.field  (not transactions.*)
 *   - Use * wildcard, never numeric indexes
 *   - Only fields directly affected by the PR change
 */
const UNIVERSAL_FIELD_FOCUS_RULES = [
  {
    keywords: ['fraud', 'forgery', 'tamper', 'manipulat', 'alter', 'fake document', 'authentic'],
    focus: 'fraud',
    fields: ['fraudChecks', 'fraudChecks.overall_fraud_flag'],
  },
  {
    keywords: ['transaction', 'posting date', 'debit', 'credit entry', 'ledger'],
    focus: 'transactions',
    fields: ['transactionsOCR', 'transactionsOCR.*.posting_date', 'transactionsOCR.*.amount', 'transactionsOCR.*.description'],
  },
  {
    keywords: ['balance', 'opening balance', 'closing balance', 'running balance', 'available balance'],
    focus: 'balance',
    fields: ['documentData.*.opening_balance', 'documentData.*.closing_balance'],
  },
  {
    keywords: ['account number', 'account no', 'iban', 'bsb', 'sort code', 'routing number'],
    focus: 'account_details',
    fields: ['documentData.*.account_number', 'documentData.*.bank_name'],
  },
  {
    keywords: ['classif', 'document type', 'doc type', 'document category'],
    focus: 'classification',
    fields: ['documentData.*.document_type'],
  },
  {
    keywords: ['ocr', 'extraction accuracy', 'parsing accuracy', 'field accuracy', 'incorrect field'],
    focus: 'field_extraction',
    fields: ['documentData'],
  },
];

/**
 * Infer response-body paths to assert from ClickUp task text keywords.
 *
 * Merges UNIVERSAL_FIELD_FOCUS_RULES with the active mapping's fieldFocusRules
 * so that document-type-specific fields are included automatically.
 *
 * @param {string} text  — combined ClickUp task title + description + comments
 * @param {object[]?} mappingFieldFocusRules  — from resolveMapping().mapping.fieldFocusRules
 * @returns {{ validationFocus: string|null, affectedFields: string[] }}
 */
function inferAffectedFields(text, mappingFieldFocusRules = []) {
  if (!text) return { validationFocus: null, affectedFields: [] };
  const lower = text.toLowerCase();
  const allFields = [];
  let firstFocus = null;

  // Universal rules first, then document-type-specific ones from the mapping
  const allRules = [...UNIVERSAL_FIELD_FOCUS_RULES, ...mappingFieldFocusRules];

  for (const rule of allRules) {
    if (rule.keywords.some(k => lower.includes(k))) {
      if (!firstFocus) firstFocus = rule.focus;
      for (const f of rule.fields) {
        if (!allFields.includes(f)) allFields.push(f);
      }
    }
  }
  return { validationFocus: firstFocus, affectedFields: allFields };
}

/**
 * QA-lead style scope decision: given everything known about the change, decide
 * which test type to run, how many fixtures to use, and write down why.
 *
 * Called only when the operator has NOT set an explicit --test-type or TEST_TYPE.
 * The goal is to match scope to actual risk rather than always running full-regression.
 *
 * Returns { testType, testRationale, suggestedFixtureCount }.
 * suggestedFixtureCount=null means "use all available fixtures" (no cap).
 */
function inferTestScope({ documentCategory, parseFileType, batchDocumentType, affectedFields, text }) {
  const lower = (text || '').toLowerCase();

  // Auth / permission changes → auth-boundary only
  // Running parse or batch tests on an auth change adds noise without signal.
  if (/\b(authori[sz]e?|permission|access.?denied|403|401|invalid.?token|unauthenticated|rbac|role.?check)\b/.test(lower)) {
    return {
      testType: 'auth-boundary',
      testRationale:
        'Auth/permission keywords detected in task — running auth-boundary tests only. ' +
        'Parse and batch tests are not useful here since auth failures surface before document processing.',
      suggestedFixtureCount: 0,
    };
  }

  // Batch pipeline / async callback / webhook → batch-upload
  // These changes touch the async delivery path, not the parse response body.
  const batchKeywords = ['batch-upload', 'batch upload', 'callback', 'webhook', 'async result', 'poll'];
  if (batchKeywords.some(k => lower.includes(k)) && (batchDocumentType || parseFileType)) {
    const docLabel = batchDocumentType || parseFileType;
    return {
      testType: 'batch-upload',
      testRationale:
        `Batch/callback keywords detected for ${docLabel} — running batch-upload tests to validate the async pipeline. ` +
        'Parse-only tests would miss callback delivery failures.',
      suggestedFixtureCount: 2,
    };
  }

  // Specific document type with known affected fields → targeted parse
  // Use all available fixtures: the more diverse the inputs, the more confidence.
  if (parseFileType && affectedFields.length > 0) {
    const preview = affectedFields.slice(0, 3).join(', ') + (affectedFields.length > 3 ? ', …' : '');
    return {
      testType: 'parse',
      testRationale:
        `${parseFileType} parsing change with ${affectedFields.length} field(s) in scope [${preview}]. ` +
        'Running targeted parse tests with all available fixtures — no fixture cap so every variant is exercised.',
      suggestedFixtureCount: null, // no cap — more fixtures = more confidence for field-level changes
    };
  }

  // Document type known but no specific field focus → targeted parse
  if (parseFileType) {
    return {
      testType: 'parse',
      testRationale:
        `${parseFileType} document type identified but no field-level keywords found. ` +
        'Running targeted parse tests. Add field-specific keywords to the ClickUp task (e.g. "net pay", "fraud score") to get assertion coverage.',
      suggestedFixtureCount: null,
    };
  }

  // No document type signal → full regression
  // Broad changes or unclear scope: run everything to catch regressions.
  return {
    testType: 'full-regression',
    testRationale: documentCategory
      ? `"${documentCategory}" category matched but document file type is ambiguous — running full regression for safety.`
      : 'No document type or field focus found in the task — running full regression to ensure nothing regressed.',
    suggestedFixtureCount: 2,
  };
}

/**
 * Determine what kinds of fixture files are needed to validate this change.
 * Returns an array of human-readable scenario strings that the generator will
 * try to match against fixture notes and filenames.
 *
 * The goal is to ensure the test suite exercises the paths that actually changed,
 * not just "any document of this type". E.g. a fraud-check change needs both a
 * clean document AND a tampered one; a payslip-salary change needs a range of
 * pay values to catch boundary issues.
 */
/**
 * Determine fixture scenarios needed to validate this change.
 *
 * Checks the active mapping's fixtureRequirementRules first (keyed by
 * validationFocus), then falls back to universal rules for cross-cutting
 * focuses (fraud, transactions, balance, etc.).
 *
 * @param {string|null} validationFocus
 * @param {string[]} affectedFields
 * @param {string|null} parseFileType
 * @param {string|null} documentCategory
 * @param {object|null} docMapping  — from resolveMapping()
 */
function buildFixtureRequirements(validationFocus, affectedFields, parseFileType, documentCategory, docMapping = null) {
  if (!parseFileType) return [];

  const doc = parseFileType.toLowerCase();

  // ── Mapping-specific fixture rules ─────────────────────────────────────────
  if (docMapping?.fixtureRequirementRules && validationFocus) {
    const rules = docMapping.fixtureRequirementRules;
    if (rules[validationFocus]) return rules[validationFocus];
  }

  // ── Universal fallbacks (cross-cutting, apply to any doc type) ────────────
  switch (validationFocus) {
    case 'fraud':
      // Need both a clean document (should NOT trigger fraud flag) and a
      // tampered/fraud-flagged one (SHOULD trigger it).
      return [
        `clean ${doc}`,
        `tampered or fraud-flagged ${doc}`,
      ];

    case 'transactions':
      // Edge-case: sparse vs dense transaction lists stress different parsing paths.
      return [
        `${doc} with many transactions`,
        `${doc} with few transactions`,
      ];

    case 'balance':
      return [
        `${doc} with opening and closing balance`,
        `${doc} with running balance`,
      ];

    case 'account_details':
      return [`${doc} with account number clearly visible`];

    case 'field_extraction':
    case 'classification':
      return [
        `complete ${doc}`,
        `partial ${doc} with missing or inconsistent fields`,
      ];

    default:
      // Check mapping _default before generic fallback
      if (docMapping?.fixtureRequirementRules?._default) {
        return docMapping.fixtureRequirementRules._default;
      }
      return [`complete ${doc}`];
  }
}

/**
 * Fetch ClickUp task title, description, and comments for inference.
 * Gracefully returns empty string on any error.
 */
async function fetchClickUpText(taskIds) {
  const token = process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_API_KEY;
  if (!token || !taskIds.length) return '';
  const parts = [];
  for (const id of taskIds) {
    try {
      const res = await fetch(`https://api.clickup.com/api/v2/task/${id}`, {
        headers: { Authorization: token },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.name) parts.push(data.name);
      if (data.description) parts.push(data.description);
      // Also fetch comments for richer keyword context
      try {
        const cRes = await fetch(`https://api.clickup.com/api/v2/task/${id}/comment`, {
          headers: { Authorization: token },
        });
        if (cRes.ok) {
          const cData = await cRes.json();
          for (const c of cData.comments ?? []) {
            if (c.comment_text) parts.push(c.comment_text);
          }
        }
      } catch { /* comments are bonus context — ignore failures */ }
    } catch {
      // ignore — inference is best-effort
    }
  }
  return parts.join(' ');
}

export async function plan(clickupTaskIds = []) {
  const prNumber = process.env.PR_NUMBER;
  const prRepo = process.env.PR_REPO;
  const previewUrl = (process.env.VERIFYIQ_SERVICE_URL || '').trim().replace(/\/$/, '');

  // Resolve testType: --test-type=<value> arg takes priority, then TEST_TYPE env, then default
  let taskIds = [...clickupTaskIds];
  let testType = null; // resolved after context analysis — see inferTestScope()

  // Parse all --flag=value overrides out of the args list
  const extractArg = (prefix) => {
    const idx = taskIds.findIndex(a => a.startsWith(prefix));
    if (idx === -1) return null;
    const value = taskIds[idx].split('=').slice(1).join('=');
    taskIds.splice(idx, 1);
    return value;
  };

  const testTypeArg         = extractArg('--test-type=');
  const docCategoryOverride = extractArg('--document-category=');
  const fileTypeOverride    = extractArg('--file-type=');
  const batchTypeOverride   = extractArg('--batch-document-type=');
  const reuseTestCasesArg        = extractArg('--reuse-test-cases=');
  const maxFixturesArg           = extractArg('--max-fixtures=');
  const allowRegistryFallbackArg = extractArg('--allow-registry-fallback=');

  // --no-clickup and --no-remote are boolean flags (no value)
  const noClickUpIdx = taskIds.findIndex(a => a === '--no-clickup');
  const disableClickUp = noClickUpIdx !== -1 || process.env.DISABLE_CLICKUP === 'true';
  if (noClickUpIdx !== -1) taskIds.splice(noClickUpIdx, 1);

  const noRemoteIdx = taskIds.findIndex(a => a === '--no-remote');
  const disableRemote = noRemoteIdx !== -1 || process.env.DISABLE_REMOTE_POSTING === 'true';
  if (noRemoteIdx !== -1) taskIds.splice(noRemoteIdx, 1);

  const reuseTestCases = reuseTestCasesArg === 'true' || process.env.REUSE_TEST_CASES === 'true';
  const allowRegistryFallback = allowRegistryFallbackArg === 'true' || process.env.ALLOW_REGISTRY_FALLBACK === 'true';
  const maxFixtures = maxFixturesArg !== null
    ? parseInt(maxFixturesArg, 10)
    : (process.env.MAX_FIXTURES ? parseInt(process.env.MAX_FIXTURES, 10) : null);

  // Preserve any explicit override — applied after context analysis below
  const explicitTestType = testTypeArg || process.env.TEST_TYPE || null;

  const missing = [];
  if (!prNumber) missing.push('PR_NUMBER');
  if (!previewUrl) missing.push('VERIFYIQ_SERVICE_URL');
  if (missing.length) {
    throw new Error(`Planner: missing required env vars: ${missing.join(', ')}`);
  }

  // ── Document type resolution ─────────────────────────────────────────────
  let documentCategory = null;
  let parseFileType = null;
  let batchDocumentType = null;
  let selectedTestReason = null;

  // Fetch ClickUp text once — used for doc type inference AND affected field detection
  const clickUpText = await fetchClickUpText(taskIds);

  if (docCategoryOverride || fileTypeOverride || batchTypeOverride) {
    // Manual override — resolve from the map when possible
    if (docCategoryOverride && DOC_TYPES[docCategoryOverride]) {
      const entry = DOC_TYPES[docCategoryOverride];
      documentCategory  = docCategoryOverride;
      parseFileType     = fileTypeOverride    ?? entry.parseFileType;
      batchDocumentType = batchTypeOverride   ?? entry.batchDocumentType;
    } else {
      documentCategory  = docCategoryOverride  ?? null;
      parseFileType     = fileTypeOverride     ?? null;
      batchDocumentType = batchTypeOverride    ?? null;
    }
    selectedTestReason = 'Manual override via CLI flag';
    console.log(`[planner] Document type: ${documentCategory} (manual override)`);
  } else {
    // Infer from ClickUp task text
    ({ documentCategory, parseFileType, batchDocumentType, selectedTestReason } = inferDocumentType(clickUpText));
    if (documentCategory) {
      console.log(`[planner] Document type inferred: ${documentCategory} — ${selectedTestReason}`);
    }
  }

  // ── Load mapping profile for the detected document type ─────────────────────
  const {
    mapping: docMapping,
    confidence: mappingConfidence,
    profile: mappingProfile,
  } = resolveMapping(documentCategory);
  console.log(`[planner] Mapping: ${mappingProfile} (${mappingConfidence})`);

  // ── Affected fields / validation focus (always inferred from ClickUp text) ─
  const { validationFocus, affectedFields } = inferAffectedFields(clickUpText, docMapping.fieldFocusRules);
  if (affectedFields.length) {
    console.log(`[planner] Validation focus: ${validationFocus} — fields: ${affectedFields.join(', ')}`);
  }

  // ── Test scope decision ──────────────────────────────────────────────────────
  // Explicit CLI / env override always wins. Otherwise the planner decides based
  // on what the task is actually about — matching scope to risk.
  let testRationale = null;
  let suggestedFixtureCount = null;

  if (explicitTestType) {
    testType = explicitTestType;
    testRationale = `Test type explicitly set to "${testType}" via ${testTypeArg ? '--test-type flag' : 'TEST_TYPE env var'}.`;
  } else {
    const scopeDecision = inferTestScope({
      documentCategory,
      parseFileType,
      batchDocumentType,
      affectedFields,
      text: clickUpText,
    });
    testType = scopeDecision.testType;
    testRationale = scopeDecision.testRationale;
    suggestedFixtureCount = scopeDecision.suggestedFixtureCount;
    console.log(`[planner] Scope: ${testType}`);
    console.log(`  Rationale: ${testRationale}`);
  }

  if (!VALID_TEST_TYPES.includes(testType)) {
    throw new Error(
      `Planner: invalid testType "${testType}". Must be one of: ${VALID_TEST_TYPES.join(', ')}`,
    );
  }

  const fixtureRequirements = buildFixtureRequirements(
    validationFocus, affectedFields, parseFileType, documentCategory, docMapping,
  );
  if (fixtureRequirements.length) {
    console.log(`[planner] Fixture requirements (${fixtureRequirements.length}):`);
    for (const req of fixtureRequirements) {
      console.log(`  - ${req}`);
    }
  }

  const plan = {
    id: `plan-${Date.now()}`,
    createdAt: new Date().toISOString(),
    prNumber,
    prRepo: prRepo || null,
    previewUrl,
    clickupTaskIds: taskIds,
    testType,
    testRationale,
    documentCategory,
    parseFileType,
    batchDocumentType,
    selectedTestReason,
    mappingProfile,        // e.g. 'payslip' | 'generic'
    mappingConfidence,     // 'learned' | 'generic'
    validationFocus,
    affectedFields,
    fixtureRequirements,   // scenario-based: what kinds of files are needed
    maxFixtures,           // hard cap from --max-fixtures / MAX_FIXTURES (null = not set)
    suggestedFixtureCount, // planner's recommendation (null = no cap; number = use this many)
    reuseTestCases,
    allowRegistryFallback,  // false by default — GCS failures hard-fail rather than silently degrade
    disableClickUp,
    disableRemote,
    status: 'pending',
    testCasesFile: null,   // filled by generator
    resultsFile: null,     // filled by evaluator
    reportFile: null,      // filled by reporter
  };

  const filename = `${plan.id}.json`;
  const outPath = join(ROOT, 'tasks', 'pending', filename);
  writeFileSync(outPath, JSON.stringify(plan, null, 2));

  console.log(`[planner] Plan created: ${filename}`);
  console.log(`  PR #${prNumber} → ${previewUrl}`);
  console.log(`  Test type: ${testType}`);
  if (taskIds.length) {
    console.log(`  ClickUp tasks: ${taskIds.join(', ')}`);
  }
  if (affectedFields.length) {
    console.log(`  Validation focus: ${validationFocus} (${affectedFields.length} fields)`);
  }
  if (maxFixtures !== null) {
    console.log(`  Max fixtures: ${maxFixtures}`);
  }

  return { planFile: filename, plan };
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes('planner')) {
  const taskIds = process.argv.slice(2); // --test-type=<value> is parsed inside plan()
  plan(taskIds).catch(err => {
    console.error(`[planner] Fatal: ${err.message}`);
    process.exit(1);
  });
}
