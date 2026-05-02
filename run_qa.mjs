#!/usr/bin/env node
/**
 * QA Runner — generates and executes test cases against VerifyIQ environments.
 *
 * Usage:
 *   node run_qa.mjs --pr owner/repo#number          Full pipeline: diff → generate → run → comment
 *   node run_qa.mjs --pr owner/repo#number --dry-run Same but skip posting PR comment
 *   node run_qa.mjs --skip-generation                Run existing test-cases.json only
 *   node run_qa.mjs --help                           Show all flags
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { parseArgs } from 'node:util';
import { getGoogleIdToken } from './utils/iap-auth.js';
import { mapFolderToFileType } from './utils/gcs-fixture-loader.mjs';
import { readdirSync } from 'fs';

// ── Load canonical field mappings at module load ─────────────────────────────
// These define the exact response paths for each document type.
// Injected into the Claude CLI prompt so generated assertions use real paths.
const MAPPING_FILES = (() => {
  const dir = 'mappings';
  const skip = ['index.mjs', 'generic.mjs'];
  const entries = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !skip.includes(f)).sort()) {
    entries.push({ name: f, content: readFileSync(`${dir}/${f}`, 'utf8') });
  }
  return entries;
})();

// ── CLI argument parsing ─────────────────────────────────────────────────────

/**
 * Parse --pr flag value into { repo, number }.
 * @param {string} value  e.g. "owaBoost/verifyiq-Dev#42"
 * @returns {{ repo: string, number: string }}
 */
export function parsePrFlag(value) {
  const match = value.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid --pr format: "${value}". Expected owner/repo#number (e.g. owaBoost/verifyiq-Dev#42)`,
    );
  }
  return { repo: match[1], number: match[2] };
}

/**
 * Parse CLI flags from an argv array. Exported for testing.
 * @param {string[]} argv  Defaults to process.argv.slice(2)
 */
/** Valid GCS URI pattern: gs://bucket-name/path */
const GCS_URI_RE = /^gs:\/\/[a-z0-9][-a-z0-9._]*\/.+$/;

/**
 * Parse a single --fixture flag value into a fixture object.
 * Accepts `[FileType:]gs://bucket/path`.
 *
 * fileType resolution (best-effort):
 *   1. Explicit prefix  →  use it
 *   2. mapFolderToFileType on the deepest folder segment  →  use if known
 *   3. Otherwise  →  'unknown' (no error)
 *
 * @param {string} value  e.g. "BankStatement:gs://bucket/file.pdf" or "gs://bucket/file.pdf"
 * @returns {{ file: string, fileType: string, source: 'cli', complete: false, notes: string }}
 */
export function parseFixtureFlag(value) {
  let fileType = null;
  let uri = value;

  // Check for explicit FileType: prefix
  const colonIdx = value.indexOf(':gs://');
  if (colonIdx > 0) {
    fileType = value.slice(0, colonIdx);
    uri = value.slice(colonIdx + 1);
  }

  // Validate GCS URI shape
  if (!GCS_URI_RE.test(uri)) {
    throw new Error(
      `Invalid GCS URI: "${uri}". Expected format: gs://bucket-name/path/to/file`,
    );
  }

  // Best-effort fileType inference from path
  if (!fileType) {
    const segments = uri.replace(/^gs:\/\/[^/]+\//, '').split('/');
    // Try each path segment from deepest folder up (skip the filename)
    for (let i = segments.length - 2; i >= 0; i--) {
      const mapped = mapFolderToFileType(segments[i]);
      if (mapped) { fileType = mapped; break; }
    }
  }

  return {
    file: uri,
    fileType: fileType || 'unknown',
    source: 'cli',
    complete: false,
    notes: 'Ad-hoc fixture from --fixture flag',
  };
}

/**
 * Validate --env flag value. Exported for testing.
 * @param {string|undefined} value
 * @returns {'auto'|'preview'|'dev'}
 */
export function validateEnvFlag(value) {
  const valid = ['auto', 'preview', 'dev'];
  if (value && !valid.includes(value)) {
    throw new Error(`Invalid --env value: "${value}". Expected: ${valid.join(', ')}`);
  }
  return value || 'auto';
}

export function parseCliFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr:              { type: 'string' },
      clickup:         { type: 'string', multiple: true },
      fixture:         { type: 'string', multiple: true },
      env:             { type: 'string', default: 'auto' },
      'diff-source':   { type: 'string', default: 'github' },
      'diff-file':     { type: 'string' },
      'dry-run':       { type: 'boolean', default: false },
      'skip-generation': { type: 'boolean', default: false },
      regenerate:      { type: 'boolean', default: false },
      'no-comment':    { type: 'boolean', default: false },
      help:            { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });
  return values;
}

/**
 * Derive a stable slug from --pr or --clickup flags for suite file naming.
 * PR slug takes priority over ClickUp slug when both are provided.
 *
 * @param {{ pr?: string, clickup?: string[] }} flags  Parsed CLI flags
 * @returns {string|null}  e.g. "pr-boost-capital-ai-parser-studio-385" or null
 */
