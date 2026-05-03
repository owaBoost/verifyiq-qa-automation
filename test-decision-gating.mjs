#!/usr/bin/env node
/**
 * Unit tests for bank statement decision-threshold gating and cross-validation scoping.
 *
 * Scenarios:
 *   1. FULL_VALIDATION   — all scores above thresholds
 *   2. DOC_LEVEL_ONLY    — completeness or authenticity below threshold
 *   3. ABORTED_LOW_QUALITY — quality score below threshold
 *
 * Cross-validation eligibility:
 *   - A batch-upload can contain 1 or many docs — 1 applicationId per batch
 *   - Single-doc batch: run doc + app callback validation only, no crossValidation
 *   - Requires 2+ BankStatement docs in the same account group (accountNumber > accountHolderName > bankName)
 *   - Score gating blocks: no cross-validation emitted (silent skip)
 *   - Only PASS/FAIL for required, WARNING for optional mismatches, SKIPPED_OPTIONAL for missing optional
 *
 * Run: node --test test-decision-gating.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBankStatementDocCallback,
  validateApplicationCallback,
  crossValidateBankStatementTotals,
  groupBankStatementsByAccount,
  parseNumericAmount,
} from './run_qa.mjs';

// ── Fixture builders ────────────────────────────────────────────────────────

/** Minimal valid BankStatement document callback. Scores are injected per-test. */
function buildDocCallback({ qualityScore, completenessScore, authenticityScore, transactions, calculatedDebits, calculatedCredits, summaryDebits, summaryCredits, documentId, accountNumber, accountHolderName, bankName } = {}) {
  const txs = transactions ?? [
    { postingDate: '2026-01-15', transactionDescription: 'Deposit', creditAmount: '5000.00', debitAmount: null },
    { postingDate: '2026-01-16', transactionDescription: 'Withdrawal', debitAmount: '1500.00', creditAmount: null },
  ];
  return {
    applicationId: 'app-test-001',
    submissionId: 'sub-test-001',
    documentId: documentId ?? 'doc-test-001',
    publicUserId: 'user-test-001',
    status: 'COMPLETED',
    documentType: 'BANK_STATEMENT',
    documentClassification: 'Bank Statement',
    authenticityScore: authenticityScore ?? 85,
    ocrResult: {
      documentData: {
        // Use !== undefined so callers can pass null to simulate a missing field
        calculated_debits:  calculatedDebits  !== undefined ? calculatedDebits  : '1500.00',
        calculated_credits: calculatedCredits !== undefined ? calculatedCredits : '5000.00',
        summary_debits:     summaryDebits,
        summary_credits:    summaryCredits,
        summary: [{ accountNumber: accountNumber ?? null, accountHolderName: accountHolderName ?? null, bankName: bankName ?? null }],
        transactions: txs,
      },
      transactions: txs,
      fraudChecks: {
        gs_isFraudulent_bankstatement: false,
        gs_overallFraudScore_bankstatement: 12,
        gs_fraudCheckStatus_bankstatement: 'COMPLETED',
      },
      qualityCheck: {
        overall_score: qualityScore ?? 90,
        resolution: 'HIGH',
      },
      completenessCheck: {
        completeness_score: completenessScore ?? 95,
        missing_fields: [],
      },
    },
  };
}

/** Minimal application callback with matching totals. */
function buildAppCallback({ totalDebit, totalCredit, documents, crossCheckFindings } = {}) {
  return {
    applicationId: 'app-test-001',
    submissionId: 'sub-test-001',
    publicUserId: 'user-test-001',
    status: 'COMPLETED',
    ocrResult: {
      documents: documents ?? [{ documentType: 'BANK_STATEMENT' }],
      computedFields: {
        BANK_STATEMENT: {
          available: true,
          gs_180days_valid_bankstatement: true,
          gs_90days_consec_bankstatement: true,
          gs_totaldebit_bankstatement:  totalDebit  ?? 1500.00,
          gs_totalcredit_bankstatement: totalCredit ?? 5000.00,
          gs_inferredincome_bankstatement: 3500.00,
        },
        crossCheckFindings: crossCheckFindings ?? [],
      },
    },
  };
}

