#!/usr/bin/env node
/**
 * Unit tests for QA_PROMPT_TEMPLATE.md content rules.
 * Ensures critical prompt instructions are present and not accidentally removed.
 *
 * Run: node --test test-prompt-template.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const template = readFileSync('QA_PROMPT_TEMPLATE.md', 'utf8');

describe('QA_PROMPT_TEMPLATE.md — critical rules presence', () => {

  it('prohibits HTTP status assertions (redundant with runner)', () => {
    assert.ok(
      template.includes('Do NOT add HTTP status as an assertion'),
      'template must contain the HTTP status assertion prohibition',
    );
  });

  it('requires ticket-scoped assertions for parse endpoints', () => {
    assert.ok(
      template.includes('assertions MUST focus on the SPECIFIC fields'),
      'template must contain the ticket-scoped assertion rule',
    );
  });

  it('requires canonical paths from mapping files', () => {
    assert.ok(
      template.includes('use ONLY paths defined in the Canonical Response'),
      'template must contain the canonical paths rule',
    );
  });

  it('prohibits callbacks in batch-upload payloads', () => {
    assert.ok(
      template.includes('Never include `callbacks` in `/ai-gateway/batch-upload` payloads'),
      'template must contain the callbacks prohibition',
    );
  });

  it('contains endpoint scoping rule for ClickUp context', () => {
    assert.ok(
      template.includes('Endpoint scoping from ClickUp context'),
      'template must contain the endpoint scoping section',
    );
  });
});
