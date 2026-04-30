#!/usr/bin/env node
/**
 * Unit tests for ClickUp context fetching, environment detection, and input validation.
 *
 * Run: node --test test-clickup-integration.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatClickUpTask,
  fetchClickUpContext,
  parseCliFlags,
  probePreviewPattern,
} from './run_qa.mjs';

// ── formatClickUpTask ──────────────────────────────────────────────────────────

describe('formatClickUpTask — markdown formatting', () => {

  it('formats a task with description and comments', () => {
    const task = {
      name: 'Fix payslip parser',
      id: 'abc123',
      url: 'https://app.clickup.com/t/abc123',
      description: 'The parser should handle PH-specific labels.',
    };
    const comments = [{
      user: { username: 'alice' },
      date: '1714000000000',
      comment_text: 'Looks good to me',
    }];
    const md = formatClickUpTask(task, comments);

    assert.ok(md.includes('# Fix payslip parser (abc123)'));
    assert.ok(md.includes('**URL:** https://app.clickup.com/t/abc123'));
    assert.ok(md.includes('The parser should handle PH-specific labels.'));
    assert.ok(md.includes('### alice'));
    assert.ok(md.includes('Looks good to me'));
  });

  it('handles task with no description', () => {
    const task = { name: 'Empty task', id: 'def456' };
    const md = formatClickUpTask(task, []);

    assert.ok(md.includes('# Empty task (def456)'));
    assert.ok(md.includes('_(no description)_'));
    assert.ok(md.includes('_(no comments)_'));
  });

  it('handles task with text_content fallback', () => {
    const task = { name: 'Task', id: 'x', text_content: 'Fallback text' };
    const md = formatClickUpTask(task, []);

    assert.ok(md.includes('Fallback text'));
  });

  it('handles multiple comments', () => {
    const task = { name: 'Task', id: 'x', description: 'desc' };
    const comments = [
      { user: { username: 'alice' }, date: '1714000000000', comment_text: 'First' },
      { user: { email: 'bob@test.com' }, date: '1714100000000', comment_text: 'Second' },
    ];
    const md = formatClickUpTask(task, comments);

    assert.ok(md.includes('### alice'));
    assert.ok(md.includes('### bob@test.com'));
    assert.ok(md.includes('First'));
    assert.ok(md.includes('Second'));
  });

  it('handles comment with array-based comment field', () => {
    const task = { name: 'Task', id: 'x', description: 'desc' };
    const comments = [{
      user: { username: 'carl' },
      date: '1714000000000',
      comment: [{ text: 'Part 1' }, { text: ' Part 2' }],
    }];
    const md = formatClickUpTask(task, comments);

    assert.ok(md.includes('Part 1 Part 2'));
  });
});

// ── fetchClickUpContext — mock tests ─────────────────────────────────────────

describe('fetchClickUpContext — error handling', () => {

  it('returns empty string for empty taskIds', async () => {
    const result = await fetchClickUpContext([]);
    assert.equal(result, '');
  });

  it('returns empty string for undefined taskIds', async () => {
    const result = await fetchClickUpContext(undefined);
    assert.equal(result, '');
  });

  it('returns empty string when client has no auth token', async () => {
    const mockClient = {
      defaults: { headers: {} },
      get: async () => { throw new Error('should not be called'); },
    };
    const result = await fetchClickUpContext(['abc123'], mockClient);
    assert.equal(result, '');
  });

  it('handles API errors silently (does NOT throw)', async () => {
    const mockClient = {
      defaults: { headers: { Authorization: 'test-token' } },
      get: async () => { throw new Error('Network error'); },
    };
    const result = await fetchClickUpContext(['nonexistent-id'], mockClient);
    assert.equal(result, '', 'should return empty string on API failure');
  });

  it('returns markdown for successful fetch via mock', async () => {
    const mockClient = {
      defaults: { headers: { Authorization: 'test-token' } },
      get: async (url) => {
        if (url.includes('/comment')) {
          return { data: { comments: [] } };
        }
        return {
          data: {
            name: 'Mock Task',
            id: 'mock-001',
            url: 'https://app.clickup.com/t/mock-001',
            description: 'Test description',
          },
        };
      },
    };
    const result = await fetchClickUpContext(['mock-001'], mockClient);
    assert.ok(result.includes('# Mock Task (mock-001)'));
    assert.ok(result.includes('Test description'));
  });

  it('returns partial results when one task fails and another succeeds', async () => {
    let callCount = 0;
    const mockClient = {
      defaults: { headers: { Authorization: 'test-token' } },
      get: async (url) => {
        callCount++;
        // First task call fails, second succeeds
        if (url === '/task/bad-id') throw new Error('Not found');
        if (url === '/task/bad-id/comment') throw new Error('Not found');
        if (url.includes('/comment')) return { data: { comments: [] } };
        return {
          data: { name: 'Good Task', id: 'good-id', description: 'Works' },
        };
      },
    };
    const result = await fetchClickUpContext(['bad-id', 'good-id'], mockClient);
    assert.ok(result.includes('# Good Task (good-id)'));
    assert.ok(!result.includes('bad-id'));
  });
});

// ── Input source validation ──────────────────────────────────────────────────

describe('input source validation — --pr / --clickup requirement', () => {

  it('no --pr and no --clickup: no input source', () => {
    const flags = parseCliFlags([]);
    const hasInput = !!flags.pr || !!flags.clickup?.length;
    assert.equal(hasInput, false);
  });

  it('--pr alone provides input', () => {
    const flags = parseCliFlags(['--pr', 'org/repo#1']);
    const hasInput = !!flags.pr || !!flags.clickup?.length;
    assert.equal(hasInput, true);
  });

  it('--clickup alone provides input', () => {
    const flags = parseCliFlags(['--clickup', 'abc123']);
    const hasInput = !!flags.pr || !!flags.clickup?.length;
    assert.equal(hasInput, true);
  });

  it('both --pr and --clickup provide input', () => {
    const flags = parseCliFlags(['--pr', 'org/repo#1', '--clickup', 'abc123']);
    const hasInput = !!flags.pr || !!flags.clickup?.length;
    assert.equal(hasInput, true);
  });

  it('--skip-generation bypasses the requirement', () => {
    const flags = parseCliFlags(['--skip-generation']);
    const needsInput = !flags['skip-generation'];
    assert.equal(needsInput, false, 'skip-generation should not require pr/clickup');
  });
});

// ── probePreviewPattern — preview URL resolution ─────────────────────────────

describe('probePreviewPattern — preview URL detection', () => {

  it('returns null when pattern is empty (no preview label)', async () => {
    const alwaysReachable = async () => true;
    const result = await probePreviewPattern('', '42', alwaysReachable);
    assert.equal(result, null, 'empty pattern must not return a URL');
  });

  it('returns null when pattern is undefined', async () => {
    const alwaysReachable = async () => true;
    const result = await probePreviewPattern(undefined, '42', alwaysReachable);
    assert.equal(result, null);
  });

  it('returns null when prNumber is missing', async () => {
    const alwaysReachable = async () => true;
    const result = await probePreviewPattern('https://pr-{NUMBER}.example.com', '', alwaysReachable);
    assert.equal(result, null);
  });

  it('substitutes {NUMBER} and returns URL when probe succeeds', async () => {
    const alwaysReachable = async () => true;
    const result = await probePreviewPattern(
      'https://pr-{NUMBER}---preview.example.com', '42', alwaysReachable,
    );
    assert.equal(result, 'https://pr-42---preview.example.com');
  });

  it('returns null when probe fails (unreachable)', async () => {
    const neverReachable = async () => false;
    const result = await probePreviewPattern(
      'https://pr-{NUMBER}---preview.example.com', '42', neverReachable,
    );
    assert.equal(result, null);
  });

  it('strips trailing slash from substituted URL', async () => {
    const alwaysReachable = async () => true;
    const result = await probePreviewPattern(
      'https://pr-{NUMBER}.example.com/', '99', alwaysReachable,
    );
    assert.equal(result, 'https://pr-99.example.com');
  });
});
