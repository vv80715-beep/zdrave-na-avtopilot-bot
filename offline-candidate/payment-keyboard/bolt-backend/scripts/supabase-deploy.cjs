'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'supabase', 'deploy-config.json');

function loadConfig(configPath = CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!/^[a-z]{20}$/.test(config.approvedProjectRef || '')) {
    throw new Error('supabase/deploy-config.json has an invalid approvedProjectRef.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(config.functionName || '')) {
    throw new Error('supabase/deploy-config.json has an invalid functionName.');
  }
  return config;
}

function assertApprovedProjectRef(targetProjectRef, approvedProjectRef) {
  if (!targetProjectRef) {
    throw new Error('Missing --project-ref. Refusing to select a Supabase project implicitly.');
  }
  if (targetProjectRef !== approvedProjectRef) {
    throw new Error(
      `Supabase project mismatch: target "${targetProjectRef}" is not the approved billing project. Refusing to continue.`,
    );
  }
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const refIndex = rest.indexOf('--project-ref');
  const projectRef = refIndex >= 0 ? rest[refIndex + 1] : undefined;
  if (!['preflight', 'deploy'].includes(action)) {
    throw new Error('Usage: npm run supabase:preflight|supabase:deploy -- --project-ref <ref>');
  }
  return { action, projectRef };
}

function runSupabase(args, runner = spawnSync) {
  const result = runner('npx', ['--no-install', 'supabase', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Supabase CLI exited with status ${result.status}.`);
  }
}

function preflight({ projectRef, config, runner = spawnSync, log = console.log }) {
  assertApprovedProjectRef(projectRef, config.approvedProjectRef);
  log(`Target project reference: ${projectRef}`);
  log(`Function identity: ${config.functionName} (${config.entrypoint})`);
  runSupabase(['functions', 'list', '--project-ref', projectRef], runner);
}

function execute({ action, projectRef, config = loadConfig(), runner = spawnSync, log = console.log }) {
  preflight({ projectRef, config, runner, log });
  if (action === 'deploy') {
    runSupabase(
      ['functions', 'deploy', config.functionName, '--project-ref', projectRef],
      runner,
    );
  }
}

if (require.main === module) {
  try {
    execute(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assertApprovedProjectRef,
  execute,
  loadConfig,
  parseArgs,
  preflight,
};