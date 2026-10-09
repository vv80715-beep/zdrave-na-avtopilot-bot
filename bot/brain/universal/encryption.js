'use strict';

const crypto = require('node:crypto');
const { MemoryError } = require('./contracts');

function createCipher(encodedKey) {
  const key = Buffer.from(encodedKey || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw new MemoryError('encryption_key_missing');
  return {
    seal(value, binding) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(binding));
      const ciphertext = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return { version: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    },
    open(envelope, binding) {
      try {
        if (envelope?.version !== 1 || typeof envelope.ciphertext !== 'string') throw new Error();
        const iv = Buffer.from(envelope.iv, 'base64');
        const tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const c = crypto.createDecipheriv('aes-256-gcm', key, iv);
        c.setAAD(Buffer.from(binding)); c.setAuthTag(tag);
        return JSON.parse(Buffer.concat([c.update(Buffer.from(envelope.ciphertext, 'base64')), c.final()]).toString('utf8'));
      } catch { throw new MemoryError('integrity_failed'); }
    },
  };
}

module.exports = { createCipher };
