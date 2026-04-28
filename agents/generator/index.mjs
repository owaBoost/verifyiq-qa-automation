#!/usr/bin/env node
/**
 * Generator Agent
 *
 * Reads a plan JSON and produces test-cases.json with real fixture payloads.
 *
 * parse mode:
 *   - requires plan.parseFileType
 *   - selects up to 3 fixtures from fixture-registry.json (complete ones preferred)
 *   - generates one POST /v1/documents/parse case per fixture
 *   - no health cases — run_qa.mjs already runs baseline health checks unconditionally
 *   - hard-fails if no matching fixture exists
 *
 * batch-upload mode:
 *   - requires plan.batchDocumentType (or resolvable via gatewayDocumentTypeMap)
 *   - selects up to 2 fixtures, builds payload.payload.documents array
 *   - hard-fails if no matching fixture or no documentType
 *
 * full-regression:
 *   - if parseFileType is set, uses fixture-backed parse + batch cases
 *   - falls back to generic (no-payload) stubs when no docType is known
 *
 * auth-boundary:
 *   - unchanged — auth.spec.js is self-contained
 *
 * Input:  tasks/pending/<plan>.json
 * Output: test-cases.json (root), updates plan with testCasesFile + selectedFixtures
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadFixturesFromGCS, GCSAccessDeniedError } from '../../utils/gcs-fixture-loader.mjs';
import { resolveMapping } from '../../mappings/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Fixture registry (secondary / fallback) ───────────────────────────────────

const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'fixture-registry.json'), 'utf8'));
const { gatewayDocumentTypeMap, fixtures: ALL_FIXTURES } = REGISTRY;

/**
 * Load fixtures from GCS (primary), optionally falling back to fixture-registry.json.
 *
 * Default behaviour: GCS only. Registry fallback is opt-in via allowRegistryFallback.
 * This prevents silent degradation where stale / wrong registry fixtures are tested
 * instead of the canonical GCS dataset.
 *
 * Source priority:
 *   1. gs://test-ai-docs-data-dev/qa-test-data/<folder>/ (always tried)
 *   2. fixture-registry.json (only when allowRegistryFallback=true)
 *   3. [] with source='gcs-empty' — caller decides whether to hard-fail
 *
 * @param {string} parseFileType
 * @param {number} maxCount
 * @param {{ allowRegistryFallback?: boolean }} opts
 * @returns {Promise<{ fixtures: FixtureItem[], source: 'gcs'|'registry'|'gcs-empty'|null, folderName: string|null }>}
 */
async function resolveFixtures(parseFileType, maxCount = 3, { allowRegistryFallback = false } = {}) {
  // 1. GCS primary — always attempted.
  // GCSAccessDeniedError (403 / IAM failure) is NOT caught here — it propagates
  // to generate() so the pipeline can mark the run as non-retryable immediately.
  const gcsResults = await loadFixturesFromGCS(parseFileType, maxCount);
  if (gcsResults.length > 0) {
    console.log(`[generator] Using GCS fixtures (primary) — ${gcsResults.length} found for ${parseFileType}`);
    return {
      fixtures: gcsResults.map(f => ({
        fixtureKey: `gcs:${f.file.split('/').pop()}`,
        file: f.file,
        fileType: f.fileType,
        complete: true,
        notes: null,
        source: 'gcs',
        folderName: f.folderName,
      })),
      source: 'gcs',
      folderName: gcsResults[0].folderName,
    };
  }

  // GCS returned empty — decide whether to fall back
  if (!allowRegistryFallback) {
    // Return sentinel so generate() can emit the correct hard-fail error
    return { fixtures: [], source: 'gcs-empty', folderName: null };
  }

  // 2. Registry fallback — only when explicitly enabled
  console.log(`[generator] Using registry fixtures (fallback enabled) — GCS returned empty for ${parseFileType}`);
  const matching = Object.entries(ALL_FIXTURES)
    .filter(([, f]) => f.fileType === parseFileType);

  if (matching.length > 0) {
    const complete = matching.filter(([, f]) => f.complete);
    const pool = complete.length > 0 ? complete : matching;
    const fixtures = pool.slice(0, maxCount).map(([key, f]) => ({
      fixtureKey: key,
      file: f.baseline,
      fileType: f.fileType,
      complete: f.complete,
      notes: f.notes ?? null,
      source: 'registry',
      folderName: null,
    }));
    return { fixtures, source: 'registry', folderName: null };
  }

  return { fixtures: [], source: null, folderName: null };
}

/**
 * Resolve batchDocumentType from plan or registry fallback.
 */
function resolveBatchDocType(plan) {
  if (plan.batchDocumentType) return plan.batchDocumentType;
  if (plan.parseFileType) return gatewayDocumentTypeMap[plan.parseFileType] ?? null;
  return null;
}

/**
 * Reverse-resolve parseFileType from batchDocumentType via registry map.
 */
function resolveParseFileTypeFromBatch(batchDocType) {
  return Object.keys(gatewayDocumentTypeMap).find(k => gatewayDocumentTypeMap[k] === batchDocType) ?? null;
}

// ── Auth test cases (self-contained, no fixtures) ─────────────────────────────

const AUTH_CASES = [
  {
    id: 'AUTH-001',
    title: 'Unauthenticated request is rejected',
    type: 'auth',
    preconditions: 'Service is deployed',
    steps: 'GET /health without Authorization header',
    expected_result: 'HTTP 401 or 403',
    method: 'GET',
    endpoint: '/health',
    expected_status: 401,
    skip_iap: true,
    assertions: [],
  },
  {
    id: 'AUTH-002',
    title: 'Invalid token is rejected',
    type: 'auth',
    preconditions: 'Service is deployed',
    steps: 'GET /health with Authorization: Bearer invalid-token',
    expected_result: 'HTTP 401 or 403',
    method: 'GET',
    endpoint: '/health',
    expected_status: 401,
    invalid_token: true,
    assertions: [],
  },
];

