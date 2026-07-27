#!/usr/bin/env node
/**
 * Test runner.
 *
 * Discovers and runs every test file in examples/ matching one of:
 *   - *.unit.js          — pure in-process unit tests
 *   - *.integration.js   — full Express + mock-provider integration tests
 *   - *.regression.js    — end-to-end regression checks for backward compat
 *
 * Usage:
 *   node scripts/run-tests.js               # run all
 *   node scripts/run-tests.js unit          # only *.unit.js
 *   node scripts/run-tests.js integration   # only *.integration.js
 *   node scripts/run-tests.js regression     # only *.regression.js
 *   node scripts/run-tests.js quota.unit     # substring filter
 *
 * Each test file is run as a child process so a crash in one file never
 * aborts the whole suite. The exit code is non-zero if ANY file reported a
 * failure or itself exited non-zero.
 *
 * (Sprint 12 — adds this runner so `npm test` works; existing convention
 * for the tests themselves — top-of-file JSDoc, `[PASS]/[FAIL]` console
 * lines, summary footer — is preserved unchanged.)
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const examplesDir = path.resolve(__dirname, '..', 'examples');
const filter = process.argv[2] || '';

function discover(kind) {
  if (!fs.existsSync(examplesDir)) return [];
  const suffix = kind === 'unit' ? '.unit.js'
    : kind === 'integration' ? '.integration.js'
      : kind === 'regression' ? '.regression.js'
        : '.js';
  return fs.readdirSync(examplesDir)
    .sort()
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(examplesDir, f));
}

let kind = null;
if (filter === 'unit') kind = 'unit';
else if (filter === 'integration') kind = 'integration';
else if (filter === 'regression') kind = 'regression';

let files;
if (kind) {
  files = discover(kind);
} else if (filter) {
  files = discover('all').filter((f) => path.basename(f).includes(filter));
} else {
  files = [].concat(discover('unit'), discover('integration'), discover('regression'));
}

if (files.length === 0) {
  console.log(`No test files found${filter ? ' matching "' + filter + '"' : ''}.`);
  process.exit(0);
}

let failed = 0;
let passed = 0;
const summary = [];

console.log('='.repeat(72));
console.log(`AI-Gateway test runner — ${files.length} file(s)`);
console.log('='.repeat(72));

for (const file of files) {
  const name = path.basename(file);
  process.stdout.write(`\n>>> ${name}\n`);
  const env = { ...process.env, NODE_ENV: 'test' };
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env });
  const ok = result.status === 0;
  summary.push({ name, ok });
  if (ok) passed += 1;
  else failed += 1;
}

console.log('\n' + '='.repeat(72));
console.log('SUMMARY');
console.log('='.repeat(72));
for (const s of summary) {
  console.log(`  [${s.ok ? 'PASS' : 'FAIL'}] ${s.name}`);
}
console.log('\n' + `${passed} passed, ${failed} failed of ${files.length} files`);
process.exit(failed > 0 ? 1 : 0);
