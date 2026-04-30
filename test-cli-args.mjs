#!/usr/bin/env node
/**
 * Unit tests for CLI argument parsing (--pr, --diff-source, --dry-run, etc.)
 *
 * Run: node --test test-cli-args.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrFlag, parseCliFlags, validateEnvFlag, parseFixtureFlag, MAPPING_FILES } from './run_qa.mjs';

// ── parsePrFlag ────────────────────────────────────────────────────────────────

describe('parsePrFlag — owner/repo#number parsing', () => {

  it('parses standard owner/repo#number format', () => {
    const result = parsePrFlag('owaBoost/verifyiq-Dev#42');
    assert.equal(result.repo, 'owaBoost/verifyiq-Dev');
    assert.equal(result.number, '42');
  });

  it('parses repo with hyphens and numbers', () => {
    const result = parsePrFlag('boost-capital/ai-parser-studio#289');
    assert.equal(result.repo, 'boost-capital/ai-parser-studio');
    assert.equal(result.number, '289');
  });

  it('parses single-digit PR number', () => {
    const result = parsePrFlag('org/repo#1');
    assert.equal(result.number, '1');
  });

  it('rejects missing PR number', () => {
    assert.throws(
      () => parsePrFlag('owner/repo'),
      /Invalid --pr format/,
    );
  });

  it('rejects non-numeric PR number', () => {
    assert.throws(
      () => parsePrFlag('owner/repo#abc'),
      /Invalid --pr format/,
    );
  });

  it('rejects missing owner', () => {
    assert.throws(
      () => parsePrFlag('repo#42'),
      /Invalid --pr format/,
    );
  });

  it('rejects empty string', () => {
    assert.throws(
      () => parsePrFlag(''),
      /Invalid --pr format/,
    );
  });

  it('rejects bare number', () => {
    assert.throws(
      () => parsePrFlag('42'),
      /Invalid --pr format/,
    );
  });
});

// ── parseCliFlags ──────────────────────────────────────────────────────────────

describe('parseCliFlags — CLI flag defaults and combinations', () => {

  it('--diff-source defaults to github', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags['diff-source'], 'github');
  });

  it('--dry-run defaults to false', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags['dry-run'], false);
  });

  it('--skip-generation defaults to false', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags['skip-generation'], false);
  });

  it('--no-comment defaults to false', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags['no-comment'], false);
  });

  it('--pr is undefined when not provided', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags.pr, undefined);
  });

  it('--pr captures the full value', () => {
    const flags = parseCliFlags(['--pr', 'owaBoost/verifyiq-Dev#42']);
    assert.equal(flags.pr, 'owaBoost/verifyiq-Dev#42');
  });

  it('--diff-source accepts custom values', () => {
    const flags = parseCliFlags(['--diff-source', 'local']);
    assert.equal(flags['diff-source'], 'local');
  });

  it('--diff-source file with --diff-file', () => {
    const flags = parseCliFlags(['--diff-source', 'file', '--diff-file', '/tmp/my.diff']);
    assert.equal(flags['diff-source'], 'file');
    assert.equal(flags['diff-file'], '/tmp/my.diff');
  });

  it('--dry-run and --skip-generation are mutually compatible', () => {
    const flags = parseCliFlags(['--dry-run', '--skip-generation']);
    assert.equal(flags['dry-run'], true);
    assert.equal(flags['skip-generation'], true);
  });

  it('--dry-run and --no-comment can be combined', () => {
    const flags = parseCliFlags(['--dry-run', '--no-comment']);
    assert.equal(flags['dry-run'], true);
    assert.equal(flags['no-comment'], true);
  });

  it('all flags together work without error', () => {
    const flags = parseCliFlags([
      '--pr', 'org/repo#1',
      '--diff-source', 'github',
      '--dry-run',
      '--skip-generation',
      '--no-comment',
    ]);
    assert.equal(flags.pr, 'org/repo#1');
    assert.equal(flags['diff-source'], 'github');
    assert.equal(flags['dry-run'], true);
    assert.equal(flags['skip-generation'], true);
    assert.equal(flags['no-comment'], true);
  });

  it('missing --pr falls back gracefully (no error)', () => {
    // Should not throw even without --pr
    const flags = parseCliFlags(['--skip-generation']);
    assert.equal(flags.pr, undefined);
    assert.equal(flags['skip-generation'], true);
  });

  it('unknown flags are silently ignored (strict: false)', () => {
    // Should not throw on unknown flags
    const flags = parseCliFlags(['--some-unknown-flag', '--skip-generation']);
    assert.equal(flags['skip-generation'], true);
  });

  // ── --clickup flag ──────────────────────────────────────────────────────────

  it('--clickup accepts a single task ID', () => {
    const flags = parseCliFlags(['--clickup', '86b94t6av']);
    assert.deepEqual(flags.clickup, ['86b94t6av']);
  });

  it('--clickup accepts multiple repeated values', () => {
    const flags = parseCliFlags(['--clickup', '86b94t6av', '--clickup', '86b94t6bx']);
    assert.deepEqual(flags.clickup, ['86b94t6av', '86b94t6bx']);
  });

  it('--clickup is undefined when not provided', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags.clickup, undefined);
  });

  // ── --env flag ──────────────────────────────────────────────────────────────

  it('--env defaults to auto', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags.env, 'auto');
  });

  it('--env accepts preview', () => {
    const flags = parseCliFlags(['--env', 'preview']);
    assert.equal(flags.env, 'preview');
  });

  it('--env accepts dev', () => {
    const flags = parseCliFlags(['--env', 'dev']);
    assert.equal(flags.env, 'dev');
  });

  // ── all Phase 1.5 flags combined ────────────────────────────────────────────

  it('--pr + --clickup + --env together', () => {
    const flags = parseCliFlags([
      '--pr', 'org/repo#1',
      '--clickup', 'abc123',
      '--env', 'dev',
      '--dry-run',
    ]);
    assert.equal(flags.pr, 'org/repo#1');
    assert.deepEqual(flags.clickup, ['abc123']);
    assert.equal(flags.env, 'dev');
    assert.equal(flags['dry-run'], true);
  });
});

// ── validateEnvFlag ─────────────────────────────────────────────────────────

describe('validateEnvFlag — --env value validation', () => {

  it('accepts auto', () => {
    assert.equal(validateEnvFlag('auto'), 'auto');
  });

  it('accepts preview', () => {
    assert.equal(validateEnvFlag('preview'), 'preview');
  });

  it('accepts dev', () => {
    assert.equal(validateEnvFlag('dev'), 'dev');
  });

  it('defaults to auto when undefined', () => {
    assert.equal(validateEnvFlag(undefined), 'auto');
  });

  it('rejects invalid values', () => {
    assert.throws(() => validateEnvFlag('staging'), /Invalid --env value/);
    assert.throws(() => validateEnvFlag('prod'), /Invalid --env value/);
    assert.throws(() => validateEnvFlag('local'), /Invalid --env value/);
  });
});

// ── parseFixtureFlag ──────────────────────────────────────────────────────────

describe('parseFixtureFlag — ad-hoc fixture parsing', () => {

  it('parses a plain gs:// path', () => {
    const f = parseFixtureFlag('gs://qa-automation-dev/test/sample.pdf');
    assert.equal(f.file, 'gs://qa-automation-dev/test/sample.pdf');
    assert.equal(f.source, 'cli');
    assert.equal(f.complete, false);
  });

  it('parses explicit FileType:gs:// prefix', () => {
    const f = parseFixtureFlag('BankStatement:gs://my-bucket/statement.pdf');
    assert.equal(f.file, 'gs://my-bucket/statement.pdf');
    assert.equal(f.fileType, 'BankStatement');
  });

  it('infers fileType from GCS folder name', () => {
    const f = parseFixtureFlag('gs://bucket/some-path/Payslip/file.pdf');
    assert.equal(f.fileType, 'Payslip');
  });

  it('infers fileType from case-insensitive folder alias', () => {
    const f = parseFixtureFlag('gs://bucket/electricity bill/meralco.jpg');
    assert.equal(f.fileType, 'ElectricUtilityBillingStatement');
  });

  it('falls back to unknown for unmapped paths (no error)', () => {
    const f = parseFixtureFlag('gs://my-bucket/random-folder/file.pdf');
    assert.equal(f.fileType, 'unknown');
    assert.equal(f.source, 'cli');
  });

  it('rejects non-gs:// scheme', () => {
    assert.throws(
      () => parseFixtureFlag('s3://wrong-scheme/path.pdf'),
      /Invalid GCS URI/,
    );
  });

  it('rejects malformed gs:// URI (no path after bucket)', () => {
    assert.throws(
      () => parseFixtureFlag('gs://invalid'),
      /Invalid GCS URI/,
    );
  });

  it('rejects http:// URI', () => {
    assert.throws(
      () => parseFixtureFlag('https://example.com/file.pdf'),
      /Invalid GCS URI/,
    );
  });

  it('rejects empty string', () => {
    assert.throws(
      () => parseFixtureFlag(''),
      /Invalid GCS URI/,
    );
  });

  it('explicit fileType takes precedence over inference', () => {
    // Path contains "Payslip" but explicit type is BankStatement
    const f = parseFixtureFlag('BankStatement:gs://bucket/Payslip/file.pdf');
    assert.equal(f.fileType, 'BankStatement');
  });
});

// ── --fixture in parseCliFlags ────────────────────────────────────────────────

describe('parseCliFlags — --fixture flag', () => {

  it('--fixture accumulates multiple values', () => {
    const flags = parseCliFlags([
      '--fixture', 'gs://bucket/a.pdf',
      '--fixture', 'gs://bucket/b.pdf',
    ]);
    assert.deepEqual(flags.fixture, ['gs://bucket/a.pdf', 'gs://bucket/b.pdf']);
  });

  it('--fixture is undefined when not provided', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags.fixture, undefined);
  });

  it('--fixture works with --pr and --clickup', () => {
    const flags = parseCliFlags([
      '--pr', 'org/repo#1',
      '--clickup', 'abc',
      '--fixture', 'gs://b/f.pdf',
    ]);
    assert.equal(flags.pr, 'org/repo#1');
    assert.deepEqual(flags.clickup, ['abc']);
    assert.deepEqual(flags.fixture, ['gs://b/f.pdf']);
  });
});

// ── MAPPING_FILES — canonical field paths loaded at module init ──────────────

describe('MAPPING_FILES — canonical response field paths', () => {

  it('loads mapping files from mappings/ directory', () => {
    assert.ok(Array.isArray(MAPPING_FILES), 'MAPPING_FILES should be an array');
    assert.ok(MAPPING_FILES.length >= 6, `expected at least 6 mapping files, got ${MAPPING_FILES.length}`);
  });

  it('includes payslip.mjs with responsePaths containing documentData.*.basicPay', () => {
    const payslip = MAPPING_FILES.find(m => m.name === 'payslip.mjs');
    assert.ok(payslip, 'payslip.mjs should be in MAPPING_FILES');
    assert.ok(payslip.content.includes("documentData.*.basicPay"), 'payslip mapping must contain documentData.*.basicPay');
    assert.ok(payslip.content.includes("documentData.*.grossPay"), 'payslip mapping must contain documentData.*.grossPay');
  });

  it('includes bank-statement.mjs with responsePaths', () => {
    const bs = MAPPING_FILES.find(m => m.name === 'bank-statement.mjs');
    assert.ok(bs, 'bank-statement.mjs should be in MAPPING_FILES');
    assert.ok(bs.content.includes('responsePaths'), 'bank-statement mapping must contain responsePaths');
  });

  it('excludes index.mjs and generic.mjs', () => {
    assert.ok(!MAPPING_FILES.find(m => m.name === 'index.mjs'), 'index.mjs should not be included');
    assert.ok(!MAPPING_FILES.find(m => m.name === 'generic.mjs'), 'generic.mjs should not be included');
  });

  it('each mapping file has name and content fields', () => {
    for (const m of MAPPING_FILES) {
      assert.ok(typeof m.name === 'string' && m.name.endsWith('.mjs'), `name should be a .mjs filename: ${m.name}`);
      assert.ok(typeof m.content === 'string' && m.content.length > 0, `content should be non-empty for ${m.name}`);
    }
  });
});
