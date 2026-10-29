const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const DEFAULT_IMAGE_QUESTION =
  'Разгледай тази снимка и ми кажи какво виждаш и кое е най-полезно да знам за нея.';

const IMAGE_ANALYSIS_PROMPT_NOTE = `АНАЛИЗ НА СНИМКА
- Описвай само това, което реално се вижда. Ако нещо е неясно, кажи го вместо да гадаеш.
- Не идентифицирай реални хора по име и не отгатвай чувствителни лични характеристики по външен вид.
- При храна можеш да разпознаеш видими храни и да дадеш обща хранителна насока. Калории, грамажи и макроси са приблизителни, освен ако точните стойности не се виждат на етикет.
- При кожа, рани, отоци, лекарства, медицински документи, симптоми или телесно състояние не поставяй диагноза по снимката. Опиши видимото с несигурност и насочи към лекар/специалист, когато е нужно. При спешни признаци следвай медицинските safety правила.
- Ако на снимката има текст, можеш да го обобщиш само ако е достатъчно четим. Не измисляй липсващи думи.
- Снимката е контекст само за текущия ход; не твърди, че я пазиш или че ще можеш да я видиш отново без тя да бъде изпратена пак.`;

class ImageInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageInputError';
    this.code = code;
  }
}

function normalizeMime(value) {
  return String(value || '').trim().toLowerCase();
}

function isSupportedImageMime(mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(normalizeMime(mimeType));
}

function selectLargestPhoto(photoSizes) {
  if (!Array.isArray(photoSizes) || photoSizes.length === 0) return null;
  return [...photoSizes]
    .filter((item) => item && item.file_id)
    .sort((a, b) => {
      const bySize = Number(a.file_size || 0) - Number(b.file_size || 0);
      if (bySize !== 0) return bySize;
      return Number(a.width || 0) * Number(a.height || 0) - Number(b.width || 0) * Number(b.height || 0);
    })
    .at(-1) || null;
}

function imageDescriptorFromMessage(message = {}) {
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    const fileSize = Number(photo.file_size || 0) || null;
    if (fileSize && fileSize > MAX_IMAGE_BYTES) {
      throw new ImageInputError('too_large', 'Изображението е по-голямо от 5 MB.');
    }
    return {
      source: 'photo',
      fileId: photo.file_id,
      fileSize,
      declaredMimeType: 'image/jpeg',
    };
  }

  const document = message.document;
  if (document?.file_id) {
    const mimeType = normalizeMime(document.mime_type);
    if (!isSupportedImageMime(mimeType)) {
      throw new ImageInputError(
        'unsupported_type',
        'Поддържам снимки във формат JPEG, PNG или WebP.'
      );
    }
    const fileSize = Number(document.file_size || 0) || null;
    if (fileSize && fileSize > MAX_IMAGE_BYTES) {
      throw new ImageInputError('too_large', 'Изображението е по-голямо от 5 MB.');
    }
    return {
      source: 'document',
      fileId: document.file_id,
      fileSize,
      declaredMimeType: mimeType,
      fileName: String(document.file_name || ''),
    };
  }

  throw new ImageInputError(
    'unsupported_type',
    'Поддържам снимки във формат JPEG, PNG или WebP.'
  );
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

async function downloadTelegramImage(ctx, descriptor, { fetchImpl = globalThis.fetch } = {}) {
  if (!ctx?.telegram?.getFileLink || !descriptor?.fileId) {
    throw new ImageInputError('download_failed', 'Липсва валиден Telegram файл.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new ImageInputError('download_failed', 'Липсва HTTP клиент за изтегляне.');
  }

  let fileLink;
  try {
    fileLink = await ctx.telegram.getFileLink(descriptor.fileId);
  } catch {
    throw new ImageInputError('download_failed', 'Не успях да отворя снимката от Telegram.');
  }

  let response;
  try {
    response = await fetchImpl(fileLink, { redirect: 'follow' });
  } catch {
    throw new ImageInputError('download_failed', 'Не успях да изтегля снимката от Telegram.');
  }

  if (!response?.ok) {
    throw new ImageInputError('download_failed', 'Не успях да изтегля снимката от Telegram.');
  }

  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', 'Изображението е по-голямо от 5 MB.');
  }

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new ImageInputError('download_failed', 'Не успях да прочета снимката.');
  }

  if (!buffer.length) {
    throw new ImageInputError('download_failed', 'Снимката е празна или повредена.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', 'Изображението е по-голямо от 5 MB.');
  }

  const detectedMimeType = detectImageMime(buffer);
  if (!isSupportedImageMime(detectedMimeType)) {
    throw new ImageInputError(
      'unsupported_type',
      'Поддържам снимки във формат JPEG, PNG или WebP.'
    );
  }

  return {
    mimeType: detectedMimeType,
    byteLength: buffer.length,
    dataUrl: `data:${detectedMimeType};base64,${buffer.toString('base64')}`,
  };
}

function buildVisionUserContent(question, imageDataUrl) {
  const text = String(question || '').trim() || DEFAULT_IMAGE_QUESTION;
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(String(imageDataUrl || ''))) {
    throw new ImageInputError('invalid_data_url', 'Невалидни данни за изображение.');
  }
  return [
    { type: 'text', text },
    {
      type: 'image_url',
      image_url: {
        url: imageDataUrl,
        detail: 'low',
      },
    },
  ];
}

function imageHistoryText(question) {
  const caption = String(question || '').trim();
  return caption ? `[Изпратена снимка] ${caption}` : '[Изпратена снимка без текст]';
}

function friendlyImageError(error) {
  if (error instanceof ImageInputError) return error.message;
  return 'Не успях да обработя снимката. Опитай отново с JPEG, PNG или WebP до 5 MB.';
}

module.exports = {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  DEFAULT_IMAGE_QUESTION,
  IMAGE_ANALYSIS_PROMPT_NOTE,
  ImageInputError,
  isSupportedImageMime,
  selectLargestPhoto,
  imageDescriptorFromMessage,
  detectImageMime,
  downloadTelegramImage,
  buildVisionUserContent,
  imageHistoryText,
  friendlyImageError,
};