/** Build a realistic crossCheckFindings array. */
function buildCrossCheckFindings(overrides = []) {
  const defaults = [
    {
      field: 'name',
      valuePrimary: ['MARIA SANTOS GARCIA', 'MARIA SANTOS GARCIA'],
      valueSecondary: ['MARIA SANTOS GARCIA'],
      match: true,
      riskLevel: 'low',
      description: 'All name values match across primary and secondary documents',
    },
    {
      field: 'address',
      valuePrimary: ['111 DON CARLOS PALANCA SAN LORENZO, MAKATI CITY 1229'],
      valueSecondary: ['111 DON CARLOS PALANCA SAN LORENZO MAKATI 1229 MANILA'],
      match: false,
      riskLevel: 'medium',
      description: 'Secondary document contains a different address',
    },
  ];
  if (overrides.length > 0) return overrides;
  return defaults;
}

/** Documents array for a multi-doc batch with mixed classifications. */
const MULTI_DOC_MIXED = [
  { documentType: 'BANK_STATEMENT', documentClassification: 'PRIMARY' },
  { documentType: 'PAYSLIP', documentClassification: 'PRIMARY' },
  { documentType: 'ELECTRICITY_BILL', documentClassification: 'SUPPORTING' },
];

/** Documents array for a multi-doc batch with 2+ PRIMARY of different types. */
const MULTI_DOC_PRIMARY_ONLY = [
  { documentType: 'BANK_STATEMENT', documentClassification: 'PRIMARY' },
  { documentType: 'PAYSLIP', documentClassification: 'PRIMARY' },
];

/** Build a bankStatementDocTotals entry from a doc callback result. */
function buildDocTotals(docCallback, scoreGating) {
  const ocr = docCallback.ocrResult ?? {};
  const docData = ocr.documentData;
  const summaryArr = Array.isArray(docData?.summary) ? docData.summary : [];
  const firstSummary = summaryArr[0] ?? {};
  return {
    docId: docCallback.documentId,
    calcDebitsRaw:    docData?.calculated_debits,
    calcCreditsRaw:   docData?.calculated_credits,
    calculatedDebits:  parseNumericAmount(docData?.calculated_debits  ?? ''),
    calculatedCredits: parseNumericAmount(docData?.calculated_credits ?? ''),
    summDebitsRaw:    docData?.summary_debits,
    summCreditsRaw:   docData?.summary_credits,
    summaryDebits:    parseNumericAmount(docData?.summary_debits  ?? ''),
    summaryCredits:   parseNumericAmount(docData?.summary_credits ?? ''),
    scoreGating,
    accountNumber:      firstSummary.accountNumber     ?? null,
    accountHolderName:  firstSummary.accountHolderName ?? null,
    bankName:           firstSummary.bankName          ?? null,
  };
}

/** Fresh app report object matching the shape used in runBatchTestCase. */
function freshAppReport() {
  return {
    index: 1,
    type: 'application',
    documentId: null,
    applicationId: 'app-test-001',
    decryptOk: true,
    deliveryStatus: 'PASS',
    checks: {
      schemaValidation:    { passed: true, errors: [] },
      structureValidation: { passed: true, errors: [] },
      keyFieldsMatched:    { passed: true, errors: [] },
      contentValidation:   { passed: true, errors: [] },
    },
    mismatchDetails: [],
  };
}