// ── Health cases (batch-upload and full-regression only) ──────────────────────
// parse mode omits these — runBaselineHealthChecks() in run_qa.mjs already
// runs /health, /health/detailed, and /ai-gateway/health/gateway-circuit-breakers
// before every test run.

const HEALTH_CASES = [
  {
    id: 'HC-001',
    title: 'Health endpoint returns ok',
    type: 'health',
    preconditions: 'Service is deployed',
    steps: 'GET /health',
    expected_result: 'HTTP 200 with status ok or healthy',
    method: 'GET',
    endpoint: '/health',
    expected_status: 200,
    assertions: [
      { path: 'status', pattern: '(?i)^(ok|healthy)$', description: 'Status is ok or healthy' },
    ],
  },
  {
    id: 'HC-002',
    title: 'Detailed health check',
    type: 'health',
    preconditions: 'Service is deployed',
    steps: 'GET /health/detailed',
    expected_result: 'HTTP 200 with redis and postgresql healthy',
    method: 'GET',
    endpoint: '/health/detailed',
    expected_status: 200,
    assertions: [
      { path: 'cache.redis.healthy', pattern: 'true', description: 'Redis is healthy' },
      { path: 'cache.postgresql.healthy', pattern: 'true', description: 'PostgreSQL is healthy' },
    ],
  },
];

// ── Fixture-backed case builders ──────────────────────────────────────────────

// ── Base field registry (universal / structural fields) ───────────────────────
// Maps response paths that apply to ALL document types regardless of mapping.
// Document-type-specific fields live in mappings/<type>.mjs assertionRules.
//
// makeAssertion() checks the active mapping's assertionRules first, then falls
// back to this registry, then falls back to a weak exists check.
//
// assertionType:
//   'type'    → run_qa.mjs does a real Array.isArray / typeof check (strong)
//   'pattern' → regex against the stringified value (strong)
//   'exists'  → .+ check — field present and non-empty (weak)

