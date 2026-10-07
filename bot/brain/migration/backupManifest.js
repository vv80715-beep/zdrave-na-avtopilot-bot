'use strict';

const crypto = require('crypto');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
}

function createChecksumManifest(files = {}) {
  const entries = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => {
      const buf = toBuffer(content);
      return {
        name,
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      };
    });
  return {
    algorithm: 'sha256',
    createdAt: null,
    files: entries,
  };
}

function verifyChecksumManifest(manifest, files = {}) {
  const current = createChecksumManifest(files);
  const expected = new Map((manifest?.files || []).map((x) => [x.name, x]));
  const mismatches = [];
  for (const row of current.files) {
    const old = expected.get(row.name);
    if (!old || old.sha256 !== row.sha256 || old.bytes !== row.bytes) {
      mismatches.push({ name: row.name, expected: old || null, actual: row });
    }
  }
  for (const name of expected.keys()) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) {
      mismatches.push({ name, expected: expected.get(name), actual: null });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

module.exports = { createChecksumManifest, verifyChecksumManifest };
