#!/usr/bin/env node
// Inspect installed program resources as inert bytes; never launch Notion.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'docs/research/rea-desktop-evidence.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/research-notion-desktop.mjs [--work-dir /tmp/name] [--npm-cache /tmp/cache] [--verify-only]');
  console.log('Reads pinned /Applications/Notion.app static resources, extracts 3 JS entries, runs REA 4.1.0; ~107 MB evidence stays in /tmp.');
  process.exit(0);
}
let requestedDir;
let npmCache;
let verifyOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verify-only') verifyOnly = true;
  else if (args[i] === '--work-dir' && args[i + 1] && !args[i + 1].startsWith('--')) requestedDir = resolve(args[++i]);
  else if (args[i] === '--npm-cache' && args[i + 1] && !args[i + 1].startsWith('--')) npmCache = resolve(args[++i]);
  else throw new Error('Invalid arguments; use --help.');
}
if (verifyOnly && !requestedDir) throw new Error('--verify-only requires --work-dir.');
const tempRoot = realpathSync('/tmp');
function assertTemporary(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
  if (!relative(tempRoot, canonical).startsWith(`..${sep}`) && canonical.startsWith(`${tempRoot}${sep}`)) return;
  throw new Error('Output and npm cache directories must be below /tmp.');
}
const workDir = requestedDir ?? mkdtempSync(join('/tmp', `fountain-notion-desktop-${manifest.app.version}-`));
assertTemporary(workDir);
if (existsSync(workDir) && lstatSync(workDir).isSymbolicLink()) throw new Error('Work directory must not be a symbolic link.');
npmCache ??= join(workDir, 'npm-cache');
assertTemporary(npmCache);
mkdirSync(workDir, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (bytes, expected, label) => {
  if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error(`Snapshot changed: ${label}`);
};
const app = manifest.app.path;
if (realpathSync(app) !== app) throw new Error('Application bundle must not be a symbolic link.');
const plistBytes = readFileSync(join(app, 'Contents/Info.plist'));
if (hash(plistBytes) !== manifest.app.info_plist_sha256) throw new Error('Info.plist snapshot changed.');
const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
if (plist.CFBundleShortVersionString !== manifest.app.version || plist.CFBundleIdentifier !== manifest.app.bundle_identifier) throw new Error('Unexpected application identity.');
check(readFileSync(join(app, 'Contents/MacOS/Notion')), manifest.app.executable, 'Notion executable');
const asarPath = join(app, manifest.asar.path);
if (statSync(asarPath).size > 32 * 1024 * 1024) throw new Error('ASAR exceeds read budget.');
const asar = readFileSync(asarPath);
check(asar, manifest.asar, 'app.asar');
if (asar.length < 16 || asar.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR prefix.');
const headerBytes = asar.readUInt32LE(12);
const base = 8 + asar.readUInt32LE(4);
if (headerBytes > 1024 * 1024 || 16 + headerBytes > base || base > asar.length) throw new Error('Invalid ASAR header bounds.');
const headerBuffer = asar.subarray(16, 16 + headerBytes);
if (hash(headerBuffer) !== manifest.asar.header_json_sha256 || hash(headerBuffer) !== plist.ElectronAsarIntegrity['Resources/app.asar'].hash) throw new Error('ASAR header integrity mismatch.');
const header = JSON.parse(headerBuffer.toString('utf8'));
const files = new Map();
function inventory(directory, prefix = '', depth = 0) {
  if (depth > 20) throw new Error('ASAR nesting exceeds budget.');
  for (const [name, entry] of Object.entries(directory.files ?? {})) {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Unsafe ASAR path.');
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) inventory(entry, path, depth + 1);
    else files.set(path, entry);
  }
}
inventory(header);
if (files.size !== manifest.asar.entries) throw new Error('ASAR inventory count mismatch.');
const selected = [...manifest.targets.map(x => ({ ...x, directory: 'target' })), ...manifest.inspection_only.map(x => ({ ...x, directory: 'inspection' }))];
for (const file of selected) {
  const entry = files.get(file.path);
  const offset = Number(entry?.offset);
  if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024 || base + offset + entry.size > asar.length) throw new Error(`Unsafe ASAR entry: ${file.path}`);
  const bytes = asar.subarray(base + offset, base + offset + entry.size);
  check(bytes, file, file.path);
  const output = join(workDir, file.directory, file.path);
  assertTemporary(output);
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Extracted file must not be a symbolic link.');
  if (!verifyOnly && !existsSync(output)) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes, { flag: 'wx' });
  }
  check(readFileSync(output), file, output);
}
const target = join(workDir, 'target');
const allowedFiles = new Set(manifest.targets.map(x => x.path));
function verifyTarget(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) verifyTarget(join(directory, entry.name), path);
    else if (!entry.isFile() || !allowedFiles.has(path)) throw new Error(`Unexpected target entry: ${path}`);
  }
}
verifyTarget(target);
for (const marker of manifest.direct_static_markers) {
  const file = selected.find(x => x.path === marker.source);
  const bytes = readFileSync(join(workDir, file.directory, file.path));
  if (bytes.indexOf(Buffer.from(marker.marker)) !== marker.byte_offset) throw new Error(`Static marker changed: ${marker.marker}`);
}
const evidencePath = join(workDir, 'application-evidence-4.1.0.json');
if (!verifyOnly) {
  for (const output of [evidencePath, join(workDir, 'analysis-progress-4.1.0.jsonl')]) {
    if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Evidence output must not be a symbolic link.');
  }
  const output = openSync(evidencePath, 'w');
  const errors = openSync(join(workDir, 'analysis-progress-4.1.0.jsonl'), 'w');
  try {
    const result = spawnSync('npm', ['--cache', npmCache, 'exec', '--yes', '--package=rea-agents@4.1.0', '--', 'rea', 'analyze-javascript-application', target, '--json'], {
      stdio: ['ignore', output, errors], timeout: 180_000,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`REA exited ${result.status}; logs remain in ${workDir}`);
  } finally {
    closeSync(output);
    closeSync(errors);
  }
}
if (statSync(evidencePath).size > 256 * 1024 * 1024) throw new Error('Evidence exceeds read budget.');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const result = evidence.normalized_result;
if (result?.root_artifact_sha256 !== manifest.evidence.root_artifact_sha256 || JSON.stringify(result.statistics) !== JSON.stringify(manifest.evidence.statistics)) throw new Error('REA artifact identity or coverage differs.');
for (const expected of manifest.rea_observations) {
  const node = result.graph.nodes.find(x => x.node_id === expected.node_id);
  if (!node?.observations.some(x => x.observation_id === expected.observation_id)) throw new Error('Expected REA observation is missing.');
}
console.log(JSON.stringify({ workDir, appVersion: plist.CFBundleShortVersionString, asarSha256: hash(asar), evidence_id: evidence.evidence_id, statistics: result.statistics }, null, 2));
