import type { TranslationKey } from './i18n';

export type ChatReplySource = 'test_ai' | 'mock' | 'unknown';
export type ChatMessageDelivery = 'api' | 'local';

export function getReplyLabelKey(source?: ChatReplySource): TranslationKey | null {
  if (source === 'test_ai') return 'liveAiReplyLabel';
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
