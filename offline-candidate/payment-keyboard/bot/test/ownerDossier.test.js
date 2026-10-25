const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const previousOwnerId = process.env.OWNER_TELEGRAM_ID;
const previousDossierPath = process.env.OWNER_DOSSIER_PATH;
const OWNER_ID = 'dossier-owner-fixture';
const OTHER_ID = 'dossier-other-fixture';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-owner-dossier-'));
const dossierPath = path.join(tempDir, 'owner_dossier.json');
process.env.OWNER_TELEGRAM_ID = OWNER_ID;
process.env.OWNER_DOSSIER_PATH = dossierPath;

const dossier = require('../ownerDossier');

function putFixture() {
  fs.writeFileSync(dossierPath, JSON.stringify({
    schemaVersion: 1,
    facts: [
      { id: 'financial-dream', category: 'goals', value: 'Synthetic financial goal.' },
      { id: 'motivation', category: 'motivation', value: 'Synthetic personal motivation.' },
      { id: 'business-mission', category: 'plans', value: 'Synthetic public business mission.' },
      { id: 'fitness-goals', category: 'goals', value: 'Synthetic fitness goal.' },
    ],
  }), { mode: 0o600 });
}

test.beforeEach(putFixture);
test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
  else process.env.OWNER_TELEGRAM_ID = previousOwnerId;
  if (previousDossierPath === undefined) delete process.env.OWNER_DOSSIER_PATH;
  else process.env.OWNER_DOSSIER_PATH = previousDossierPath;
});

test('owner-only reads, prompt context, and deterministic answers are isolated', () => {
  assert.equal(dossier.getOwnerDossierEntries(OTHER_ID).length, 0);
  assert.equal(dossier.buildOwnerDossierPrompt(OTHER_ID, 'What are my goals?'), '');
  assert.match(dossier.buildOwnerDossierPrompt(OWNER_ID, 'Какви са целите ми?'), /Synthetic financial goal/);

  assert.equal(dossier.detectOwnerDossierQuestion('Каква е твоята мисия?'), 'business_mission');
  assert.equal(dossier.detectOwnerDossierQuestion('Защо създадох Ели?'), 'creation_reason');
  assert.equal(dossier.detectOwnerDossierQuestion('Какви са целите ми?'), 'goals');
  assert.match(dossier.answerOwnerDossierQuestion(OWNER_ID, 'business_mission'), /Synthetic public business mission/);
  assert.match(dossier.answerOwnerDossierQuestion(OWNER_ID, 'creation_reason'), /Synthetic personal motivation/);
  assert.match(dossier.answerOwnerDossierQuestion(OWNER_ID, 'goals'), /не означава, че са постигнати/);
});

test('safe memory updates and deletions change only the selected dossier entry', () => {
  const updated = dossier.applyOwnerDossierMemoryCommand(OWNER_ID, {
    type: 'update', target: 'финансовата ми мечта', value: 'Synthetic corrected goal.',
  });
  assert.match(updated, /Обнових и проверих/);
  assert.equal(
    dossier.getOwnerDossierEntries(OWNER_ID).find((x) => x.id === 'financial-dream').value,
    'Synthetic corrected goal.'
  );

  const deleted = dossier.applyOwnerDossierMemoryCommand(OWNER_ID, {
    type: 'forget', target: 'бизнес мисията',
  });
  assert.match(deleted, /Изтрих и проверих/);
  assert.equal(dossier.getOwnerDossierEntries(OWNER_ID).some((x) => x.id === 'business-mission'), false);
  assert.equal(dossier.getOwnerDossierEntries(OWNER_ID).some((x) => x.id === 'fitness-goals'), true);
  assert.equal(
    dossier.applyOwnerDossierMemoryCommand(OTHER_ID, { type: 'forget', target: 'мечта' }),
    null
  );
});
