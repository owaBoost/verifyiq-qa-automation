/**
 * report.mjs — Generate three report files from bulk-parse results.
 *
 * Outputs:
 *   1. summary.md       — Human-scannable pass/fail + anomalies
 *   2. all-fields.csv   — Every extracted field as an adaptive column
 *   3. field-presence.md — Which fields appear in which fixtures
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { flattenResponse, extractAllColumns } from './flatten.mjs';

/**
 * @param {string} runDir   Output directory (already exists)
 * @param {Array} results   Array of { index, filename, file, ok, elapsed_ms, correlation_id, data, error }
 * @param {object} suiteMeta  { name, description, targetUrl, timestamp, totalElapsedMs }
 */
export async function generateReport(runDir, results, suiteMeta) {
  // Flatten all responses
  const flatRecords = results.map(r => r.ok && r.data ? flattenResponse(r.data) : {});
  const allColumns = extractAllColumns(flatRecords);

  generateSummary(runDir, results, suiteMeta);
  generateCsv(runDir, results, flatRecords, allColumns);
  generateFieldPresence(runDir, results, flatRecords, allColumns);
}

// ── 1. summary.md ────────────────────────────────────────────────────────────

function generateSummary(runDir, results, meta) {
  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  const elapsed = results.map(r => r.elapsed_ms || 0);
  const totalElapsed = elapsed.reduce((a, b) => a + b, 0);
  const avgElapsed = results.length ? Math.round(totalElapsed / results.length) : 0;
  const cached = results.filter(r => r.data?.fromCache === true).length;

  const lines = [];
  lines.push(`# ${meta.name} — Bulk Parse Summary`);
  lines.push('');
  lines.push(`| Key | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Suite | ${meta.name} |`);
  lines.push(`| Description | ${meta.description || ''} |`);
  lines.push(`| Target | ${meta.targetUrl} |`);
  lines.push(`| Timestamp | ${meta.timestamp} |`);
  lines.push(`| Total docs | ${results.length} |`);
  lines.push(`| Passed | ${ok} |`);
  lines.push(`| Failed | ${failed} |`);
  lines.push(`| Cached | ${cached} |`);
  lines.push(`| Total elapsed (API) | ${Math.round(totalElapsed)} ms |`);
  lines.push(`| Avg per-doc | ${avgElapsed} ms |`);
  lines.push(`| Wall-clock | ${Math.round(meta.totalElapsedMs)} ms |`);
  lines.push('');

  // Compact results table
  lines.push('## Results');
  lines.push('');
  lines.push('| # | filename | ok | elapsed_ms | fileType | correlation_id | error |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const fname = r.filename.length > 50 ? r.filename.substring(0, 47) + '...' : r.filename;
    const ft = r.data?.fileType || '';
    const err = r.error ? r.error.substring(0, 80) : '';
    lines.push(`| ${r.index} | ${fname} | ${r.ok} | ${r.elapsed_ms || ''} | ${ft} | ${(r.correlation_id || '').substring(0, 12)}... | ${err} |`);
  }
  lines.push('');

  // Anomalies
  const anomalies = [];
  for (const r of results) {
    if (!r.ok) {
      anomalies.push(`**#${r.index} ${r.filename}**: FAILED — ${r.error || 'unknown error'}`);
      continue;
    }
    const d = r.data || {};
    const qs = d.qualityScore ?? d.qualityCheck?.overall_score;
    if (qs != null && qs < 60) {
      anomalies.push(`**#${r.index} ${r.filename}**: Low quality score (${qs})`);
    }
    const cs = d.completenessScore ?? d.completenessCheck?.completeness_score;
    if (cs != null && cs < 80) {
      anomalies.push(`**#${r.index} ${r.filename}**: Low completeness (${cs})`);
    }
    const fs = d.fraudScore ?? d.mathematicalFraudReport?.fraud_score;
    if (fs != null && fs > 70) {
      anomalies.push(`**#${r.index} ${r.filename}**: High fraud score (${fs})`);
    }
    if (d.mathematicalFraudReport && (d.fraudScore == null && d.mathematicalFraudReport.fraud_score == null)) {
      anomalies.push(`**#${r.index} ${r.filename}**: Fraud pipeline incomplete (fraud_score missing)`);
    }
    const hasDocData = d.summaryOCR?.length > 0 || d.summaryResult?.length > 0;
    if (!hasDocData) {
      anomalies.push(`**#${r.index} ${r.filename}**: Extraction failed (no summaryOCR data)`);
    }
  }

  if (anomalies.length) {
    lines.push('## Anomalies');
    lines.push('');
    for (const a of anomalies) lines.push(`- ${a}`);
    lines.push('');
  } else {
    lines.push('## Anomalies');
    lines.push('');
    lines.push('None detected.');
    lines.push('');
  }

  lines.push('---');
  lines.push('Full field dump: [all-fields.csv](all-fields.csv)');
  lines.push('');

  writeFileSync(join(runDir, 'summary.md'), lines.join('\n'));
  console.log('  Written: summary.md');
}

// ── 2. all-fields.csv ────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function generateCsv(runDir, results, flatRecords, allColumns) {
  const headerCols = ['#', 'filename', 'ok', 'elapsed_ms', 'correlation_id', 'error', ...allColumns];
  const csvLines = [headerCols.map(csvEscape).join(',')];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const flat = flatRecords[i];
    const row = [
      r.index,
      r.filename,
      r.ok,
      r.elapsed_ms || '',
      r.correlation_id || '',
      r.error || '',
      ...allColumns.map(col => {
        const v = flat[col];
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      }),
    ];
    csvLines.push(row.map(csvEscape).join(','));
  }

  writeFileSync(join(runDir, 'all-fields.csv'), csvLines.join('\n'));
  console.log(`  Written: all-fields.csv (${headerCols.length} columns x ${results.length} rows)`);
}

// ── 3. field-presence.md ─────────────────────────────────────────────────────

function generateFieldPresence(runDir, results, flatRecords, allColumns) {
  const lines = [];
  lines.push('# Field Presence Report');
  lines.push('');
  lines.push(`Total fixtures: ${results.length}`);
  lines.push('');
  lines.push('| Field | Count | Fixtures |');
  lines.push('|---|---|---|');

  for (const col of allColumns) {
    const present = [];
    for (let i = 0; i < flatRecords.length; i++) {
      const v = flatRecords[i][col];
      if (v !== undefined && v !== null && v !== '') {
        present.push(i + 1);
      }
    }
    if (present.length === 0) continue;
    const fixtureList = present.length === results.length
      ? 'all'
      : present.map(n => `#${n}`).join(', ');
    lines.push(`| ${col} | ${present.length}/${results.length} | ${fixtureList} |`);
  }

  lines.push('');
  writeFileSync(join(runDir, 'field-presence.md'), lines.join('\n'));
  console.log(`  Written: field-presence.md (${allColumns.length} fields tracked)`);
}
