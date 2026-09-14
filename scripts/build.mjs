#!/usr/bin/env node
/**
 * Floe selectable build tool — developer / dogfooding only.
 * NOT a product feature. Never invoke from within the `floe` CLI.
 *
 * Usage:
 *   npm run build                   # interactive multi-select (TTY)
 *   npm run build -- --all          # build all targets
 *   npm run build -- bus bridge     # build named targets
 *   npm run build -- --help         # show usage
 *
 * Non-TTY (agent / CI) with no args → builds all (never hangs).
 */

import { execSync } from 'child_process';
import * as readline from 'readline';
import * as process from 'process';

// ─── Target registry ──────────────────────────────────────────────────────────

const TARGETS = [
  { id: 'bus',    workspace: 'floe-bus',    label: 'bus    (floe-bus    — tsc)' },
  { id: 'bridge', workspace: 'floe-bridge', label: 'bridge (floe-bridge — tsc)' },
  { id: 'cli',    workspace: 'floe-cli',    label: 'cli    (floe-cli    — tsc)' },
];

const TARGET_IDS = TARGETS.map(t => t.id);

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Floe selectable build (dev tool)

  npm run build                   interactive multi-select (requires TTY)
  npm run build -- --all          build all targets
  npm run build -- bus bridge     build named targets
  npm run build -- --help         show this help

Targets: ${TARGET_IDS.join(', ')}
`);
  process.exit(0);
}

// ─── Resolve targets from args (or defer to interactive/auto) ─────────────────

async function resolveTargets() {
  const flagAll = args.includes('--all');

  if (flagAll) return TARGET_IDS;

  const named = args.filter(a => !a.startsWith('-'));
  const unknown = named.filter(n => !TARGET_IDS.includes(n));
  if (unknown.length > 0) {
    console.error(`Unknown target(s): ${unknown.join(', ')}`);
    console.error(`Valid targets: ${TARGET_IDS.join(', ')}`);
    process.exit(1);
  }

  if (named.length > 0) return named;

  // No args given
  if (!process.stdin.isTTY) {
    // Non-interactive: build all silently
    console.log('Non-TTY detected — building all targets.');
    return TARGET_IDS;
  }

  // Interactive
  return interactiveSelect();
}

// ─── Zero-dep interactive checkbox ───────────────────────────────────────────

function interactiveSelect() {
  return new Promise((resolve, reject) => {
    const ticked = new Set(TARGET_IDS); // all pre-ticked
    let cursor = 0;

    const rl = readline.createInterface({ input: process.stdin });

    // Put stdin into raw mode so we get keystrokes immediately
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);

    function render() {
      // Move cursor to top of our block each time
      process.stdout.write('\x1b[' + TARGETS.length + 'A'); // cursor up N lines
      for (let i = 0; i < TARGETS.length; i++) {
        const t = TARGETS[i];
        const check = ticked.has(t.id) ? '◉' : '○';
        const pointer = i === cursor ? '>' : ' ';
        process.stdout.write(`\r${pointer} ${check} ${t.label}\x1b[K\n`);
      }
    }

    function renderInitial() {
      process.stdout.write('\n');
      console.log('  Space = toggle, ↑↓ = move, Enter = confirm, a = toggle all\n');
      for (let i = 0; i < TARGETS.length; i++) {
        const t = TARGETS[i];
        const check = ticked.has(t.id) ? '◉' : '○';
        const pointer = i === cursor ? '>' : ' ';
        process.stdout.write(`${pointer} ${check} ${t.label}\n`);
      }
    }

    function cleanup(selected) {
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      rl.close();
      process.stdout.write('\n');
      resolve(selected);
    }

    process.stdout.write('\x1b[?25l'); // hide cursor
    renderInitial();

    process.stdin.on('data', (buf) => {
      const str = buf.toString();

      if (str === '\r' || str === '\n') {
        // Enter
        process.stdout.write('\x1b[?25h'); // show cursor
        cleanup([...ticked]);
        return;
      }

      if (str === ' ') {
        const id = TARGETS[cursor].id;
        if (ticked.has(id)) ticked.delete(id);
        else ticked.add(id);
        render();
        return;
      }

      if (str === 'a' || str === 'A') {
        if (ticked.size === TARGETS.length) ticked.clear();
        else TARGET_IDS.forEach(id => ticked.add(id));
        render();
        return;
      }

      if (str === '\x1b[A' || str === '\x1b[D') {
        // Up or Left
        cursor = (cursor - 1 + TARGETS.length) % TARGETS.length;
        render();
        return;
      }

      if (str === '\x1b[B' || str === '\x1b[C') {
        // Down or Right
        cursor = (cursor + 1) % TARGETS.length;
        render();
        return;
      }

      if (str === '\x03') {
        // Ctrl+C
        process.stdout.write('\x1b[?25h');
        process.stdout.write('\nAborted.\n');
        if (process.stdin.setRawMode) process.stdin.setRawMode(false);
        rl.close();
        process.exit(0);
      }
    });

    process.stdin.on('error', reject);
  });
}

// ─── Build execution ──────────────────────────────────────────────────────────

function buildTarget(target) {
  const t = TARGETS.find(x => x.id === target);
  console.log(`\n▶  Building ${t.id} (${t.workspace})…`);
  try {
    execSync(`npm run build --workspace ${t.workspace}`, {
      stdio: 'inherit',
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    });
    console.log(`✓  ${t.id} done`);
  } catch (err) {
    console.error(`✗  ${t.id} FAILED (exit ${err.status ?? '?'})`);
    process.exitCode = 1;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const selected = await resolveTargets();

if (selected.length === 0) {
  console.log('No targets selected — nothing to build.');
  process.exit(0);
}

console.log(`\nBuilding: ${selected.join(', ')}`);

for (const id of selected) {
  buildTarget(id);
}

if (process.exitCode === 1) {
  console.error('\nOne or more builds failed.');
} else {
  console.log('\nAll builds complete.');
}