export function suiteSlug(flags) {
  if (flags.pr) {
    // "boost-capital/ai-parser-studio#385" → "pr-boost-capital-ai-parser-studio-385"
    return 'pr-' + flags.pr.toLowerCase().replace(/[/#]/g, '-').replace(/[^a-z0-9-]/g, '');
  }
  if (flags.clickup?.length) {
    // Use first ClickUp task ID
    return 'clickup-' + flags.clickup[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  }
  return null;
}

const cliFlags = parseCliFlags(process.argv.slice(2));

if (cliFlags.help) {
  console.log(`
Usage: node run_qa.mjs [options]

  Requires at least one of --pr or --clickup (unless --skip-generation).

Options:
  --pr <owner/repo#number>    PR to test (e.g. owaBoost/verifyiq-Dev#42)
  --clickup <task-id>         ClickUp task for AC context (repeatable)
  --fixture <[Type:]gs://...> Ad-hoc fixture file (repeatable)
                                gs://bucket/path.pdf — infer fileType from path
                                BankStatement:gs://bucket/path.pdf — explicit type
  --env <auto|preview|dev>    Target environment (default: auto)
                                auto    — probe preview, fall back to dev
                                preview — require preview, error if unreachable
                                dev     — use dev directly
  --diff-source <source>      Where to get the diff (default: github)
                                github — fetch via GitHub API
                                local  — run git diff main...HEAD locally
                                file   — read from --diff-file path
  --diff-file <path>          Path to diff file (requires --diff-source file)
  --dry-run                   Run tests but skip posting PR comment
  --skip-generation           Use existing test-cases.json instead of regenerating
  --regenerate                Force fresh test-case generation even if a saved
                                suite exists in qa-suites/
  --no-comment                Skip posting PR comment (tests still run)
  --help                      Show this help message

Modes:
  PR + ClickUp (full context):
    node run_qa.mjs --pr owaBoost/verifyiq-Dev#42 --clickup 86b94t6av

  PR only (diff-driven):
    node run_qa.mjs --pr owaBoost/verifyiq-Dev#42

  ClickUp only (ticket-driven, runs against dev):
    node run_qa.mjs --clickup 86b94t6av

  Re-run existing test cases:
    node run_qa.mjs --skip-generation

Environment variables (set in .env):
  VERIFYIQ_API_KEY            Tenant API key (required)
  GH_TOKEN                    GitHub PAT (required when --pr is used)
  DEV_URL                     Parser dev URL (default: https://parser-dev.boostkh.com)
  GATEWAY_DEV_URL             Gateway dev URL (default: same as DEV_URL)
  PREVIEW_URL_PATTERN         Preview parser URL, e.g. https://pr-{NUMBER}---...run.app
  PREVIEW_GATEWAY_URL_PATTERN Preview gateway URL (optional, falls back to GATEWAY_DEV_URL)
  USE_IAP                     Enable IAP authentication (set to 'true')
  IAP_CLIENT_ID               OAuth client ID for IAP
  CLICKUP_API_TOKEN           ClickUp API token (optional, for --clickup)
  GOOGLE_SA_KEY_FILE          Path to service account JSON key
  WEBHOOK_SERVER_URL          Webhook server for batch callbacks
`.trim());
  process.exit(0);
}

// Parse --pr flag early so it can override config vars
const _parsedPr = cliFlags.pr ? parsePrFlag(cliFlags.pr) : null;

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN    = process.env.GH_TOKEN;        // PAT with repo + PR comment permissions
let   PR_REPO         = _parsedPr?.repo   ?? process.env.PR_REPO;         // owner/repo
let   PR_NUMBER       = _parsedPr?.number ?? process.env.PR_NUMBER;
const CLICKUP_TOKEN   = process.env.CLICKUP_API_TOKEN;
const CLICKUP_FOLDER_ID = process.env.CLICKUP_FOLDER_ID || '90147709410';
const VERIFYIQ_KEY    = process.env.VERIFYIQ_API_KEY;
let   PREVIEW_URL     = (process.env.VERIFYIQ_SERVICE_URL || '').trim().replace(/\/$/, '');
const DEV_URL         = (process.env.DEV_URL || 'https://parser-dev.boostkh.com').trim().replace(/\/$/, '');
const GATEWAY_DEV_URL = (process.env.GATEWAY_DEV_URL || '').trim().replace(/\/$/, '') || DEV_URL;
const PREVIEW_URL_PATTERN = process.env.PREVIEW_URL_PATTERN || '';
const PREVIEW_GATEWAY_URL_PATTERN = process.env.PREVIEW_GATEWAY_URL_PATTERN || '';

// Resolved per-endpoint URLs — set by resolveServiceUrl(), used by createPreviewClient()
let _resolvedParserUrl  = '';
let _resolvedGatewayUrl = '';
let   WEBHOOK_TOKEN_ID       = process.env.WEBHOOK_TOKEN_ID; // overwritten at runtime
const WEBHOOK_SERVER_URL     = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
const GOOGLE_SA_KEY_FILE     = process.env.GOOGLE_SA_KEY_FILE;
const IAP_CLIENT_ID          = process.env.IAP_CLIENT_ID;       // OAuth client ID from GCP IAP
const USE_IAP                = process.env.USE_IAP === 'true';  // opt-in flag
const DISABLE_CLICKUP        = process.env.DISABLE_CLICKUP === 'true';
const DISABLE_REMOTE_POSTING = process.env.DISABLE_REMOTE_POSTING === 'true';

// ── Webhook server IAP auth ──────────────────────────────────────────────────

let _webhookIapToken = null;

function getWebhookIapToken() {
  if (_webhookIapToken) return _webhookIapToken;
  if (!GOOGLE_SA_KEY_FILE) throw new Error('GOOGLE_SA_KEY_FILE is required for webhook server auth');
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  _webhookIapToken = jwt.sign(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: WEBHOOK_SERVER_URL,
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
    { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  console.log(`  ✓ Webhook IAP token generated (${_webhookIapToken.length} chars)`);
  return _webhookIapToken;
}

// ── Webhook token lifecycle ──────────────────────────────────────────────────

async function createWebhookToken() {
  console.log('→ Creating fresh webhook token...');
  const res = await axios.post(`${WEBHOOK_SERVER_URL}/token`, null, {
    headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
    validateStatus: () => true,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Webhook token creation failed: HTTP ${res.status} — ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  const uuid = res.data?.uuid;
  if (!uuid) throw new Error('Webhook server returned no uuid');
  console.log(`  ✓ Webhook token created: ${uuid}`);
  return uuid;
}

async function deleteWebhookToken(uuid) {
  if (!uuid) return;
  console.log(`→ Deleting webhook token ${uuid}...`);
  try {
    await axios.delete(`${WEBHOOK_SERVER_URL}/token/${uuid}`, {
      headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
      validateStatus: () => true,
    });
    console.log('  ✓ Webhook token deleted');
  } catch (err) {
    console.warn(`  ⚠ Could not delete webhook token: ${err.message}`);
  }
}

// ── Startup validation (deferred — called at start of main()) ────────────────

function validateConfig() {
  const required = {
    VERIFYIQ_SERVICE_URL: PREVIEW_URL,
  };

  // GH_TOKEN needed when we have a PR (diff fetch, comments)
  if (cliFlags.pr) {
    required.GH_TOKEN = GITHUB_TOKEN;
  }

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error(`Fatal: missing required config: ${missing.join(', ')}`);
    console.error('Set them in .env or pass appropriate CLI flags. See --help.');
    process.exit(1);
  }

  if (!/^https?:\/\//i.test(PREVIEW_URL)) {
    console.error(`Fatal: resolved service URL must start with https:// (got: "${PREVIEW_URL}")`);
    process.exit(1);
  }
}

// ── Environment auto-detection ────────────────────────────────────────────────

async function probeHealthEndpoint(url) {
  try {
    const res = await axios.head(`${url}/health`, { timeout: 5000, validateStatus: () => true });
    return res.status >= 200 && res.status < 300;
  } catch (err) {
    console.log(`  ⚠ Probe ${url}/health failed: ${err.code || err.message}`);
    return false;
  }
}

/**
 * Probe a PREVIEW_URL_PATTERN for reachability.
 * Returns the resolved URL if reachable, null otherwise.
 * Only called when pattern is configured AND a PR number is available.
 */
/**
 * Probe a preview URL pattern for reachability. Exported for testing.
 * Returns the resolved URL if reachable, null otherwise.
 *
 * @param {string} pattern    URL template with {NUMBER} placeholder
 * @param {string} prNumber   PR number to substitute
 * @param {Function} [probe]  Override health probe (for testing)
 * @returns {Promise<string|null>}
 */
export async function probePreviewPattern(pattern, prNumber, probe) {
  if (!pattern || !prNumber) return null;
  const url = pattern.replace('{NUMBER}', prNumber).replace(/\/$/, '');
  const probeFn = probe || probeHealthEndpoint;
  if (await probeFn(url)) return url;
  return null;
}

/**
 * Resolve parser and gateway URLs based on --env flag and PREVIEW_URL_PATTERN.
 * Sets _resolvedParserUrl and _resolvedGatewayUrl, returns the parser URL as
 * the primary PREVIEW_URL (backward compat — most call sites use PREVIEW_URL).
 */
async function resolveServiceUrl() {
  const envMode = validateEnvFlag(cliFlags.env);

  // ── Explicit dev ────────────────────────────────────────────────────────────
  if (envMode === 'dev') {
    _resolvedParserUrl  = DEV_URL;
    _resolvedGatewayUrl = GATEWAY_DEV_URL;
    console.log(`→ Using dev env (--env dev): ${DEV_URL}`);
    if (GATEWAY_DEV_URL !== DEV_URL) console.log(`  Gateway dev: ${GATEWAY_DEV_URL}`);
    return DEV_URL;
  }

  // ── ClickUp-only mode (no PR) → always dev ─────────────────────────────────
  if (!cliFlags.pr) {
    _resolvedParserUrl  = DEV_URL;
    _resolvedGatewayUrl = GATEWAY_DEV_URL;
    console.log(`→ ClickUp-only mode, using dev env: ${DEV_URL}`);
    if (GATEWAY_DEV_URL !== DEV_URL) console.log(`  Gateway dev: ${GATEWAY_DEV_URL}`);
    return DEV_URL;
  }

  // ── Explicit preview — require at least one pattern to be reachable ────────
  if (envMode === 'preview') {
    if (!PREVIEW_URL_PATTERN) {
      throw new Error(
        '--env preview specified but PREVIEW_URL_PATTERN is not configured in .env.',
      );
    }
    const parserUrl = await probePreviewPattern(PREVIEW_URL_PATTERN, PR_NUMBER);
    if (!parserUrl) {
      const tried = PREVIEW_URL_PATTERN.replace('{NUMBER}', PR_NUMBER);
      throw new Error(
        `--env preview specified but preview is unreachable: ${tried}`,
      );
    }
    _resolvedParserUrl = parserUrl;
    console.log(`→ Using preview env: ${parserUrl}`);

    // Gateway preview — optional, fall back to gateway dev if unconfigured/unreachable
    const gwUrl = await probePreviewPattern(PREVIEW_GATEWAY_URL_PATTERN, PR_NUMBER);
    _resolvedGatewayUrl = gwUrl || GATEWAY_DEV_URL;
    if (gwUrl) {
      console.log(`  Gateway preview: ${gwUrl}`);
    } else if (PREVIEW_GATEWAY_URL_PATTERN) {
      console.log(`  ⚠ Gateway preview unreachable, using gateway dev: ${GATEWAY_DEV_URL}`);
    }
    return parserUrl;
  }

  // ── Auto mode with PR ──────────────────────────────────────────────────────
  // Only try genuine preview patterns — never label DEV_URL as "preview"
  if (PREVIEW_URL_PATTERN) {
    const parserUrl = await probePreviewPattern(PREVIEW_URL_PATTERN, PR_NUMBER);
    if (parserUrl) {
      _resolvedParserUrl = parserUrl;
      console.log(`→ Using preview env: ${parserUrl}`);

      const gwUrl = await probePreviewPattern(PREVIEW_GATEWAY_URL_PATTERN, PR_NUMBER);
      _resolvedGatewayUrl = gwUrl || GATEWAY_DEV_URL;
      if (gwUrl) {
        console.log(`  Gateway preview: ${gwUrl}`);
      } else if (PREVIEW_GATEWAY_URL_PATTERN) {
        console.log(`  ⚠ Gateway preview unreachable, using gateway dev: ${GATEWAY_DEV_URL}`);
      }
      return parserUrl;
    }
    const tried = PREVIEW_URL_PATTERN.replace('{NUMBER}', PR_NUMBER);
    console.log(`→ Preview unreachable (${tried}), falling back to dev env: ${DEV_URL}`);
  } else {
    console.log(`→ No PREVIEW_URL_PATTERN configured, using dev env: ${DEV_URL}`);
  }

  _resolvedParserUrl  = DEV_URL;
  _resolvedGatewayUrl = GATEWAY_DEV_URL;
  if (GATEWAY_DEV_URL !== DEV_URL) console.log(`  Gateway dev: ${GATEWAY_DEV_URL}`);
  return DEV_URL;
}

/**
 * Return the resolved base URL for a given endpoint.
 * Gateway endpoints (/ai-gateway/*, /api/v1/applications/*) use the gateway URL;
 * everything else uses the parser URL.
 */
function resolveBaseUrlForEndpoint(endpoint) {
  if (needsIapAuth(endpoint)) return _resolvedGatewayUrl || PREVIEW_URL;
  return _resolvedParserUrl || PREVIEW_URL;
}

// ── ClickUp context fetching ─────────────────────────────────────────────────

/**
 * Format a ClickUp task + comments into markdown. Exported for testing.
 */
export function formatClickUpTask(task, comments) {
  const lines = [
    `# ${task.name} (${task.id})`,
    '',
    task.url ? `**URL:** ${task.url}` : null,
    '',
    '## Description',
    '',
    (task.description || task.text_content || '_(no description)_').trim(),
    '',
    '## Comments',
    '',
  ].filter(l => l !== null);

  if (!comments.length) {
    lines.push('_(no comments)_');
  } else {
    for (const c of comments) {
      const who = c.user?.username || c.user?.email || 'unknown';
      const when = Number.isFinite(Number(c.date))
        ? new Date(Number(c.date)).toISOString()
        : String(c.date ?? '');
      const text = (c.comment_text || (c.comment || []).map(p => p.text).join('') || '').trim();
      lines.push(`### ${who} — ${when}`, '', text, '');
    }
  }
  return lines.join('\n');
}

/**
 * Fetch ClickUp task context for one or more task IDs.
 * Returns markdown string. Returns '' on any failure (silent fallback).
 *
 * @param {string[]} taskIds
 * @param {object}   [client]  Axios-like client (default: module-level clickup instance)
 * @returns {Promise<string>}
 */
export async function fetchClickUpContext(taskIds, client) {
  if (!taskIds?.length) return '';

  // Defer client resolution so the module-level clickup instance isn't required at import time
  const cl = client || clickup;
  const token = cl.defaults?.headers?.Authorization;
  if (!token) {
    console.warn('  ⚠ CLICKUP_API_TOKEN not set — skipping ClickUp context');
    return '';
  }

  const blocks = [];
  for (const id of taskIds) {
    try {
      console.log(`→ Fetching ClickUp task ${id}...`);
      const { data: task } = await cl.get(`/task/${id}`);
      const { data: commentsRes } = await cl.get(`/task/${id}/comment`);
      const md = formatClickUpTask(task, commentsRes.comments || []);
      blocks.push(md);
      console.log(`  ✓ ClickUp task ${id}: ${task.name}`);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      console.warn(`  ⚠ ClickUp fetch failed for ${id}: ${detail} — continuing without this task`);
    }
  }

  return blocks.join('\n\n---\n\n');
}

// ── Axios clients ─────────────────────────────────────────────────────────────

const github = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: CLICKUP_TOKEN },
});

/**
 * Return a Bearer token for IAP-protected endpoints.
 * Requires USE_IAP=true and IAP_CLIENT_ID in .env.
 */
async function getIapBearerToken() {
  if (!(USE_IAP && IAP_CLIENT_ID)) {
    throw new Error(
      'IAP authentication requires USE_IAP=true and IAP_CLIENT_ID in .env. '
      + 'See .env.example for the correct values.',
    );
  }
  return getGoogleIdToken(IAP_CLIENT_ID);
}

function needsIapAuth(endpoint) {
  return endpoint.startsWith('/ai-gateway/') || endpoint.startsWith('/api/v1/applications/');
}

async function createPreviewClient(endpoint) {
  const headers = {
    'X-Tenant-Token': VERIFYIQ_KEY,
    'Content-Type': 'application/json',
  };

  if (USE_IAP && IAP_CLIENT_ID) {
    // IAP-protected domain: OIDC token in Proxy-Authorization (consumed by IAP),
    // API key in Authorization (forwarded to app layer).
    // For ai-gateway endpoints the app reads X-Tenant-Token, not Authorization.
    headers['Proxy-Authorization'] = `Bearer ${await getGoogleIdToken(IAP_CLIENT_ID)}`;
    headers.Authorization = needsIapAuth(endpoint)
      ? `Bearer ${await getGoogleIdToken(IAP_CLIENT_ID)}`
      : `Bearer ${VERIFYIQ_KEY}`;
  } else if (needsIapAuth(endpoint)) {
    headers.Authorization = `Bearer ${await getIapBearerToken()}`;
  } else {
    headers.Authorization = `Bearer ${VERIFYIQ_KEY}`;
  }

  return axios.create({
    baseURL: resolveBaseUrlForEndpoint(endpoint),
    headers,
    validateStatus: () => true,
  });
}

// ── Step 1: Load test cases ──────────────────────────────────────────────────

function loadTestCases() {
  console.log('→ Loading test cases from test-cases.json...');
  const raw = readFileSync('test-cases.json', 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.test_cases?.length) {
    throw new Error('test-cases.json has no test_cases');
  }

  console.log(`  ✓ ${parsed.test_cases.length} test cases loaded`);
  return parsed;
}

// ── Diff fetching ────────────────────────────────────────────────────────────

/**
 * Fetch a PR diff from the configured source.
 * @param {string} repo     owner/repo
 * @param {string} number   PR number
 * @param {string} source   'github' | 'local' | 'file'
 * @param {string} [filePath] Path to diff file (required when source='file')
 * @returns {Promise<string>} The diff content
 */
async function fetchDiff(repo, number, source, filePath) {
  switch (source) {
    case 'github': {
      console.log(`→ Fetching diff for ${repo}#${number} via GitHub API...`);
      const { data } = await axios.get(
        `https://api.github.com/repos/${repo}/pulls/${number}`,
        {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3.diff',
          },
          transformResponse: [d => d], // keep as raw string
        },
      );
      console.log(`  ✓ Diff fetched (${data.length} chars)`);
      return data;
    }
    case 'local': {
      console.log('→ Generating diff from local git (main...HEAD)...');
      const diff = execSync('git diff main...HEAD', { encoding: 'utf8' });
      if (!diff.trim()) {
        console.warn('  ⚠ Local diff is empty — no changes vs main');
      } else {
        console.log(`  ✓ Local diff generated (${diff.length} chars)`);
      }
      return diff;
    }
    case 'file': {
      if (!filePath) {
        throw new Error('--diff-file <path> is required when --diff-source is file');
      }
      console.log(`→ Reading diff from ${filePath}...`);
      const diff = readFileSync(filePath, 'utf8');
      console.log(`  ✓ Diff read (${diff.length} chars)`);
      return diff;
    }
    default:
      throw new Error(`Unknown --diff-source: "${source}". Expected: github, local, file`);
  }
}

// ── Test-case generation via Claude Code CLI ─────────────────────────────────

/**
 * Generate test cases by invoking `claude -p` with the QA prompt template.
 * Accepts PR diff and/or ClickUp context. Writes result to test-cases.json.
 *
 * @param {{ diff?: string, clickUpContext?: string }} context
 * @returns {object} The parsed test-cases JSON
 */
function generateTestCases({ diff, clickUpContext, adHocFixtures } = {}) {
  console.log('→ Generating test cases via Claude Code CLI...');

  const template = readFileSync('QA_PROMPT_TEMPLATE.md', 'utf8');
  const registry = readFileSync('fixture-registry.json', 'utf8');

  const promptParts = [template];

  if (diff) {
    promptParts.push('', '## PR Diff', '```diff', diff, '```');
  }

  if (clickUpContext) {
    promptParts.push('', '## ClickUp Task Context', '', clickUpContext);
  }

  promptParts.push('', '## Fixture Registry (fixture-registry.json)', '```json', registry, '```');

  // Inject canonical field mappings — the LLM MUST use these paths in assertions
  if (MAPPING_FILES.length) {
    promptParts.push(
      '',
      '## Canonical Response Field Paths',
      '',
      'The following mapping files define the EXACT paths where parsed fields appear',
      'in API responses. ALWAYS use these paths in assertions. Do not invent or',
      'modify field paths. The `responsePaths` object in each mapping is the source',
      'of truth for assertion path values.',
    );
    for (const { name, content } of MAPPING_FILES) {
      promptParts.push('', `### ${name}`, '', '```js', content, '```');
    }
  }

  if (adHocFixtures?.length) {
    promptParts.push(
      '',
      '## Ad-Hoc Fixtures (from --fixture flag)',
      '',
      '```json',
      JSON.stringify(adHocFixtures, null, 2),
      '```',
    );
  }

  const prompt = promptParts.join('\n');

  let output;
  try {
    output = execSync('claude -p', {
      input: prompt,
      encoding: 'utf8',
      timeout: 300_000, // 5 minutes
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `Claude Code CLI failed: ${err.message}\n`
      + "Ensure 'claude' is installed and in PATH (npm install -g @anthropic-ai/claude-code).",
    );
  }

  // Extract JSON — the prompt template instructs a ```json code block response
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : output.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    writeFileSync('test-cases-raw.txt', output);
    throw new Error(
      'Failed to parse Claude output as JSON. Raw output saved to test-cases-raw.txt',
    );
  }

  if (!parsed.test_cases?.length) {
    writeFileSync('test-cases.json', JSON.stringify(parsed, null, 2));
    console.log('  ⚠ Claude generated 0 test cases (PR may not be API-testable)');
    return parsed;
  }

  writeFileSync('test-cases.json', JSON.stringify(parsed, null, 2));
  console.log(`  ✓ ${parsed.test_cases.length} test cases generated → test-cases.json`);
  return parsed;
}

// ── Step 2: Fetch PR metadata ────────────────────────────────────────────────

async function getPr() {
  console.log('→ Fetching PR metadata...');
  const { data } = await github.get(`/repos/${PR_REPO}/pulls/${PR_NUMBER}`);
  return data;
}

// ── Step 3: ClickUp task creation & update ────────────────────────────────────

function buildDescription(tc) {
  const sections = [
    `**${tc.id} — ${tc.title}**`,
    `**Preconditions**\n${tc.preconditions}`,
    `**Steps**\n${tc.steps}`,
    `**Expected Result**\n${tc.expected_result}`,
    `**Endpoint:** ${tc.method} ${tc.endpoint}`,
  ];
  if (tc.payload) {
    sections.push(`**Payload:**\n\`\`\`json\n${JSON.stringify(tc.payload, null, 2)}\n\`\`\``);
  }
  if (tc.payload?.file) {
    sections.push(`**Fixture:** ${tc.payload.file}`);
  } else if (tc.payload?.items?.[0]?.file) {
    sections.push(`**Fixture:** ${tc.payload.items[0].file}`);
  }
  return sections.join('\n\n');
}

// Created at runtime in main() — a new list per PR inside CLICKUP_FOLDER_ID
let clickupListId = null;

async function clearClickUpList() {
  try {
    const { data } = await clickup.get(`/list/${clickupListId}/task`);
    const tasks = data.tasks ?? [];
    if (!tasks.length) return;
    console.log(`  Deleting ${tasks.length} stale tasks from previous run...`);
    for (const task of tasks) {
      await clickup.delete(`/task/${task.id}`);
    }
    console.log(`  ✓ Cleared ${tasks.length} stale tasks`);
  } catch (err) {
    console.warn(`  ⚠ Could not clear stale tasks: ${err.message}`);
  }
}

async function createClickUpList(pr) {
  if (DISABLE_REMOTE_POSTING || DISABLE_CLICKUP) {
    console.log('  [run_qa] ClickUp disabled — skipping list creation');
    return;
  }
  if (!CLICKUP_TOKEN) {
    console.warn('  ⚠ CLICKUP_API_TOKEN not set — ClickUp integration disabled');
    return;
  }
  const listName = `PR #${PR_NUMBER} - ${pr.title}`;
  try {
    const { data } = await clickup.post(`/folder/${CLICKUP_FOLDER_ID}/list`, {
      name: listName,
    });
    clickupListId = data.id;
    console.log(`  ✓ ClickUp list created: ${listName} (${clickupListId})`);
  } catch (err) {
    // SUBCAT_016: list name already taken — find and reuse the existing one
    const errCode = err.response?.data?.ECODE ?? err.response?.data?.err ?? '';
    if (errCode === 'SUBCAT_016') {
      console.log(`  ⚠ List "${listName}" already exists, looking up existing list...`);
      try {
        const { data: folder } = await clickup.get(`/folder/${CLICKUP_FOLDER_ID}/list`);
        const existing = folder.lists.find(l => l.name === listName);
        if (existing) {
          clickupListId = existing.id;
          console.log(`  ✓ Reusing existing ClickUp list: ${listName} (${clickupListId})`);
          // Delete stale tasks from previous runs
          await clearClickUpList();
          return;
        }
      } catch (lookupErr) {
        console.warn(`  ⚠ Failed to look up existing lists: ${lookupErr.message}`);
      }
    }
    const errBody = err.response?.data ? JSON.stringify(err.response.data) : 'no response body';
    console.warn(`  ⚠ Could not create ClickUp list in folder ${CLICKUP_FOLDER_ID}: ${err.message}`);
    console.warn(`    Status: ${err.response?.status ?? 'N/A'} — Body: ${errBody}`);
  }
}

async function createClickUpTask(tc) {
  if (!clickupListId) return { id: null, url: null };
  try {
    const { data } = await clickup.post(`/list/${clickupListId}/task`, {
      name: `${tc.id} - ${tc.title}`,
      description: buildDescription(tc),
      tags: [tc.type, 'qa-auto'],
      status: 'to do',
    });
    console.log(`  ✓ ClickUp: ${data.url}`);
    return { id: data.id, url: data.url };
  } catch (err) {
    console.warn(`  ⚠ ClickUp create failed for ${tc.id}: ${err.message}`);
    return { id: null, url: null };
  }
}

function isFixtureNotFound(actualResult, responseBody) {
  const text = `${actualResult} ${JSON.stringify(responseBody ?? '')}`.toLowerCase();
  return text.includes('no such object') || text.includes('fixture') ||
    (text.includes('404') && text.includes('storage.googleapis.com'));
}

async function updateClickUpTask(taskId, tc, actualResult, passed, curlCmd, failedAssertions, assertionResults, responseBody) {
  if (!taskId) return;
  try {
    // Detect fixture-not-found: tag as needs-fixture and keep status as "to do"
    const fixtureNotFound = !passed && isFixtureNotFound(actualResult, responseBody);

    if (fixtureNotFound) {
      await clickup.put(`/task/${taskId}`, {
        status: 'to do',
      });
      // Add needs-fixture tag
      try {
        await clickup.post(`/task/${taskId}/tag/needs-fixture`);
      } catch { /* tag may already exist */ }
    } else {
      await clickup.put(`/task/${taskId}`, {
        status: passed ? 'passed' : 'fail',
      });
    }

    // Post test result as a comment on the task activity
    const statusIcon = passed ? '✅' : fixtureNotFound ? '⚠️' : '❌';
    const statusLabel = passed ? 'PASSED' : fixtureNotFound ? 'SKIPPED' : 'FAILED';
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    // Extract HTTP status code from actualResult
    const httpStatusMatch = actualResult.match(/HTTP (\d+)/);
    const httpStatus = httpStatusMatch ? httpStatusMatch[1] : actualResult;

    const commentLines = [
      `## ${statusIcon} ${tc.id} ${statusLabel}`,
      `**HTTP Status:** ${httpStatus}`,
    ];

    if (fixtureNotFound) {
      commentLines.push('', '⚠️ Fixture not found in GCS bucket — upload required before this TC can run.');
    }

    // Assertion details
    if (assertionResults?.length) {
      commentLines.push('', '**Assertions:**');
      for (const ar of assertionResults) {
        const icon = ar.warning ? '⚠️' : ar.passed ? '✅' : '❌';
        commentLines.push(`- ${icon} \`${ar.path}\` → expected: \`${ar.expected}\` → actual: \`${ar.actual}\``);
      }
    }

    if (!passed && !fixtureNotFound && failedAssertions) {
      commentLines.push('', `**Failure Details:**`, failedAssertions);
    }

    // Curl command used
    if (curlCmd) {
      commentLines.push('', '**Curl Command:**', '```', curlCmd, '```');
    }

    // Full API response body (truncated to 3000 chars)
    if (responseBody != null) {
      const responseJson = JSON.stringify(responseBody, null, 2);
      const truncated = responseJson.length > 3000
        ? responseJson.slice(0, 3000) + '\n... (truncated)'
        : responseJson;
      commentLines.push('', '**API Response:**', '```json', truncated, '```');
    }

    commentLines.push('', `Ran at ${timestamp}`);

    await clickup.post(`/task/${taskId}/comment`, {
      comment_text: commentLines.join('\n'),
      notify_all: false,
    });
  } catch (err) {
    console.warn(`  ⚠ ClickUp update failed for ${taskId}: ${err.message}`);
  }
}

// ── Step 4: Run test cases ────────────────────────────────────────────────────

function resolvePath(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length; i++) {
    if (current == null) throw new Error(`null at "${keys[i]}"`);
    const key = keys[i];
    if (key === '*') {
      // Wildcard: iterate array items, resolve remaining path on each, return first non-null
      if (!Array.isArray(current)) throw new Error(`"*" used on non-array at segment ${i}`);
      const remaining = keys.slice(i + 1).join('.');
      if (!remaining) return current[0]; // * at end → first item
      for (const item of current) {
        try {
          const val = resolvePath(item, remaining);
          if (val != null) return val;
        } catch { /* try next item */ }
      }
      throw new Error(`no array item matched remaining path "${remaining}"`);
    }
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

// Health endpoints return "ok" or "healthy" interchangeably across environments.
// Normalise so assertions matching either value pass regardless of which is returned.
const HEALTH_STATUS_SYNONYMS = ['ok', 'healthy'];

function isHealthStatusField(path) {
  return /(?:^|\.)status$/.test(path) || /(?:^|\.)healthy$/.test(path);
}

/**
 * Evaluate a completenessScore assertion against the parsed response body.
 *
 * Supports two field-definition formats in assertion.required / assertion.optional:
 *
 *   Object format (payslip legacy):
 *     { fieldName: points, ... }
 *
 *   Array format (bank-statement, utility-bill):
 *     [{ field: 'name', points }, ...]           single field
 *     [{ fields: ['a', 'b'], points }, ...]       OR group — points awarded if any present
 *
 * Field lookup strategy per entry:
 *   1. Each documentData[] item's own keys
 *   2. Root body keys (for GS computed fields like gs_bankname_bankstatement)
 *
 * Takes the worst (lowest) score across all documentData items (most conservative).
 *
 * Thresholds (from assertion.thresholds):
 *   score >= pass   → PASS  (test passes, no warning)
 *   score >= warn   → WARN  (test passes, logged as ⚠️)
 *   score <  warn   → FAIL  (test fails)
 */
function runCompletenessAssertion(assertion, body) {
  const { required = {}, optional = {}, thresholds = {}, maxScore = 100 } = assertion;
  const passThreshold = thresholds.pass ?? 90;
  const warnThreshold = thresholds.warn ?? 70;

  // Resolve the items array to score. Default: documentData (payslip / most types).
  // Bank statements use documentData.summary; docArrayPath can be a string or string[].
  // The first path that resolves to a non-empty array wins.
  const docArrayPaths = assertion.docArrayPath
    ? (Array.isArray(assertion.docArrayPath) ? assertion.docArrayPath : [assertion.docArrayPath])
    : ['documentData'];

  let docItems = null;
  for (const p of docArrayPaths) {
    try {
      const candidate = resolvePath(body, p);
      if (Array.isArray(candidate) && candidate.length > 0) {
        docItems = candidate;
        break;
      }
    } catch { /* try next path */ }
  }
  if (!docItems) {
    const triedPaths = docArrayPaths.join(', ');
    return { skipped: true, skipReason: `no scoreable array found at [${triedPaths}] — skipping completeness check` };
  }

  const isPresent = v => v != null && v !== '' && String(v).toUpperCase() !== 'N/A';

  // Check a single key against the documentData item and the root body
  const hasKey = (key, item) => isPresent(item[key]) || isPresent(body[key]);

  // Normalise both field formats into { keys, points, label } entries
  function* iterateFields(fields) {
    if (Array.isArray(fields)) {
      for (const entry of fields) {
        const keys  = entry.fields ?? (entry.field ? [entry.field] : []);
        const label = keys.length > 1 ? keys.join(' | ') : (keys[0] ?? '(unknown)');
        yield { keys, points: entry.points ?? 0, label };
      }
    } else {
      for (const [field, pts] of Object.entries(fields ?? {})) {
        yield { keys: [field], points: pts, label: field };
      }
    }
  }

  let worstScore   = Infinity;
  let worstDetails = null;

  for (const item of docItems) {
    if (!item || typeof item !== 'object') continue;

    let score = 0;
    const missingRequired = [];
    const missingOptional = [];

    for (const { keys, points, label } of iterateFields(required)) {
      if (keys.some(k => hasKey(k, item))) score += points;
      else missingRequired.push(label);
    }
    for (const { keys, points, label } of iterateFields(optional)) {
      if (keys.some(k => hasKey(k, item))) score += points;
      else missingOptional.push(label);
    }

    if (score < worstScore) {
      worstScore   = score;
      worstDetails = { score, missingRequired, missingOptional };
    }
  }

  if (!worstDetails) {
    return { skipped: true, skipReason: 'no scoreable documentData items found — skipping completeness check' };
  }

  const { score, missingRequired, missingOptional } = worstDetails;
  const statusLabel = score >= passThreshold ? 'PASS' : score >= warnThreshold ? 'WARN' : 'FAIL';
  const passed  = score >= warnThreshold;
  const warning = score >= warnThreshold && score < passThreshold;

  const actual = [
    `score=${score}/${maxScore}`,
    `status=${statusLabel}`,
    missingRequired.length ? `missing_required=${missingRequired.join(',')}` : null,
    missingOptional.length ? `missing_optional=${missingOptional.join(',')}` : null,
  ].filter(Boolean).join(' ');

  return {
    passed,
    warning,
    score,
    maxScore,
    statusLabel,
    actual,
    missingRequired,
    missingOptional,
    detail: passed ? null
      : `Completeness score ${score}/${maxScore} is below FAIL threshold (${warnThreshold}). `
        + `Missing required: ${missingRequired.join(', ') || 'none'}. `
        + `Missing optional: ${missingOptional.join(', ') || 'none'}.`,
  };
}

/**
 * Evaluate a computed (cross-field) assertion against the parsed response body.
 *
 * Returns one of:
 *   { skipped: true,  skipReason: string }           — required paths absent; emit WARN
 *   { passed: true,   actual: string }                — check passed
 *   { passed: false,  actual: string, detail: string} — check failed; detail is the human message
 *
 * Numeric parsing handles both number and string-number values ("12,345.67").
 * All checks are tolerance-aware for the numeric equality cases.
 */
function runComputedAssertion(assertion, body) {
  const { check, paths, tolerance = 0 } = assertion;

  const parseNum = v => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  };

  const resolve = key => {
    const p = paths?.[key];
    if (!p) return null;
    try { return resolvePath(body, p); } catch { return null; }
  };

  switch (check) {
    case 'net_approx_gross_minus_total': {
      const grossPay = parseNum(resolve('grossPay'));
      const netPay   = parseNum(resolve('netPay'));
      if (grossPay == null || netPay == null) {
        return { skipped: true, skipReason: 'grossPay or netPay not present — skipping net=gross−deductions check' };
      }
      const td = parseNum(resolve('totalDeductions')) ?? parseNum(resolve('totalDeductionsMeta'));
      if (td == null) {
        return { skipped: true, skipReason: 'totalDeductions not present — skipping net=gross−deductions check' };
      }
      const expected = grossPay - td;
      const diff = Math.abs(expected - netPay);
      const passed = diff <= tolerance;
      return {
        passed,
        actual: `grossPay=${grossPay}, totalDeductions=${td}, expectedNet=${expected.toFixed(2)}, actualNet=${netPay}, diff=${diff.toFixed(2)}`,
        detail: passed ? null : `netPay (${netPay}) ≠ grossPay (${grossPay}) − totalDeductions (${td}) = ${expected.toFixed(2)} [diff=${diff.toFixed(2)}, tolerance=±${tolerance}]`,
      };
    }

    case 'total_approx_sum_deductions': {
      // Extraction rules: total_deductions is only extracted if explicitly present;
      // individual deductions may be a partial subset, so the sum check is unreliable.
      // Skipped by default unless the mapping explicitly clears skipByDefault.
      if (assertion.skipByDefault) {
        return { skipped: true, skipReason: '[computed] skipped total deduction check (non-standard payslip format)' };
      }
      const total = parseNum(resolve('totalDeductions')) ?? parseNum(resolve('totalDeductionsMeta'));
      if (total == null) {
        return { skipped: true, skipReason: '[computed] skipped total deduction check (no explicit total line)' };
      }
      const deductionKeys = ['withholdingTax', 'sss', 'philhealth', 'hdmfPagibig'];
      const present = deductionKeys.map(k => parseNum(resolve(k))).filter(v => v != null);
      if (present.length === 0) {
        return { skipped: true, skipReason: '[computed] skipped total deduction check (no individual deductions present)' };
      }
      const sumDeductions = present.reduce((a, b) => a + b, 0);
      const diff = Math.abs(total - sumDeductions);
      const passed = diff <= tolerance;
      return {
        passed,
        actual: `totalDeductions=${total}, sumOfPresent=${sumDeductions.toFixed(2)} (${present.length} fields), diff=${diff.toFixed(2)}`,
        detail: passed ? null : `totalDeductions (${total}) ≠ sum of present deductions (${sumDeductions.toFixed(2)}) [diff=${diff.toFixed(2)}, tolerance=±${tolerance}]`,
      };
    }

    case 'gross_gte_net': {
      const grossPay = parseNum(resolve('grossPay'));
      const netPay   = parseNum(resolve('netPay'));
      if (grossPay == null || netPay == null) {
        return { skipped: true, skipReason: 'grossPay or netPay not present — skipping gross≥net check' };
      }
      const passed = grossPay >= netPay;
      return {
        passed,
        actual: `grossPay=${grossPay}, netPay=${netPay}`,
        detail: passed ? null : `grossPay (${grossPay}) < netPay (${netPay}) — impossible: gross must be ≥ net`,
      };
    }

    case 'deductions_non_negative': {
      const keys = ['withholdingTax', 'sss', 'philhealth', 'hdmfPagibig'];
      const violations = [];
      const present    = [];
      for (const key of keys) {
        const v = parseNum(resolve(key));
        if (v == null) continue;
        present.push(`${key}=${v}`);
        if (v < 0) violations.push(`${key}=${v}`);
      }
      if (present.length === 0) {
        return { skipped: true, skipReason: 'no deductions present — skipping non-negative check' };
      }
      const passed = violations.length === 0;
      return {
        passed,
        actual: present.join(', '),
        detail: passed ? null : `negative deductions detected: ${violations.join(', ')}`,
      };
    }

    case 'fraud_score_range': {
      const fraudScore = parseNum(resolve('fraudScore'));
      if (fraudScore == null) {
        return { skipped: true, skipReason: 'fraudScore not present — skipping range check' };
      }
      const passed = fraudScore >= 0 && fraudScore <= 100;
      return {
        passed,
        actual: `fraudScore=${fraudScore}`,
        detail: passed ? null : `fraudScore (${fraudScore}) is outside valid range [0, 100]`,
      };
    }

    case 'no_negative_pay': {
      const grossPay = parseNum(resolve('grossPay'));
      const netPay   = parseNum(resolve('netPay'));
      if (grossPay == null && netPay == null) {
        return { skipped: true, skipReason: 'neither grossPay nor netPay present — skipping positive-pay check' };
      }
      const violations = [];
      if (grossPay != null && grossPay <= 0) violations.push(`grossPay=${grossPay}`);
      if (netPay   != null && netPay   <= 0) violations.push(`netPay=${netPay}`);
      const parts = [
        grossPay != null ? `grossPay=${grossPay}` : null,
        netPay   != null ? `netPay=${netPay}`   : null,
      ].filter(Boolean);
      const passed = violations.length === 0;
      return {
        passed,
        actual: parts.join(', '),
        detail: passed ? null : `non-positive pay values: ${violations.join(', ')}`,
      };
    }

    case 'bank_closing_balance_non_negative': {
      const closing = parseNum(resolve('closingBalance'));
      if (closing == null) {
        return { skipped: true, skipReason: 'closingBalance not present — skipping non-negative check' };
      }
      const passed = closing >= 0;
      return {
        passed,
        actual: `closingBalance=${closing}`,
        detail: passed ? null : `closingBalance (${closing}) is negative — unexpected for a statement closing balance`,
      };
    }

    case 'bank_total_credits_gte_debits': {
      if (assertion.skipByDefault) {
        return { skipped: true, skipReason: '[computed] skipped credits≥debits check (optional — requires complete statement data)' };
      }
      const credits = parseNum(resolve('totalCredits'))   ?? parseNum(resolve('summaryCredits'));
      const debits  = parseNum(resolve('totalDebits'))    ?? parseNum(resolve('summaryDebits'));
      if (credits == null || debits == null) {
        return { skipped: true, skipReason: 'totalCredits or totalDebits not present — skipping credits≥debits check' };
      }
      const passed = credits >= debits;
      return {
        passed,
        actual: `totalCredits=${credits}, totalDebits=${debits}`,
        detail: passed ? null : `totalCredits (${credits}) < totalDebits (${debits})`,
      };
    }

    case 'bank_transaction_count_positive': {
      const transactions = resolve('transactions');
      if (transactions == null) {
        return { skipped: true, skipReason: 'documentData.transactions not present — skipping count check' };
      }
      if (!Array.isArray(transactions)) {
        return {
          passed: false,
          actual: `transactions is ${typeof transactions}`,
          detail: 'documentData.transactions must be an array',
        };
      }
      const passed = transactions.length > 0;
      return {
        passed,
        actual: `transaction count=${transactions.length}`,
        detail: passed ? null : 'documentData.transactions is empty — expected at least one transaction',
      };
    }

    case 'no_cross_section_contamination': {
      // Earnings and deduction sections must not bleed into each other.
      // A deduction field resolving to the same value as an earnings field indicates
      // the extractor mixed sections. Giftaway is a known exception (employer gift
      // that legitimately appears in both sections) — flag but do not fail.
      const earningsMap = {
        grossPay: parseNum(resolve('grossPay')),
        basicPay: parseNum(resolve('basicPay')),
        netPay:   parseNum(resolve('netPay')),
      };
      const deductionMap = {
        withholdingTax: parseNum(resolve('withholdingTax')),
        sss:            parseNum(resolve('sss')),
        philhealth:     parseNum(resolve('philhealth')),
        hdmfPagibig:    parseNum(resolve('hdmfPagibig')),
      };
      const earningsPresent   = Object.entries(earningsMap).filter(([, v]) => v != null && v !== 0);
      const deductionsPresent = Object.entries(deductionMap).filter(([, v]) => v != null && v !== 0);
      if (earningsPresent.length === 0 || deductionsPresent.length === 0) {
        return { skipped: true, skipReason: '[computed] skipped cross-section contamination check (insufficient fields)' };
      }
      const earningsSet = new Set(earningsPresent.map(([, v]) => v));
      const violations  = deductionsPresent.filter(([, v]) => earningsSet.has(v));
      if (violations.length === 0) {
        return {
          passed: true,
          actual: `earnings=[${earningsPresent.map(([k, v]) => `${k}=${v}`).join(', ')}] deductions=[${deductionsPresent.map(([k, v]) => `${k}=${v}`).join(', ')}]`,
        };
      }
      // Giftaway exception: a single deduction matching an earnings value may be a
      // legitimate employer gift. Flag as a warning via detail but still pass — the
      // runner treats detail+passed:true as advisory.
      const violationStr = violations.map(([k, v]) => `${k}=${v}`).join(', ');
      const isLikelyGiftaway = violations.length === 1;
      return {
        passed: isLikelyGiftaway,
        actual: `cross-section overlap: ${violationStr}`,
        detail: isLikelyGiftaway
          ? `possible Giftaway: ${violationStr} matches an earnings value — verify document`
          : `earnings/deductions section contamination: ${violationStr} — deduction field(s) resolved to earnings values`,
      };
    }

    case 'explicit_total_only': {
      // Policy check: total_deductions must come from an explicit document line.
      // If absent → null is correct (must not be inferred from individual fields).
      // If present → must be a non-negative numeric value (proves explicit extraction).
      const total = parseNum(resolve('totalDeductions')) ?? parseNum(resolve('totalDeductionsMeta'));
      if (total == null) {
        return { passed: true, actual: 'totalDeductions=null (correctly absent — not inferred)' };
      }
      if (total < 0) {
        return {
          passed: false,
          actual: `totalDeductions=${total}`,
          detail: `totalDeductions (${total}) is negative — explicit total lines must be non-negative`,
        };
      }
      // Advisory: flag if total exactly matches the sum of a partial deduction set,
      // which may indicate computation rather than explicit extraction.
      const deductionKeys = ['withholdingTax', 'sss', 'philhealth', 'hdmfPagibig'];
      const present = deductionKeys.map(k => parseNum(resolve(k))).filter(v => v != null);
      if (present.length > 0 && present.length < deductionKeys.length) {
        const partialSum = present.reduce((a, b) => a + b, 0);
        if (Math.abs(total - partialSum) < 0.01) {
          return {
            passed: true,
            actual: `totalDeductions=${total} — matches partial sum of ${present.length}/${deductionKeys.length} deductions; verify not computed`,
          };
        }
      }
      return { passed: true, actual: `totalDeductions=${total} (present — assumed explicitly extracted)` };
    }

    default:
      return { skipped: true, skipReason: `unknown computed check type: "${check}"` };
  }
}

async function runTestCase(tc) {
  console.log(`  Running ${tc.id} (${tc.type}) — ${tc.method} ${tc.endpoint}`);

  // Log equivalent curl for debugging
  const authType = needsIapAuth(tc.endpoint) ? 'IAP' : 'API_KEY';
  const maskedKey = VERIFYIQ_KEY ? `${VERIFYIQ_KEY.slice(0, 3)}***` : '(unset)';
  const curlParts = [
    `curl -X ${tc.method} '${PREVIEW_URL}${tc.endpoint}'`,
    `-H 'Authorization: Bearer <${authType}_TOKEN>'`,
    `-H 'X-Tenant-Token: ${maskedKey}'`,
    `-H 'Content-Type: application/json'`,
  ];
  if (tc.payload) curlParts.push(`-d '${JSON.stringify(tc.payload)}'`);
  const curlCmd = curlParts.join(' \\\n    ');
  console.log(`  curl: ${curlCmd}`);

  let status, body;

  try {
    const client = await createPreviewClient(tc.endpoint);
    const res = await client.request({
      method: tc.method,
      url: tc.endpoint,
      data: tc.payload ?? undefined,
    });
    status = res.status;
    body   = res.data;
  } catch (err) {
    return { passed: false, actualResult: `Request error: ${err.message}`, curlCmd, failedAssertions: null, responseBody: null };
  }

  const expectedStatus = tc.expected_status ?? 200;
  const assertionResults = [];
  const warnings = [];

  if (status !== expectedStatus) {
    const snippet = JSON.stringify(body).slice(0, 300);
    assertionResults.push({
      path: 'HTTP status',
      description: `Expected HTTP ${expectedStatus}`,
      expected: String(expectedStatus),
      actual: String(status),
      passed: false,
    });
    return {
      passed: false,
      actualResult: `Expected HTTP ${expectedStatus}, got ${status}. Body: ${snippet}`,
      curlCmd,
      failedAssertions: `Expected status ${expectedStatus} but received ${status}`,
      assertionResults,
      responseBody: body,
    };
  }

  for (const assertion of (tc.assertions ?? [])) {
    // anyOf: at least one of the listed paths must exist and match
    if (assertion.anyOf) {
      let anyPassed = false;
      const tried = [];
      for (const alt of assertion.anyOf) {
        let value;
        try { value = resolvePath(body, alt.path); } catch { tried.push(`${alt.path} (not found)`); continue; }
        if (value == null) { tried.push(`${alt.path} (null)`); continue; }
        if (alt.pattern) {
          const hasI = alt.pattern.includes('(?i)');
          const re = new RegExp(alt.pattern.replace(/\(\?i\)/g, ''), hasI ? 'i' : '');
          if (re.test(String(value))) { anyPassed = true; tried.push(`${alt.path} = ${JSON.stringify(value)} ✓`); break; }
          tried.push(`${alt.path} = ${JSON.stringify(value)} (no match)`);
        } else {
          anyPassed = true; tried.push(`${alt.path} = ${JSON.stringify(value)} ✓`); break;
        }
      }
      const anyOfPath = assertion.anyOf.map(a => a.path).join(' | ');
      if (!anyPassed) {
        if (assertion.optional) {
          warnings.push({ path: anyOfPath, description: assertion.description, message: `optional anyOf not satisfied — skipped (tried: ${tried.join('; ')})` });
          assertionResults.push({
            path: anyOfPath,
            description: assertion.description,
            expected: 'any of: ' + assertion.anyOf.map(a => a.path).join(', '),
            actual: `(not found — optional, skipped): ${tried.join('; ')}`,
            passed: true,
            warning: true,
          });
          continue;
        }
        assertionResults.push({
          path: anyOfPath,
          description: assertion.description,
          expected: 'any of: ' + assertion.anyOf.map(a => a.path).join(', '),
          actual: tried.join('; '),
          passed: false,
        });
        return {
          passed: false,
          actualResult: `anyOf failed: ${tried.join('; ')}`,
          curlCmd,
          failedAssertions: `Assertion: \`${assertion.description}\`\nTried: ${tried.join('; ')}`,
          assertionResults,
          responseBody: body,
        };
      }
      assertionResults.push({
        path: anyOfPath,
        description: assertion.description,
        expected: 'any of: ' + assertion.anyOf.map(a => a.path).join(', '),
        actual: tried.join('; '),
        passed: true,
      });
      continue;
    }

    // Completeness score assertion — weighted field-presence scoring per documentData item
    if (assertion.assertionType === 'completenessScore') {
      const result = runCompletenessAssertion(assertion, body);
      const aPath  = 'completenessScore';

      if (result.skipped) {
        warnings.push({ path: aPath, description: assertion.description, message: result.skipReason });
        assertionResults.push({
          path:        aPath,
          description: assertion.description,
          expected:    `completeness ≥ ${assertion.thresholds?.pass ?? 90}/${assertion.maxScore ?? 100}`,
          actual:      `(skipped: ${result.skipReason})`,
          passed:      true,
          warning:     true,
        });
        continue;
      }

      // Emit a parseable line for the runner agent to extract per-fixture scores
      console.log(`  [completeness] ${tc.id} ${result.actual}`);

      assertionResults.push({
        path:        aPath,
        description: assertion.description,
        expected:    `completeness ≥ ${assertion.thresholds?.pass ?? 90}/${assertion.maxScore ?? 100}`,
        actual:      result.actual,
        passed:      result.passed,
        warning:     result.warning || false,
      });

      if (result.warning) {
        // WARN band: score >= 75 but < 90 — pass the test, note the warning
        warnings.push({
          path:        aPath,
          description: assertion.description,
          message:     `Completeness score ${result.score}/${result.maxScore} (${result.statusLabel}) — missing optional: ${result.missingOptional.join(', ') || 'none'}`,
        });
        continue;
      }

      if (!result.passed) {
        // FAIL band: score < 75 — hard fail
        return {
          passed:           false,
          actualResult:     `Completeness score too low: ${result.actual}`,
          curlCmd,
          failedAssertions: result.detail,
          assertionResults,
          responseBody:     body,
        };
      }
      continue;
    }

    // Computed (cross-field) assertion — evaluates mathematical relationships
    if (assertion.assertionType === 'computed') {
      const result = runComputedAssertion(assertion, body);
      const aPath  = `computed:${assertion.check}`;
      if (result.skipped) {
        warnings.push({ path: aPath, description: assertion.description, message: result.skipReason });
        assertionResults.push({
          path:        aPath,
          description: assertion.description,
          expected:    assertion.description,
          actual:      `(skipped: ${result.skipReason})`,
          passed:      true,
          warning:     true,
        });
        continue;
      }
      assertionResults.push({
        path:        aPath,
        description: assertion.description,
        expected:    assertion.description,
        actual:      result.actual,
        passed:      result.passed,
      });
      if (!result.passed) {
        return {
          passed:           false,
          actualResult:     `Computed check failed: ${assertion.description}`,
          curlCmd,
          failedAssertions: `Computed assertion: ${assertion.description}\n${result.detail}`,
          assertionResults,
          responseBody:     body,
        };
      }
      continue;
    }

    let value;
    try {
      value = resolvePath(body, assertion.path);
    } catch {
      // Field not found in response
      if (assertion.optional) {
        warnings.push({ path: assertion.path, description: assertion.description, message: 'optional field not found — skipped' });
        assertionResults.push({
          path: assertion.path,
          description: assertion.description,
          expected: assertion.pattern ?? '(exists)',
          actual: '(not found — optional, skipped)',
          passed: true,
          warning: true,
        });
        continue;
      }
      assertionResults.push({
        path: assertion.path,
        description: assertion.description,
        expected: assertion.pattern ?? '(exists)',
        actual: '(not found)',
        passed: false,
      });
      return {
        passed: false,
        actualResult: `Field not found: ${assertion.path}`,
        curlCmd,
        failedAssertions: `Path \`${assertion.path}\` not found in response`,
        assertionResults,
        responseBody: body,
      };
    }
    // Optional field present but null — treat same as missing
    if (value == null && assertion.optional) {
      warnings.push({ path: assertion.path, description: assertion.description, message: 'optional field is null — skipped' });
      assertionResults.push({
        path: assertion.path,
        description: assertion.description,
        expected: assertion.pattern ?? '(exists)',
        actual: '(null — optional, skipped)',
        passed: true,
        warning: true,
      });
      continue;
    }
    // Type assertion: structural check that doesn't rely on regex stringification
    if (assertion.assertionType === 'type') {
      const expected = assertion.expectedType;
      const isArr   = Array.isArray(value);
      const rawType = isArr ? 'array' : (value === null ? 'null' : typeof value);
      let typePassed = false;

      if      (expected === 'array')   typePassed = isArr && value.length > 0;
      else if (expected === 'object')  typePassed = value !== null && !isArr && typeof value === 'object';
      else if (expected === 'number')  typePassed = value !== null && (typeof value === 'number' || (!isNaN(parseFloat(value)) && isFinite(value)));
      else if (expected === 'boolean') typePassed = typeof value === 'boolean' || value === 'true' || value === 'false';
      else if (expected === 'string')  typePassed = typeof value === 'string' && value.length > 0;
      else                             typePassed = value != null;

      const typeDisplay = isArr ? `array[${value.length}]` : rawType;
      assertionResults.push({
        path: assertion.path,
        description: assertion.description,
        expected: `type:${expected}`,
        actual: typeDisplay,
        passed: typePassed,
      });
      if (!typePassed) {
        return {
          passed: false,
          actualResult: `\`${assertion.path}\` expected type ${expected}, got ${typeDisplay}`,
          curlCmd,
          failedAssertions: `Assertion: \`${assertion.description}\`\nPath: \`${assertion.path}\`\nExpected type: ${expected}\nActual type: ${typeDisplay}`,
          assertionResults,
          responseBody: body,
        };
      }
      continue;
    }

    if (assertion.pattern) {
      // Strip (?i) inline flag (not supported in JS) and use 'i' flag instead
      const hasInlineIgnoreCase = assertion.pattern.includes('(?i)');
      const cleanPattern = assertion.pattern.replace(/\(\?i\)/g, '');
      const flags = hasInlineIgnoreCase ? 'i' : '';

      // Normalise health status synonyms: treat "ok" and "healthy" as equivalent
      const re = new RegExp(cleanPattern, flags);
      let matched = re.test(String(value));
      if (!matched && isHealthStatusField(assertion.path) && HEALTH_STATUS_SYNONYMS.includes(String(value).toLowerCase())) {
        matched = HEALTH_STATUS_SYNONYMS.some(s => re.test(s));
      }
      assertionResults.push({
        path: assertion.path,
        description: assertion.description,
        expected: assertion.pattern,
        actual: String(value),
        passed: matched,
      });
      if (!matched) {
        return {
          passed: false,
          actualResult: `\`${assertion.path}\` = ${JSON.stringify(value)} did not match \`${assertion.pattern}\``,
          curlCmd,
          failedAssertions: `Assertion: \`${assertion.description}\`\nPath: \`${assertion.path}\`\nActual: ${JSON.stringify(value)}\nExpected pattern: \`${assertion.pattern}\``,
          assertionResults,
          responseBody: body,
        };
      }
    } else {
      assertionResults.push({
        path: assertion.path,
        description: assertion.description,
        expected: '(exists)',
        actual: String(value),
        passed: true,
      });
    }
  }

  const warnCount = warnings.length;
  const warnNote  = warnCount ? ` (${warnCount} warning${warnCount > 1 ? 's' : ''}: optional fields not found)` : '';
  return { passed: true, actualResult: `HTTP ${status} — all assertions passed${warnNote}`, curlCmd, failedAssertions: null, assertionResults, responseBody: body, warnings };
}

// ── Step 4b: Run batch test cases ────────────────────────────────────────────

const DECRYPT_URL = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWebhookBaseline() {
  const res = await axios.get(
    `${WEBHOOK_SERVER_URL}/token/${WEBHOOK_TOKEN_ID}/requests?per_page=50`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
  );
  return res.data?.data?.length ?? 0;
}

async function pollWebhookCallbacks(baselineCount, expectedCount, applicationId, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);
    const res = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${WEBHOOK_TOKEN_ID}/requests?per_page=50`,
      { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
    );
    const all = res.data?.data ?? [];
    // Callbacks are encrypted so we can't filter by applicationId in the ciphertext.
    // Since we create a fresh webhook token per run, count new callbacks by offset.
    const newRequests = all.slice(0, all.length - baselineCount);
    if (newRequests.length >= expectedCount) return newRequests;
    console.log(`    Polling… ${newRequests.length}/${expectedCount} callbacks received`);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${expectedCount} callbacks`);
}

