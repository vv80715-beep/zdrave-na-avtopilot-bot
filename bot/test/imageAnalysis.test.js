const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_IMAGE_BYTES,
  DEFAULT_IMAGE_QUESTION,
  ImageInputError,
  imageDescriptorFromMessage,
  detectImageMime,
  downloadTelegramImage,
  buildVisionUserContent,
  imageHistoryText,
} = require('../imageAnalysis');

function responseFor(buffer, contentLength = buffer.length) {
  return {
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(contentLength) : null },
    arrayBuffer: async () => buffer,
  };
}

function jpegBuffer(extra = 16) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]);
}
function pngBuffer(extra = 16) {
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(extra)]);
}
function webpBuffer(extra = 16) {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0,0,0,0]), Buffer.from('WEBP'), Buffer.alloc(extra)]);
}

test('selects the largest Telegram photo and treats it as JPEG', () => {
  const descriptor = imageDescriptorFromMessage({
    photo: [
      { file_id: 'small', file_size: 100, width: 100, height: 100 },
      { file_id: 'large', file_size: 900, width: 800, height: 800 },
    ],
  });
  assert.equal(descriptor.fileId, 'large');
  assert.equal(descriptor.declaredMimeType, 'image/jpeg');
});

test('accepts JPEG PNG and WebP image documents', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const descriptor = imageDescriptorFromMessage({
      document: { file_id: mime, mime_type: mime, file_size: 500 },
    });
    assert.equal(descriptor.declaredMimeType, mime);
  }
});

test('rejects unsupported and oversized documents before download', () => {
  assert.throws(
    () => imageDescriptorFromMessage({ document: { file_id: 'x', mime_type: 'application/pdf', file_size: 50 } }),
    (err) => err instanceof ImageInputError && err.code === 'unsupported_type'
  );
  assert.throws(
    () => imageDescriptorFromMessage({ document: { file_id: 'x', mime_type: 'image/png', file_size: MAX_IMAGE_BYTES + 1 } }),
    (err) => err instanceof ImageInputError && err.code === 'too_large'
  );
});

test('detects supported image types from bytes instead of trusting metadata', () => {
  assert.equal(detectImageMime(jpegBuffer()), 'image/jpeg');
  assert.equal(detectImageMime(pngBuffer()), 'image/png');
  assert.equal(detectImageMime(webpBuffer()), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('not an image payload')), null);
});

test('downloads image once and returns a data URL', async () => {
  let linkCalls = 0;
  let fetchCalls = 0;
  const ctx = {
    telegram: {
      getFileLink: async () => {
        linkCalls += 1;
        return new URL('https://example.invalid/file');
      },
    },
  };
  const result = await downloadTelegramImage(
    ctx,
    { fileId: 'photo', declaredMimeType: 'image/jpeg' },
    { fetchImpl: async () => { fetchCalls += 1; return responseFor(jpegBuffer()); } }
  );
  assert.equal(linkCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
});

test('rejects a body that exceeds 5 MB even if Telegram metadata was missing', async () => {
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_IMAGE_BYTES)]);
  const ctx = { telegram: { getFileLink: async () => new URL('https://example.invalid/file') } };
  await assert.rejects(
    downloadTelegramImage(ctx, { fileId: 'x' }, { fetchImpl: async () => responseFor(huge, 0) }),
    (err) => err instanceof ImageInputError && err.code === 'too_large'
  );
});

test('rejects fake image bytes even when metadata says image/png', async () => {
  const ctx = { telegram: { getFileLink: async () => new URL('https://example.invalid/file') } };
  await assert.rejects(
    downloadTelegramImage(ctx, { fileId: 'x', declaredMimeType: 'image/png' }, {
      fetchImpl: async () => responseFor(Buffer.from('definitely not an image')),
    }),
    (err) => err instanceof ImageInputError && err.code === 'unsupported_type'
  );
});

test('vision content uses one text part and one low-detail image part', () => {
  const parts = buildVisionUserContent('Какво виждаш?', 'data:image/png;base64,AAAA');
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: 'text', text: 'Какво виждаш?' });
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.detail, 'low');
});

test('vision content supplies a default question when no caption exists', () => {
  const parts = buildVisionUserContent('', 'data:image/webp;base64,AAAA');
  assert.equal(parts[0].text, DEFAULT_IMAGE_QUESTION);
});

test('history stores only a textual marker/caption, never image bytes', () => {
  assert.equal(imageHistoryText('Това става ли за закуска?'), '[Изпратена снимка] Това става ли за закуска?');
  assert.equal(imageHistoryText(''), '[Изпратена снимка без текст]');
});
