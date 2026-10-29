// Run an isolated source copy: no .env, runtime JSON, credentials, bot launch,
// or real provider requests. Dependencies must already be installed.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const botRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-offline-'));
const copyRoot = path.join(tempRoot, 'bot');
const violations = path.join(tempRoot, 'network-attempts.txt');
const targets = process.argv.slice(2);
if (targets.some(target => !/^test\/[A-Za-z0-9_.-]+\.test\.js$/.test(target))) {
  throw new Error('Only explicit test/*.test.js targets are accepted');
}

let exitCode = 1;
try {
  fs.cpSync(botRoot, copyRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(botRoot, source);
      if (!relative) return true;
      if (relative.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules')) return false;
      if (fs.statSync(source).isDirectory()) return true;
      return /\.(?:js|cjs|mjs)$/.test(relative) ||
        relative === 'package.json' || relative === 'package-lock.json' ||
        (relative.startsWith(`test${path.sep}fixtures${path.sep}`) && /\.(?:json|txt)$/.test(relative));
    },
  });
  fs.symlinkSync(path.join(botRoot, 'node_modules'), path.join(copyRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // An existing bot regression imports this pure server handler by relative
  // path. Copy its source, without configs, database state or credentials.
  const meteringRelative = path.join('bolt-backend', 'supabase', 'functions', 'avatar-metering');
  fs.cpSync(path.join(botRoot, '..', meteringRelative), path.join(tempRoot, meteringRelative), {
    recursive: true,
    filter: source => fs.statSync(source).isDirectory() || /\.(?:ts|js|mjs)$/.test(source),
  });
  for (const target of targets) {
    if (!fs.existsSync(path.join(copyRoot, target))) throw new Error(`Missing test target: ${target}`);
  }
  function findTests(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const item = path.join(directory, entry.name);
      return entry.isDirectory() ? findTests(item) : entry.name.endsWith('.test.js') ? [item] : [];
    });
  }
  const selected = targets.length ? targets : findTests(path.join(copyRoot, 'test'));
  if (!selected.length) throw new Error('No bot tests found');

  const env = { NODE_ENV: 'test', TZ: 'UTC', ELI_OFFLINE_VIOLATIONS_PATH: violations };
  for (const name of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const guard = path.join(copyRoot, 'scripts', 'offline-network-guard.cjs');
  const result = spawnSync(process.execPath, ['--require', guard, '--test', '--test-reporter=tap', ...selected], {
    cwd: copyRoot, env, stdio: 'inherit', timeout: 120_000,
  });
  if (result.error) console.error(result.error.message);
  const attempts = fs.existsSync(violations) ? fs.readFileSync(violations, 'utf8').trim().split('\n').length : 0;
  console.log(`Offline network attempts: ${attempts}; credentials and runtime data excluded.`);
  exitCode = attempts === 0 && !result.error ? (result.status ?? 1) : 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = exitCode;