async function decryptCallback(rawBody) {
  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: {
      Authorization: `Bearer ${await getIapBearerToken()}`,
      ...(USE_IAP && IAP_CLIENT_ID ? { 'Proxy-Authorization': `Bearer ${await getGoogleIdToken(IAP_CLIENT_ID)}` } : {}),
      'Content-Type': 'text/plain',
    },
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`Decrypt returned HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

function assertField(obj, path, label) {
  try {
    const val = resolvePath(obj, path);
    if (val == null) return `${label}: ${path} is null`;
    return null;
  } catch {
    return `${label}: ${path} not found`;
  }
}

/**
 * Parse a numeric amount that may be a number, a formatted string like "1,234.56",
 * or a negative string like "-500.00". Returns NaN for non-numeric values.
 */
function parseNumericAmount(val) {
  if (val == null) return NaN;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  return cleaned ? parseFloat(cleaned) : NaN;
}

/**
 * Deep validator for BankStatement / GcashTransactionHistory document-level callbacks.
 * Returns { checks, passed, allErrors }.
 *
 * checks = {
 *   schemaValidation:    { passed, errors[] }
 *   structureValidation: { passed, errors[] }
 *   keyFieldsMatched:    { passed, errors[] }
 *   contentValidation:   { passed, errors[] }
 * }
 */
function validateBankStatementDocCallback(decrypted) {
  const checks = {
    schemaValidation:   { passed: true, errors: [] },
    structureValidation: { passed: true, errors: [] },
    keyFieldsMatched:   { passed: true, errors: [] },
    contentValidation:  { passed: true, errors: [] },
  };

  // ── Schema validation ─────────────────────────────────────────────────────
  const schemaRequired = ['applicationId', 'submissionId', 'documentId', 'publicUserId', 'status', 'documentType'];
  for (const f of schemaRequired) {
    if (decrypted[f] == null) {
      checks.schemaValidation.errors.push(`required field absent: ${f}`);
    } else if (typeof decrypted[f] !== 'string') {
      checks.schemaValidation.errors.push(`${f} must be string, got ${typeof decrypted[f]}`);
    }
  }
  checks.schemaValidation.passed = checks.schemaValidation.errors.length === 0;

  // ── Structure validation ──────────────────────────────────────────────────
  if (decrypted.status !== 'COMPLETED') {
    checks.structureValidation.errors.push(`status="${decrypted.status}", expected COMPLETED`);
  }
  const docType = decrypted.documentType ?? '';
  const isGCash = docType === 'GcashTransactionHistory' || docType === 'GCashTransactionHistory';
  const isBankStatementType = docType === 'BankStatement' || docType === 'BANK_STATEMENT';
  if (!isBankStatementType && !isGCash) {
    checks.structureValidation.errors.push(`documentType="${docType}", expected BANK_STATEMENT or BankStatement`);
  }
  if (!decrypted.documentClassification) {
    checks.structureValidation.errors.push('documentClassification is missing or empty');
  }

  const ocr = decrypted.ocrResult;
  if (!ocr || typeof ocr !== 'object') {
    checks.structureValidation.errors.push('ocrResult is missing or not an object');
  } else {
    for (const section of ['fraudChecks', 'qualityCheck', 'completenessCheck']) {
      if (!ocr[section] || typeof ocr[section] !== 'object') {
        checks.structureValidation.errors.push(`ocrResult.${section} is missing or not an object`);
      }
    }
  }
  checks.structureValidation.passed = checks.structureValidation.errors.length === 0;

  // ── Decision-threshold gating ─────────────────────────────────────────────
  // Extract document-level scores to decide validation depth.
  const qualityScore      = parseNumericAmount(ocr?.qualityCheck?.overall_score  ?? decrypted.qualityScore);
  const completenessScore = parseNumericAmount(ocr?.completenessCheck?.completeness_score ?? decrypted.completenessScore);
  const authenticityScore = parseNumericAmount(decrypted.authenticityScore ?? ocr?.authenticityScore);

  const QUALITY_THRESHOLD      = 60;
  const COMPLETENESS_THRESHOLD = 80;
  const AUTHENTICITY_THRESHOLD = 70;

  const hasQuality      = !isNaN(qualityScore);
  const hasCompleteness = !isNaN(completenessScore);
  const hasAuthenticity = !isNaN(authenticityScore);

  const lowQuality        = hasQuality && qualityScore < QUALITY_THRESHOLD;
  const lowCompleteness   = hasCompleteness && completenessScore < COMPLETENESS_THRESHOLD;
  const lowAuthenticity   = hasAuthenticity && authenticityScore < AUTHENTICITY_THRESHOLD;
  const allScoresPass     = (!hasQuality || qualityScore >= QUALITY_THRESHOLD)
                         && (!hasCompleteness || completenessScore >= COMPLETENESS_THRESHOLD)
                         && (!hasAuthenticity || authenticityScore >= AUTHENTICITY_THRESHOLD);

  // Attach score metadata so callers (cross-validation) can read gating decisions
  const scoreGating = {
    qualityScore:      hasQuality      ? qualityScore      : null,
    completenessScore: hasCompleteness ? completenessScore : null,
    authenticityScore: hasAuthenticity ? authenticityScore : null,
    decision: 'FULL_VALIDATION', // default
  };

  if (lowQuality) {
    scoreGating.decision = 'ABORTED_LOW_QUALITY';
    console.log(`    ⚠ quality=${qualityScore} < ${QUALITY_THRESHOLD} — ABORTED_LOW_QUALITY (docId=${decrypted.documentId})`);
    checks.contentValidation.passed = true;
    checks.contentValidation.errors = [`ABORTED_LOW_QUALITY: quality=${qualityScore} < ${QUALITY_THRESHOLD} — OCR data, fraud checks, transactions, and app-level field validation skipped`];
    // Key fields: still check error fields and timestamps
    for (const f of ['error', 'errorMessage', 'errorCode', 'failureReason']) {
      if (decrypted[f] != null) {
        checks.keyFieldsMatched.errors.push(`unexpected error field present: ${f}="${decrypted[f]}"`);
      }
    }
    for (const f of ['processedAt', 'createdAt', 'updatedAt', 'completedAt']) {
      if (decrypted[f] != null && isNaN(Date.parse(decrypted[f]))) {
        checks.keyFieldsMatched.errors.push(`invalid timestamp: ${f}="${decrypted[f]}"`);
      }
    }
    checks.keyFieldsMatched.passed = checks.keyFieldsMatched.errors.length === 0;
    const allErrors = Object.values(checks).flatMap(c => c.errors);
    return { checks, passed: allErrors.filter(e => !e.startsWith('ABORTED_LOW_QUALITY')).length === 0, allErrors, scoreGating };
  }

  if (lowCompleteness || lowAuthenticity) {
    scoreGating.decision = 'DOC_LEVEL_ONLY';
    const reasons = [];
    if (lowCompleteness) reasons.push(`completeness=${completenessScore} < ${COMPLETENESS_THRESHOLD}`);
    if (lowAuthenticity) reasons.push(`authenticity=${authenticityScore} < ${AUTHENTICITY_THRESHOLD}`);
    console.log(`    ⚠ ${reasons.join(', ')} — DOC_LEVEL_ONLY (docId=${decrypted.documentId})`);
  }

  // ── Key fields matched ────────────────────────────────────────────────────
  for (const f of ['error', 'errorMessage', 'errorCode', 'failureReason']) {
    if (decrypted[f] != null) {
      checks.keyFieldsMatched.errors.push(`unexpected error field present: ${f}="${decrypted[f]}"`);
    }
  }
  for (const f of ['processedAt', 'createdAt', 'updatedAt', 'completedAt']) {
    if (decrypted[f] != null && isNaN(Date.parse(decrypted[f]))) {
      checks.keyFieldsMatched.errors.push(`invalid timestamp: ${f}="${decrypted[f]}"`);
    }
  }
  checks.keyFieldsMatched.passed = checks.keyFieldsMatched.errors.length === 0;

  // ── Content validation ────────────────────────────────────────────────────
  if (!isFraudFlagged(decrypted) && ocr && typeof ocr === 'object') {
    // Structure checks that require ocrResult sub-objects
    if (!ocr.documentData || typeof ocr.documentData !== 'object') {
      checks.structureValidation.errors.push('ocrResult.documentData is missing or not an object');
      checks.structureValidation.passed = false;
    }
    const txAtRoot = Array.isArray(ocr.transactions) ? ocr.transactions : null;
    const txAtData = ocr.documentData && Array.isArray(ocr.documentData.transactions)
      ? ocr.documentData.transactions
      : null;
    if (!txAtRoot && !txAtData) {
      checks.structureValidation.errors.push(
        'ocrResult.transactions (or ocrResult.documentData.transactions) is missing or not an array'
      );
      checks.structureValidation.passed = checks.structureValidation.errors.length === 0;
    }

    const docData = ocr.documentData;
    const transactions = (Array.isArray(ocr.transactions) ? ocr.transactions : null)
                      ?? (docData && Array.isArray(docData.transactions) ? docData.transactions : null);

    if (!transactions || transactions.length === 0) {
      checks.contentValidation.errors.push('transactions array is empty or missing');
    } else {
      // Per-transaction field checks
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (!tx.postingDate) {
          checks.contentValidation.errors.push(`transactions[${i}] missing postingDate`);
        }
        if (!tx.transactionDescription) {
          checks.contentValidation.errors.push(`transactions[${i}] missing transactionDescription`);
        }
        if (tx.debitAmount == null && tx.creditAmount == null) {
          checks.contentValidation.errors.push(`transactions[${i}] missing both debitAmount and creditAmount`);
        }
      }

      // Arithmetic cross-validation: calculated_debits / calculated_credits
      const calcDebitsRaw  = docData?.calculated_debits  ?? ocr.calculated_debits;
      const calcCreditsRaw = docData?.calculated_credits ?? ocr.calculated_credits;
      const summDebitsRaw  = docData?.summary_debits     ?? ocr.summary_debits;
      const summCreditsRaw = docData?.summary_credits    ?? ocr.summary_credits;

      if (calcDebitsRaw != null) {
        const calcDebits = parseNumericAmount(calcDebitsRaw);
        if (isNaN(calcDebits)) {
          checks.contentValidation.errors.push(`calculated_debits="${calcDebitsRaw}" is not numeric`);
        } else {
          const sumDebits = transactions.reduce((acc, tx) => {
            const v = parseNumericAmount(tx.debitAmount ?? 0);
            return acc + (isNaN(v) ? 0 : v);
          }, 0);
          if (Math.abs(calcDebits - sumDebits) > 0.02) {
            checks.contentValidation.errors.push(
              `calculated_debits (${calcDebits}) does not match sum of debitAmounts (${sumDebits.toFixed(2)})`
            );
          }
          if (summDebitsRaw != null) {
            const summDebits = parseNumericAmount(summDebitsRaw);
            if (!isNaN(summDebits) && Math.abs(summDebits - calcDebits) > 0.02) {
              checks.contentValidation.errors.push(
                `summary_debits (${summDebits}) does not match calculated_debits (${calcDebits})`
              );
            }
          }
        }
      }

      if (calcCreditsRaw != null) {
        const calcCredits = parseNumericAmount(calcCreditsRaw);
        if (isNaN(calcCredits)) {
          checks.contentValidation.errors.push(`calculated_credits="${calcCreditsRaw}" is not numeric`);
        } else {
          const sumCredits = transactions.reduce((acc, tx) => {
            const v = parseNumericAmount(tx.creditAmount ?? 0);
            return acc + (isNaN(v) ? 0 : v);
          }, 0);
          if (Math.abs(calcCredits - sumCredits) > 0.02) {
            checks.contentValidation.errors.push(
              `calculated_credits (${calcCredits}) does not match sum of creditAmounts (${sumCredits.toFixed(2)})`
            );
          }
          if (summCreditsRaw != null) {
            const summCredits = parseNumericAmount(summCreditsRaw);
            if (!isNaN(summCredits) && Math.abs(summCredits - calcCredits) > 0.02) {
              checks.contentValidation.errors.push(
                `summary_credits (${summCredits}) does not match calculated_credits (${calcCredits})`
              );
            }
          }
        }
      }
    }

    // Fraud/quality/completeness sections: check actual API response fields
    if (ocr.fraudChecks && typeof ocr.fraudChecks === 'object') {
      for (const f of ['gs_isFraudulent_bankstatement', 'gs_overallFraudScore_bankstatement', 'gs_fraudCheckStatus_bankstatement']) {
        if (!(f in ocr.fraudChecks)) {
          checks.contentValidation.errors.push(`ocrResult.fraudChecks missing ${f}`);
        }
      }
    }
    if (ocr.qualityCheck && typeof ocr.qualityCheck === 'object') {
      if (Object.keys(ocr.qualityCheck).length === 0) {
        checks.contentValidation.errors.push('ocrResult.qualityCheck is an empty object');
      }
    }
    if (ocr.completenessCheck && typeof ocr.completenessCheck === 'object') {
      if (Object.keys(ocr.completenessCheck).length === 0) {
        checks.contentValidation.errors.push('ocrResult.completenessCheck is an empty object');
      }
    }
  }
  checks.contentValidation.passed = checks.contentValidation.errors.length === 0;

  const allErrors = Object.values(checks).flatMap(c => c.errors);
  return { checks, passed: allErrors.length === 0, allErrors, scoreGating };
}

function isFraudFlagged(decrypted) {
  try {
    const flag = resolvePath(decrypted, 'ocrResult.fraudChecks.gs_isFraudulent_bankstatement');
    return flag === true || flag === 'true';
  } catch { return false; }
}

/**
 * Validate a document-level callback. Returns { checks, passed, allErrors }.
 * BankStatement / GcashTransactionHistory routes to the deep validator.
 * Other types use a lightweight structural check for backward compat.
 * context.expectedApplicationId is used for cross-run ID matching.
 */
function validateDocumentCallback(decrypted, context = {}) {
  const docType = decrypted?.documentType ?? '';
  const isBankStatement = (
    docType === 'BankStatement' ||
    docType === 'BANK_STATEMENT' ||
    docType === 'GcashTransactionHistory' ||
    docType === 'GCashTransactionHistory'
  );

  if (isFraudFlagged(decrypted)) {
    console.log(`    ⚠ Fraud-flagged document (docId=${decrypted.documentId}) — skipping parse-field assertions`);
    return {
      checks: {
        schemaValidation:   { passed: true, errors: [] },
        structureValidation: { passed: true, errors: [] },
        keyFieldsMatched:   { passed: true, errors: [] },
        contentValidation:  { passed: true, errors: ['skipped — fraud-flagged document'] },
      },
      passed: true,
      allErrors: [],
    };
  }

  if (isBankStatement) {
    const result = validateBankStatementDocCallback(decrypted);
    // General: applicationId must match the batch submission
    if (context.expectedApplicationId && decrypted.applicationId !== context.expectedApplicationId) {
      const err = `applicationId mismatch: expected ${context.expectedApplicationId}, got ${decrypted.applicationId}`;
      result.checks.keyFieldsMatched.errors.push(err);
      result.checks.keyFieldsMatched.passed = false;
      result.allErrors.push(err);
      result.passed = false;
    }
    return result;
  }

  // ── Non-BankStatement: lightweight structural check ───────────────────────
  const coreFields = ['applicationId', 'submissionId', 'documentId', 'publicUserId', 'status', 'documentType', 'documentClassification'];
  const structErrors = coreFields.map(f => assertField(decrypted, f, 'doc-callback')).filter(Boolean);

  const ocrMissing = assertField(decrypted, 'ocrResult', 'doc-callback');
  if (ocrMissing) structErrors.push(ocrMissing);

  const contentErrors = [];
  if (!ocrMissing) {
    if (docType === 'ElectricUtilityBillingStatement') {
      contentErrors.push(
        ...['ocrResult.documentData.bill_period_start', 'ocrResult.documentData.bill_period_end']
          .map(f => assertField(decrypted, f, 'doc-callback')).filter(Boolean)
      );
    } else if (docType === 'Payslip') {
      const gross = assertField(decrypted, 'ocrResult.documentData.gross_pay', 'doc-callback');
      const net   = assertField(decrypted, 'ocrResult.documentData.net_pay', 'doc-callback');
      if (gross && net) contentErrors.push('doc-callback: neither ocrResult.documentData.gross_pay nor net_pay found');
    }
  }

  const keyErrors = [];
  if (context.expectedApplicationId && decrypted.applicationId !== context.expectedApplicationId) {
    keyErrors.push(`doc-callback: applicationId mismatch: expected ${context.expectedApplicationId}, got ${decrypted.applicationId}`);
  }
  // No unexpected error fields
  for (const f of ['error', 'errorMessage', 'errorCode', 'failureReason']) {
    if (decrypted[f] != null) keyErrors.push(`doc-callback: unexpected error field: ${f}="${decrypted[f]}"`);
  }

  const allErrors = [...structErrors, ...keyErrors, ...contentErrors];
  return {
    checks: {
      schemaValidation:   { passed: true, errors: [] },
      structureValidation: { passed: structErrors.length === 0, errors: structErrors },
      keyFieldsMatched:   { passed: keyErrors.length === 0, errors: keyErrors },
      contentValidation:  { passed: contentErrors.length === 0, errors: contentErrors },
    },
    passed: allErrors.length === 0,
    allErrors,
  };
}

/**
 * Validate an application-level callback. Returns { checks, passed, allErrors }.
 * context.expectedApplicationId is used for cross-run ID matching.
 */
function validateApplicationCallback(decrypted, context = {}) {
  const checks = {
    schemaValidation:   { passed: true, errors: [] },
    structureValidation: { passed: true, errors: [] },
    keyFieldsMatched:   { passed: true, errors: [] },
    contentValidation:  { passed: true, errors: [] },
  };

  // ── Schema validation ─────────────────────────────────────────────────────
  const schemaRequired = ['applicationId', 'submissionId', 'publicUserId', 'status'];
  for (const f of schemaRequired) {
    if (decrypted[f] == null) {
      checks.schemaValidation.errors.push(`required field absent: ${f}`);
    } else if (typeof decrypted[f] !== 'string') {
      checks.schemaValidation.errors.push(`${f} must be string, got ${typeof decrypted[f]}`);
    }
  }
  checks.schemaValidation.passed = checks.schemaValidation.errors.length === 0;

  // ── Determine doc types from ocrResult.documents ──────────────────────────
  const documents = [];
  try {
    const docs = resolvePath(decrypted, 'ocrResult.documents');
    if (Array.isArray(docs)) documents.push(...docs);
  } catch { /* ignore */ }
  const docTypes = new Set(documents.map(d => d.documentType).filter(Boolean));
  try {
    const dt = resolvePath(decrypted, 'ocrResult.documentType');
    if (dt) docTypes.add(dt);
  } catch { /* ignore */ }

  const hasBankStatement = docTypes.has('BankStatement') || docTypes.has('BANK_STATEMENT');
  const hasGCash = docTypes.has('GcashTransactionHistory') || docTypes.has('GCashTransactionHistory');

  // ── Structure validation ──────────────────────────────────────────────────
  if (hasBankStatement) {
    const cf = decrypted.ocrResult?.computedFields;
    if (!cf) {
      checks.structureValidation.errors.push('missing ocrResult.computedFields');
    } else {
      if (!cf.BANK_STATEMENT) {
        checks.structureValidation.errors.push('missing ocrResult.computedFields.BANK_STATEMENT');
      } else {
        for (const f of [
          'gs_180days_valid_bankstatement',
          'gs_90days_consec_bankstatement',
          'gs_totaldebit_bankstatement',
          'gs_totalcredit_bankstatement',
          'gs_inferredincome_bankstatement',
        ]) {
          if (cf.BANK_STATEMENT[f] == null) {
            checks.structureValidation.errors.push(`missing ocrResult.computedFields.BANK_STATEMENT.${f}`);
          }
        }
      }
      if (cf.crossCheckFindings == null) {
        checks.structureValidation.errors.push('missing ocrResult.computedFields.crossCheckFindings');
      }
    }
  } else if (hasGCash) {
    const cf = decrypted.ocrResult?.computedFields;
    if (!cf) {
      checks.structureValidation.errors.push('missing ocrResult.computedFields');
    } else if (!cf.BANK_STATEMENT) {
      checks.structureValidation.errors.push('missing ocrResult.computedFields.BANK_STATEMENT');
    } else {
      for (const f of ['gs_180days_valid_bankstatement', 'gs_90days_consec_bankstatement']) {
        if (cf.BANK_STATEMENT[f] == null) {
          checks.structureValidation.errors.push(`missing ocrResult.computedFields.BANK_STATEMENT.${f}`);
        }
      }
    }
  }
  checks.structureValidation.passed = checks.structureValidation.errors.length === 0;

  // ── Key fields matched ────────────────────────────────────────────────────
  if (context.expectedApplicationId && decrypted.applicationId !== context.expectedApplicationId) {
    checks.keyFieldsMatched.errors.push(
      `applicationId mismatch: expected ${context.expectedApplicationId}, got ${decrypted.applicationId}`
    );
  }
  for (const f of ['error', 'errorMessage', 'errorCode', 'failureReason']) {
    if (decrypted[f] != null) {
      checks.keyFieldsMatched.errors.push(`unexpected error field: ${f}="${decrypted[f]}"`);
    }
  }
  for (const f of ['processedAt', 'createdAt', 'updatedAt', 'completedAt']) {
    if (decrypted[f] != null && isNaN(Date.parse(decrypted[f]))) {
      checks.keyFieldsMatched.errors.push(`invalid timestamp: ${f}="${decrypted[f]}"`);
    }
  }
  checks.keyFieldsMatched.passed = checks.keyFieldsMatched.errors.length === 0;

  // ── Content validation (BANK_STATEMENT) ──────────────────────────────────
  if (hasBankStatement && decrypted.ocrResult?.computedFields?.BANK_STATEMENT) {
    const bs = decrypted.ocrResult.computedFields.BANK_STATEMENT;
    if (bs.available !== true) {
      checks.contentValidation.errors.push(
        `computedFields.BANK_STATEMENT.available="${bs.available}", expected true`
      );
    }
    for (const f of ['gs_totaldebit_bankstatement', 'gs_totalcredit_bankstatement']) {
      if (bs[f] != null && isNaN(parseNumericAmount(bs[f]))) {
        checks.contentValidation.errors.push(
          `computedFields.BANK_STATEMENT.${f}="${bs[f]}" is not numeric`
        );
      }
    }
    const ccf = decrypted.ocrResult.computedFields.crossCheckFindings;
    if (ccf != null && typeof ccf === 'object' && !Array.isArray(ccf) && Object.keys(ccf).length === 0) {
      checks.contentValidation.errors.push('computedFields.crossCheckFindings is an empty object');
    }
  }
  checks.contentValidation.passed = checks.contentValidation.errors.length === 0;

  const allErrors = Object.values(checks).flatMap(c => c.errors);
  return { checks, passed: allErrors.length === 0, allErrors };
}

/**
 * Compute a confidence score and QA summary for an application-level callback report.
 *
 * Deductions from base score of 100:
 *   -10 per failed check (FAIL)
 *   -5  per WARNING entry in crossValidation (e.g. summary_* mismatch)
 *   -2  per SKIPPED_OPTIONAL entry in crossValidation
 *   No deduction when crossValidation is absent (not applicable — only 1 BankStatement doc)
 *
 * Returns a qaSummary object ready to embed in the report JSON.
 */
function computeApplicationQaSummary(report) {
  const { checks, crossValidation } = report;

  const safeLen = (arr) => Array.isArray(arr) ? arr.length : 0;

  let failCount =
    safeLen(checks.schemaValidation?.errors)   +
    safeLen(checks.structureValidation?.errors) +
    safeLen(checks.keyFieldsMatched?.errors)    +
    safeLen(checks.contentValidation?.errors);

  let warningCount = 0;
  let skippedOptionalCount = 0;
  if (crossValidation) {
    for (const entry of Object.values(crossValidation)) {
      if (entry.status === 'FAIL')             failCount++;
      if (entry.status === 'WARNING')          warningCount++;
      if (entry.status === 'SKIPPED_OPTIONAL') skippedOptionalCount++;
    }
  }

  const confidence = Math.max(0, 100 - failCount * 10 - warningCount * 5 - skippedOptionalCount * 2);
  const result     = failCount === 0 ? 'PASS' : 'FAIL';

  return { result, confidence, failCount, warningCount, skippedOptionalCount };
}

/**
 * Group bank statement doc totals by account identity for cross-validation scoping.
 *
 * Grouping priority:
 *   1. accountNumber (primary — most specific)
 *   2. accountHolderName (fallback when accountNumber is absent)
 *   3. bankName (last resort — grouped with docs sharing the same bank)
 *
 * Docs with no identity fields at all are placed in a catch-all group keyed '__unknown__'.
 * Returns a Map<string, docTotals[]>. Only groups with 2+ docs are cross-validation eligible.
 */
function groupBankStatementsByAccount(bankStatementDocTotals) {
  const groups = new Map();

  for (const doc of bankStatementDocTotals) {
    let key;
    if (doc.accountNumber) {
      key = `acct:${doc.accountNumber}`;
    } else if (doc.accountHolderName) {
      key = `holder:${doc.accountHolderName}`;
    } else if (doc.bankName) {
      key = `bank:${doc.bankName}`;
    } else {
      key = '__unknown__';
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  return groups;
}

/**
 * Cross-validate BANK_STATEMENT document totals against application computedFields.
 * Respects decision-threshold gating from doc-level scoreGating.
 *
 * A batch-upload can contain 1 or many documents — the API creates exactly 1
 * applicationId per batch. crossValidation only runs when BOTH conditions are met:
 *   1. The same applicationId has 2+ BankStatement documents in the same account group.
 *   2. All documents in the group pass score-gating (no ABORTED_LOW_QUALITY or DOC_LEVEL_ONLY).
 *
 * Single-document batches: run normal doc + app callback validation only. No crossValidation.
 *
 * Mutates appReport (crossValidation, mismatchDetails, checks) and allErrors.
 * Only sets appReport.crossValidation when validation actually runs.
 */
function crossValidateBankStatementTotals(bankStatementDocTotals, appDecrypted, appReport, allErrors) {
  // Eligibility: need 2+ BankStatement docs to cross-validate totals
  if (bankStatementDocTotals.length < 2) return;

  // Score-gating: if any doc has degraded quality, skip silently
  const hasAborted = bankStatementDocTotals.some(d => d.scoreGating?.decision === 'ABORTED_LOW_QUALITY');
  const hasDocOnly = bankStatementDocTotals.some(d => d.scoreGating?.decision === 'DOC_LEVEL_ONLY');
  if (hasAborted || hasDocOnly) {
    const reasons = bankStatementDocTotals
      .filter(d => d.scoreGating?.decision === 'ABORTED_LOW_QUALITY' || d.scoreGating?.decision === 'DOC_LEVEL_ONLY')
      .map(d => `docId=${d.docId} gating=${d.scoreGating.decision}`);
    console.log(`    ⚠ cross-validation skipped — score gating: ${reasons.join(', ')}`);
    return;
  }

  const bs = appDecrypted.ocrResult?.computedFields?.BANK_STATEMENT;
  const cv = {};

  // Required: ALL docs must have valid numeric values. If any doc is missing, the sum is
  // incomplete and the comparison is meaningless — treat as FAIL per business rules.
  const hasCalcDebits  = bankStatementDocTotals.every(d => !isNaN(d.calculatedDebits));
  const hasCalcCredits = bankStatementDocTotals.every(d => !isNaN(d.calculatedCredits));
  const docTotalCalcDebits  = bankStatementDocTotals.reduce((s, d) => s + (isNaN(d.calculatedDebits)  ? 0 : d.calculatedDebits),  0);
  const docTotalCalcCredits = bankStatementDocTotals.reduce((s, d) => s + (isNaN(d.calculatedCredits) ? 0 : d.calculatedCredits), 0);
  const appDebits  = bs ? parseNumericAmount(bs.gs_totaldebit_bankstatement  ?? '') : NaN;
  const appCredits = bs ? parseNumericAmount(bs.gs_totalcredit_bankstatement ?? '') : NaN;

  // ── PRIMARY (REQUIRED): calculated_debits vs gs_totaldebit_bankstatement ──
  if (!hasCalcDebits) {
    const badDocs = bankStatementDocTotals.filter(d => isNaN(d.calculatedDebits)).map(d => d.docId).join(', ');
    const msg = `cross_validation_debits: FAIL — calculated_debits missing or non-numeric for doc(s): ${badDocs} (required)`;
    allErrors.push(msg);
    appReport.checks.contentValidation.errors.push(msg);
    appReport.checks.contentValidation.passed = false;
    appReport.mismatchDetails.push(msg);
    cv.debits = { status: 'FAIL', detail: msg };
  } else if (!bs || isNaN(appDebits)) {
    const reason = !bs ? 'application computedFields.BANK_STATEMENT absent' : 'application gs_totaldebit_bankstatement missing or non-numeric';
    const msg = `cross_validation_debits: FAIL — ${reason} (required)`;
    allErrors.push(msg);
    appReport.checks.contentValidation.errors.push(msg);
    appReport.checks.contentValidation.passed = false;
    appReport.mismatchDetails.push(msg);
    cv.debits = { status: 'FAIL', detail: msg };
  } else {
    const diff = Math.abs(appDebits - docTotalCalcDebits);
    if (diff > 0.02) {
      const msg = `cross-validation: gs_totaldebit_bankstatement (${appDebits}) !== sum(calculated_debits) (${docTotalCalcDebits.toFixed(2)}), diff=${diff.toFixed(2)}`;
      allErrors.push(msg);
      appReport.checks.contentValidation.errors.push(msg);
      appReport.checks.contentValidation.passed = false;
      appReport.mismatchDetails.push(`cross_validation_debits: doc_sum=${docTotalCalcDebits.toFixed(2)} app_total=${appDebits} diff=${diff.toFixed(2)}`);
      cv.debits = { status: 'FAIL', detail: msg };
    } else {
      cv.debits = { status: 'PASS', detail: `matched within tolerance (diff=${diff.toFixed(2)})` };
    }
  }

  // ── PRIMARY (REQUIRED): calculated_credits vs gs_totalcredit_bankstatement ──
  if (!hasCalcCredits) {
    const badDocs = bankStatementDocTotals.filter(d => isNaN(d.calculatedCredits)).map(d => d.docId).join(', ');
    const msg = `cross_validation_credits: FAIL — calculated_credits missing or non-numeric for doc(s): ${badDocs} (required)`;
    allErrors.push(msg);
    appReport.checks.contentValidation.errors.push(msg);
    appReport.checks.contentValidation.passed = false;
    appReport.mismatchDetails.push(msg);
    cv.credits = { status: 'FAIL', detail: msg };
  } else if (!bs || isNaN(appCredits)) {
    const reason = !bs ? 'application computedFields.BANK_STATEMENT absent' : 'application gs_totalcredit_bankstatement missing or non-numeric';
    const msg = `cross_validation_credits: FAIL — ${reason} (required)`;
    allErrors.push(msg);
    appReport.checks.contentValidation.errors.push(msg);
    appReport.checks.contentValidation.passed = false;
    appReport.mismatchDetails.push(msg);
    cv.credits = { status: 'FAIL', detail: msg };
  } else {
    const diff = Math.abs(appCredits - docTotalCalcCredits);
    if (diff > 0.02) {
      const msg = `cross-validation: gs_totalcredit_bankstatement (${appCredits}) !== sum(calculated_credits) (${docTotalCalcCredits.toFixed(2)}), diff=${diff.toFixed(2)}`;
      allErrors.push(msg);
      appReport.checks.contentValidation.errors.push(msg);
      appReport.checks.contentValidation.passed = false;
      appReport.mismatchDetails.push(`cross_validation_credits: doc_sum=${docTotalCalcCredits.toFixed(2)} app_total=${appCredits} diff=${diff.toFixed(2)}`);
      cv.credits = { status: 'FAIL', detail: msg };
    } else {
      cv.credits = { status: 'PASS', detail: `matched within tolerance (diff=${diff.toFixed(2)})` };
    }
  }

  // ── OPTIONAL: summary_debits / summary_credits vs calculated fields ───────
  const hasSummDebits  = bankStatementDocTotals.some(d => !isNaN(d.summaryDebits));
  const hasSummCredits = bankStatementDocTotals.some(d => !isNaN(d.summaryCredits));
  const docTotalSummDebits  = bankStatementDocTotals.reduce((s, d) => s + (isNaN(d.summaryDebits)  ? 0 : d.summaryDebits),  0);
  const docTotalSummCredits = bankStatementDocTotals.reduce((s, d) => s + (isNaN(d.summaryCredits) ? 0 : d.summaryCredits), 0);

  if (!hasSummDebits) {
    cv.summary_debits = { status: 'SKIPPED_OPTIONAL', detail: 'document summary_debits missing or non-numeric' };
  } else if (hasCalcDebits) {
    const diff = Math.abs(docTotalSummDebits - docTotalCalcDebits);
    if (diff > 0.02) {
      appReport.mismatchDetails.push(`cross_validation_summary_debits: WARNING — summary_debits (${docTotalSummDebits.toFixed(2)}) !== calculated_debits (${docTotalCalcDebits.toFixed(2)}), diff=${diff.toFixed(2)}`);
      cv.summary_debits = { status: 'WARNING', detail: `summary_debits (${docTotalSummDebits.toFixed(2)}) !== calculated_debits (${docTotalCalcDebits.toFixed(2)}), diff=${diff.toFixed(2)}` };
    } else {
      cv.summary_debits = { status: 'PASS', detail: `matched within tolerance (diff=${diff.toFixed(2)})` };
    }
  }

  if (!hasSummCredits) {
    cv.summary_credits = { status: 'SKIPPED_OPTIONAL', detail: 'document summary_credits missing or non-numeric' };
  } else if (hasCalcCredits) {
    const diff = Math.abs(docTotalSummCredits - docTotalCalcCredits);
    if (diff > 0.02) {
      appReport.mismatchDetails.push(`cross_validation_summary_credits: WARNING — summary_credits (${docTotalSummCredits.toFixed(2)}) !== calculated_credits (${docTotalCalcCredits.toFixed(2)}), diff=${diff.toFixed(2)}`);
      cv.summary_credits = { status: 'WARNING', detail: `summary_credits (${docTotalSummCredits.toFixed(2)}) !== calculated_credits (${docTotalCalcCredits.toFixed(2)}), diff=${diff.toFixed(2)}` };
    } else {
      cv.summary_credits = { status: 'PASS', detail: `matched within tolerance (diff=${diff.toFixed(2)})` };
    }
  }

  // Only attach crossValidation when we actually produced results
  if (Object.keys(cv).length > 0) {
    appReport.crossValidation = cv;
  }
}

async function runBatchTestCase(tc) {
  console.log(`  Running ${tc.id} (batch) — POST /ai-gateway/batch-upload`);

  const missingBatchVars = [];
  if (!WEBHOOK_TOKEN_ID) missingBatchVars.push('WEBHOOK_TOKEN_ID');
  if (!GOOGLE_SA_KEY_FILE) missingBatchVars.push('GOOGLE_SA_KEY_FILE');
  if (missingBatchVars.length) {
    const note = `⚠️ SKIPPED — batch TC requires ${missingBatchVars.join(', ')}`;
    console.log(`  ${note}`);
    return {
      passed: false,
      actualResult: note,
      curlCmd: '(batch — env vars missing)',
      failedAssertions: null,
      skipped: true,
    };
  }

  // Always overwrite callbacks with real webhook URLs. LLM-generated TCs may
  // include placeholder callback blocks with <project>/<token> strings — the
  // runner is the source of truth for webhook URLs.
  const payload = JSON.parse(JSON.stringify(tc.payload));
  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  payload.callbacks = {
    documentResult: {
      url: `${WEBHOOK_SERVER_URL}/${WEBHOOK_TOKEN_ID}`,
      method: 'POST',
      headers: webhookIapHeader,
    },
    applicationResult: {
      url: `${WEBHOOK_SERVER_URL}/${WEBHOOK_TOKEN_ID}`,
      method: 'POST',
      headers: webhookIapHeader,
    },
  };

  const curlCmd = [
    `curl -X POST '${PREVIEW_URL}/ai-gateway/batch-upload'`,
    `-H 'X-Tenant-Token: ${VERIFYIQ_KEY ? VERIFYIQ_KEY.slice(0, 3) + '***' : '(unset)'}'`,
    `-H 'Authorization: Bearer <IAP_TOKEN>'`,
    `-H 'Content-Type: application/json'`,
    `-d '${JSON.stringify(payload).slice(0, 500)}...'`,
  ].join(' \\\n    ');
  console.log(`  curl: ${curlCmd}`);

  // 1. Get baseline webhook count
  let baselineCount;
  try {
    baselineCount = await getWebhookBaseline();
    console.log(`    Webhook baseline: ${baselineCount} existing requests`);
  } catch (err) {
    return { passed: false, actualResult: `Webhook baseline failed: ${err.message}`, curlCmd, failedAssertions: null };
  }

  // 2. POST to batch-upload
  let status, body;
  try {
    const iapBearer = await getIapBearerToken();
    const batchHeaders = {
      Authorization: `Bearer ${iapBearer}`,
      'X-Tenant-Token': VERIFYIQ_KEY,
      'Content-Type': 'application/json',
    };
    if (USE_IAP && IAP_CLIENT_ID) {
      batchHeaders['Proxy-Authorization'] = `Bearer ${await getGoogleIdToken(IAP_CLIENT_ID)}`;
    }
    const client = axios.create({
      baseURL: resolveBaseUrlForEndpoint('/ai-gateway/batch-upload'),
      headers: batchHeaders,
      validateStatus: () => true,
    });
    const res = await client.post('/ai-gateway/batch-upload', payload);
    status = res.status;
    body = res.data;
  } catch (err) {
    return { passed: false, actualResult: `POST error: ${err.message}`, curlCmd, failedAssertions: null };
  }

  console.log(`    POST response: HTTP ${status}`);

  if (status !== 200) {
    return {
      passed: false,
      actualResult: `Expected HTTP 200, got ${status}. Body: ${JSON.stringify(body).slice(0, 300)}`,
      curlCmd,
      failedAssertions: `Expected 200, got ${status}`,
    };
  }

  // 3. Assert initial response fields (only require applicationId — status may be ACCEPTED or FAILED)
  if (!body.applicationId) {
    return { passed: false, actualResult: 'Missing applicationId in response', curlCmd, failedAssertions: 'Missing applicationId' };
  }
  console.log(`    ✓ HTTP 200, applicationId=${body.applicationId}, status=${body.status}`);

  // 4. Poll for webhook callbacks
  const docCount = payload.payload?.documents?.length ?? 1;
  const expectedCallbacks = docCount + 1; // N document callbacks + 1 application callback
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${docCount} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    ✓ Received ${callbacks.length} callbacks`);
  } catch (err) {
    return { passed: false, actualResult: err.message, curlCmd, failedAssertions: `Polling: ${err.message}` };
  }

  // 5. Decrypt and validate each callback
  //    Group by applicationId — a batch upload may contain multiple applicationIds.
  //    applicationId is the real validation boundary, not the batch container.
  const allErrors = [];
  const callbackReports = [];
  // Per-applicationId grouping: { docIndices, appIndex, appDecrypted, bankStatementDocTotals }
  const appGroups = new Map();

  function getAppGroup(appId) {
    if (!appGroups.has(appId)) {
      appGroups.set(appId, { docIndices: [], appIndex: -1, appDecrypted: null, bankStatementDocTotals: [] });
    }
    return appGroups.get(appId);
  }

  for (let cbIdx = 0; cbIdx < callbacks.length; cbIdx++) {
    const cb = callbacks[cbIdx];
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);

    const report = {
      index: cbIdx,
      received: true,
      type: 'unknown',
      documentId: null,
      applicationId: null,
      decryptOk: false,
      deliveryStatus: 'PENDING',
      checks: {
        schemaValidation:   { passed: false, errors: ['decrypt pending'] },
        structureValidation: { passed: false, errors: ['decrypt pending'] },
        keyFieldsMatched:   { passed: false, errors: ['decrypt pending'] },
        contentValidation:  { passed: false, errors: ['decrypt pending'] },
      },
      mismatchDetails: [],
    };

    let decrypted;
    try {
      decrypted = await decryptCallback(rawBody);
      report.decryptOk = true;
      report.deliveryStatus = 'PASS';
      report.applicationId = decrypted.applicationId ?? null;
    } catch (err) {
      const msg = `Decrypt failed: ${err.message}`;
      report.deliveryStatus = 'FAIL';
      report.checks = {
        schemaValidation:   { passed: false, errors: [msg] },
        structureValidation: { passed: false, errors: ['decryption failed'] },
        keyFieldsMatched:   { passed: false, errors: ['decryption failed'] },
        contentValidation:  { passed: false, errors: ['decryption failed'] },
      };
      report.mismatchDetails = [msg];
      allErrors.push(msg);
      callbackReports.push(report);
      continue;
    }

    const isDocLevel = !!decrypted.documentId;
    report.type = isDocLevel ? 'document' : 'application';
    report.documentId = decrypted.documentId ?? null;
    const cbAppId = decrypted.applicationId ?? body.applicationId;

    if (isDocLevel) {
      const group = getAppGroup(cbAppId);
      group.docIndices.push(cbIdx);
      const validation = validateDocumentCallback(decrypted, { expectedApplicationId: cbAppId });
      report.checks = validation.checks;
      report.mismatchDetails = validation.allErrors;
      if (validation.scoreGating) report.scoreGating = validation.scoreGating;
      if (!validation.passed) {
        allErrors.push(...validation.allErrors.map(e => `doc-callback: ${e}`));
        console.log(`    ✗ Document callback FAILED (docId=${decrypted.documentId}) — ${validation.allErrors.length} error(s)`);
        for (const e of validation.allErrors) console.log(`      • ${e}`);
      } else {
        console.log(`    ✓ Document callback OK (docId=${decrypted.documentId})`);
      }
      // Capture BANK_STATEMENT totals for cross-validation (only BankStatement family)
      const docType = decrypted.documentType ?? '';
      if (docType === 'BANK_STATEMENT' || docType === 'BankStatement') {
        const ocr = decrypted.ocrResult ?? {};
        const docData = ocr.documentData;
        const calcDebitsRaw  = docData?.calculated_debits  ?? ocr.calculated_debits;
        const calcCreditsRaw = docData?.calculated_credits ?? ocr.calculated_credits;
        const summDebitsRaw  = docData?.summary_debits     ?? ocr.summary_debits;
        const summCreditsRaw = docData?.summary_credits    ?? ocr.summary_credits;
        // Extract account identity fields from summary array for account grouping
        const summaryArr = Array.isArray(docData?.summary) ? docData.summary : [];
        const firstSummary = summaryArr[0] ?? {};
        group.bankStatementDocTotals.push({
          docId:             decrypted.documentId,
          calcDebitsRaw,
          calcCreditsRaw,
          calculatedDebits:  parseNumericAmount(calcDebitsRaw  ?? ''),
          calculatedCredits: parseNumericAmount(calcCreditsRaw ?? ''),
          summDebitsRaw,
          summCreditsRaw,
          summaryDebits:     parseNumericAmount(summDebitsRaw  ?? ''),
          summaryCredits:    parseNumericAmount(summCreditsRaw ?? ''),
          scoreGating:       validation.scoreGating ?? null,
          // Account identity for cross-validation grouping
          accountNumber:      firstSummary.accountNumber     ?? null,
          accountHolderName:  firstSummary.accountHolderName ?? null,
          bankName:           firstSummary.bankName          ?? null,
        });
      }
    } else {
      const group = getAppGroup(cbAppId);
      group.appIndex = cbIdx;
      group.appDecrypted = decrypted;
      const validation = validateApplicationCallback(decrypted, { expectedApplicationId: cbAppId });
      report.checks = validation.checks;
      report.mismatchDetails = validation.allErrors;
      if (!validation.passed) {
        allErrors.push(...validation.allErrors.map(e => `app-callback: ${e}`));
        console.log(`    ✗ Application callback FAILED (appId=${decrypted.applicationId}) — ${validation.allErrors.length} error(s)`);
        for (const e of validation.allErrors) console.log(`      • ${e}`);
      } else {
        console.log(`    ✓ Application callback OK (appId=${decrypted.applicationId})`);
      }
    }

    callbackReports.push(report);
  }

  // ── Per-applicationId post-processing ──────────────────────────────────────
  for (const [appId, group] of appGroups) {
    // Ordering: document callbacks must all arrive before the application callback
    if (group.appIndex !== -1 && group.docIndices.length > 0) {
      const lastDocIdx = Math.max(...group.docIndices);
      if (group.appIndex < lastDocIdx) {
        const orderErr = `app-callback: received before all document callbacks (app at index ${group.appIndex}, last doc at ${lastDocIdx})`;
        allErrors.push(orderErr);
        const appReport = callbackReports.find(r => r.type === 'application' && r.applicationId === appId);
        if (appReport) {
          appReport.checks.keyFieldsMatched.errors.push(orderErr);
          appReport.checks.keyFieldsMatched.passed = false;
          appReport.mismatchDetails.push(orderErr);
        }
      }
    }

    // Cross-validate BANK_STATEMENT doc totals vs application computedFields.
    // Group by account identity first — only same-account docs are compared.
    if (group.bankStatementDocTotals.length >= 2) {
      if (!group.appDecrypted) {
        console.log(`    ⚠ ${group.bankStatementDocTotals.length} BankStatement docs for appId=${appId} — cross-validation skipped (no app callback)`);
      } else {
        const appReport = callbackReports.find(r => r.type === 'application' && r.applicationId === appId);
        if (appReport) {
          const accountGroups = groupBankStatementsByAccount(group.bankStatementDocTotals);
          for (const [acctKey, acctDocs] of accountGroups) {
            if (acctDocs.length < 2) {
              console.log(`    ℹ Account group [${acctKey}] has ${acctDocs.length} doc — cross-validation not applicable`);
              continue;
            }
            console.log(`    ℹ Cross-validating ${acctDocs.length} BankStatement docs for appId=${appId}, account group [${acctKey}]`);
            crossValidateBankStatementTotals(acctDocs, group.appDecrypted, appReport, allErrors);
          }
        }
      }
    } else if (group.bankStatementDocTotals.length === 1) {
      console.log(`    ℹ Single BankStatement for appId=${appId} — multi-doc cross-validation not applicable`);
    }
  }

  // Emit structured per-callback report lines for runner to parse
  console.log(`\n  Callback Validation Report (${tc.id}):`);
  for (const report of callbackReports) {
    const c = report.checks;
    const p = (chk) => chk.passed ? 'PASS' : 'FAIL';
    const idLabel = report.type === 'document'
      ? `docId=${report.documentId ?? '?'}`
      : `appId=${report.applicationId ?? '?'}`;
    console.log(
      `  [cb-report] idx=${report.index} type=${report.type} ${idLabel}` +
      ` delivery=${report.deliveryStatus}` +
      ` decrypt=${report.decryptOk ? 'OK' : 'FAIL'}` +
      ` schema=${p(c.schemaValidation)}` +
      ` structure=${p(c.structureValidation)}` +
      ` keyFields=${p(c.keyFieldsMatched)}` +
      ` content=${p(c.contentValidation)}`
    );
    if (report.mismatchDetails.length > 0) {
      for (const e of report.mismatchDetails) console.log(`    ✗ ${e}`);
    }
    // Emit JSON line for runner to capture full detail without regex fragility
    const jsonPayload = {
      index: report.index,
      type: report.type,
      documentId: report.documentId,
      applicationId: report.applicationId,
      deliveryStatus: report.deliveryStatus,
      decryptOk: report.decryptOk,
      checks: {
        schemaValidation:   { passed: c.schemaValidation.passed,   errors: c.schemaValidation.errors },
        structureValidation: { passed: c.structureValidation.passed, errors: c.structureValidation.errors },
        keyFieldsMatched:   { passed: c.keyFieldsMatched.passed,   errors: c.keyFieldsMatched.errors },
        contentValidation:  { passed: c.contentValidation.passed,  errors: c.contentValidation.errors },
      },
      mismatchDetails: report.mismatchDetails,
    };
    if (report.scoreGating) jsonPayload.scoreGating = report.scoreGating;
    if (report.crossValidation) jsonPayload.crossValidation = report.crossValidation;
    if (report.type === 'application') {
      const qaSummary = computeApplicationQaSummary(report);
      report.qaSummary  = qaSummary;
      jsonPayload.qaSummary = qaSummary;
    }
    console.log(`  [cb-report-json] ${JSON.stringify(jsonPayload)}`);
  }

  if (allErrors.length) {
    return {
      passed: false,
      actualResult: `Callback validation: ${allErrors.length} error(s): ${allErrors.slice(0, 3).join('; ')}${allErrors.length > 3 ? ` … (+${allErrors.length - 3} more)` : ''}`,
      curlCmd,
      failedAssertions: allErrors.join('\n'),
      callbackReports,
    };
  }

  return {
    passed: true,
    actualResult: `HTTP 200 ACCEPTED — ${callbacks.length} callbacks validated`,
    curlCmd,
    failedAssertions: null,
    callbackReports,
  };
}

