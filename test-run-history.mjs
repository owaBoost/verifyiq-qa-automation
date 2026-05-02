#!/usr/bin/env node
/**
 * Unit tests for run-over-run history comparison.
 *
 * Run: node --test test-run-history.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs';

import {
  readHistory,
  appendHistory,
  buildRunRecord,
  compareRuns,
  consecutiveFailures,
  formatComparisonSection,
} from './run_qa.mjs';

// Use a temp directory so tests don't collide with real history
const TEST_HISTORY_DIR = 'qa-runs/.history';

function cleanup(slug) {
  const path = `${TEST_HISTORY_DIR}/${slug}.jsonl`;
  if (existsSync(path)) rmSync(path);
}

// ── readHistory / appendHistory ──────────────────────────────────────────────

describe('readHistory + appendHistory', () => {
  const slug = 'test-rw-slug';

  beforeEach(() => cleanup(slug));
  afterEach(() => cleanup(slug));

  it('returns empty array when no history file exists', () => {
    cleanup(slug); // ensure clean
    const h = readHistory(slug);
    assert.deepEqual(h, []);
  });

  it('round-trips a single record', () => {
    const record = { timestamp: '2026-05-01T10:00:00Z', suite: slug, results: [] };
    appendHistory(slug, record);
    const h = readHistory(slug);
    assert.equal(h.length, 1);
    assert.deepEqual(h[0], record);
  });

  it('appends multiple records', () => {
    appendHistory(slug, { timestamp: '2026-05-01T10:00:00Z', suite: slug, results: [] });
    appendHistory(slug, { timestamp: '2026-05-01T11:00:00Z', suite: slug, results: [] });
    const h = readHistory(slug);
    assert.equal(h.length, 2);
    assert.equal(h[0].timestamp, '2026-05-01T10:00:00Z');
    assert.equal(h[1].timestamp, '2026-05-01T11:00:00Z');
  });
});

// ── History truncation ───────────────────────────────────────────────────────

describe('history truncation', () => {
  const slug = 'test-truncation-slug';

  beforeEach(() => cleanup(slug));
  afterEach(() => cleanup(slug));

  it('keeps only the most recent 100 entries when exceeding limit', () => {
    // Seed 100 entries directly
    if (!existsSync(TEST_HISTORY_DIR)) mkdirSync(TEST_HISTORY_DIR, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(JSON.stringify({ timestamp: `2026-01-01T${String(i).padStart(4, '0')}Z`, suite: slug, results: [], seq: i }));
    }
    writeFileSync(`${TEST_HISTORY_DIR}/${slug}.jsonl`, lines.join('\n') + '\n', 'utf8');

    // Append the 101st entry — should trigger truncation
    appendHistory(slug, { timestamp: '2026-01-02T00:00:00Z', suite: slug, results: [], seq: 101 });

    const h = readHistory(slug);
    assert.equal(h.length, 100, 'should have exactly 100 entries after truncation');
    assert.equal(h[0].seq, 2, 'oldest entry (seq=1) should be dropped');
    assert.equal(h[99].seq, 101, 'newest entry should be the 101st');
  });
});

// ── buildRunRecord ───────────────────────────────────────────────────────────

describe('buildRunRecord', () => {
  it('builds a record with pass/fail and failure_reason', () => {
    const results = [
      { id: 'TC-01', passed: true, title: 'Parse OK', assertionResults: [] },
      {
        id: 'TC-02', passed: false, title: 'Parse fail',
        assertionResults: [
          { description: 'field exists', expected: 'string', actual: '(not found)', passed: false },
        ],
      },
    ];
    const rec = buildRunRecord('test-slug', results);
    assert.equal(rec.suite, 'test-slug');
    assert.equal(rec.results.length, 2);
    assert.equal(rec.results[0].passed, true);
    assert.equal(rec.results[0].failure_reason, undefined);
    assert.equal(rec.results[1].passed, false);
    assert.ok(rec.results[1].failure_reason.includes('field exists'));
  });
});

// ── compareRuns ──────────────────────────────────────────────────────────────

describe('compareRuns', () => {
  it('returns null when no previous entry', () => {
    assert.equal(compareRuns([], null), null);
  });

  it('all stable (identical passing results)', () => {
    const current = [
      { tc_id: 'TC-01', passed: true, title: 'A' },
      { tc_id: 'TC-02', passed: true, title: 'B' },
    ];
    const prev = { timestamp: '2026-05-01T00:00:00Z', results: [...current] };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.fixed.length, 0);
    assert.equal(cmp.regressed.length, 0);
    assert.equal(cmp.stillFailing.length, 0);
    assert.equal(cmp.stillPassingCount, 2);
    assert.equal(cmp.newTcs.length, 0);
    assert.equal(cmp.goneTcs.length, 0);
  });

  it('FAIL → PASS marked as FIXED', () => {
    const current = [{ tc_id: 'TC-01', passed: true, title: 'A' }];
    const prev = { timestamp: '2026-05-01T00:00:00Z', results: [{ tc_id: 'TC-01', passed: false, title: 'A' }] };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.fixed.length, 1);
    assert.equal(cmp.fixed[0].tc_id, 'TC-01');
  });

  it('PASS → FAIL marked as REGRESSED', () => {
    const current = [{ tc_id: 'TC-01', passed: false, title: 'A' }];
    const prev = { timestamp: '2026-05-01T00:00:00Z', results: [{ tc_id: 'TC-01', passed: true, title: 'A' }] };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.regressed.length, 1);
    assert.equal(cmp.regressed[0].tc_id, 'TC-01');
  });

  it('FAIL in both runs marked as STILL FAILING', () => {
    const current = [{ tc_id: 'TC-01', passed: false, title: 'A' }];
    const prev = { timestamp: '2026-05-01T00:00:00Z', results: [{ tc_id: 'TC-01', passed: false, title: 'A' }] };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.stillFailing.length, 1);
  });

  it('new TC (not in previous) marked as NEW', () => {
    const current = [
      { tc_id: 'TC-01', passed: true, title: 'A' },
      { tc_id: 'TC-99', passed: true, title: 'New test' },
    ];
    const prev = { timestamp: '2026-05-01T00:00:00Z', results: [{ tc_id: 'TC-01', passed: true, title: 'A' }] };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.newTcs.length, 1);
    assert.equal(cmp.newTcs[0].tc_id, 'TC-99');
  });

  it('TC from previous not in current marked as GONE', () => {
    const current = [{ tc_id: 'TC-01', passed: true, title: 'A' }];
    const prev = {
      timestamp: '2026-05-01T00:00:00Z',
      results: [
        { tc_id: 'TC-01', passed: true, title: 'A' },
        { tc_id: 'TC-02', passed: true, title: 'B' },
      ],
    };
    const cmp = compareRuns(current, prev);
    assert.equal(cmp.goneTcs.length, 1);
    assert.equal(cmp.goneTcs[0].tc_id, 'TC-02');
  });

  it('suite regenerated: title-based matching when tc_ids differ', () => {
    const current = [
      { tc_id: 'TC-01', passed: true, title: 'Parse Blade Asia' },
      { tc_id: 'TC-02', passed: false, title: 'Brand new test' },
    ];
    const prev = {
      timestamp: '2026-05-01T00:00:00Z',
      results: [
        { tc_id: 'TC-05', passed: false, title: 'Parse Blade Asia' },  // same title, different ID
        { tc_id: 'TC-06', passed: true, title: 'Old test removed' },
      ],
    };
    const cmp = compareRuns(current, prev);
    // TC-01 matched TC-05 by title: FAIL → PASS = FIXED
    assert.equal(cmp.fixed.length, 1);
    assert.equal(cmp.fixed[0].title, 'Parse Blade Asia');
    // TC-02 is NEW (no match)
    assert.equal(cmp.newTcs.length, 1);
    // TC-06 is GONE
    assert.equal(cmp.goneTcs.length, 1);
    assert.ok(cmp.suiteRegenerated);
  });
});

// ── consecutiveFailures ──────────────────────────────────────────────────────

describe('consecutiveFailures', () => {
  it('counts consecutive failing runs from most recent', () => {
    const history = [
      { results: [{ tc_id: 'TC-01', passed: true }] },
      { results: [{ tc_id: 'TC-01', passed: false }] },
      { results: [{ tc_id: 'TC-01', passed: false }] },
    ];
    assert.equal(consecutiveFailures('TC-01', '', history), 2);
  });

  it('returns 0 when last run passed', () => {
    const history = [
      { results: [{ tc_id: 'TC-01', passed: false }] },
      { results: [{ tc_id: 'TC-01', passed: true }] },
    ];
    assert.equal(consecutiveFailures('TC-01', '', history), 0);
  });

  it('falls back to title matching', () => {
    const history = [
      { results: [{ tc_id: 'TC-99', title: 'My test', passed: false }] },
      { results: [{ tc_id: 'TC-99', title: 'My test', passed: false }] },
    ];
    assert.equal(consecutiveFailures('TC-01', 'My test', history), 2);
  });
});

// ── formatComparisonSection ──────────────────────────────────────────────────

describe('formatComparisonSection', () => {
  it('says "first run" when comparison is null', () => {
    const output = formatComparisonSection(null, []);
    assert.ok(output.includes('First run'));
    assert.ok(output.includes('no comparison'));
  });

  it('shows FIXED, REGRESSED, STILL FAILING sections', () => {
    const comparison = {
      previousTimestamp: new Date(Date.now() - 86400000).toISOString(),
      fixed: [{ tc_id: 'TC-03', title: 'Parse Blade Asia' }],
      regressed: [],
      stillFailing: [{ tc_id: 'TC-07', title: 'employer_name' }],
      stillPassingCount: 8,
      newTcs: [],
      goneTcs: [],
      suiteRegenerated: false,
    };
    const history = [
      { results: [{ tc_id: 'TC-07', passed: false }] },
      { results: [{ tc_id: 'TC-07', passed: false }] },
    ];
    const output = formatComparisonSection(comparison, history);
    assert.ok(output.includes('FIXED'));
    assert.ok(output.includes('TC-03'));
    assert.ok(output.includes('REGRESSED'));
    assert.ok(output.includes('None.'));
    assert.ok(output.includes('STILL FAILING'));
    assert.ok(output.includes('TC-07'));
    assert.ok(output.includes('3 consecutive runs'));
    assert.ok(output.includes('8 still passing'));
  });

  it('includes regeneration warning when suiteRegenerated is true', () => {
    const comparison = {
      previousTimestamp: new Date().toISOString(),
      fixed: [],
      regressed: [],
      stillFailing: [],
      stillPassingCount: 0,
      newTcs: [{ tc_id: 'TC-01', title: 'New' }],
      goneTcs: [{ tc_id: 'TC-99', title: 'Old' }],
      suiteRegenerated: true,
    };
    const output = formatComparisonSection(comparison, []);
    assert.ok(output.includes('Suite regenerated'));
    assert.ok(output.includes('Comparison limited'));
  });
});