const BASE_FIELD_REGISTRY = {
  // ── Top-level structural checks ───────────────────────────────────────────
  // documentData shape varies by document type — do NOT assume array here.
  // Payslip: array. BankStatement: object with .summary[] and .transactions[].
  // Use the learned mapping's assertionRules for the documentData type assertion.
  'applicationId':   { assertionType: 'exists',  pattern: '.+' },
  'fileType':        { assertionType: 'exists',  pattern: '.+' },
  'extractionStatus':{ assertionType: 'exists',  pattern: '.+' },
  'fraudChecks':     { assertionType: 'type',    expectedType: 'object' },
  'transactionsOCR': { assertionType: 'type',    expectedType: 'array' },

  // ── Boolean flags ─────────────────────────────────────────────────────────
  'fraudChecks.overall_fraud_flag': {
    assertionType: 'pattern',
    pattern: '^(true|false|True|False|0|1)$',
  },

  // ── transactionsOCR child fields ──────────────────────────────────────────
  'transactionsOCR.*.posting_date': {
    assertionType: 'pattern',
    pattern: '^\\d{4}-\\d{2}-\\d{2}|^\\d{2}[/.]\\d{2}[/.]\\d{4}',
  },
  'transactionsOCR.*.amount':      { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$' },
  'transactionsOCR.*.description': { assertionType: 'exists',  pattern: '.+' },
};

/**
 * Classify a fixture as 'complete', 'partial', or 'complex'.
 *
 * Checks GCS path segments first, then applies filename keyword rules.
 *
 * Path-based rules (applied to full gs:// path, case-insensitive):
 *   /gcash/ folder  → complex  (GCash-sourced, edge-case payment platform)
 *
 * Filename keyword rules (applied to basename, punctuation → spaces):
 *   'compact', 'full', 'complete', 'standard' → complete
 *   'partial', 'missing', 'test'              → partial
 *   'multi' (multi-page, multi-employer)       → complex
 *
 * Registry flag:
 *   fixture.complete === false                 → partial
 *
 * Default: complete
 *
 * Validation mode per class:
 *   complete / complex → 'strict'  — missing field = FAIL
 *   partial            → 'relaxed' — missing field = WARN, wrong value = FAIL
 */
function classifyFixture(fixture) {
  const fullPath = (fixture.file || '').toLowerCase();
  const filename = fullPath.split('/').pop().replace(/[._]/g, ' ');

  // Path-level overrides (checked before filename)
  if (/\/gcash\//i.test(fullPath)) return 'complex';

  // Filename keyword rules
  if (/\b(partial|missing|test)\b/.test(filename)) return 'partial';
  if (/\bmulti\b/.test(filename))                  return 'complex';
  if (/\b(compact|full|complete|standard)\b/.test(filename)) return 'complete';

  // Registry flag fallback
  if (fixture.complete === false) return 'partial';

  return 'complete';
}

/**
 * Build a single typed assertion object for a given path.
 *
 * Lookup order:
 *   1. docMapping.assertionRules  — document-type-specific (e.g. payslip fields)
 *   2. BASE_FIELD_REGISTRY        — universal structural fields
 *   3. weak exists fallback       — unknown field, minimal assertion
 *
 * optional behaviour:
 *   An assertion is marked optional: true when:
 *   - The rule has optional: true AND forceRequired is not set
 *   - OR relaxed mode is active (partial fixture) AND forceRequired is not set
 *   Optional assertions produce WARN (not FAIL) when the field is absent.
 *   A present field with the wrong value still FAILs regardless of optional.
 *
 * @param {string} path
 * @param {string} description
 * @param {object|null} docMapping — resolved mapping from mappings/index.mjs
 * @param {{ forceRequired?: boolean, relaxed?: boolean }} opts
 */
function makeAssertion(path, description, docMapping = null, { forceRequired = false, relaxed = false } = {}) {
  const reg = docMapping?.assertionRules?.[path] ?? BASE_FIELD_REGISTRY[path] ?? null;
  // optional if the rule marks it optional OR relaxed mode is active (and not forced required)
  const optional = !forceRequired && (relaxed || reg?.optional === true);

  if (!reg) {
    const a = { path, assertionType: 'exists', pattern: '.+', description, strength: 'weak' };
    if (optional) a.optional = true;
    return a;
  }

  if (reg.assertionType === 'type') {
    const a = {
      path,
      assertionType: 'type',
      expectedType: reg.expectedType,
      pattern: '.+',            // fallback for runners that predate assertionType support
      description,
      strength: 'strong',
    };
    if (optional) a.optional = true;
    return a;
  }

  if (reg.assertionType === 'pattern') {
    const a = { path, assertionType: 'pattern', pattern: reg.pattern, description, strength: reg.strength ?? 'strong' };
    if (optional) a.optional = true;
    return a;
  }

  const a = { path, assertionType: 'exists', pattern: '.+', description, strength: reg.strength ?? 'weak' };
  if (optional) a.optional = true;
  return a;
}

/**
 * Build the full assertion list for a parse test case.
 *
 * mode: 'strict'  — all assertions required; absent field = FAIL.
 *       'relaxed' — structural fields (applicationId, documentData) required;
 *                   all other assertions optional (absent = WARN, wrong value = FAIL).
 *                   Use for partial/incomplete fixtures so the pipeline does not fail
 *                   just because a fixture lacks a field — only real value regressions fail.
 *
 * The optional flag from docMapping.assertionRules is always respected.
 * In strict mode, mapping-optional fields still produce WARN when absent.
 * In relaxed mode, ALL non-structural assertions produce WARN when absent.
 *
 * Never returns an empty list.
 *
 * @param {string[]} affectedFields
 * @param {string|null} validationFocus
 * @param {string|null} documentCategory
 * @param {object|null} docMapping — resolved mapping from mappings/index.mjs
 * @param {'strict'|'relaxed'} mode
 */
function buildAssertions(affectedFields, validationFocus, documentCategory, docMapping = null, mode = 'strict') {
  const focusLabel = validationFocus ? ` (${validationFocus})` : '';
  const seen = new Set();
  const assertions = [];
  const isRelaxed = mode === 'relaxed';

  const add = (path, description, opts = {}) => {
    if (seen.has(path)) return;
    seen.add(path);
    assertions.push(makeAssertion(path, description, docMapping, opts));
  };

  // Structural base assertions — always required regardless of mode or fixture class
  add('applicationId', 'applicationId is present',                    { forceRequired: true });
  add('documentData',  'documentData object is present in response',  { forceRequired: true });

  if (!affectedFields || affectedFields.length === 0) {
    // No specific fields targeted — add safe root-level structural assertions only.
    // Do NOT add documentData.*.document_type: documentData is not always an array
    // (BankStatement returns documentData as an object with .summary[] sub-array).
    // Learned mappings own their documentData shape assertion via assertionRules.
    if (documentCategory) {
      add('fileType',         'fileType is present in response',         { relaxed: isRelaxed });
      add('extractionStatus', 'extractionStatus is present in response', { relaxed: isRelaxed });
    }
    return assertions;
  }

  for (const field of affectedFields) {
    // relaxed: missing field → WARN; wrong value → FAIL
    // strict:  missing field → FAIL
    add(field, `${field} is present and valid${focusLabel}`, { relaxed: isRelaxed });
  }

  // Fraud focus: guard top-level fraudChecks even in relaxed mode — the ticket
  // explicitly targets fraud so its container must exist.
  if (validationFocus === 'fraud') {
    add('fraudChecks', 'fraudChecks object is present (fraud focus)', { forceRequired: true });
  }

  return assertions;
}

/**
 * Build computed (cross-field) assertion objects from docMapping.computedValidations.
 *
 * Each entry in computedValidations becomes one assertionType:'computed' object in the
 * test case assertions array. The runner evaluates these by resolving named path keys
 * from the paths map and applying the check-specific math logic.
 *
 * The runner skips a check with WARN when required paths are absent (e.g. a payslip
 * that lacks totalDeductions can't be verified against the net=gross-deductions formula).
 * A present-but-incorrect value always FAILs, regardless of fixture mode.
 *
 * @param {object|null} docMapping
 * @returns {object[]}
 */
function buildComputedAssertions(docMapping = null) {
  if (!docMapping?.computedValidations?.length) return [];
  return docMapping.computedValidations.map(cv => ({
    assertionType: 'computed',
    check:         cv.check,
    description:   cv.description,
    tolerance:     cv.tolerance ?? 0,
    paths:         cv.paths,
    ...(cv.skipByDefault && { skipByDefault: true }),
  }));
}

/**
 * Build a single completenessScore assertion from docMapping.completenessScoring.
 * Returns null when no completeness scoring is defined (non-payslip document types).
 *
 * The assertion carries the full scoring model (required/optional weights + thresholds)
 * so the runner can operate without re-loading the mapping.
 *
 * @param {object|null} docMapping
 * @returns {object|null}
 */
function buildCompletenessAssertion(docMapping = null) {
  const cs = docMapping?.completenessScoring;
  if (!cs) return null;

  // Sum points from either format:
  //   object: { fieldName: points, ... }
  //   array:  [{ field|fields, points }, ...]
  const sumPoints = fields => {
    if (Array.isArray(fields)) return fields.reduce((s, e) => s + (e.points ?? 0), 0);
    return Object.values(fields ?? {}).reduce((s, p) => s + p, 0);
  };
  const maxScore = sumPoints(cs.required ?? {}) + sumPoints(cs.optional ?? {});

  return {
    assertionType: 'completenessScore',
    description:   'Extraction completeness (weighted field scoring)',
    thresholds:    cs.thresholds ?? { pass: 90, warn: 70 },
    required:      cs.required ?? {},
    optional:      cs.optional ?? {},
    maxScore,
    ...(cs.docArrayPath != null && { docArrayPath: cs.docArrayPath }),
  };
}

/**
 * Build one POST /v1/documents/parse test case for a given fixture.
 * Payload: { file: "gs://...", fileType: "Payslip" }
 *
 * @param {object} fixture
 * @param {number} idx
 * @param {object[]} assertions - pre-built assertion list from buildAssertions()
 */
function buildParseCase(fixture, idx, assertions) {
  const tc = {
    id: `PARSE-${String(idx + 1).padStart(3, '0')}`,
    title: `Parse ${fixture.fileType} — ${fixture.notes || fixture.fixtureKey}`,
    type: 'parse',
    preconditions: 'Service is deployed',
    steps: `POST /v1/documents/parse with ${fixture.fileType} fixture`,
    expected_result: 'HTTP 200 with applicationId in response',
    method: 'POST',
    endpoint: '/v1/documents/parse',
    expected_status: 200,
    payload: {
      file: fixture.file,
      fileType: fixture.fileType,
    },
    assertions,
  };
  // Propagate requirement metadata from fixture selection
  if (fixture.matchedRequirement) tc.fixtureRequirement = fixture.matchedRequirement;
  if (fixture.lowConfidence)      tc.lowConfidence = true;
  if (fixture.lowConfidenceReason) tc.lowConfidenceReason = fixture.lowConfidenceReason;
  return tc;
}

/**
 * Build one POST /ai-gateway/batch-upload test case from a set of fixtures.
 *
 * A batch can contain 1 document or multiple related documents — the API creates
 * exactly 1 applicationId per batch-upload regardless of document count.
 * crossValidation only runs when 2+ eligible documents share the same account group.
 *
 * Payload shape:
 *   {
 *     payload: {
 *       publicUserId: "qa-test-user",
 *       submissionId: "qa-submission-BATCH-001",
 *       documents: [{ documentId, fileId, documentClassification, documentType, filename, preSignedUrl }]
 *     }
 *   }
 * run_qa.mjs injects `callbacks` at runtime — do not include it here.
 * expected_status: 200 — runBatchTestCase checks `status !== 200` (not 202).
 */
function buildBatchCase(fixtures, batchDocumentType) {
  const documents = fixtures.map((f, i) => {
    const idx = String(i + 1).padStart(3, '0');
    const filename = f.file.split('/').pop();
    return {
      documentId: `doc-${idx}`,
      fileId: `file-${idx}`,
      documentClassification: 'PRIMARY',
      documentType: batchDocumentType,
      filename,
      preSignedUrl: f.file,
    };
  });
  const docLabel = fixtures.length === 1 ? '1 document' : `${fixtures.length} documents`;
  return {
    id: 'BATCH-001',
    title: `Batch-upload ${batchDocumentType} (${docLabel})`,
    type: 'batch',
    preconditions: 'Service is deployed, webhook server is reachable',
    steps: `POST /ai-gateway/batch-upload with ${docLabel} (${batchDocumentType}), poll callbacks`,
    expected_result: 'HTTP 200, all callbacks received and schema-valid',
    method: 'POST',
    endpoint: '/ai-gateway/batch-upload',
    expected_status: 200,
    payload: {
      payload: {
        publicUserId: 'qa-test-user',
        submissionId: 'qa-submission-BATCH-001',
        documents,
      },
    },
    assertions: [
      { path: 'applicationId', pattern: '.+', description: 'applicationId is present' },
    ],
  };
}

// ── Requirement-based fixture selection ──────────────────────────────────────

/**
 * Score how well a fixture satisfies a requirement string.
 * Checks fixture.notes, filename, and fixtureKey in order of reliability.
 * Returns 0 if no requirement words appear in any field.
 */
function scoreFixtureMatch(fixture, requirement) {
  const words = requirement.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 2);
  const filename = (fixture.file || '').toLowerCase().split('/').pop().replace(/[._-]/g, ' ');
  const notes    = (fixture.notes || '').toLowerCase();
  const key      = (fixture.fixtureKey || '').toLowerCase().replace(/[._:-]/g, ' ');

  let score = 0;
  for (const word of words) {
    if (notes.includes(word))    score += 3; // notes are curator-written, most reliable
    if (key.includes(word))      score += 2;
    if (filename.includes(word)) score += 2;
  }
  return score;
}

/**
 * Match fixtures from the pool to scenario requirements, then fill remaining
 * slots with all unused pool fixtures.
 *
 * Requirements guide prioritisation — they do NOT cap coverage.
 * Every fixture in the pool is included unless maxFixtures is set.
 *
 * Pass:   priority fixtures (one per matched requirement) annotated with
 *         matchedRequirement so the reporter can surface scenario coverage.
 * Fill:   remaining fixtures appended in pool order (no annotation).
 * Cap:    if maxFixtures is set, stop once the limit is reached.
 *
 * Returns { selected: AnnotatedFixture[], matched: number, unmatched: string[] }
 *
 * @param {object[]} pool         — full fixture pool for the document type
 * @param {string[]} requirements — scenario strings from the planner
 * @param {number}   maxFixtures  — hard cap (default: Infinity = use all)
 */
function selectByRequirements(pool, requirements, maxFixtures = Infinity) {
  if (!requirements || requirements.length === 0) {
    return {
      selected: pool.slice(0, maxFixtures).map(f => ({ ...f, matchedRequirement: null, lowConfidence: false })),
      matched: 0,
      unmatched: [],
    };
  }

  const selected = [];
  const unmatched = [];
  const used = new Set();

  // ── Pass 1: requirement-priority fixtures ──────────────────────────────────
  for (const req of requirements) {
    if (selected.length >= maxFixtures) break;

    const candidates = pool
      .filter(f => !used.has(f.fixtureKey))
      .map(f => ({ fixture: f, score: scoreFixtureMatch(f, req) }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];

    if (best && best.score > 0) {
      used.add(best.fixture.fixtureKey);
      selected.push({ ...best.fixture, matchedRequirement: req, lowConfidence: false });
    } else {
      unmatched.push(req);
      // No exact match — use any unused fixture as a generic fallback
      const fallback = pool.find(f => !used.has(f.fixtureKey));
      if (fallback) {
        used.add(fallback.fixtureKey);
        selected.push({
          ...fallback,
          matchedRequirement: req,
          lowConfidence: true,
          lowConfidenceReason: `No fixture matched requirement: "${req}"`,
        });
      }
    }
  }

  const matched = selected.length;

  // ── Pass 2: fill remaining slots with all unused pool fixtures ─────────────
  for (const f of pool) {
    if (selected.length >= maxFixtures) break;
    if (!used.has(f.fixtureKey)) {
      used.add(f.fixtureKey);
      selected.push({ ...f, matchedRequirement: null, lowConfidence: false });
    }
  }

  return { selected, matched, unmatched };
}

/**
 * Select fixtures from a pool with class-diversity coverage.
 *
 * Strategy:
 *   1. Classify every fixture (complete / partial / complex).
 *   2. Reserve at least one slot for each available class.
 *   3. Fill remaining slots with all unused fixtures in manifest order.
 *   4. If maxFixtures is set, stop once the cap is reached.
 *
 * Returns { selected: AnnotatedFixture[], breakdown: { complete, partial, complex } }
 *
 * @param {object[]} pool       — fixture objects from resolveFixtures
 * @param {number}   maxFixtures — hard cap (default: Infinity = use all)
 */
function selectWithCoverage(pool, maxFixtures = Infinity) {
  if (pool.length === 0) return { selected: [], breakdown: { complete: 0, partial: 0, complex: 0 } };

  // Classify every fixture
  const classified = pool.map(f => ({ ...f, fixtureClass: classifyFixture(f) }));

  const groups = {
    complete: classified.filter(f => f.fixtureClass === 'complete'),
    partial:  classified.filter(f => f.fixtureClass === 'partial'),
    complex:  classified.filter(f => f.fixtureClass === 'complex'),
  };

  const selected = [];
  const usedKeys = new Set();

  // Pick one representative from each class first (coverage guarantee)
  const pickFirst = (candidates) => {
    if (selected.length >= maxFixtures) return;
    const available = candidates.find(f => !usedKeys.has(f.fixtureKey));
    if (!available) return;
    usedKeys.add(available.fixtureKey);
    selected.push(available);
  };

  pickFirst(groups.complete);
  pickFirst(groups.partial);
  pickFirst(groups.complex);

  // Fill remaining slots in manifest order (deterministic)
  for (const f of classified) {
    if (selected.length >= maxFixtures) break;
    if (!usedKeys.has(f.fixtureKey)) {
      usedKeys.add(f.fixtureKey);
      selected.push(f);
    }
  }

  const breakdown = {
    complete: selected.filter(f => f.fixtureClass === 'complete').length,
    partial:  selected.filter(f => f.fixtureClass === 'partial').length,
    complex:  selected.filter(f => f.fixtureClass === 'complex').length,
  };
  return { selected, breakdown };
}

// ── Generic fallbacks for full-regression with no known docType ───────────────
// These have no payload — the API will likely return 400, but this matches
// the pre-fixture-registry behavior and is preserved for compatibility.

const GENERIC_PARSE_CASE = {
  id: 'PARSE-001',
  title: 'Parse endpoint accepts valid document',
  type: 'parse',
  preconditions: 'Service is deployed',
  steps: 'POST /v1/documents/parse with a valid fixture PDF',
  expected_result: 'HTTP 200 with parsed document fields',
  method: 'POST',
  endpoint: '/v1/documents/parse',
  expected_status: 200,
  assertions: [
    { path: 'applicationId', pattern: '.+', description: 'applicationId is present' },
  ],
};

const GENERIC_BATCH_CASE = {
  id: 'BATCH-001',
  title: 'Batch-upload lifecycle',
  type: 'batch',
  preconditions: 'Service is deployed, webhook server is reachable',
  steps: 'POST /ai-gateway/batch-upload, poll callbacks until complete',
  expected_result: 'HTTP 200, callbacks received and schema-valid',
  method: 'POST',
  endpoint: '/ai-gateway/batch-upload',
  expected_status: 200,
  assertions: [
    { path: 'applicationId', pattern: '.+', description: 'applicationId is present' },
  ],
};

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the full test-cases.json content synchronously from already-resolved fixtures.
 *
 * @param {object} plan
 * @param {{ parse: ResolveResult, batch: ResolveResult }} resolved
 *   where ResolveResult = { fixtures, source, folderName }
 */
function buildTestCases(plan, resolved) {
  const { prNumber, testType } = plan;
  const docSuffix = plan.documentCategory
    ? ` [${plan.documentCategory.replace(/_/g, ' ')}]`
    : '';

  // ── auth-boundary ───────────────────────────────────────────────────────────
  if (testType === 'auth-boundary') {
    return {
      summary: `Auth boundary tests for PR #${prNumber}`,
      documentCategory: null,
      parseFileType: null,
      batchDocumentType: null,
      selectedTestReason: null,
      selectedFixtures: [],
      fixtureSource: null,
      selectedFolder: null,
      test_cases: [...AUTH_CASES],
    };
  }

  const { parse: parseResolved, batch: batchResolved } = resolved;

  // ── parse ───────────────────────────────────────────────────────────────────
  if (testType === 'parse') {
    const { fixtures, source, folderName } = parseResolved;
    const { mapping: docMapping } = resolveMapping(plan.documentCategory);
    // Per-fixture assertions: classify each fixture (complete/partial/complex) and
    // choose strict vs relaxed mode so partial fixtures don't hard-fail on absent fields.
    const computedAssertions    = buildComputedAssertions(docMapping);
    const completenessAssertion = buildCompletenessAssertion(docMapping);
    const annotatedFixtures = fixtures.map(f => {
      const fixtureClass = classifyFixture(f);
      const fixtureMode  = fixtureClass === 'partial' ? 'relaxed' : 'strict';
      const assertions   = [
        ...buildAssertions(plan.affectedFields, plan.validationFocus, plan.documentCategory, docMapping, fixtureMode),
        ...computedAssertions,
        ...(completenessAssertion ? [completenessAssertion] : []),
      ];
      return { ...f, fixtureClass, fixtureMode, assertions };
    });
    return {
      summary: `Parse ${plan.parseFileType} — PR #${prNumber}${docSuffix}`,
      documentCategory: plan.documentCategory ?? null,
      parseFileType: plan.parseFileType,
      batchDocumentType: plan.batchDocumentType ?? null,
      selectedTestReason: plan.selectedTestReason ?? null,
      validationFocus: plan.validationFocus ?? null,
      affectedFields: plan.affectedFields ?? [],
      fixtureRequirements: plan.fixtureRequirements ?? [],
      selectedFixtures: annotatedFixtures,
      fixtureSource: source,
      selectedFolder: folderName,
      // No HEALTH_CASES — run_qa.mjs already runs runBaselineHealthChecks() before every run
      test_cases: annotatedFixtures.map((f, i) => buildParseCase(f, i, f.assertions)),
    };
  }

  // ── batch-upload ────────────────────────────────────────────────────────────
  if (testType === 'batch-upload') {
    const batchDocType = resolveBatchDocType(plan);
    const { fixtures, source, folderName } = batchResolved;
    return {
      summary: `Batch-upload ${batchDocType} — PR #${prNumber}${docSuffix}`,
      documentCategory: plan.documentCategory ?? null,
      parseFileType: plan.parseFileType ?? null,
      batchDocumentType: batchDocType,
      selectedTestReason: plan.selectedTestReason ?? null,
      selectedFixtures: fixtures,
      fixtureSource: source,
      selectedFolder: folderName,
      test_cases: [
        ...HEALTH_CASES,
        buildBatchCase(fixtures, batchDocType),
      ],
    };
  }

  // ── full-regression ─────────────────────────────────────────────────────────
  const allFixtures = [];
  let parseCases, batchCases;
  let source = null;
  let folderName = null;

  if (parseResolved.fixtures.length > 0) {
    const { mapping: docMapping } = resolveMapping(plan.documentCategory);
    const computedAssertions    = buildComputedAssertions(docMapping);
    const completenessAssertion = buildCompletenessAssertion(docMapping);
    const annotated = parseResolved.fixtures.map(f => {
      const fixtureClass = classifyFixture(f);
      const fixtureMode  = fixtureClass === 'partial' ? 'relaxed' : 'strict';
      const assertions   = [
        ...buildAssertions(plan.affectedFields, plan.validationFocus, plan.documentCategory, docMapping, fixtureMode),
        ...computedAssertions,
        ...(completenessAssertion ? [completenessAssertion] : []),
      ];
      return { ...f, fixtureClass, fixtureMode, assertions };
    });
    allFixtures.push(...annotated);
    parseCases = annotated.map((f, i) => buildParseCase(f, i, f.assertions));
    source = parseResolved.source;
    folderName = parseResolved.folderName;
  } else {
    parseCases = [GENERIC_PARSE_CASE];
  }

  const batchDocType = resolveBatchDocType(plan);
  if (batchResolved.fixtures.length > 0) {
    // Avoid duplicating a fixture key already selected for parse
    const fresh = batchResolved.fixtures.filter(
      f => !allFixtures.some(s => s.fixtureKey === f.fixtureKey),
    );
    allFixtures.push(...fresh);
    batchCases = [buildBatchCase(batchResolved.fixtures, batchDocType)];
  } else {
    batchCases = [GENERIC_BATCH_CASE];
  }

  return {
    summary: `Full regression — PR #${prNumber}${docSuffix}`,
    documentCategory: plan.documentCategory ?? null,
    parseFileType: plan.parseFileType ?? null,
    batchDocumentType: batchDocType ?? null,
    selectedTestReason: plan.selectedTestReason ?? null,
    validationFocus: plan.validationFocus ?? null,
    affectedFields: plan.affectedFields ?? [],
    selectedFixtures: allFixtures,
    fixtureSource: source,
    selectedFolder: folderName,
    test_cases: [
      ...HEALTH_CASES,
      ...parseCases,
      ...batchCases,
    ],
  };
}

// ── generate() ────────────────────────────────────────────────────────────────

export async function generate(planFile) {
  const pendingPath = join(ROOT, 'tasks', 'pending', planFile);
  const runningPath = join(ROOT, 'tasks', 'running', planFile);

  // ── Retry-safe plan loading ───────────────────────────────────────────────
  // First attempt:  plan is in pending  → move to running (normal path).
  // Retry attempt:  plan already in running (prior attempt moved it) → reuse.
  // Missing both:   plan completed or deleted → fail clearly.
  //
  // This prevents "Plan not found" errors when the pipeline retries the
  // generator after a transient failure mid-run.
  if (existsSync(pendingPath)) {
    renameSync(pendingPath, runningPath);
  } else if (existsSync(runningPath)) {
    console.log(`[generator] Retrying — plan already in running: ${planFile}`);
  } else {
    throw new Error(
      `Plan not found in pending or running: ${planFile}. ` +
      'It may have already completed or been manually removed.',
    );
  }

  const plan = JSON.parse(readFileSync(runningPath, 'utf8'));
  plan.status = 'running';
  writeFileSync(runningPath, JSON.stringify(plan, null, 2));

  const testType = plan.testType || 'full-regression';

  console.log(`[generator] Processing plan ${plan.id} (testType: ${testType})`);
  console.log(`  PR #${plan.prNumber} → ${plan.previewUrl}`);
  if (plan.parseFileType)     console.log(`  parseFileType:     ${plan.parseFileType}`);
  if (plan.batchDocumentType) console.log(`  batchDocumentType: ${plan.batchDocumentType}`);
  if (plan.documentCategory)  console.log(`  documentCategory:  ${plan.documentCategory}`);

  // Auth-boundary: auth.spec.js is self-contained — no test-cases.json needed
  if (testType === 'auth-boundary') {
    console.log('[generator] auth-boundary — skipping test-cases.json (auth.spec.js handles its own cases)');
    plan.testCasesFile = null;
    plan.selectedFixtures = [];
    writeFileSync(runningPath, JSON.stringify(plan, null, 2));
    return { planFile, testCasesFile: null, count: 0 };
  }

  // ── Decide whether to reuse an existing test-cases.json ─────────────────────
  //
  // Rules:
  //   parse        → always regenerate (fixture-backed cases required)
  //   batch-upload → always regenerate (fixture-backed cases required)
  //   auth-boundary→ no test-cases.json (handled above)
  //   full-regression → reuse if no document override is set AND --reuse-test-cases not false
  //
  // Override: --reuse-test-cases=true / REUSE_TEST_CASES=true forces reuse for any mode.
  const testCasesPath = join(ROOT, 'test-cases.json');
  const reuseExplicit = plan.reuseTestCases || process.env.REUSE_TEST_CASES === 'true';
  const hasDocOverride = !!(plan.documentCategory || plan.parseFileType || plan.batchDocumentType);

  const shouldReuse = existsSync(testCasesPath) && (
    reuseExplicit ||
    (testType === 'full-regression' && !hasDocOverride)
  );

  if (shouldReuse) {
    const existing = JSON.parse(readFileSync(testCasesPath, 'utf8'));
    const count = existing.test_cases?.length ?? 0;
    console.log(`[generator] Reusing existing test-cases.json (${count} test cases)`);
    plan.testCasesFile = 'test-cases.json';
    writeFileSync(runningPath, JSON.stringify(plan, null, 2));
    return { planFile, testCasesFile: 'test-cases.json', count };
  }

  if (existsSync(testCasesPath)) {
    console.log(
      `[generator] Regenerating test-cases.json for ${testType}` +
      (plan.parseFileType ? ` using ${plan.parseFileType} fixtures` : ''),
    );
  }

  // ── Fixture source policy ─────────────────────────────────────────────────
  // GCS is always the primary source. Registry fallback is disabled by default
  // to prevent silent testing against stale or wrong datasets.
  // Enable with: --allow-registry-fallback=true or ALLOW_REGISTRY_FALLBACK=true
  const allowRegistryFallback =
    plan.allowRegistryFallback === true ||
    process.env.ALLOW_REGISTRY_FALLBACK === 'true';

  const fixtureOpts = { allowRegistryFallback };

  // ── Async fixture resolution ───────────────────────────────────────────────
  const empty = { fixtures: [], source: null, folderName: null };
  let parseResolved = empty;
  let batchResolved = empty;

  if (testType !== 'auth-boundary') {
    const batchDocType = resolveBatchDocType(plan);
    const batchParseType = plan.parseFileType ?? resolveParseFileTypeFromBatch(batchDocType ?? '');

    if (plan.parseFileType) {
      const requirements = plan.fixtureRequirements ?? [];

      if (requirements.length > 0) {
        // Planner-defined scenario requirements — fetch full pool then match by scenario.
        // Requirements guide prioritization only; remaining pool fixtures are included after.
        const pool = await resolveFixtures(plan.parseFileType, Infinity, fixtureOpts);
        const maxFixtures = plan.maxFixtures ?? Infinity;
        const { selected, matched, unmatched } = selectByRequirements(pool.fixtures, requirements, maxFixtures);
        console.log(`  [generator] Requirements matched ${matched} fixture(s); total selected ${selected.length}/${pool.fixtures.length}`);
        for (const req of unmatched) {
          console.warn(`  [generator] Warning: No fixture satisfies requirement: "${req}" — using generic fallback`);
        }
        parseResolved = { fixtures: selected, source: pool.source, folderName: pool.folderName };
      } else {
        // No planner requirements — coverage-based selection from the full manifest pool.
        // Default: use ALL available fixtures (maxFixtures=Infinity).
        // Override: --max-fixtures=N or plan.maxFixtures=N to cap.
        const maxFixtures = plan.maxFixtures ?? Infinity;
        const pool = await resolveFixtures(plan.parseFileType, Infinity, fixtureOpts);
        const { selected, breakdown } = selectWithCoverage(pool.fixtures, maxFixtures);

        console.log(`  [generator] Selected fixtures (coverage strategy):`);
        console.log(`    complete: ${breakdown.complete}`);
        console.log(`    partial:  ${breakdown.partial}`);
        console.log(`    complex:  ${breakdown.complex}`);
        if (maxFixtures !== Infinity) console.log(`    (capped at --max-fixtures=${maxFixtures})`);

        parseResolved = { fixtures: selected, source: pool.source, folderName: pool.folderName };
      }

      console.log(`  [generator] parse fixtures: ${parseResolved.fixtures.length} from ${parseResolved.source ?? 'none'}`);
    }

    if (batchDocType && (testType === 'batch-upload' || testType === 'full-regression')) {
      // Batch runs: default 2 fixtures per run (callback polling makes large batches slow).
      // A batch can validly contain 1 document — crossValidation is conditional on 2+ docs.
      // Override with plan.maxFixtures (can be 1 for single-doc batch tests).
      const batchDefault = 2;
      const max = plan.maxFixtures ?? batchDefault;
      batchResolved = await resolveFixtures(batchParseType ?? '', max, fixtureOpts);
      console.log(`  [generator] batch fixtures: ${batchResolved.fixtures.length} from ${batchResolved.source ?? 'none'}`);
    }
  }

  // ── Hard-fail checks ───────────────────────────────────────────────────────
  if (testType === 'parse') {
    if (!plan.parseFileType) {
      throw new Error(
        'Generator: testType=parse requires plan.parseFileType. ' +
        'Use --document-category=<category>, --file-type=<parseFileType>, ' +
        'or ensure the ClickUp task text matches a known document type.',
      );
    }
    if (parseResolved.fixtures.length === 0) {
      const tip = allowRegistryFallback
        ? 'Both GCS and fixture-registry.json returned no results.'
        : 'Use --allow-registry-fallback=true to fall back to fixture-registry.json.';
      throw new Error(
        `No GCS fixtures found for parseFileType: ${plan.parseFileType}. ` +
        `Bucket: gs://test-ai-docs-data-dev/qa-test-data/. ${tip}`,
      );
    }
  }

  if (testType === 'batch-upload') {
    const batchDocType = resolveBatchDocType(plan);
    if (!batchDocType) {
      throw new Error(
        'Generator: testType=batch-upload requires plan.batchDocumentType ' +
        '(or a plan.parseFileType that maps via gatewayDocumentTypeMap). ' +
        'Use --batch-document-type=<type> or --document-category=<category>.',
      );
    }
    if (batchResolved.fixtures.length === 0) {
      const batchParseType = plan.parseFileType ?? resolveParseFileTypeFromBatch(batchDocType);
      const tip = allowRegistryFallback
        ? 'Both GCS and fixture-registry.json returned no results.'
        : 'Use --allow-registry-fallback=true to fall back to fixture-registry.json.';
      throw new Error(
        `No GCS fixtures found for batchDocumentType: ${batchDocType} ` +
        `(parseFileType: ${batchParseType ?? 'unknown'}). ` +
        `Bucket: gs://test-ai-docs-data-dev/qa-test-data/. ${tip}`,
      );
    }
  }

  // ── Build and write test cases ──────────────────────────────────────────────
  const testCases = buildTestCases(plan, { parse: parseResolved, batch: batchResolved });

  writeFileSync(testCasesPath, JSON.stringify(testCases, null, 2));

  // Write fixture metadata back to plan so reporter can surface them
  plan.testCasesFile = 'test-cases.json';
  plan.selectedFixtures = testCases.selectedFixtures;
  plan.fixtureSource    = testCases.fixtureSource;
  plan.selectedFolder   = testCases.selectedFolder;
  writeFileSync(runningPath, JSON.stringify(plan, null, 2));

  const count = testCases.test_cases.length;
  console.log(`[generator] Generated ${count} test cases`);
  if (testCases.selectedFixtures.length) {
    console.log(`  Fixtures selected (${testCases.selectedFixtures.length}):`);
    for (const f of testCases.selectedFixtures) {
      console.log(`    ${f.fixtureKey} — ${f.file}`);
    }
  }

  return { planFile, testCasesFile: 'test-cases.json', count };
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes('generator')) {
  const planFile = process.argv[2];
  if (!planFile) {
    console.error('Usage: node agents/generator/index.mjs <plan-file.json>');
    process.exit(1);
  }
  generate(planFile).catch(err => {
    console.error(`[generator] Fatal: ${err.message}`);
    process.exit(1);
  });
}