// ── Step 5: Post results comment ──────────────────────────────────────────────

async function postResultsComment(summary, results) {
  const passed = results.filter(r => r.passed).length;
  const total  = results.length;
  const icon   = passed === total ? '✅' : passed > 0 ? '⚠️' : '❌';

  const rows = results.map(r => {
    const rowIcon = r.passed ? '✅' : '❌';
    const cu      = r.taskUrl ? `[${r.taskId}](${r.taskUrl})` : '—';
    return `| ${rowIcon} | \`${r.id}\` | ${r.type} | ${r.title} | ${r.actualResult} | ${cu} |`;
  }).join('\n');

  const now  = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const body = [
    `## ${icon} QA Results — ${passed}/${total} passed`,
    '',
    `**Changes analysed:** ${summary}`,
    '',
    '| | ID | Type | Test | Result | ClickUp |',
    '|---|---|---|---|---|---|',
    rows,
    '',
    `<sub>Generated by claude-code-action (QA) · ${now}</sub>`,
  ].join('\n');

  await github.post(`/repos/${PR_REPO}/issues/${PR_NUMBER}/comments`, { body });
  console.log('→ Results comment posted.');
}

// ── Baseline health checks (always run before TCs) ──────────────────────────

async function runBaselineHealthChecks() {
  console.log('→ Running baseline health checks...\n');
  const errors = [];

  // 1. GET /health — status ok/healthy, revision exists, service exists
  try {
    const client = await createPreviewClient('/health');
    const res = await client.get('/health');
    if (res.status !== 200) {
      errors.push(`GET /health returned HTTP ${res.status}`);
    } else {
      const b = res.data;
      const s = String(b.status ?? '').toLowerCase();
      if (s !== 'ok' && s !== 'healthy') errors.push(`GET /health: status="${b.status}", expected "ok" or "healthy"`);
      if (!b.revision) errors.push('GET /health: missing revision');
      if (!b.service) errors.push('GET /health: missing service');
      console.log(`  ✓ /health — status=${b.status}, revision=${b.revision}, service=${b.service}`);
    }
  } catch (err) {
    errors.push(`GET /health failed: ${err.message}`);
  }

  // 2. GET /health/detailed — services exist, redis/pg healthy, force_failure off
  try {
    const client = await createPreviewClient('/health/detailed');
    const res = await client.get('/health/detailed');
    if (res.status !== 200) {
      errors.push(`GET /health/detailed returned HTTP ${res.status}`);
    } else {
      const b = res.data;
      for (const svc of ['vlm', 'sightengine', 'openai', 'textract']) {
        if (!b.services?.[svc]) errors.push(`GET /health/detailed: missing services.${svc}`);
      }
      if (b.cache?.redis?.healthy !== true) errors.push('GET /health/detailed: redis.healthy is not true');
      if (b.cache?.postgresql?.healthy !== true) errors.push('GET /health/detailed: postgresql.healthy is not true');
      if (b.cache?.force_failure_enabled !== false) errors.push(`GET /health/detailed: force_failure_enabled=${b.cache?.force_failure_enabled}, expected false`);
      if (!errors.length) console.log('  ✓ /health/detailed — all services present, redis/pg healthy, force_failure off');
    }
  } catch (err) {
    errors.push(`GET /health/detailed failed: ${err.message}`);
  }

  // 3. GET /ai-gateway/health/gateway-circuit-breakers — boost_callback.state=closed
  try {
    const client = await createPreviewClient('/ai-gateway/health/gateway-circuit-breakers');
    const res = await client.get('/ai-gateway/health/gateway-circuit-breakers');
    if (res.status !== 200) {
      errors.push(`GET /ai-gateway/health/gateway-circuit-breakers returned HTTP ${res.status}`);
    } else {
      const state = res.data?.boost_callback?.state;
      if (state !== 'closed') errors.push(`GET /ai-gateway/health/gateway-circuit-breakers: boost_callback.state="${state}", expected "closed"`);
      else console.log(`  ✓ /ai-gateway/health/gateway-circuit-breakers — boost_callback.state=closed`);
    }
  } catch (err) {
    errors.push(`GET /ai-gateway/health/gateway-circuit-breakers failed: ${err.message}`);
  }

  if (errors.length) {
    console.error(`\n❌ Baseline health checks failed (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  • ${e}`);
    console.error('\nEnvironment is unhealthy — aborting test run.\n');
    process.exit(1);
  }
  console.log('  ✓ All baseline health checks passed\n');
}