/** Build two doc totals entries (the minimum for cross-validation). */
function buildTwoDocTotals(overrides = {}) {
  const doc1 = buildDocCallback({ documentId: 'doc-001', calculatedDebits: '1000.00', calculatedCredits: '3000.00', ...overrides });
  const doc2 = buildDocCallback({ documentId: 'doc-002', calculatedDebits: '500.00',  calculatedCredits: '2000.00', ...overrides });
  const r1 = validateBankStatementDocCallback(doc1);
  const r2 = validateBankStatementDocCallback(doc2);
  return [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('validateBankStatementDocCallback — scoreGating decision', () => {

  it('FULL_VALIDATION when all scores above thresholds', () => {
    const cb = buildDocCallback({ qualityScore: 90, completenessScore: 95, authenticityScore: 85 });
    const result = validateBankStatementDocCallback(cb);

    assert.ok(result.scoreGating, 'scoreGating must be present');
    assert.equal(result.scoreGating.decision, 'FULL_VALIDATION');
    assert.equal(result.scoreGating.qualityScore, 90);
    assert.equal(result.scoreGating.completenessScore, 95);
    assert.equal(result.scoreGating.authenticityScore, 85);
    assert.ok(result.passed, 'should pass with good scores');
  });

  it('FULL_VALIDATION at exact threshold boundaries', () => {
    const cb = buildDocCallback({ qualityScore: 60, completenessScore: 80, authenticityScore: 70 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'FULL_VALIDATION');
    assert.ok(result.passed);
  });

  it('DOC_LEVEL_ONLY when completeness below 80', () => {
    const cb = buildDocCallback({ qualityScore: 75, completenessScore: 65, authenticityScore: 85 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'DOC_LEVEL_ONLY');
    assert.equal(result.scoreGating.completenessScore, 65);
    assert.ok(result.checks.contentValidation, 'contentValidation checks must still exist');
  });

  it('DOC_LEVEL_ONLY when authenticity below 70', () => {
    const cb = buildDocCallback({ qualityScore: 80, completenessScore: 90, authenticityScore: 50 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'DOC_LEVEL_ONLY');
    assert.equal(result.scoreGating.authenticityScore, 50);
  });

  it('DOC_LEVEL_ONLY when both completeness and authenticity below threshold', () => {
    const cb = buildDocCallback({ qualityScore: 65, completenessScore: 70, authenticityScore: 60 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'DOC_LEVEL_ONLY');
  });

  it('ABORTED_LOW_QUALITY when quality below 60', () => {
    const cb = buildDocCallback({ qualityScore: 40, completenessScore: 95, authenticityScore: 85 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'ABORTED_LOW_QUALITY');
    assert.equal(result.scoreGating.qualityScore, 40);
    assert.ok(result.passed, 'ABORTED_LOW_QUALITY should not mark the callback as failed');
    assert.ok(
      result.checks.contentValidation.errors.some(e => e.startsWith('ABORTED_LOW_QUALITY')),
      'contentValidation.errors must include the abort reason'
    );
  });

  it('ABORTED_LOW_QUALITY takes precedence over low completeness/authenticity', () => {
    const cb = buildDocCallback({ qualityScore: 30, completenessScore: 50, authenticityScore: 40 });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'ABORTED_LOW_QUALITY');
  });

  it('ABORTED_LOW_QUALITY skips transaction and arithmetic checks', () => {
    const cb = buildDocCallback({ qualityScore: 20, transactions: [] });
    const result = validateBankStatementDocCallback(cb);

    assert.equal(result.scoreGating.decision, 'ABORTED_LOW_QUALITY');
    assert.ok(result.passed, 'should pass — abort skips content checks');
    const txValidationErrors = result.allErrors.filter(e =>
      e.includes('transactions array') || e.includes('missing postingDate') || e.includes('calculated_debits')
    );
    assert.equal(txValidationErrors.length, 0, 'no transaction/arithmetic errors when quality aborted');
  });
});

describe('crossValidateBankStatementTotals — eligibility and scoping', () => {

  it('single BankStatement doc: no crossValidation emitted', () => {
    const docCb = buildDocCallback({ calculatedDebits: '1500.00', calculatedCredits: '5000.00' });
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const docResult = validateBankStatementDocCallback(docCb);
    const docTotals = [buildDocTotals(docCb, docResult.scoreGating)];
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation, undefined, 'crossValidation must NOT be emitted for single doc');
    assert.equal(errors.length, 0, 'no errors for single doc');
  });

  it('2 BankStatement docs: PASS when sum matches app totals', () => {
    // doc-001: debits=1000, credits=3000; doc-002: debits=500, credits=2000
    // sum: debits=1500, credits=5000
    const docTotals = buildTwoDocTotals();
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.ok(appReport.crossValidation, 'crossValidation must be present for 2+ docs');
    assert.equal(appReport.crossValidation.debits.status,  'PASS');
    assert.equal(appReport.crossValidation.credits.status, 'PASS');
    assert.equal(errors.length, 0);
  });

  it('2 BankStatement docs: FAIL when sum mismatches app totals', () => {
    const docTotals = buildTwoDocTotals();
    // sum is 1500 debits, app says 9999
    const appCb = buildAppCallback({ totalDebit: 9999.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation.debits.status,  'FAIL');
    assert.equal(appReport.crossValidation.credits.status, 'PASS');
    assert.ok(errors.length > 0, 'should have errors for debit mismatch');
  });

  it('2 BankStatement docs: summary fields SKIPPED_OPTIONAL when missing', () => {
    const docTotals = buildTwoDocTotals({ summaryDebits: undefined, summaryCredits: undefined });
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation.summary_debits.status,  'SKIPPED_OPTIONAL');
    assert.equal(appReport.crossValidation.summary_credits.status, 'SKIPPED_OPTIONAL');
    assert.equal(errors.length, 0, 'optional skips should not produce errors');
  });

  it('2 BankStatement docs: summary mismatch is WARNING, not FAIL', () => {
    const docTotals = buildTwoDocTotals({ summaryDebits: '9999.00', summaryCredits: '9999.00' });
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation.summary_debits.status,  'WARNING');
    assert.equal(appReport.crossValidation.summary_credits.status, 'WARNING');
    assert.equal(errors.length, 0, 'summary warnings must not produce allErrors');
  });

  it('2 BankStatement docs: FAIL when one doc has missing calculated_debits', () => {
    // doc-001 has valid debits; doc-002 has null (missing) → every() fails → FAIL
    const doc1 = buildDocCallback({ documentId: 'doc-001', calculatedDebits: '1000.00', calculatedCredits: '3000.00' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', calculatedDebits: null, calculatedCredits: '2000.00' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.ok(appReport.crossValidation, 'crossValidation must be present (2 docs)');
    assert.equal(appReport.crossValidation.debits.status, 'FAIL', 'FAIL when any doc missing calculated_debits');
    assert.ok(
      appReport.crossValidation.debits.detail.includes('doc-002'),
      'FAIL detail must identify the offending doc'
    );
    assert.ok(errors.length > 0, 'must push to allErrors');
  });

  it('2 BankStatement docs: FAIL when one doc has missing calculated_credits', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', calculatedDebits: '1000.00', calculatedCredits: '3000.00' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', calculatedDebits: '500.00',  calculatedCredits: null });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation.credits.status, 'FAIL', 'FAIL when any doc missing calculated_credits');
    assert.ok(
      appReport.crossValidation.credits.detail.includes('doc-002'),
      'FAIL detail must identify the offending doc'
    );
  });

  it('score gating ABORTED_LOW_QUALITY: crossValidation not emitted', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', qualityScore: 90 });
    const doc2 = buildDocCallback({ documentId: 'doc-002', qualityScore: 30 });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];
    const appCb = buildAppCallback();
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation, undefined, 'crossValidation must NOT be emitted when gated');
    assert.equal(errors.length, 0, 'score gating must not produce allErrors');
  });

  it('score gating DOC_LEVEL_ONLY: crossValidation not emitted', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', qualityScore: 80, completenessScore: 60 });
    const doc2 = buildDocCallback({ documentId: 'doc-002', qualityScore: 80, completenessScore: 90 });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];
    const appCb = buildAppCallback();
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.equal(appReport.crossValidation, undefined, 'crossValidation must NOT be emitted when gated');
    assert.equal(errors.length, 0);
  });

  it('3 BankStatement docs all FULL_VALIDATION: cross-validation runs', () => {
    // 3 docs: debits 1000+500+200=1700, credits 3000+2000+1000=6000
    const doc1 = buildDocCallback({ documentId: 'doc-001', calculatedDebits: '1000.00', calculatedCredits: '3000.00' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', calculatedDebits: '500.00',  calculatedCredits: '2000.00' });
    const doc3 = buildDocCallback({ documentId: 'doc-003', calculatedDebits: '200.00',  calculatedCredits: '1000.00' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const r3 = validateBankStatementDocCallback(doc3);
    const docTotals = [
      buildDocTotals(doc1, r1.scoreGating),
      buildDocTotals(doc2, r2.scoreGating),
      buildDocTotals(doc3, r3.scoreGating),
    ];
    const appCb = buildAppCallback({ totalDebit: 1700.00, totalCredit: 6000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    assert.ok(appReport.crossValidation, 'crossValidation must be present for 3 docs');
    assert.equal(appReport.crossValidation.debits.status,  'PASS');
    assert.equal(appReport.crossValidation.credits.status, 'PASS');
    assert.equal(errors.length, 0);
  });
});

describe('deliveryStatus separation from content validation', () => {

  it('deliveryStatus is independent of content validation pass/fail', () => {
    const appReport = freshAppReport();
    assert.equal(appReport.deliveryStatus, 'PASS');
    appReport.checks.contentValidation.passed = false;
    appReport.checks.contentValidation.errors.push('some content error');
    assert.equal(appReport.deliveryStatus, 'PASS',
      'delivery PASS must be independent of content FAIL');
  });

  it('cb-report-json shape includes both deliveryStatus and checks', () => {
    const appReport = freshAppReport();
    const c = appReport.checks;
    const jsonPayload = {
      index: appReport.index,
      type: appReport.type,
      documentId: appReport.documentId,
      applicationId: appReport.applicationId,
      deliveryStatus: appReport.deliveryStatus,
      decryptOk: appReport.decryptOk,
      checks: {
        schemaValidation:    { passed: c.schemaValidation.passed,    errors: c.schemaValidation.errors },
        structureValidation: { passed: c.structureValidation.passed, errors: c.structureValidation.errors },
        keyFieldsMatched:    { passed: c.keyFieldsMatched.passed,    errors: c.keyFieldsMatched.errors },
        contentValidation:   { passed: c.contentValidation.passed,   errors: c.contentValidation.errors },
      },
      mismatchDetails: appReport.mismatchDetails,
    };

    assert.ok('deliveryStatus' in jsonPayload, 'deliveryStatus must be a top-level field');
    assert.ok('checks' in jsonPayload, 'checks must be a top-level field');
    assert.equal(jsonPayload.deliveryStatus, 'PASS');
    assert.ok(jsonPayload.checks.contentValidation.passed);
  });

  it('scoreGating appears in cb-report-json for doc callbacks', () => {
    const docCb = buildDocCallback({ qualityScore: 90, completenessScore: 95, authenticityScore: 85 });
    const result = validateBankStatementDocCallback(docCb);

    const jsonPayload = {
      index: 0,
      type: 'document',
      documentId: docCb.documentId,
      deliveryStatus: 'PASS',
      decryptOk: true,
      checks: result.checks,
      mismatchDetails: result.allErrors,
    };
    if (result.scoreGating) jsonPayload.scoreGating = result.scoreGating;

    assert.ok('scoreGating' in jsonPayload, 'scoreGating must be present for doc callbacks');
    assert.equal(jsonPayload.scoreGating.decision, 'FULL_VALIDATION');
  });

  it('crossValidation present on app report only when validation runs (2+ docs)', () => {
    const docTotals = buildTwoDocTotals();
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    const jsonPayload = {
      index: appReport.index,
      type: appReport.type,
      deliveryStatus: appReport.deliveryStatus,
      decryptOk: appReport.decryptOk,
      checks: appReport.checks,
      mismatchDetails: appReport.mismatchDetails,
    };
    if (appReport.crossValidation) jsonPayload.crossValidation = appReport.crossValidation;

    assert.ok('crossValidation' in jsonPayload, 'crossValidation must be present with 2+ docs');
    assert.ok('debits' in jsonPayload.crossValidation);
    assert.ok('credits' in jsonPayload.crossValidation);
  });

  it('crossValidation omitted from app report when single doc', () => {
    const docCb = buildDocCallback();
    const appCb = buildAppCallback();
    const docResult = validateBankStatementDocCallback(docCb);
    const docTotals = [buildDocTotals(docCb, docResult.scoreGating)];
    const appReport = freshAppReport();
    const errors = [];

    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    const jsonPayload = {
      index: appReport.index,
      type: appReport.type,
      checks: appReport.checks,
      mismatchDetails: appReport.mismatchDetails,
    };
    if (appReport.crossValidation) jsonPayload.crossValidation = appReport.crossValidation;

    assert.ok(!('crossValidation' in jsonPayload), 'crossValidation must NOT appear for single doc');
  });
});

describe('groupBankStatementsByAccount — account-level grouping', () => {

  it('groups docs with same accountNumber together', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', accountNumber: '1234567890' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', accountNumber: '1234567890' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 1, 'same accountNumber → single group');
    const key = [...groups.keys()][0];
    assert.ok(key.startsWith('acct:'), 'group key must use acct: prefix');
    assert.equal(groups.get(key).length, 2);
  });

  it('separates docs with different accountNumbers into distinct groups', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', accountNumber: '1111111111' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', accountNumber: '2222222222' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 2, 'different accountNumbers → two groups');
    for (const [, docs] of groups) {
      assert.equal(docs.length, 1, 'each group has 1 doc — neither is cross-validation eligible');
    }
  });

  it('falls back to accountHolderName when accountNumber is absent', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', accountHolderName: 'John Doe' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', accountHolderName: 'John Doe' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 1);
    const key = [...groups.keys()][0];
    assert.ok(key.startsWith('holder:'), 'group key must use holder: prefix');
  });

  it('falls back to bankName when accountNumber and accountHolderName are absent', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', bankName: 'Chase Bank' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', bankName: 'Chase Bank' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 1);
    const key = [...groups.keys()][0];
    assert.ok(key.startsWith('bank:'), 'group key must use bank: prefix');
  });

  it('docs with no identity fields go to __unknown__ group', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001' });
    const doc2 = buildDocCallback({ documentId: 'doc-002' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 1);
    assert.ok(groups.has('__unknown__'));
  });

  it('mixed: 2 same-account + 1 different-account → only same-account group eligible', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', accountNumber: 'AAAA', calculatedDebits: '1000.00', calculatedCredits: '3000.00' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', accountNumber: 'AAAA', calculatedDebits: '500.00',  calculatedCredits: '2000.00' });
    const doc3 = buildDocCallback({ documentId: 'doc-003', accountNumber: 'BBBB', calculatedDebits: '200.00',  calculatedCredits: '1000.00' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const r3 = validateBankStatementDocCallback(doc3);
    const docTotals = [
      buildDocTotals(doc1, r1.scoreGating),
      buildDocTotals(doc2, r2.scoreGating),
      buildDocTotals(doc3, r3.scoreGating),
    ];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 2, 'two distinct account groups');
    const aaaa = groups.get('acct:AAAA');
    const bbbb = groups.get('acct:BBBB');
    assert.equal(aaaa.length, 2, 'AAAA group has 2 docs — eligible for cross-validation');
    assert.equal(bbbb.length, 1, 'BBBB group has 1 doc — not eligible');

    // Cross-validate only AAAA group
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });
    const appReport = freshAppReport();
    const errors = [];
    crossValidateBankStatementTotals(aaaa, appCb, appReport, errors);

    assert.ok(appReport.crossValidation, 'crossValidation must run for AAAA group');
    assert.equal(appReport.crossValidation.debits.status, 'PASS');
    assert.equal(appReport.crossValidation.credits.status, 'PASS');
  });

  it('accountNumber takes precedence over accountHolderName', () => {
    const doc1 = buildDocCallback({ documentId: 'doc-001', accountNumber: '111', accountHolderName: 'Same Name' });
    const doc2 = buildDocCallback({ documentId: 'doc-002', accountNumber: '222', accountHolderName: 'Same Name' });
    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    const groups = groupBankStatementsByAccount(docTotals);

    assert.equal(groups.size, 2, 'different accountNumbers → separate groups despite same holder name');
  });
});

