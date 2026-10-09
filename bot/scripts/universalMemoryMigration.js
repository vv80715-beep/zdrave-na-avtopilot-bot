'use strict';

// Read-only with respect to legacy data and Supabase. All output files are
// encrypted, exclusive-create, and kept outside version control.
const path = require('node:path');
const { createCipher } = require('../brain/universal/encryption');
const { createBackup, loadBackup, reconcileBackup, writeReconciliation, createVerifiedImporter } = require('../brain/universal/backup');
const { createSemanticEngine } = require('../brain/universal/semantic');

async function run() {
  const [command, directory, backupFilename, planFilename] = process.argv.slice(2);
  if (!['backup', 'reconcile', 'verify'].includes(command) || !path.isAbsolute(directory || '') || !path.isAbsolute(backupFilename || '')) throw new Error('invalid_arguments');
  const cipher = createCipher(process.env.ELI_UNIVERSAL_MEMORY_KEY);
  if (command === 'backup') {
    console.info(JSON.stringify(await createBackup({ directory, filename: backupFilename, cipher })));
  } else if (command === 'reconcile') {
    if (!process.env.ELI_MEMORY_RECONCILIATION_AI_CONSENT || process.env.ELI_MEMORY_RECONCILIATION_AI_CONSENT !== '1') throw new Error('ai_reconciliation_not_authorized');
    const backup = await loadBackup({ filename: backupFilename, cipher });
    const plan = await reconcileBackup({ backup, semantic: createSemanticEngine({ openai: require('../openaiClient') }) });
    await writeReconciliation({ filename: planFilename, plan, cipher });
    console.info(JSON.stringify({ verified: true, ...plan.counts }));
  } else {
    const importer = await createVerifiedImporter({ directory, backupFilename, planFilename, cipher });
    console.info(JSON.stringify({ verified: true, ready: importer.readiness.blockedUsers === 0, ...importer.readiness, writes: 0 }));
    if (importer.readiness.blockedUsers) process.exitCode = 1;
  }
}

if (require.main === module) run().catch(() => { console.error('Memory migration stopped; inspect privately. No database or legacy writes were performed.'); process.exitCode = 1; });

module.exports = { run };