// ── Run summary report ───────────────────────────────────────────────────────

const GENERIC_FIELDS = new Set([
  'basicPay', 'grossPay', 'netPay', 'employee_name', 'employer_name',
]);

function classifyAssertedField(path) {
  // Extract the terminal field name from paths like "documentData.*.grossPay"
  const parts = path.split('.');
  return parts[parts.length - 1];
}

// ── Run history (append-only JSONL per suite) ────────────────────────────────

const HISTORY_DIR = 'qa-runs/.history';
const MAX_HISTORY_ENTRIES = 100;

/**
 * Read previous run entries for a suite from its JSONL history file.
 * Returns an array of parsed objects (most recent last).
 */
function readHistory(suiteSlugValue) {
  const path = `${HISTORY_DIR}/${suiteSlugValue}.jsonl`;
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

/**
 * Append one run record to the suite's JSONL history file.
 * Truncates to MAX_HISTORY_ENTRIES if needed.
 */
function appendHistory(suiteSlugValue, record) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const path = `${HISTORY_DIR}/${suiteSlugValue}.jsonl`;
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');

  // Truncate if over limit
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length > MAX_HISTORY_ENTRIES) {
    writeFileSync(path, lines.slice(lines.length - MAX_HISTORY_ENTRIES).join('\n') + '\n', 'utf8');
  }
}