describe('batch-upload business rule — crossValidation conditionality', () => {

  it('1-document batch: doc + app callbacks pass, no crossValidation emitted', () => {
    // Simulates a single-document batch-upload: 1 doc callback + 1 app callback.
    // The corrected rule says: single-doc batch → validate doc + app only, no crossValidation.
    const docCb = buildDocCallback({
      documentId: 'doc-001',
      accountNumber: '9999999999',
      calculatedDebits: '1500.00',
      calculatedCredits: '5000.00',
    });
    const appCb = buildAppCallback({ totalDebit: 1500.00, totalCredit: 5000.00 });

    // Validate the document callback independently
    const docResult = validateBankStatementDocCallback(docCb);
    assert.ok(docResult.passed, 'single-doc callback must pass validation');
    assert.equal(docResult.scoreGating.decision, 'FULL_VALIDATION');

    // Build the totals array — only 1 entry (single-doc batch)
    const docTotals = [buildDocTotals(docCb, docResult.scoreGating)];

    // Attempt cross-validation with the single doc — must be a no-op
    const appReport = freshAppReport();
    const errors = [];
    crossValidateBankStatementTotals(docTotals, appCb, appReport, errors);

    // Assertions: app report must NOT have crossValidation
    assert.equal(appReport.crossValidation, undefined,
      'crossValidation must NOT be emitted for a 1-document batch');
    assert.equal(errors.length, 0, 'no errors for single-doc batch');

    // App report checks must still be clean (doc + app validation passed)
    assert.ok(appReport.checks.schemaValidation.passed);
    assert.ok(appReport.checks.structureValidation.passed);
    assert.ok(appReport.checks.keyFieldsMatched.passed);
    assert.ok(appReport.checks.contentValidation.passed);
  });

  it('2-document batch, different account groups: no crossValidation emitted', () => {
    // Two bank statements from different accounts uploaded together.
    // The corrected rule says: crossValidation requires same account group with 2+ docs.
    // Different accounts → each account group has 1 doc → no crossValidation for either.
    const doc1 = buildDocCallback({
      documentId: 'doc-001',
      accountNumber: 'ACCT-AAA',
      calculatedDebits: '1500.00',
      calculatedCredits: '5000.00',
    });
    const doc2 = buildDocCallback({
      documentId: 'doc-002',
      accountNumber: 'ACCT-BBB',
      calculatedDebits: '1500.00',
      calculatedCredits: '5000.00',
    });
    const appCb = buildAppCallback({ totalDebit: 3000.00, totalCredit: 10000.00 });

    const r1 = validateBankStatementDocCallback(doc1);
    const r2 = validateBankStatementDocCallback(doc2);
    assert.ok(r1.passed, 'doc-001 callback must pass validation');
    assert.ok(r2.passed, 'doc-002 callback must pass validation');

    const docTotals = [buildDocTotals(doc1, r1.scoreGating), buildDocTotals(doc2, r2.scoreGating)];

    // Group by account — should produce 2 groups of 1 doc each
    const accountGroups = groupBankStatementsByAccount(docTotals);
    assert.equal(accountGroups.size, 2, 'different accounts → 2 groups');

    // Simulate the post-processing loop from run_qa.mjs:
    // iterate account groups, skip any group with < 2 docs
    const appReport = freshAppReport();
    const errors = [];
    for (const [, acctDocs] of accountGroups) {
      if (acctDocs.length >= 2) {
        crossValidateBankStatementTotals(acctDocs, appCb, appReport, errors);
      }
    }

    // Neither group has 2+ docs → crossValidation must not exist
    assert.equal(appReport.crossValidation, undefined,
      'crossValidation must NOT be emitted when docs are in different account groups');
    assert.equal(errors.length, 0,
      'no errors when account groups each have only 1 doc');
  });
});

