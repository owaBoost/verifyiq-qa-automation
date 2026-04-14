#!/usr/bin/env node
/**
 * Fetch ClickUp task context (name + description + comments) and write it to
 * .clickup-context.md for manual paste into Claude Code.
 *
 * Usage: node fetch-context.mjs <taskId> [<taskId> ...]
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync } from 'fs';

const TOKEN = process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_API_KEY;
const taskIds = process.argv.slice(2);

if (!TOKEN) {
  console.error('Fatal: CLICKUP_API_TOKEN (or CLICKUP_API_KEY) not set in .env');
  process.exit(1);
}
if (!taskIds.length) {
  console.error('Usage: node fetch-context.mjs <taskId> [<taskId> ...]');
  process.exit(1);
}

const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: TOKEN },
});

function fmtDate(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : String(ms ?? '');
}

async function fetchTaskBlock(taskId) {
  const { data: task } = await clickup.get(`/task/${taskId}`);
  const { data: commentsRes } = await clickup.get(`/task/${taskId}/comment`);
  const comments = commentsRes.comments || [];

  const lines = [
    `# ${task.name} (${taskId})`,
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
      const when = fmtDate(c.date);
      const text = (c.comment_text || (c.comment || []).map(p => p.text).join('') || '').trim();
      lines.push(`### ${who} — ${when}`, '', text, '');
    }
  }
  return lines.join('\n');
}

const blocks = [];
for (const id of taskIds) {
  try {
    console.log(`→ Fetching ${id}...`);
    blocks.push(await fetchTaskBlock(id));
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`  ✗ ${id}: ${detail}`);
    process.exit(1);
  }
}

writeFileSync('.clickup-context.md', blocks.join('\n\n---\n\n') + '\n');
console.log('Context written to .clickup-context.md — paste it into Claude Code to generate test-cases.json');