/**
 * Build a run record from current results.
 */
function buildRunRecord(suiteSlugValue, results) {
  return {
    timestamp: new Date().toISOString(),
    suite: suiteSlugValue,
    results: results.map(r => {
      const entry = { tc_id: r.id, passed: r.passed, title: r.title || '' };
      if (!r.passed) {
        const failedAr = r.assertionResults?.find(ar => !ar.passed);
        entry.failure_reason = failedAr
          ? `${failedAr.description}: expected ${failedAr.expected}, got ${failedAr.actual}`
          : (r.actualResult || 'unknown');
      }
      return entry;
    }),
  };
}

/**
 * Compare current run results against the previous run for the same suite.
 * Returns { previousTimestamp, fixed, regressed, stillFailing, stillPassingCount, newTcs, goneTcs, suiteRegenerated }
 */
function compareRuns(currentResults, previousEntry) {
  if (!previousEntry) return null;

  const prevMap = new Map();
  for (const r of previousEntry.results) {
    prevMap.set(r.tc_id, r);
  }

  // Build a title-based fallback map for unmatched TCs
  const prevByTitle = new Map();
  for (const r of previousEntry.results) {
    if (r.title) prevByTitle.set(r.title, r);
  }

  const fixed = [];
  const regressed = [];
  const stillFailing = [];
  let stillPassingCount = 0;
  const newTcs = [];
  const matchedPrevIds = new Set();

  for (const cur of currentResults) {
    let prev = prevMap.get(cur.tc_id);
    if (prev) {
      matchedPrevIds.add(cur.tc_id);
    } else if (cur.title && prevByTitle.has(cur.title)) {
      prev = prevByTitle.get(cur.title);
      matchedPrevIds.add(prev.tc_id);
    }

    if (!prev) {
      newTcs.push(cur);
      continue;
    }

    if (prev.passed && cur.passed) {
      stillPassingCount++;
    } else if (!prev.passed && cur.passed) {
      fixed.push(cur);
    } else if (prev.passed && !cur.passed) {
      regressed.push(cur);
    } else {
      // both failing
      stillFailing.push(cur);
    }
  }

  const goneTcs = previousEntry.results.filter(r => !matchedPrevIds.has(r.tc_id));
  const suiteRegenerated = newTcs.length > 0 || goneTcs.length > 0;

  return {
    previousTimestamp: previousEntry.timestamp,
    fixed,
    regressed,
    stillFailing,
    stillPassingCount,
    newTcs,
    goneTcs,
    suiteRegenerated,
  };
}

