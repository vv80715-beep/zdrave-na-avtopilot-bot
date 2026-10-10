'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('../brain/universal/contracts');
const { createBackup, loadBackup, reconcileBackup, writeReconciliation, createVerifiedImporter } = require('../brain/universal/backup');
const { USER_A, answer, rig } = require('./universalMemoryFixtures');

async function fixture(r, entries) {
  const legacy = path.join(r.directory, 'legacy'); await fs.mkdir(legacy);
  const source = path.join(legacy, 'relationship_memory.json');
  const original = JSON.stringify({ [USER_A]: { memories: entries } });
  await fs.writeFile(source, original);
  return { legacy, source, original, backupFilename: path.join(r.directory, 'private.memory-backup'), planFilename: path.join(r.directory, 'private.memory-plan') };
}

test('encrypted, verified legacy backup and reconciliation preserve sources byte-for-byte', async (t) => {
  const r = await rig(t, ({ message }) => answer({ topic: 'лична нова категория', evidence: message.split('): ')[1] }));
  const f = await fixture(r, [{ id: 'old-a', category: 'unknown_future_topic', value: 'името на телескопа ми е Северна искра' }]);
  assert.deepEqual(await createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher }), { files: 1, verified: true });
  assert.doesNotMatch(await fs.readFile(f.backupFilename, 'utf8'), /Северна искра|880000000001/);
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  assert.deepEqual(backup.files['relationship_memory.json'], Buffer.from(f.original));
  const plan = await reconcileBackup({ backup, semantic: r.semantic });
  assert.equal(plan.counts.imported, 1); assert.equal(plan.counts.held, 0);
  await writeReconciliation({ filename: f.planFilename, plan, cipher: r.cipher });
  const importer = await createVerifiedImporter({ directory: f.legacy, ...f, cipher: r.cipher });
  assert.equal((await importer(USER_A))[0].value, 'името на телескопа ми е Северна искра');
  assert.equal(await fs.readFile(f.source, 'utf8'), f.original);
});

test('malformed legacy is backed up but never silently treated as empty', async (t) => {
  const r = await rig(t, () => answer());
  const f = await fixture(r, []); await fs.writeFile(f.source, '{damaged');
  await assert.rejects(createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher }), { code: 'corrupt_legacy' });
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  assert.deepEqual(backup.files['relationship_memory.json'], Buffer.from('{damaged'));
  assert.equal(await fs.readFile(f.source, 'utf8'), '{damaged');
  assert.equal(r.openai.calls.length, 0);
});

test('invalid UTF-8 is preserved exactly in the backup and blocks reconciliation', async (t) => {
  const r = await rig(t, () => answer());
  const f = await fixture(r, []);
  const damaged = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff, 0xc3, 0x28]), Buffer.from('"}')]);
  await fs.writeFile(f.source, damaged);
  await assert.rejects(createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher }), { code: 'corrupt_legacy' });
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  assert.deepEqual(backup.files['relationship_memory.json'], damaged);
  assert.deepEqual(await fs.readFile(f.source), damaged);
  await assert.rejects(reconcileBackup({ backup, semantic: r.semantic }), { code: 'corrupt_legacy' });
  const restored = path.join(r.directory, 'restored.relationship-memory');
  await fs.writeFile(restored, backup.files['relationship_memory.json']);
  assert.equal(hash(await fs.readFile(restored)), hash(damaged));
  assert.equal(r.openai.calls.length, 0);
});

test('verified version-one UTF-8 backups remain readable after the byte-preserving upgrade', async (t) => {
  const r = await rig(t, () => answer());
  const f = await fixture(r, []);
  const files = { 'relationship_memory.json': f.original };
  const { createChecksumManifest } = require('../brain/migration/backupManifest');
  await fs.writeFile(f.backupFilename, JSON.stringify(r.cipher.seal({ version: 1, manifest: createChecksumManifest(files), files }, 'eli-legacy-backup:v1')));
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  assert.equal(backup.files['relationship_memory.json'], f.original);
  assert.equal((await reconcileBackup({ backup, semantic: r.semantic })).counts.candidates, 0);
});

