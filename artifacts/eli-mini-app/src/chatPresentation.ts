import type { TranslationKey } from './i18n';

export type ChatReplySource = 'bot_text' | 'bot_voice' | 'bot_avatar' | 'test_ai' | 'owner_dossier_faq' | 'mock' | 'unknown';
export type ChatMessageDelivery = 'api' | 'local';

export function getReplyLabelKey(source?: ChatReplySource): TranslationKey | null {
  if (source === 'bot_text') return 'botTextReplyLabel';
  if (source === 'bot_voice') return 'botVoiceReplyLabel';
  if (source === 'bot_avatar') return 'botAvatarReplyLabel';
  if (source === 'test_ai') return 'liveAiReplyLabel';
  if (source === 'owner_dossier_faq') return 'ownerDossierFaqReplyLabel';
  if (source === 'mock') return 'fixedMockReply';
  return null;
}

export function getUserMessageTimeKey(delivery?: ChatMessageDelivery): TranslationKey | null {
  if (delivery === 'api') return 'apiMessageTime';
  if (delivery === 'local') return 'localMessageTime';
  return null;
}

export function showPreparedChatExamples(stageMode: string): boolean {
  return stageMode !== 'live';
}
