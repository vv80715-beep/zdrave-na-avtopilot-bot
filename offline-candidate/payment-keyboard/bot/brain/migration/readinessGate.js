'use strict';

const { ELI_V2_2_FLAG_DEFAULTS } = require('../featureFlags');

function evaluateStep5Readiness(input = {}) {
  const report = input.report || {};
  const checksumVerification = input.checksumVerification || { ok: false };
  const counts = report.counts || {};

  const checks = {
    dryRunOnly: report.mode === 'dry-run' && report.writeEnabled === false,
    zeroWrites: Number(counts.writes || 0) === 0,
    checksumVerified: checksumVerification.ok === true,
    reconciliationPresent:
      Array.isArray(report.reconciliation) && report.reconciliation.length > 0,
    noInvalidRecords: Number(counts.invalid || 0) === 0,
    noUnresolvedConflicts: Number(counts.conflicting || 0) === 0,
    featureFlagsDefaultOff:
      Object.values(ELI_V2_2_FLAG_DEFAULTS).every((value) => value === false),
  };

  const passed = Object.values(checks).every(Boolean);

  return {
    step: 'Eli V2.2 Step 5',
    status: passed ? 'non_production_validation_passed' : 'review_required',
    checks,
    productionActivationAuthorized: false,
    nextAction: passed
      ? 'Await explicit approval before any test-Supabase schema application or canary activation.'
      : 'Resolve validation or reconciliation findings and repeat the dry-run.',
  };
}

module.exports = { evaluateStep5Readiness };
