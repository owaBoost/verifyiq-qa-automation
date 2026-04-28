#!/usr/bin/env node
/**
 * run-bulk.mjs — CLI orchestrator for bulk document parsing.
 *
 * Usage:
 *   node bulk-parse/run-bulk.mjs --suite=aoi-smoke
 *   node bulk-parse/run-bulk.mjs --gcs-prefix=gs://bucket/path/ --file-type=BankStatement
 */

import 'dotenv/config';
import axios from 'axios';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getGoogleIdToken } from '../utils/iap-auth.js';
import { discoverFixtures } from './discover.mjs';
import { chunk } from './chunk.mjs';
import { generateReport } from './report.mjs';

// ── Config ───────────────────────────────────────────────────────────────────

const SERVICE_URL = (process.env.VERIFYIQ_SERVICE_URL || '').trim().replace(/\/$/, '');
const API_KEY     = process.env.VERIFYIQ_API_KEY;
const USE_IAP     = process.env.USE_IAP === 'true';
const IAP_CLIENT_ID = process.env.IAP_CLIENT_ID;

if (!SERVICE_URL || !API_KEY) {
  console.error('Fatal: VERIFYIQ_SERVICE_URL and VERIFYIQ_API_KEY are required');
  process.exit(1);
}

// ── Args ─────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...rest] = a.slice(2).split('=');
      return [k, rest.join('=') || 'true'];
    })
);

// ── Load fixtures ────────────────────────────────────────────────────────────

async function loadFixtures() {
  if (args.suite) {
    const suitePath = resolve('bulk-parse/suites', args.suite + '.json');
    const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
    console.log(`Suite: ${suite.name} — ${suite.description}`);
    const items = suite.fixtures.map(f => ({ file: f, fileType: suite.fileType }));
    return { items, meta: { name: suite.name, description: suite.description } };
  }

  if (args['gcs-prefix'] && args['file-type']) {
    const items = await discoverFixtures(args['gcs-prefix'], args['file-type']);
    const name = args['file-type'] + '-discover';
    return { items, meta: { name, description: `Auto-discovered from ${args['gcs-prefix']}` } };
  }

  console.error('Usage: --suite=<name> or --gcs-prefix=gs://... --file-type=<type>');
  process.exit(1);
}

// ── HTTP client ──────────────────────────────────────────────────────────────

async function makeClient() {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'X-Tenant-Token': API_KEY,
    'Content-Type': 'application/json',
  };
  if (USE_IAP && IAP_CLIENT_ID) {
    const oidc = await getGoogleIdToken(IAP_CLIENT_ID);
    headers['Proxy-Authorization'] = `Bearer ${oidc}`;
  }
  return axios.create({
    baseURL: SERVICE_URL,
    headers,
    validateStatus: () => true,
    timeout: 300_000,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const wallStart = Date.now();
  const { items, meta } = await loadFixtures();
  console.log(`Fixtures: ${items.length}`);
  console.log(`Target:   ${SERVICE_URL}`);
  console.log(`IAP:      ${USE_IAP ? 'enabled' : 'disabled'}\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = resolve('bulk-results', `${timestamp}_${meta.name}`);
  const rawDir = join(runDir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const chunks = chunk(items);
  console.log(`Batches:  ${chunks.length} (${chunks.map(c => c.length).join('+')} items)\n`);

  const client = await makeClient();
  const allResults = [];
  let globalIndex = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci];
    console.log(`Batch ${ci + 1}/${chunks.length} (${batch.length} items)...`);

    const t0 = Date.now();
    let res;
    try {
      res = await client.post('/v1/documents/batch', { items: batch });
    } catch (err) {
      console.error(`  Batch ${ci + 1} network error: ${err.message}`);
      for (const item of batch) {
        globalIndex++;
        const filename = item.file.split('/').pop();
        allResults.push({
          index: globalIndex, filename, file: item.file,
          ok: false, elapsed_ms: 0, correlation_id: null,
          data: null, error: `Network error: ${err.message}`,
        });
      }
      continue;
    }
    const batchMs = Date.now() - t0;
    console.log(`  HTTP ${res.status} (${batchMs} ms)`);

    if (res.status !== 200) {
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.error(`  Batch ${ci + 1} failed: ${body.substring(0, 300)}`);
      for (const item of batch) {
        globalIndex++;
        const filename = item.file.split('/').pop();
        allResults.push({
          index: globalIndex, filename, file: item.file,
          ok: false, elapsed_ms: 0, correlation_id: null,
          data: null, error: `Batch HTTP ${res.status}: ${body.substring(0, 200)}`,
        });
      }
      continue;
    }

    const batchResults = res.data?.results || [];
    const summary = res.data?.summary || {};
    console.log(`  ok=${summary.ok}, failed=${summary.failed}, elapsed=${Math.round(summary.elapsed_ms || 0)} ms`);

    for (let i = 0; i < batch.length; i++) {
      globalIndex++;
      const item = batch[i];
      const br = batchResults[i] || {};
      const filename = item.file.split('/').pop();

      const result = {
        index: globalIndex,
        filename,
        file: item.file,
        ok: br.ok ?? false,
        elapsed_ms: Math.round(br.elapsed_ms || 0),
        correlation_id: br.correlation_id || null,
        data: br.data || null,
        error: br.ok ? null : (br.error || 'Unknown batch item error'),
      };
      allResults.push(result);

      // Save raw response
      const safeName = filename.replace(/[\s/\\]+/g, '_').replace(/\.pdf$/i, '');
      const rawPath = join(rawDir, `${String(globalIndex).padStart(2, '0')}_${safeName}.json`);
      writeFileSync(rawPath, JSON.stringify(br.data || { error: result.error }, null, 2));

      const status = result.ok ? 'OK' : 'FAIL';
      console.log(`    #${globalIndex} ${filename.substring(0, 45).padEnd(47)} ${status}  ${result.elapsed_ms} ms`);
    }

    // 1s pause between batches
    if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  const wallMs = Date.now() - wallStart;
  console.log(`\nAll batches complete. Wall-clock: ${wallMs} ms\n`);

  // Write run metadata
  const runMeta = {
    suite: meta.name,
    description: meta.description,
    targetUrl: SERVICE_URL,
    useIap: USE_IAP,
    timestamp: new Date().toISOString(),
    totalFixtures: items.length,
    ok: allResults.filter(r => r.ok).length,
    failed: allResults.filter(r => !r.ok).length,
    totalElapsedMs: wallMs,
  };
  writeFileSync(join(runDir, 'run-metadata.json'), JSON.stringify(runMeta, null, 2));

  // Generate reports
  console.log('Generating reports...');
  await generateReport(runDir, allResults, {
    ...meta,
    targetUrl: SERVICE_URL,
    timestamp: new Date().toISOString(),
    totalElapsedMs: wallMs,
  });

  console.log(`\nDone. Results: ${runDir}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
