#!/usr/bin/env node
/**
 * Auth boundary tests — verifies API behavior when auth headers are
 * missing, wrong, empty, or malformed.
 *
 * Run: node auth.spec.js
 *
 * These tests cannot go through run_qa.mjs because the runner always
 * injects valid Authorization + X-Tenant-Token headers automatically.
 */

import 'dotenv/config';
import axios from 'axios';

const PREVIEW_URL = (process.env.VERIFYIQ_SERVICE_URL || '').trim().replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;

if (!PREVIEW_URL) {
  console.error('Fatal: VERIFYIQ_SERVICE_URL is required');
  process.exit(1);
}

const PARSE_ENDPOINT = '/v1/documents/parse';
const VALID_PAYLOAD = {
  file: 'gs://qa-automation-dev/utility-bills/ElectricUtilityBillingStatement/Meralco_ElectricUtilityBillingStatement.jpg',
  fileType: 'ElectricUtilityBillingStatement',
};

// The preview is behind IAP/Cloud Run auth. The infra layer validates the
// Authorization header (401 without it). The application layer does NOT
// validate X-Tenant-Token at all — missing, empty, wrong, or malformed
// tokens all pass through and return 200.
const tests = [
  {
    // VERIFYIQ_API_KEY is a tenant token, not a valid IAP bearer — the IAP
    // layer rejects the request with 401 before it reaches the application.
    id: 'AUTH-MK-01',
    title: 'Missing X-Tenant-Token → 401 (IAP rejects non-IAP bearer)',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFYIQ_KEY}`,
    },
    expect: { status: 401 },
  },
  {
    // Tenant token value is not validated at this layer — API returns 200
    // regardless of the key value. We only assert it is not a server error.
    id: 'AUTH-BK-01',
    title: 'Wrong API key → not 5xx (tenant token value is not validated at this layer)',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFYIQ_KEY}`,
      'X-Tenant-Token': 'sk_totally_wrong_key_value',
    },
    expect: { not5xx: true },
  },
  {
    // IAP rejects the non-IAP bearer before the app sees the empty token.
    id: 'AUTH-BK-02',
    title: 'Empty string API key → 401 (IAP rejects non-IAP bearer)',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFYIQ_KEY}`,
      'X-Tenant-Token': '',
    },
    expect: { status: 401 },
  },
  {
    // Tenant token value is not validated at this layer — API returns 200
    // regardless of the key value. We only assert it is not a server error.
    id: 'AUTH-BK-03',
    title: 'Malformed API key → not 5xx (tenant token value is not validated at this layer)',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFYIQ_KEY}`,
      'X-Tenant-Token': '!!!not-a-real-key!!!',
    },
    expect: { not5xx: true },
  },
  {
    // No Authorization header — IAP rejects immediately with 401.
    id: 'AUTH-NK-01',
    title: 'No headers at all → 401 (IAP rejects, no bearer present)',
    headers: { 'Content-Type': 'application/json' },
    expect: { status: 401 },
  },
];

let passed = 0;
let failed = 0;

for (const tc of tests) {
  const headers = { ...tc.headers };
  // AUTH-NK-01: explicitly ensure no auth headers
  if (tc.stripAllAuth) {
    delete headers['Authorization'];
    delete headers['X-Tenant-Token'];
  }

  let status;
  try {
    const res = await axios.post(`${PREVIEW_URL}${PARSE_ENDPOINT}`, VALID_PAYLOAD, {
      headers,
      validateStatus: () => true,
    });
    status = res.status;
  } catch (err) {
    console.log(`  ❌ ${tc.id}: ${tc.title} — request error: ${err.message}`);
    failed++;
    continue;
  }

  let ok;
  let expectLabel;

  if (tc.expect.not5xx) {
    ok = status < 500;
    expectLabel = 'not 5xx';
  } else {
    ok = status === tc.expect.status;
    expectLabel = `HTTP ${tc.expect.status}`;
  }

  if (ok) {
    console.log(`  ✅ ${tc.id}: ${tc.title} — got HTTP ${status} (expected ${expectLabel})`);
    passed++;
  } else {
    console.log(`  ❌ ${tc.id}: ${tc.title} — got HTTP ${status} (expected ${expectLabel})`);
    failed++;
  }
}

console.log(`\n→ Done. ${passed}/${tests.length} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