/**
 * Count consecutive failures for a TC across history entries (most recent first).
 */
function consecutiveFailures(tcId, tcTitle, historyEntries) {
  let count = 0;
  for (let i = historyEntries.length - 1; i >= 0; i--) {
    const entry = historyEntries[i];
    const match = entry.results.find(r => r.tc_id === tcId || (tcTitle && r.title === tcTitle));
    if (match && !match.passed) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Format the "CHANGES SINCE LAST RUN" section for the summary.
 */
function formatComparisonSection(comparison, historyEntries) {
  if (!comparison) return 'First run for this suite — no comparison available.';

  const lines = [];
  lines.push('CHANGES SINCE LAST RUN');
  lines.push('──────────────────────');

  // Format relative time
  const prevDate = new Date(comparison.previousTimestamp);
  const now = new Date();
  const diffMs = now - prevDate;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  let ago;
  if (diffDays > 0) ago = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  else if (diffHours > 0) ago = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  else ago = 'just now';
  lines.push(`Last run: ${comparison.previousTimestamp} (${ago})`);

  if (comparison.suiteRegenerated) {
    lines.push('');
    lines.push('Suite regenerated since last run — TC IDs may not align with previous run. Comparison limited.');
  }

  lines.push('');

  // FIXED
  lines.push(`✓ FIXED          (${comparison.fixed.length})`);
  if (comparison.fixed.length === 0) {
    lines.push('  None.');
  } else {
    for (const tc of comparison.fixed) {
      lines.push(`  ${tc.tc_id || tc.id}  ${tc.title}`);
    }
  }

  lines.push('');

  // REGRESSED
  lines.push(`✗ REGRESSED      (${comparison.regressed.length})`);
  if (comparison.regressed.length === 0) {
    lines.push('  None.');
  } else {
    for (const tc of comparison.regressed) {
      lines.push(`  ${tc.tc_id || tc.id}  ${tc.title}`);
    }
  }

  lines.push('');

  // STILL FAILING
  lines.push(`✗ STILL FAILING  (${comparison.stillFailing.length})`);
  if (comparison.stillFailing.length === 0) {
    lines.push('  None.');
  } else {
    for (const tc of comparison.stillFailing) {
      const id = tc.tc_id || tc.id;
      const consec = consecutiveFailures(id, tc.title, historyEntries);
      // +1 for current run which isn't in history yet
      const total = consec + 1;
      const suffix = total >= 2 ? ` — failing for ${total} consecutive runs` : '';
      lines.push(`  ${id}  ${tc.title}${suffix}`);
    }
  }

  lines.push('');
  lines.push(`Stable: ${comparison.stillPassingCount} still passing.`);

  if (comparison.newTcs.length > 0) {
    lines.push('');
    lines.push(`NEW (${comparison.newTcs.length})`);
    for (const tc of comparison.newTcs) {
      lines.push(`  ${tc.tc_id || tc.id}  ${tc.title}`);
    }
  }

  if (comparison.goneTcs.length > 0) {
    lines.push('');
    lines.push(`GONE (${comparison.goneTcs.length})`);
    for (const tc of comparison.goneTcs) {
      lines.push(`  ${tc.tc_id}  ${tc.title}`);
    }
  }

  return lines.join('\n');
}

function generateRunSummary(results, testCases, suiteSlugValue) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = PR_NUMBER ? `pr${PR_NUMBER}` : 'manual-run';
  const filename = `${date}-${slug}.md`;

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const verdict = passed === total ? 'PASS' : passed > 0 ? 'PARTIAL' : 'FAIL';
  const icon = passed === total ? '✅' : passed > 0 ? '⚠️' : '❌';

  // Collect all failures
  const failures = [];
  const httpStatusViolations = [];
  const ticketScopedFields = new Set();
  const genericFieldsAsserted = new Set();

  for (const r of results) {
    // Find matching TC for assertion details
    const tc = testCases.find(t => t.id === r.id);

    // Check each assertion for field classification
    if (tc?.assertions) {
      for (const a of tc.assertions) {
        if (a.anyOf) {
          for (const alt of a.anyOf) {
            const f = classifyAssertedField(alt.path);
            if (GENERIC_FIELDS.has(f)) genericFieldsAsserted.add(f);
            else ticketScopedFields.add(f);
          }
        } else if (a.path) {
          // HTTP status path isn't a field
          if (a.path === 'HTTP status') continue;
          // Skip non-document fields (fraudScore, authenticityScore, completenessScore)
          if (!a.path.includes('.') && !GENERIC_FIELDS.has(a.path)) continue;
          const f = classifyAssertedField(a.path);
          if (GENERIC_FIELDS.has(f)) genericFieldsAsserted.add(f);
          else ticketScopedFields.add(f);
        }
      }
    }

    if (!r.passed) {
      // Check for HTTP status assertion violations
      if (r.assertionResults) {
        for (const ar of r.assertionResults) {
          if (ar.path === 'HTTP status' && !ar.passed) {
            httpStatusViolations.push(r.id);
          }
        }
      }

      // Build failure entry
      const failedAr = r.assertionResults?.find(ar => !ar.passed);
      const entry = { id: r.id };
      if (failedAr) {
        entry.assertion = failedAr.description;
        entry.expected = failedAr.expected;
        entry.actual = failedAr.actual;
        // Triage hint for common patterns
        if (failedAr.path === 'HTTP status') {
          entry.likely = 'API error or auth issue — check service health';
        } else if (failedAr.actual === '(not found)') {
          entry.likely = 'field missing from response — check parser mapping';
        }
      } else {
        entry.assertion = r.actualResult;
        entry.expected = '(pass)';
        entry.actual = r.actualResult;
      }
      failures.push(entry);
    }
  }

  // Build the report
  const lines = [];
  lines.push(`═══════════════════════════════════════════════════════`);
  lines.push(`QA RUN SUMMARY — ${date}`);
  lines.push(`Target: ${PR_NUMBER ? `PR #${PR_NUMBER}` : 'manual run'}`);
  lines.push(`Result: ${verdict} ${icon}  (${passed}/${total})`);
  lines.push(`═══════════════════════════════════════════════════════`);
  lines.push(``);

  // Failures
  lines.push(`FAILURES`);
  lines.push(`────────`);
  if (failures.length === 0) {
    lines.push(`None.`);
  } else {
    for (const f of failures) {
      lines.push(`${f.id}`);
      lines.push(`         assertion: ${f.assertion}`);
      lines.push(`         expected: ${f.expected}`);
      lines.push(`         actual:   ${f.actual}`);
      if (f.likely) {
        lines.push(`         likely:   ${f.likely}`);
      }
    }
  }
  lines.push(``);

  // Assertion scope check
  lines.push(`ASSERTION SCOPE CHECK`);
  lines.push(`─────────────────────`);
  lines.push(`Ticket-scoped fields asserted:`);
  if (ticketScopedFields.size === 0) {
    lines.push(`  (none detected)`);
  } else {
    for (const f of [...ticketScopedFields].sort()) {
      lines.push(`  ✓ ${f}`);
    }
  }

  const genericCount = genericFieldsAsserted.size;
  const genericVerdict = genericCount === 0 ? 'good — rule holding' : 'REVIEW';
  lines.push(`Generic fields asserted:  ${genericCount}  ("${genericVerdict}")`);
  if (genericCount > 0) {
    lines.push(`  ${[...genericFieldsAsserted].sort().join(', ')}`);
  }
  lines.push(``);

  // Notes
  lines.push(`NOTES`);
  lines.push(`─────`);

  if (httpStatusViolations.length > 0) {
    lines.push(`- ⚠ HTTP status assertion detected in ${httpStatusViolations.join(', ')}`);
  }

  const skipped = results.filter(r => r.actualResult?.includes('SKIPPED'));
  if (skipped.length > 0) {
    lines.push(`- ${skipped.length} test case(s) skipped (fixture unavailable)`);
  }

  if (failures.length === 0 && httpStatusViolations.length === 0 && skipped.length === 0) {
    lines.push(`- Clean run, no issues.`);
  } else if (httpStatusViolations.length === 0 && skipped.length === 0 && failures.length > 0) {
    lines.push(`- ${failures.length} assertion failure(s) — see FAILURES above.`);
  }

  // Run-over-run comparison
  let comparisonSection = '';
  if (suiteSlugValue) {
    const history = readHistory(suiteSlugValue);
    const previousEntry = history.length > 0 ? history[history.length - 1] : null;
    const comparison = compareRuns(
      results.map(r => ({ tc_id: r.id, passed: r.passed, title: r.title || '' })),
      previousEntry,
    );
    comparisonSection = formatComparisonSection(comparison, history);

    lines.push('');
    lines.push(comparisonSection);
  }

  lines.push(`═══════════════════════════════════════════════════════`);

  const report = lines.join('\n');

  // Write to qa-runs/
  const dir = 'qa-runs';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${filename}`, report + '\n', 'utf8');

  // Append structured record to history
  if (suiteSlugValue) {
    const record = buildRunRecord(suiteSlugValue, results);
    appendHistory(suiteSlugValue, record);
  }

  // Print to stdout
  console.log('\n' + report);

  return { filename, report };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Require at least one input source (unless re-running existing TCs)
  if (!cliFlags['skip-generation'] && !cliFlags.pr && !cliFlags.clickup?.length && !cliFlags.fixture?.length) {
    console.error('Error: provide --pr <owner/repo#number>, --clickup <task-id>, or --fixture <gs://...> (or combine them).');
    console.error('See --help for examples.');
    process.exit(1);
  }

  // Resolve target environment URL (may probe preview, fall back to dev)
  PREVIEW_URL = await resolveServiceUrl();

  validateConfig();

  // Can only post to a PR if we have one
  const shouldPost = !DISABLE_REMOTE_POSTING && !cliFlags['dry-run'] && !cliFlags['no-comment'] && !!cliFlags.pr;

  // ── Parse ad-hoc fixtures from --fixture flags ──────────────────────────────
  let adHocFixtures = [];
  if (cliFlags.fixture?.length) {
    for (const raw of cliFlags.fixture) {
      adHocFixtures.push(parseFixtureFlag(raw));
    }
    console.log(`→ ${adHocFixtures.length} ad-hoc fixture(s) from --fixture flags`);
    for (const f of adHocFixtures) {
      console.log(`  • ${f.fileType}: ${f.file}`);
    }
  }

  // ── Orchestration: diff + ClickUp + fixtures → generate → run → post ──────
  // Suite persistence: save/load test cases per PR/ticket so re-runs are stable.
  const slug = cliFlags['skip-generation'] ? null : suiteSlug(cliFlags);
  const suiteDir = 'qa-suites';
  const suitePath = slug ? `${suiteDir}/${slug}.json` : null;

  if (cliFlags['skip-generation']) {
    // Power-user path: use test-cases.json directly, no suite logic
  } else if (suitePath && existsSync(suitePath) && !cliFlags.regenerate) {
    // Existing suite found — reuse it
    const raw = readFileSync(suitePath, 'utf8');
    const suite = JSON.parse(raw);
    const mtime = new Date(JSON.parse(JSON.stringify(
      // stat is sync, but we just need the date from the file content
      suite._generated || '(unknown date)'
    )));
    console.log(`→ Loaded existing suite from ${suitePath} (${suite.test_cases?.length ?? 0} test cases)`);
    console.log(`  Reusing existing suite from ${suite._generated || 'unknown date'}. Use --regenerate to create fresh test cases.`);
    writeFileSync('test-cases.json', JSON.stringify(suite, null, 2));
  } else {
    // Generate fresh test cases
    if (cliFlags.regenerate && suitePath && existsSync(suitePath)) {
      console.log(`→ --regenerate flag set, regenerating test cases (overwriting ${suitePath})`);
    } else if (suitePath) {
      console.log(`→ No existing suite found, generating fresh...`);
    }

    let diff = null;
    let clickUpContext = '';

    if (cliFlags.pr) {
      diff = await fetchDiff(
        PR_REPO, PR_NUMBER,
        cliFlags['diff-source'],
        cliFlags['diff-file'],
      );
    }

    if (cliFlags.clickup?.length) {
      clickUpContext = await fetchClickUpContext(cliFlags.clickup);
    }

    if (diff || clickUpContext || adHocFixtures.length) {
      generateTestCases({ diff, clickUpContext, adHocFixtures });
    }

    // Persist to suite file for future re-runs
    if (suitePath && existsSync('test-cases.json')) {
      if (!existsSync(suiteDir)) mkdirSync(suiteDir, { recursive: true });
      const generated = JSON.parse(readFileSync('test-cases.json', 'utf8'));
      generated._generated = new Date().toISOString();
      writeFileSync(suitePath, JSON.stringify(generated, null, 2));
      console.log(`  ✓ Suite saved to ${suitePath}`);
    }
  }

  const { summary, test_cases: testCases } = loadTestCases();
  console.log(`→ ${testCases.length} test cases loaded\n`);

  await runBaselineHealthChecks();

  if (!shouldPost) {
    console.log('  [run_qa] Comment posting disabled — skipping PR metadata fetch and ClickUp setup');
  } else {
    let pr = null;
    try {
      pr = await getPr();
    } catch (err) {
      console.warn(`  ⚠ PR metadata fetch failed — skipping ClickUp setup and continuing: ${err.message}`);
    }
    if (pr) {
      await createClickUpList(pr);
    }
  }

  // Create a fresh webhook token for batch tests (only if env vars are available)
  const hasBatchTests = testCases.some(tc => tc.type === 'batch');
  const batchEnvReady = GOOGLE_SA_KEY_FILE && WEBHOOK_SERVER_URL;
  if (hasBatchTests && batchEnvReady) {
    WEBHOOK_TOKEN_ID = await createWebhookToken();
  } else if (hasBatchTests) {
    console.warn('  ⚠ Batch TCs found but GOOGLE_SA_KEY_FILE / WEBHOOK_SERVER_URL not set — batch TCs will be skipped');
  }

  const results = [];
  try {
    for (const tc of testCases) {
      // Skip TCs flagged as needing a fixture upload
      if (tc.needs_fixture) {
        const note = tc.fixture_note || 'Fixture not found in gs://qa-automation-dev — upload required';
        console.log(`  ⚠️ ${tc.id}: SKIPPED — ${note}`);

        // Create ClickUp task with "to do" status + needs-fixture tag
        let taskId = null, taskUrl = null;
        if (clickupListId) {
          try {
            const { data } = await clickup.post(`/list/${clickupListId}/task`, {
              name: `${tc.id} - ${tc.title}`,
              description: buildDescription(tc),
              tags: [tc.type, 'qa-auto', 'needs-fixture'],
              status: 'to do',
            });
            taskId = data.id;
            taskUrl = data.url;
            console.log(`  ✓ ClickUp: ${taskUrl}`);

            // Post the fixture_note as a comment
            await clickup.post(`/task/${taskId}/comment`, {
              comment_text: [
                '**Result:** ⚠️ SKIPPED — fixture not available',
                '',
                `**Note:** ${note}`,
                '',
                'Upload the required fixture to gs://qa-automation-dev/ and re-run the workflow.',
              ].join('\n'),
            });
          } catch (err) {
            console.warn(`  ⚠ ClickUp create/update failed for skipped TC ${tc.id}: ${err.message}`);
          }
        }

        results.push({
          ...tc,
          passed: false,
          actualResult: `⚠️ SKIPPED — ${note}`,
          taskId,
          taskUrl,
        });
        continue;
      }

      const { id: taskId, url: taskUrl } = await createClickUpTask(tc);
      const runner = tc.type === 'batch' ? runBatchTestCase : runTestCase;
      const { passed, actualResult, curlCmd, failedAssertions, assertionResults, responseBody } = await runner(tc);
      await updateClickUpTask(taskId, tc, actualResult, passed, curlCmd, failedAssertions, assertionResults, responseBody);

      console.log(`  ${passed ? '✅' : '❌'} ${tc.id}: ${actualResult}`);
      results.push({ ...tc, passed, actualResult, assertionResults, taskId, taskUrl });
    }
  } finally {
    if (hasBatchTests) {
      await deleteWebhookToken(WEBHOOK_TOKEN_ID);
    }
  }

  console.log();
  if (!shouldPost) {
    console.log('→ Comment posting skipped (--dry-run, --no-comment, or DISABLE_REMOTE_POSTING)');
  } else {
    await postResultsComment(summary, results);
  }

  const passedCount = results.filter(r => r.passed).length;
  console.log(`\n→ Done. ${passedCount}/${results.length} passed.`);

  // Generate structured run summary
  generateRunSummary(results, testCases, slug);

  if (passedCount < results.length) process.exit(1);
}

// ── Conditional execution vs import ─────────────────────────────────────────
// When imported for testing, skip auto-execution.
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('run_qa.mjs') || process.argv[1].endsWith('run_qa'));

if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export {
  validateBankStatementDocCallback,
  validateDocumentCallback,
  validateApplicationCallback,
  crossValidateBankStatementTotals,
  groupBankStatementsByAccount,
  parseNumericAmount,
  resolvePath,
  isFraudFlagged,
  MAPPING_FILES,
  readHistory,
  appendHistory,
  buildRunRecord,
  compareRuns,
  consecutiveFailures,
  formatComparisonSection,
};
