/**
 * Callback Validator
 *
 * Validates async batch-upload callback lifecycle:
 *   1. Webhook token management (create / poll / cleanup)
 *   2. Callback decryption via the decrypt Cloud Function
 *   3. Schema validation of decrypted payloads
 *   4. PII masking and artifact storage
 *
 * Designed for use by the pipeline runner when handling batch tests
 * independently. Does NOT re-trigger POST calls — validates callbacks
 * that arrive from an already-submitted batch.
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findSchema, validate } from './schema-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const WEBHOOK_SERVER_URL = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
const DECRYPT_URL = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';

const CALLBACK_TIMEOUT_MS = parseInt(process.env.CALLBACK_TIMEOUT_MS, 10) || 90_000;
const CALLBACK_POLL_INTERVAL_MS = parseInt(process.env.CALLBACK_POLL_INTERVAL_MS, 10) || 3_000;

// ── PII fields to mask in artifacts ─────────────────────────────────────────

const PII_FIELDS = new Set([
  'name', 'firstName', 'lastName', 'first_name', 'last_name',
  'email', 'emailAddress', 'email_address',
  'phone', 'phoneNumber', 'phone_number', 'mobile',
  'address', 'streetAddress', 'street_address',
  'ssn', 'socialSecurityNumber', 'tin', 'taxId',
  'dateOfBirth', 'date_of_birth', 'dob', 'birthdate',
  'accountNumber', 'account_number', 'bankAccountNumber',
  'routingNumber', 'routing_number',
]);

/**
 * Deep-clone an object with PII fields masked.
 */
export function maskPii(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskPii);

  const masked = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key) && typeof value === 'string') {
      masked[key] = value.length > 4
        ? value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2)
        : '****';
    } else if (typeof value === 'object') {
      masked[key] = maskPii(value);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

// ── IAP token for webhook server ────────────────────────────────────────────

let _webhookIapToken = null;

function getWebhookIapToken() {
  if (_webhookIapToken) return _webhookIapToken;
  if (!GOOGLE_SA_KEY_FILE) throw new Error('GOOGLE_SA_KEY_FILE is required for webhook server auth');
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  _webhookIapToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: WEBHOOK_SERVER_URL, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  return _webhookIapToken;
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Create a callback session — provisions a fresh webhook token.
 * Returns { tokenId, createdAt }.
 */
export async function createSession() {
  if (!WEBHOOK_SERVER_URL) throw new Error('WEBHOOK_SERVER_URL not set');
  if (!GOOGLE_SA_KEY_FILE) throw new Error('GOOGLE_SA_KEY_FILE not set');

  const res = await axios.post(`${WEBHOOK_SERVER_URL}/token`, null, {
    headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
    validateStatus: () => true,
  });

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Webhook token creation failed: HTTP ${res.status}`);
  }

  const tokenId = res.data?.uuid;
  if (!tokenId) throw new Error('Webhook server returned no uuid');

  return { tokenId, createdAt: new Date().toISOString() };
}

/**
 * Poll for callbacks on a webhook token.
 * Returns array of raw callback objects once expectedCount is reached.
 */
export async function pollCallbacks(tokenId, expectedCount, { timeoutMs, pollIntervalMs } = {}) {
  const timeout = timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const interval = pollIntervalMs ?? CALLBACK_POLL_INTERVAL_MS;
  const start = Date.now();

  // Get baseline count
  const baseRes = await axios.get(
    `${WEBHOOK_SERVER_URL}/token/${tokenId}/requests?per_page=50`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true },
  );
  const baselineCount = baseRes.data?.data?.length ?? 0;

  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, interval));

    const res = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${tokenId}/requests?per_page=50`,
      { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true },
    );
    const all = res.data?.data ?? [];
    const newRequests = all.slice(0, all.length - baselineCount);

    if (newRequests.length >= expectedCount) return newRequests;
  }

  throw new Error(`Callback timeout: waited ${timeout / 1000}s for ${expectedCount} callbacks`);
}

/**
 * Decrypt an encrypted callback body via the decrypt Cloud Function.
 */
export async function decryptPayload(rawBody) {
  if (!rawBody) throw new Error('Empty callback body');

  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: { 'Content-Type': 'text/plain' },
    validateStatus: () => true,
    timeout: 15_000,
  });

  if (res.status !== 200) {
    throw new Error(`Decrypt HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

/**
 * Validate a decrypted callback payload against the appropriate schema.
 * Returns { valid, type, errors }.
 */
export function validateCallbackSchema(decrypted) {
  const isDocLevel = !!decrypted?.documentId;
  const schemaFile = isDocLevel ? 'callback-document.json' : 'callback-application.json';
  const schemaPath = join(ROOT, 'schemas', schemaFile);

  if (!existsSync(schemaPath)) {
    return { valid: true, type: isDocLevel ? 'document' : 'application', errors: [], skipped: true };
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const errors = validate(decrypted, schema);

  return {
    valid: errors.length === 0,
    type: isDocLevel ? 'document' : 'application',
    errors,
  };
}

// ── Artifact storage ────────────────────────────────────────────────────────

/**
 * Save callback validation artifacts to reports/callbacks/<planId>/.
 * PII is masked in all written files. Encrypted payloads are truncated.
 */
export function saveArtifacts(planId, results) {
  const dir = join(ROOT, 'reports', 'callbacks', planId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const summary = {
    planId,
    savedAt: new Date().toISOString(),
    totalCallbacks: results.length,
    valid: results.filter(r => r.schemaResult?.valid).length,
    invalid: results.filter(r => r.schemaResult && !r.schemaResult.valid).length,
    decryptFailed: results.filter(r => r.decryptError).length,
    callbacks: results.map((r, i) => ({
      index: i,
      type: r.schemaResult?.type ?? 'unknown',
      applicationId: r.decrypted?.applicationId ?? null,
      documentId: r.decrypted?.documentId ?? null,
      receivedAt: r.receivedAt ?? null,
      decryptOk: !r.decryptError,
      decryptError: r.decryptError ?? null,
      schemaValid: r.schemaResult?.valid ?? null,
      schemaErrors: r.schemaResult?.errors ?? [],
    })),
  };

  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Write individual decrypted payloads (PII-masked)
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.decrypted) {
      writeFileSync(
        join(dir, `callback-${i}.json`),
        JSON.stringify(maskPii(r.decrypted), null, 2),
      );
    }
  }

  return { dir, summaryFile: join(dir, 'summary.json') };
}

/**
 * Delete a webhook token (cleanup).
 */
export async function cleanup(tokenId) {
  if (!tokenId) return;
  try {
    await axios.delete(`${WEBHOOK_SERVER_URL}/token/${tokenId}`, {
      headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
      validateStatus: () => true,
    });
  } catch { /* best effort */ }
}
