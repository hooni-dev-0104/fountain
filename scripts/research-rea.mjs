#!/usr/bin/env node
// Public Notion assets and complete REA evidence stay outside the repository.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'docs/research/rea-notion-evidence.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/research-rea.mjs [--work-dir /tmp/rea-research] [--verify-only]');
  console.log('Downloads 272 KB of public assets, runs pinned REA 4.1.0, and keeps ~271 MB of evidence outside this repo.');
  process.exit(0);
}
let requestedWorkDir;
let verifyOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verify-only') verifyOnly = true;
  else if (args[i] === '--work-dir' && args[i + 1] && !args[i + 1].startsWith('--')) requestedWorkDir = resolve(args[++i]);
  else throw new Error('Invalid arguments; use --help.');
}
if (verifyOnly && !requestedWorkDir) throw new Error('--verify-only requires --work-dir.');
const workDir = requestedWorkDir ?? mkdtempSync(join(tmpdir(), 'fountain-rea-'));
mkdirSync(workDir, { recursive: true });
const outside = relative(realpathSync(root), realpathSync(workDir));
if (outside === '' || !outside.startsWith(`..${sep}`) && outside !== '..') throw new Error('The work directory must be outside the repository.');
const target = join(workDir, 'target');
mkdirSync(target, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', timeout: 180_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}; evidence/logs remain in ${workDir}`);
};
for (const asset of manifest.targets) {
  const path = join(target, asset.path);
  if (!existsSync(path) && !verifyOnly) {
    run('curl', ['--silent', '--show-error', '--location', '--fail', '--max-time', '45', '--max-filesize', '16777216', '--output', path, asset.url]);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Asset snapshot changed: ${asset.path}`);
}
const evidencePath = join(workDir, 'application-evidence-4.1.0.json');
if (!verifyOnly) {
  const output = openSync(evidencePath, 'w');
  const errors = openSync(join(workDir, 'analysis-progress-4.1.0.jsonl'), 'w');
  try {
    run('npm', ['--cache', join(workDir, 'npm-cache'), 'exec', '--yes', '--package=rea-agents@4.1.0', '--', 'rea', 'analyze-javascript-application', target, '--json'], {
      stdio: ['ignore', output, errors],
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
    });
  } finally {
    closeSync(output);
    closeSync(errors);
  }
}
if (statSync(evidencePath).size > 512 * 1024 * 1024) throw new Error('Evidence exceeds the 512 MB read budget.');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const result = evidence.normalized_result;
if (!result || result.root_artifact_sha256 !== manifest.evidence.root_artifact_sha256) throw new Error('Unexpected evidence artifact identity.');
if (result.statistics.parsed_javascript_files !== 4 || result.statistics.parse_failures !== 0) throw new Error('Source analysis is incomplete.');
const sidebar = result.graph.nodes.find(node => node.kind === 'storage' && node.observations.some(observation => observation.properties.name === 'LRU:KeyValueStore2:sidebar'));
if (!sidebar) throw new Error('Expected sidebar storage observation is missing.');
console.log(JSON.stringify({ workDir, evidence_id: evidence.evidence_id, root_artifact_sha256: result.root_artifact_sha256, statistics: result.statistics, sidebar_storage_node_id: sidebar.node_id }, null, 2));
