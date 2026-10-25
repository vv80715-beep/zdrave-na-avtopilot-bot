'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertApprovedProjectRef,
  execute,
  loadConfig,
} = require('../../scripts/supabase-deploy.cjs');

const CONFIG = loadConfig();
const APPROVED_REF = CONFIG.approvedProjectRef;
const OLD_APPROVED_REF = 'aighgpkrexvhyvfohuxp';

test('deployment guard accepts the exact approved Supabase project reference', () => {
  assert.doesNotThrow(() => assertApprovedProjectRef(APPROVED_REF, APPROVED_REF));
});

test('deployment guard rejects the old Supabase project reference', () => {
  assert.throws(
    () => assertApprovedProjectRef(OLD_APPROVED_REF, APPROVED_REF),
    /project mismatch.*Refusing to continue/i,
  );
});

test('deploy runs read-only identity preflight before upload', () => {
  const calls = [];
  const logs = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0 };
  };

  execute({
    action: 'deploy',
    projectRef: APPROVED_REF,
    config: CONFIG,
    runner,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(calls, [
    ['npx', '--no-install', 'supabase', 'functions', 'list', '--project-ref', APPROVED_REF],
    ['npx', '--no-install', 'supabase', 'functions', 'deploy', 'api', '--project-ref', APPROVED_REF],
  ]);
  assert.match(logs[0], new RegExp(APPROVED_REF));
  assert.match(logs[1], /Function identity: api/);
});

test('mismatch stops before any Supabase CLI command', () => {
  let calls = 0;
  assert.throws(
    () => execute({
      action: 'deploy',
      projectRef: OLD_APPROVED_REF,
      config: CONFIG,
      runner: () => {
        calls += 1;
        return { status: 0 };
      },
      log: () => {},
    }),
    /project mismatch/i,
  );
  assert.equal(calls, 0);
});