#!/usr/bin/env node
/**
 * Pipeline Watcher
 *
 * Polls tasks/pending/ every 10 seconds for new plan JSON files.
 * When one appears, runs the pipeline stages (generator → runner →
 * evaluator → reporter) for that plan. Prevents duplicate execution
 * via a lock file that auto-expires after 10 minutes.
 *
 * Usage:
 *   node watcher.mjs
 *   npm run watch:pipeline
 */

import 'dotenv/config';
import { readdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generate } from './agents/generator/index.mjs';
import { run } from './agents/runner/index.mjs';
import { evaluate } from './agents/evaluator/index.mjs';
import { report } from './agents/reporter/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const PENDING_DIR  = join(ROOT, 'tasks', 'pending');
const RUNNING_DIR  = join(ROOT, 'tasks', 'running');
const LOCK_DIR     = join(ROOT, 'tasks');
const POLL_MS      = 10_000;
const LOCK_TTL_MS  = 10 * 60 * 1000; // 10 minutes — stale lock auto-expires

// ── Lock helpers ────────────────────────────────────────────────────────────

function lockPath(planFile) {
  return join(LOCK_DIR, `.lock-${planFile}`);
}

function acquireLock(planFile) {
  const lp = lockPath(planFile);

  // If lock exists, check if it's stale
  if (existsSync(lp)) {
    try {
      const age = Date.now() - statSync(lp).mtimeMs;
      if (age < LOCK_TTL_MS) return false; // still held
      console.log(`[watcher] Stale lock for ${planFile} (${(age / 1000).toFixed(0)}s old) — removing`);
    } catch { /* stat failed, remove it */ }
    try { unlinkSync(lp); } catch { /* ignore */ }
  }

  writeFileSync(lp, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  return true;
}

function releaseLock(planFile) {
  try { unlinkSync(lockPath(planFile)); } catch { /* already gone */ }
}

// ── Pipeline execution ──────────────────────────────────────────────────────

async function runPipeline(planFile) {
  console.log(`\n[watcher] ▶ Processing ${planFile}`);
  const startTime = Date.now();

  const stages = [
    { name: 'generator',  fn: () => generate(planFile) },
    { name: 'runner',     fn: () => run(planFile) },
    { name: 'evaluator',  fn: () => evaluate(planFile) },
    { name: 'reporter',   fn: () => report(planFile) },
  ];

  for (const stage of stages) {
    try {
      await stage.fn();
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`[watcher] ✗ ${planFile} failed at ${stage.name} (${elapsed}s): ${err.message}`);

      // Move to completed with failed status (same as pipeline.mjs failPlan)
      const runningPath = join(RUNNING_DIR, planFile);
      const pendingPath = join(PENDING_DIR, planFile);
      const completedPath = join(ROOT, 'tasks', 'completed', planFile);

      let plan = null;
      let sourcePath = null;
      if (existsSync(runningPath)) { plan = JSON.parse(readFileSync(runningPath, 'utf8')); sourcePath = runningPath; }
      else if (existsSync(pendingPath)) { plan = JSON.parse(readFileSync(pendingPath, 'utf8')); sourcePath = pendingPath; }

      const planId = plan?.id ?? planFile.replace('.json', '');

      // Error report
      const errorFile = `${planId}-error.json`;
      writeFileSync(join(ROOT, 'reports', errorFile), JSON.stringify({
        planId,
        failedStage: stage.name,
        error: err.message,
        stack: err.stack,
        failedAt: new Date().toISOString(),
      }, null, 2));
      console.error(`[watcher]   Error report: reports/${errorFile}`);

      // Move plan to completed
      if (plan && sourcePath) {
        plan.status = 'failed';
        plan.failedStage = stage.name;
        plan.failedAt = new Date().toISOString();
        plan.errorFile = errorFile;
        writeFileSync(completedPath, JSON.stringify(plan, null, 2));
        try { unlinkSync(sourcePath); } catch { /* ignore */ }
      }

      return;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Read final verdict from completed plan
  const completedPath = join(ROOT, 'tasks', 'completed', planFile);
  let verdict = 'UNKNOWN';
  let reportFile = null;
  if (existsSync(completedPath)) {
    try {
      const plan = JSON.parse(readFileSync(completedPath, 'utf8'));
      verdict = plan.evaluation?.verdict ?? 'UNKNOWN';
      reportFile = plan.reportFile;
    } catch { /* ignore */ }
  }

  const icon = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '⚠️' : '🚨';
  console.log(`[watcher] ${icon} ${planFile} completed — ${verdict} (${elapsed}s)`);
  if (reportFile) console.log(`[watcher]   Report: reports/${reportFile}`);
}

// ── Poll loop ───────────────────────────────────────────────────────────────

function getPendingPlans() {
  try {
    return readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json') && f !== 'sample-plan.json');
  } catch {
    return [];
  }
}

function isAlreadyRunning(planFile) {
  return existsSync(join(RUNNING_DIR, planFile));
}

async function poll() {
  const plans = getPendingPlans();

  for (const planFile of plans) {
    if (isAlreadyRunning(planFile)) continue;
    if (!acquireLock(planFile)) continue;

    try {
      await runPipeline(planFile);
    } finally {
      releaseLock(planFile);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log('[watcher] Watching tasks/pending/ for new plans...');
console.log(`[watcher] Poll interval: ${POLL_MS / 1000}s | Lock TTL: ${LOCK_TTL_MS / 1000 / 60}min`);
console.log('[watcher] Press Ctrl+C to stop\n');

// Run immediately, then on interval
poll();
const timer = setInterval(poll, POLL_MS);

process.on('SIGINT', () => {
  console.log('\n[watcher] Shutting down...');
  clearInterval(timer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
