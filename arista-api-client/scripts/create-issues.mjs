#!/usr/bin/env node
/**
 * Mirror the milestone checklists in docs/PLAN.md to GitHub issues.
 *
 *   node scripts/create-issues.mjs              # create missing / update existing (matched by title)
 *   node scripts/create-issues.mjs --dry-run    # show what would happen, change nothing
 *   node scripts/create-issues.mjs --print-table # also emit a markdown table for docs/STATUS.md §4
 *
 * docs/PLAN.md stays the source of truth: every `### M<n> — Title` section becomes one issue whose
 * body is that section's task/test checklist. Re-running updates instead of duplicating.
 * Needs an authenticated `gh` (https://cli.github.com).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'svaj/vibe-arista-webui';
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PATH = join(PKG_ROOT, 'docs', 'PLAN.md');
const PLAN_LINK = `[\`arista-api-client/docs/PLAN.md\`](../blob/main/arista-api-client/docs/PLAN.md)`;

const LABELS = [
  { name: 'area:api-client', color: '0E8A16', description: 'Arista TypeScript API client package' },
  { name: 'kind:epic', color: '5319E7', description: 'Milestone umbrella issue' },
  { name: 'kind:module', color: 'D4C5F9', description: 'Ports a pyeapi resource module' },
  { name: 'kind:infra', color: 'BFD4F2', description: 'Build, packaging, CI, test harness' },
  { name: 'wave:2', color: 'FBCA04', description: 'Post-wave-1 resource modules' },
  { name: 'wave:3', color: 'F9D0C4', description: 'Routing / VRRP / VXLAN modules' },
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const gh = (argv, { ok = [] } = {}) => {
  try {
    return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (ok.some((needle) => String(err.stderr ?? err.message).includes(needle))) return '';
    throw new Error(`gh ${argv.slice(0, 3).join(' ')} failed:\n${err.stderr ?? err.message}`);
  }
};

/** Milestone sections of PLAN.md: [{ id: 'M0', title, body }] */
function readMilestones(markdown) {
  const out = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const heading = /^### (M\d+) — (.+)$/.exec(line);
    if (heading) {
      if (current) out.push(current);
      current = { id: heading[1], title: heading[2], body: [] };
      continue;
    }
    if (/^#{2,3} /.test(line)) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map(({ id, title, body }) => ({
    id,
    title,
    body: body.join('\n').replace(/\n{3,}$/g, '\n').trim(),
  }));
}

/** Backlog rows of PLAN.md §4 grouped by wave. */
function readWaves(markdown, wave) {
  const header = /^\| Wave \| Module \| pyeapi LOC \| Methods \(public verbs\) \| Upstream unit tests \| Notes for this platform \|$/m;
  if (!header.test(markdown)) return [];
  return markdown
    .split('\n')
    .filter((row) => row.startsWith(`| ${wave} |`))
    .map((row) => row.replace(/^\| W\d \|/, '|'));
}

function ensureLabels() {
  for (const label of LABELS) {
    gh(['label', 'create', label.name, '--repo', REPO, '--color', label.color,
        '--description', label.description, '--force'],
      { ok: ['Unknown JSON field', 'already exists', 'HTTP 422'] });
  }
}

function findIssue(title) {
  const json = gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '50',
    '--search', `"${title}" in:title`, '--json', 'number,title']);
  if (!json) return null;
  const match = JSON.parse(json).find((issue) => issue.title === title);
  return match ? match.number : null;
}

function upsert({ title, body, labels, tmpDir }) {
  const bodyFile = join(tmpDir, `${title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.md`);
  writeFileSync(bodyFile, `${body.trim()}\n`, 'utf8');
  const labelArgs = labels.flatMap((label) => ['--label', label]);
  const existing = findIssue(title);
  if (existing) {
    console.log(`update #${String(existing).padEnd(6)} ${title}`);
    if (!dryRun) gh(['issue', 'edit', String(existing), '--repo', REPO, '--body-file', bodyFile]);
    return existing;
  }
  console.log(`create          ${title}`);
  if (dryRun) return null;
  const url = gh(['issue', 'create', '--repo', REPO, '--title', title,
    '--body-file', bodyFile, ...labelArgs]);
  return Number(/(\d+)$/.exec(url)?.[1] ?? NaN);
}

function main() {
  const plan = readFileSync(PLAN_PATH, 'utf8');
  const milestones = readMilestones(plan);
  if (milestones.length === 0) {
    console.error(`No "### M<n> — Title" sections found in ${PLAN_PATH} — refusing to create issues.`);
    process.exit(1);
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'arista-issues-'));
  if (!dryRun) ensureLabels();

  const umbrella = upsert({
    title: '[api-client] Port pyeapi to a TypeScript eAPI client (umbrella)',
    labels: ['area:api-client', 'kind:infra'],
    tmpDir,
    body: `Plan of record: ${PLAN_LINK}
Board: [\`arista-api-client/docs/STATUS.md\`](../blob/main/arista-api-client/docs/STATUS.md)
Decisions: [\`arista-api-client/docs/DECISIONS.md\`](../blob/main/arista-api-client/docs/DECISIONS.md)

Port of pyeapi **1.0.4-rc0** (~9k LOC of source; 436 unit + 284 system test methods) to a TypeScript
eAPI client: browser-safe core + Node entry point, Vitest/oxlint conventions matching
\`arista-webui\`. Each milestone below has its own issue with a burn-down checklist generated from
\`docs/PLAN.md\` by \`scripts/create-issues.mjs\` (idempotent).`,
  });

  const table = [];
  for (const milestone of milestones) {
    const number = upsert({
      title: `[api-client ${milestone.id}] ${milestone.title}`,
      labels: ['area:api-client', 'kind:epic'],
      tmpDir,
      body: `Milestone **${milestone.id}** from ${PLAN_LINK} · part of #${umbrella ?? 'umbrella'}

${milestone.body}`,
    });
    table.push({ id: milestone.id, title: milestone.title, number });
  }

  for (const wave of ['W2', 'W3']) {
    const rows = readWaves(plan, wave);
    if (rows.length === 0) continue;
    const number = upsert({
      title: `[api-client ${wave}] Wave ${wave.slice(1)} resource modules (backlog)`,
      labels: ['area:api-client', 'kind:module', `wave:${wave.slice(1)}`],
      tmpDir,
      body: `Backlog from ${PLAN_LINK} · part of #${umbrella ?? 'umbrella'}

Each row needs a module issue of its own when its wave starts; effort is expressed as the number of
pyeapi unit test methods to port.

| Module | pyeapi LOC | Methods (public verbs) | Upstream unit tests | Notes for this platform |
|---|---|---|---|---|
${rows.join('\n')}`,
    });
    table.push({ id: wave, title: `Wave ${wave.slice(1)} resource modules`, number });
  }

  if (args.has('--print-table')) {
    console.log('\n<!-- paste into docs/STATUS.md §4 -->');
    console.log('| Issue | Milestone |');
    console.log('|---|---|');
    for (const row of table) {
      console.log(`| #${row.number ?? 'pending'} | ${row.id} ${row.title} |`);
    }
  }
  if (dryRun) console.log('\n(dry run — nothing changed)');
}

main();
