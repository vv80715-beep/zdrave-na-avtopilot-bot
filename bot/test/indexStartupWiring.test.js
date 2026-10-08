const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('bot startup keeps the ownerName dependency imported for /start registration', () => {
  const ownerContextImport = indexSource.match(
    /const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]\.\/ownerContext['"]\)/
  );
  assert.ok(ownerContextImport, 'ownerContext import exists');
  assert.match(ownerContextImport[1], /\bOWNER_NAME\b/);
  assert.match(indexSource, /ownerName:\s*OWNER_NAME/);
});

test('free-text messages have one registered text catch-all', () => {
  const textHandlers = indexSource.match(/\bbot\.on\(['"]text['"]/g) || [];
  assert.equal(textHandlers.length, 1);
});
