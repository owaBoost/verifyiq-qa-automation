#!/usr/bin/env node
/**
 * Unit tests for suite persistence (slug generation, load-or-generate, --regenerate).
 *
 * Run: node --test test-suite-persistence.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { suiteSlug, parseCliFlags } from './run_qa.mjs';

// ── suiteSlug ─────────────────────────────────────────────────────────────────

describe('suiteSlug — derive stable filenames from CLI flags', () => {

  it('PR flag → pr-<owner>-<repo>-<number>', () => {
    const slug = suiteSlug({ pr: 'boost-capital/ai-parser-studio#385' });
    assert.equal(slug, 'pr-boost-capital-ai-parser-studio-385');
  });

  it('ClickUp only → clickup-<task-id>', () => {
    const slug = suiteSlug({ clickup: ['86b94t6av'] });
    assert.equal(slug, 'clickup-86b94t6av');
  });

  it('both PR and ClickUp → uses PR slug (PR is more specific)', () => {
    const slug = suiteSlug({ pr: 'org/repo#1', clickup: ['86b94t6av'] });
    assert.equal(slug, 'pr-org-repo-1');
  });

  it('multiple ClickUp tasks → uses first task ID', () => {
    const slug = suiteSlug({ clickup: ['86b94t6av', '86b94t6bx'] });
    assert.equal(slug, 'clickup-86b94t6av');
  });

  it('neither PR nor ClickUp → null', () => {
    const slug = suiteSlug({});
    assert.equal(slug, null);
  });

  it('weird characters in repo name get stripped', () => {
    const slug = suiteSlug({ pr: 'org-with.dots/repo_with!chars#42' });
    // Only [a-z0-9-] should survive after lowercasing
    assert.equal(slug, 'pr-org-withdots-repowithchars-42');
  });

  it('uppercase is lowercased', () => {
    const slug = suiteSlug({ pr: 'OwaBoost/VerifyIQ-Dev#100' });
    assert.equal(slug, 'pr-owaboost-verifyiq-dev-100');
  });

  it('ClickUp task IDs with mixed case are lowercased', () => {
    const slug = suiteSlug({ clickup: ['ABC123def'] });
    assert.equal(slug, 'clickup-abc123def');
  });

  it('repo with consecutive special chars collapses cleanly', () => {
    // e.g. org//repo##5 — the // and ## become -- after replacement
    const slug = suiteSlug({ pr: 'org//repo##5' });
    // / and # → -, other chars stripped → pr-org--repo--5
    assert.equal(slug, 'pr-org--repo--5');
  });
});

// ── --regenerate flag parsing ────────────────────────────────────────────────

describe('parseCliFlags — --regenerate flag', () => {

  it('--regenerate defaults to false', () => {
    const flags = parseCliFlags([]);
    assert.equal(flags.regenerate, false);
  });

  it('--regenerate is true when provided', () => {
    const flags = parseCliFlags(['--regenerate']);
    assert.equal(flags.regenerate, true);
  });

  it('--regenerate combines with --pr and --dry-run', () => {
    const flags = parseCliFlags([
      '--pr', 'org/repo#1',
      '--regenerate',
      '--dry-run',
    ]);
    assert.equal(flags.regenerate, true);
    assert.equal(flags.pr, 'org/repo#1');
    assert.equal(flags['dry-run'], true);
  });

  it('--regenerate and --skip-generation are both parseable (runtime decides priority)', () => {
    const flags = parseCliFlags(['--regenerate', '--skip-generation']);
    assert.equal(flags.regenerate, true);
    assert.equal(flags['skip-generation'], true);
  });
});
