'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const dist = path.join(root, 'dist');

function filesUnder(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return /\.(?:html|js|css)$/i.test(entry.name) ? [file] : [];
  });
}

test('built frontend contains no retired provider prefix or UUID payment URL', () => {
  assert.ok(
    fs.existsSync(dist),
    'dist is missing; run `npm run build` before `npm run test:frontend:build-guard`',
  );
  const files = filesUnder(dist);
  assert.ok(files.length > 0, 'dist contains no HTML, JS, or CSS files');
  const builtSource = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  // Keep the retired provider out of the shipped browser bundle without
  // embedding any retired full URLs in this test.
  assert.doesNotMatch(builtSource, /revolut/i);
  assert.doesNotMatch(
    builtSource,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  );
});