test('duplicates, contradictions and sensitive historical facts are reconciled without overwrite', async (t) => {
  const r = await rig(t, ({ message, facts }) => answer({ topic: 'един и същ атрибут', evidence: message.split('): ')[1], existingId: facts[0]?.id || null }));
  const f = await fixture(r, [
    { id: 'a', value: 'предпочитам зеления цвят' },
    { id: 'b', value: 'предпочитам зеления цвят' },
    { id: 'c', value: 'предпочитам синия цвят' },
    { id: 'd', value: 'имам алергия към сусам' },
  ]);
  await createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher });
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  const plan = await reconcileBackup({ backup, semantic: r.semantic });
  assert.equal(plan.counts.duplicates, 1); assert.equal(plan.counts.conflicts, 1); assert.equal(plan.counts.held, 1);
  assert.equal(plan.users[USER_A].held.length, 2); assert.equal(r.openai.calls.length, 3);
  await writeReconciliation({ filename: f.planFilename, plan, cipher: r.cipher });
  const importer = await createVerifiedImporter({ directory: f.legacy, ...f, cipher: r.cipher });
  await assert.rejects(importer(USER_A), { code: 'legacy_review_required' });
  assert.equal(await fs.readFile(f.source, 'utf8'), f.original);
});

test('reconciliation never merges independent legacy facts by a broad topic alone', async (t) => {
  const r = await rig(t, ({ message }) => answer({ topic: 'хоби', evidence: message.split('): ')[1] }));
  const f = await fixture(r, [
    { id: 'a', value: 'хобито ми е оригами' },
    { id: 'b', value: 'наричам телескопа си Северна искра' },
    { id: 'c', value: 'хобито ми е оригами' },
  ]);
  await createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher });
  const plan = await reconcileBackup({ backup: await loadBackup({ filename: f.backupFilename, cipher: r.cipher }), semantic: r.semantic });
  assert.equal(plan.counts.imported, 2); assert.equal(plan.counts.duplicates, 1);
  assert.equal(plan.counts.conflicts, 0); assert.equal(plan.users[USER_A].held.length, 0);
  assert.equal(new Set(plan.users[USER_A].facts.map((f) => f.id)).size, 2);
  assert.equal(await fs.readFile(f.source, 'utf8'), f.original);
});

test('changed personal legacy values block first import; changing journals does not break reload', async (t) => {
  const r = await rig(t, ({ message }) => answer({ topic: 'предпочитание', evidence: message.split('): ')[1] }));
  const f = await fixture(r, [{ id: 'a', value: 'предпочитам зеления цвят' }]);
  await createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher });
  const backup = await loadBackup({ filename: f.backupFilename, cipher: r.cipher });
  const plan = await reconcileBackup({ backup, semantic: r.semantic });
  await writeReconciliation({ filename: f.planFilename, plan, cipher: r.cipher });
  await fs.writeFile(path.join(f.legacy, 'daily_logs.json'), JSON.stringify({ [USER_A]: { '2026-10-09': [{ category: 'water', amount: 2 }] } }));
  const importer = await createVerifiedImporter({ directory: f.legacy, ...f, cipher: r.cipher });
  assert.equal((await importer(USER_A)).length, 1);
  await fs.writeFile(f.source, f.original.replace('зеления', 'синия'));
  await assert.rejects(importer(USER_A), { code: 'legacy_changed_since_backup' });
});

test('backup overwrite and tampering are rejected', async (t) => {
  const r = await rig(t, () => answer());
  const f = await fixture(r, []);
  await createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher });
  const before = await fs.readFile(f.backupFilename, 'utf8');
  await assert.rejects(createBackup({ directory: f.legacy, filename: f.backupFilename, cipher: r.cipher }));
  assert.equal(hash(await fs.readFile(f.backupFilename, 'utf8')), hash(before));
  const envelope = JSON.parse(before); envelope.tag = Buffer.alloc(16).toString('base64');
  await fs.writeFile(f.backupFilename, JSON.stringify(envelope));
  await assert.rejects(loadBackup({ filename: f.backupFilename, cipher: r.cipher }), { code: 'integrity_failed' });
});
