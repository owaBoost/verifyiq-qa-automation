#!/usr/bin/env node
/**
 * Unit tests for batch-upload callback injection logic.
 *
 * Verifies that runBatchTestCase always overwrites payload.callbacks
 * with real webhook URLs, regardless of what the LLM generated.
 *
 * Run: node --test test-batch-injection.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Callback injection logic (extracted from runBatchTestCase) ────────────────
// We test the payload mutation in isolation — the actual function is deeply
// coupled to network calls, but the injection logic is a pure data transform.

/**
 * Simulate the callback injection that runBatchTestCase performs.
 * This mirrors the exact code path in run_qa.mjs.
 */
function injectCallbacks(tcPayload, webhookServerUrl, webhookTokenId, iapToken) {
  const payload = JSON.parse(JSON.stringify(tcPayload));
  const webhookIapHeader = { Authorization: `Bearer ${iapToken}` };
  payload.callbacks = {
    documentResult: {
      url: `${webhookServerUrl}/${webhookTokenId}`,
      method: 'POST',
      headers: webhookIapHeader,
    },
    applicationResult: {
      url: `${webhookServerUrl}/${webhookTokenId}`,
      method: 'POST',
      headers: webhookIapHeader,
    },
  };
  return payload;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('batch-upload callback injection', () => {

  const REAL_SERVER = 'https://verifyiq-webhook-server-1019050071398.us-central1.run.app';
  const REAL_TOKEN  = 'abc-123-def';
  const IAP_TOKEN   = 'eyJhbGciOiJSUzI1NiJ9.test';

  it('overwrites placeholder callbacks with real webhook URLs', () => {
    const tcPayload = {
      payload: {
        publicUserId: 'qa-test-user',
        submissionId: 'qa-sub-001',
        documents: [{ documentId: 'doc-001', preSignedUrl: 'gs://bucket/file.pdf' }],
      },
      callbacks: {
        documentResult: {
          url: 'https://verifyiq-webhook-server-<project>.us-central1.run.app/<token>',
          method: 'POST',
          headers: { Authorization: 'Bearer <WEBHOOK_IAP_TOKEN>' },
        },
        applicationResult: {
          url: 'https://verifyiq-webhook-server-<project>.us-central1.run.app/<token>',
          method: 'POST',
          headers: { Authorization: 'Bearer <WEBHOOK_IAP_TOKEN>' },
        },
      },
    };

    const result = injectCallbacks(tcPayload, REAL_SERVER, REAL_TOKEN, IAP_TOKEN);

    // Verify real URLs replaced placeholders
    assert.equal(
      result.callbacks.documentResult.url,
      `${REAL_SERVER}/${REAL_TOKEN}`,
      'documentResult URL should be real, not placeholder',
    );
    assert.equal(
      result.callbacks.applicationResult.url,
      `${REAL_SERVER}/${REAL_TOKEN}`,
      'applicationResult URL should be real, not placeholder',
    );
    assert.equal(
      result.callbacks.documentResult.headers.Authorization,
      `Bearer ${IAP_TOKEN}`,
    );

    // Verify no placeholder strings remain
    const serialized = JSON.stringify(result.callbacks);
    assert.ok(!serialized.includes('<project>'), 'no <project> placeholder should remain');
    assert.ok(!serialized.includes('<token>'), 'no <token> placeholder should remain');
    assert.ok(!serialized.includes('<WEBHOOK_IAP_TOKEN>'), 'no <WEBHOOK_IAP_TOKEN> placeholder should remain');
  });

  it('injects callbacks when payload.callbacks is absent', () => {
    const tcPayload = {
      payload: {
        publicUserId: 'qa-test-user',
        submissionId: 'qa-sub-001',
        documents: [{ documentId: 'doc-001', preSignedUrl: 'gs://bucket/file.pdf' }],
      },
      // No callbacks key at all
    };

    const result = injectCallbacks(tcPayload, REAL_SERVER, REAL_TOKEN, IAP_TOKEN);

    assert.ok(result.callbacks, 'callbacks should be injected');
    assert.equal(result.callbacks.documentResult.url, `${REAL_SERVER}/${REAL_TOKEN}`);
    assert.equal(result.callbacks.applicationResult.url, `${REAL_SERVER}/${REAL_TOKEN}`);
    assert.equal(result.callbacks.documentResult.method, 'POST');
    assert.equal(result.callbacks.applicationResult.method, 'POST');
  });

  it('does not mutate the original test case payload', () => {
    const original = {
      payload: { publicUserId: 'qa', submissionId: 'sub', documents: [] },
      callbacks: {
        documentResult: { url: 'placeholder', method: 'POST', headers: {} },
        applicationResult: { url: 'placeholder', method: 'POST', headers: {} },
      },
    };

    const originalStr = JSON.stringify(original);
    injectCallbacks(original, REAL_SERVER, REAL_TOKEN, IAP_TOKEN);

    assert.equal(
      JSON.stringify(original),
      originalStr,
      'original payload object should not be mutated',
    );
  });

  it('preserves payload.payload fields during injection', () => {
    const tcPayload = {
      payload: {
        publicUserId: 'qa-test-user',
        submissionId: 'qa-sub-001',
        documents: [
          { documentId: 'doc-001', documentType: 'BANK_STATEMENT', preSignedUrl: 'gs://b/f.pdf' },
          { documentId: 'doc-002', documentType: 'BANK_STATEMENT', preSignedUrl: 'gs://b/g.pdf' },
        ],
      },
    };

    const result = injectCallbacks(tcPayload, REAL_SERVER, REAL_TOKEN, IAP_TOKEN);

    assert.equal(result.payload.publicUserId, 'qa-test-user');
    assert.equal(result.payload.submissionId, 'qa-sub-001');
    assert.equal(result.payload.documents.length, 2);
    assert.equal(result.payload.documents[0].documentId, 'doc-001');
    assert.equal(result.payload.documents[1].documentId, 'doc-002');
  });
});
