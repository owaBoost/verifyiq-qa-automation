#!/usr/bin/env node
/**
 * Pipeline Orchestrator
 *
 * Chains all agents in sequence:
 *   planner → generator → runner → evaluator → reporter
 *
 * Fault tolerance:
 *   - Each stage is wrapped in try/catch with 1 retry
 *   - On permanent failure: plan moves to tasks/completed with status "failed",
 *     error details written to reports/<plan-id>-error.json
 *   - Pipeline never leaves tasks stuck in "running"
 *
 * Usage:
 *   node pipeline.mjs [clickup_task_id ...]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { plan } from './agents/planner/index.mjs';
import { generate } from './agents/generator/index.mjs';
import { run } from './agents/runner/index.mjs';
import { evaluate } from './agents/evaluator/index.mjs';
import { report } from './agents/reporter/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ── Fault-tolerance helpers ─────────────────────────────────────────────────

/**
 * Run a stage function with 1 retry on failure.
 * Returns the stage result on success, throws on permanent failure.
 */
async function runStage(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 1) {
        console.warn(`\n⚠ [${name}] Attempt 1 failed: ${err.message}`);
        console.warn(`  Retrying ${name}...\n`);
      } else {
        throw err;
      }
    }
  }
}

/**
 * On permanent failure, move the plan to tasks/completed with status "failed"
 * and write an error report. Ensures nothing is left in tasks/running.
 */
function failPlan(planFile, stageName, error) {
  const runningPath = join(ROOT, 'tasks', 'running', planFile);
  const pendingPath = join(ROOT, 'tasks', 'pending', planFile);
  const completedPath = join(ROOT, 'tasks', 'completed', planFile);

  // Find the plan wherever it currently lives
  let plan = null;
  let sourcePath = null;

  if (existsSync(runningPath)) {
    plan = JSON.parse(readFileSync(runningPath, 'utf8'));
    sourcePath = runningPath;
  } else if (existsSync(pendingPath)) {
    plan = JSON.parse(readFileSync(pendingPath, 'utf8'));
    sourcePath = pendingPath;
  }

  const planId = plan?.id ?? planFile.replace('.json', '');

  // Write error report
  const errorReport = {
    planId,
    failedStage: stageName,
    error: error.message,
    stack: error.stack,
    failedAt: new Date().toISOString(),
  };
  const errorFile = `${planId}-error.json`;
  writeFileSync(join(ROOT, 'reports', errorFile), JSON.stringify(errorReport, null, 2));
  console.error(`  Error report: reports/${errorFile}`);

  // Move plan to completed with failed status
  if (plan && sourcePath) {
    plan.status = 'failed';
    plan.failedStage = stageName;
    plan.failedAt = new Date().toISOString();
    plan.errorFile = errorFile;
    writeFileSync(completedPath, JSON.stringify(plan, null, 2));
    try { unlinkSync(sourcePath); } catch { /* already gone */ }
    console.error(`  Plan moved to tasks/completed/${planFile}`);
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

async function pipeline() {
  // Pass all CLI args to planner — it will extract --test-type= and leave ClickUp task IDs
  const clickupTaskIds = process.argv.slice(2);

  console.log('═══════════════════════════════════════════');
  console.log('  VerifyIQ QA Pipeline');
  console.log('═══════════════════════════════════════════\n');

  // 1. Plan
  console.log('── Stage 1: Planner ──────────────────────\n');
  let planFile;
  try {
    const result = await runStage('planner', () => plan(clickupTaskIds));
    planFile = result.planFile;
  } catch (err) {
    // Planner failed before creating a plan file — write a standalone error report
    const errorId = `plan-${Date.now()}`;
    const errorReport = {
      planId: errorId,
      failedStage: 'planner',
      error: err.message,
      stack: err.stack,
      failedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(ROOT, 'reports', `${errorId}-error.json`),
      JSON.stringify(errorReport, null, 2),
    );
    console.error(`\n❌ [planner] Failed permanently: ${err.message}`);
    console.error(`  Error report: reports/${errorId}-error.json`);
    process.exit(1);
  }

  // Stages 2–5 all have a planFile, so failures can be cleaned up
  const stages = [
    { name: 'generator',  label: 'Stage 2: Generator',  fn: () => generate(planFile) },
    { name: 'runner',     label: 'Stage 3: Runner',     fn: () => run(planFile) },
    { name: 'evaluator',  label: 'Stage 4: Evaluator',  fn: () => evaluate(planFile) },
    { name: 'reporter',   label: 'Stage 5: Reporter',   fn: () => report(planFile) },
  ];

  let lastResult = null;

  for (const stage of stages) {
    console.log(`\n── ${stage.label} ──────────────────────\n`);
    try {
      lastResult = await runStage(stage.name, stage.fn);
    } catch (err) {
      console.error(`\n❌ [${stage.name}] Failed permanently: ${err.message}`);
      failPlan(planFile, stage.name, err);
      process.exit(1);
    }
  }

  // Summary
  const evaluation = lastResult?.evaluation ??
    (() => {
      // Read from completed plan if reporter didn't return it
      try {
        const p = JSON.parse(readFileSync(join(ROOT, 'tasks', 'completed', planFile), 'utf8'));
        return p.evaluation;
      } catch { return null; }
    })();

  const verdict = evaluation?.verdict ?? 'UNKNOWN';

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Pipeline complete — ${verdict}`);
  if (evaluation) {
    console.log(`  ${evaluation.passed}/${evaluation.total} passed (${evaluation.passRate})`);
  }
  console.log(`  Report: reports/${lastResult?.reportFile ?? '(see tasks/completed/)'}`);
  console.log('═══════════════════════════════════════════\n');

  if (verdict !== 'PASS') process.exit(1);
}

pipeline().catch(err => {
  console.error(`\n[pipeline] Fatal: ${err.message}`);
  process.exit(1);
});