// ── crossCheckFindings validation ─────────────────────────────────────────────

describe('crossCheckFindings validation (validateApplicationCallback)', () => {
  it('single-doc batch: crossCheckFindings not asserted, no errors', () => {
    // Single-doc batch — no crossCheckFindings validation at all
    const cb = buildAppCallback({
      documents: [{ documentType: 'BANK_STATEMENT', documentClassification: 'PRIMARY' }],
      crossCheckFindings: null, // would fail on multi-doc, must pass on single-doc
    });
    const result = validateApplicationCallback(cb);
    assert.ok(result.passed, `expected pass, got errors: ${result.allErrors.join('; ')}`);
    assert.equal(result.crossCheckMismatches.length, 0);
  });

  it('multi-doc PRIMARY+SUPPORTING + crossCheckFindings: [] → passes with informational note', () => {
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
      crossCheckFindings: [],
    });
    const result = validateApplicationCallback(cb);
    assert.ok(result.passed, `expected pass, got errors: ${result.allErrors.join('; ')}`);
    assert.ok(
      result.notes.some(n => n.includes('crossCheckFindings is empty')),
      'should surface informational note about empty findings'
    );
  });

  it('multi-doc + valid findings array, all match: true → passes, no mismatches', () => {
    const findings = [
      {
        field: 'name',
        valuePrimary: ['MARIA SANTOS GARCIA'],
        valueSecondary: ['MARIA SANTOS GARCIA'],
        match: true,
        riskLevel: 'low',
        description: 'Names match',
      },
    ];
    const cb = buildAppCallback({
      documents: MULTI_DOC_PRIMARY_ONLY,
      crossCheckFindings: findings,
    });
    const result = validateApplicationCallback(cb);
    assert.ok(result.passed, `expected pass, got errors: ${result.allErrors.join('; ')}`);
    assert.equal(result.crossCheckMismatches.length, 0);
  });

  it('multi-doc + finding with match: false, riskLevel: "medium" → passes, mismatch surfaced', () => {
    const findings = buildCrossCheckFindings(); // includes address mismatch (medium)
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
      crossCheckFindings: findings,
    });
    const result = validateApplicationCallback(cb);
    assert.ok(result.passed, `expected pass (mismatches are informational), got errors: ${result.allErrors.join('; ')}`);
    assert.equal(result.crossCheckMismatches.length, 1, 'one mismatch (address)');
    assert.equal(result.crossCheckMismatches[0].field, 'address');
    assert.equal(result.crossCheckMismatches[0].riskLevel, 'medium');
  });

  it('multi-doc + finding with match: false, riskLevel: "high" → passes, HIGH RISK surfaced', () => {
    const findings = [
      {
        field: 'income',
        valuePrimary: ['50000'],
        valueSecondary: ['15000'],
        match: false,
        riskLevel: 'high',
        description: 'Significant income discrepancy across documents',
      },
    ];
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
      crossCheckFindings: findings,
    });
    const result = validateApplicationCallback(cb);
    assert.ok(result.passed, 'high-risk mismatch must NOT fail the test');
    assert.equal(result.crossCheckMismatches.length, 1);
    assert.equal(result.crossCheckMismatches[0].riskLevel, 'high');
  });

  it('multi-doc + crossCheckFindings: null → ERROR', () => {
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
      crossCheckFindings: null,
    });
    // Manually set to null since buildAppCallback defaults to []
    cb.ocrResult.computedFields.crossCheckFindings = null;
    const result = validateApplicationCallback(cb);
    assert.ok(!result.passed, 'null crossCheckFindings on multi-doc must fail');
    assert.ok(
      result.allErrors.some(e => e.includes('missing ocrResult.computedFields.crossCheckFindings')),
      'error message must mention missing crossCheckFindings'
    );
  });

  it('multi-doc + crossCheckFindings: {} (object instead of array) → ERROR with type message', () => {
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
    });
    cb.ocrResult.computedFields.crossCheckFindings = {};
    const result = validateApplicationCallback(cb);
    assert.ok(!result.passed, 'object crossCheckFindings must fail');
    assert.ok(
      result.allErrors.some(e => e.includes('must be an array, got object')),
      'error must mention type'
    );
  });

  it('multi-doc + finding missing required field (no riskLevel) → ERROR with shape message', () => {
    const findings = [
      {
        field: 'name',
        valuePrimary: ['MARIA'],
        valueSecondary: ['MARIA'],
        match: true,
        // riskLevel intentionally omitted
        description: 'Names match',
      },
    ];
    const cb = buildAppCallback({
      documents: MULTI_DOC_MIXED,
      crossCheckFindings: findings,
    });
    const result = validateApplicationCallback(cb);
    assert.ok(!result.passed, 'missing riskLevel must fail');
    assert.ok(
      result.allErrors.some(e => e.includes('crossCheckFindings[0] missing required field: riskLevel')),
      'error must identify missing field'
    );
  });

  it('bank-statement multi-doc batch → still validates crossCheckFindings (regression)', () => {
    // This regression test confirms the old hasBankStatement gate being removed
    // doesn't break bank-statement batches — they still get validated under the
    // new multi-doc gate (2 PRIMARY docs of different types).
    const docs = [
      { documentType: 'BANK_STATEMENT', documentClassification: 'PRIMARY' },
      { documentType: 'PAYSLIP', documentClassification: 'PRIMARY' },
    ];
    const cb = buildAppCallback({
      documents: docs,
      crossCheckFindings: null,
    });
    cb.ocrResult.computedFields.crossCheckFindings = null;
    const result = validateApplicationCallback(cb);
    assert.ok(!result.passed, 'bank-statement multi-doc with null crossCheckFindings must fail');
    assert.ok(
      result.allErrors.some(e => e.includes('crossCheckFindings')),
      'error must reference crossCheckFindings'
    );
  });
});
