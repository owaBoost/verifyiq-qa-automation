#!/usr/bin/env node
/**
 * Unit tests for CLI argument parsing (--pr, --diff-source, --dry-run, etc.)
 *
 * Run: node --test test-cli-args.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrFlag, parseCliFlags } from './run_qa.mjs';

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
});
