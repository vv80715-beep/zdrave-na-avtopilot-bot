import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  CircleHelp,
  Clock3,
  FileText,
  HeartPulse,
  ImagePlus,
  Leaf,
  Mic,
  MessageCircle,
  Moon,
  Paperclip,
  Save,
  Send,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import { translate, type Language, type TranslationKey } from './i18n';
import {
  getReplyLabelKey,
  getUserMessageTimeKey,
  showPreparedChatExamples,
  type ChatMessageDelivery,
  type ChatReplySource,
} from './chatPresentation';
import { connectTelegramWebApp } from './telegramWebApp';
import { useChatMedia, type ChatAttachment } from './useChatMedia';
import {
  getMiniAppProfileSnapshot,
  isMiniAppModeAllowed,
  MiniAppStageError,
  mutateMiniAppRecord,
  requestMiniAppCoaching,
  sendMiniAppVoiceTurn,
  sendMiniAppTextTurn,
  type MiniAppCoachingAction,
  type MiniAppTurnMode,
  type MiniAppProfileSnapshot,
} from './miniAppSessionClient';
import {
  dailyEntryToDraft,
  emptyDailyEntryDraft,
  getRecentDateKeys,
  localDateKey,
  removeDailyEntry,
  summarizeWeek,
  upsertDailyEntry,
  validateDailyEntry,
  type DailyEntry,
  type DailyEntryDraft,
  type EntryField,
} from './profileProgress';

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
type ProgressContextValue = {
  entries: DailyEntry[];
  setEntries: (entries: DailyEntry[]) => void;
  preferredMode: MiniAppTurnMode;
  setPreferredMode: (mode: MiniAppTurnMode) => void;
};
const ProgressContext = createContext<ProgressContextValue | null>(null);

function ProgressProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [preferredMode, setPreferredMode] = useState<MiniAppTurnMode>('text');
  return <ProgressContext.Provider value={{ entries, setEntries, preferredMode, setPreferredMode }}>{children}</ProgressContext.Provider>;
}

function useProgress() {
  const context = useContext(ProgressContext);
  if (!context) throw new Error('ProgressProvider is missing.');
  return context;
}

function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return window.localStorage.getItem('eli-mini-app-language') === 'en' ? 'en' : 'bg';
    } catch {
      return 'bg';
    }
  });

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, 'documentTitle');
    try {
      window.localStorage.setItem('eli-mini-app-language', language);
    } catch {
      // The language switch still works when storage is unavailable.
    }
  }, [language]);

  const value: LanguageContextValue = {
    language,
    setLanguage,
    t: (key) => translate(language, key),
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('LanguageProvider is missing.');
  return context;
}

const navItems = [
  { href: '/', labelKey: 'home', Icon: Sun, testId: 'link-home' },
  { href: '/chat', labelKey: 'chat', Icon: MessageCircle, testId: 'link-chat' },
  { href: '/profile', labelKey: 'profile', Icon: Activity, testId: 'link-profile' },
] as const;

function Navigation() {
  const [location] = useLocation();
  const { language, setLanguage, t } = useLanguage();
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" data-testid="link-brand" aria-label={t('brandHomeAria')}>
          <span className="brand-mark" aria-hidden="true">{t('brandMark')}</span>
          <span>{t('brand')}<span className="brand-sub">{t('brandSubtitle')}</span></span>
        </Link>
        <nav className="desktop-links" aria-label={t('desktopNavAria')}>
          {navItems.map(({ href, labelKey, testId }) => (
            <Link key={href} href={href} data-testid={testId} className={`desktop-link${location === href ? ' active' : ''}`}>
              {t(labelKey)}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="topbar-tagline">{t('tagline')}</span>
          <div className="language-switch" role="group" aria-label={t('languageSelector')} data-testid="language-switch">
            <button type="button" aria-label={t('chooseBulgarian')} aria-pressed={language === 'bg'} onClick={() => setLanguage('bg')}>BG</button>
            <button type="button" aria-label={t('chooseEnglish')} aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
          </div>
          <span className="prototype-pill"><i className="prototype-dot" /> {t('prototype')}</span>
        </div>
      </header>
      <nav className="bottom-nav" aria-label={t('bottomNavAria')}>
        {navItems.map(({ href, labelKey, Icon, testId }) => (
          <Link key={href} href={href} data-testid={testId} className={`bottom-link${location === href ? ' active' : ''}`} aria-current={location === href ? 'page' : undefined}>
            <Icon size={18} strokeWidth={1.8} /><span>{t(labelKey)}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Navigation />
      {children}
    </div>
  );
}

const eliAvatarSrc = `${import.meta.env.BASE_URL}eli-avatar.png`;

function EliAvatar({
  className,
  fallbackClassName,
  alt,
  testId,
}: {
  className: string;
  fallbackClassName?: string;
  alt: string;
  testId: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const { t } = useLanguage();

  return (
    <span
      className={`eli-avatar-slot ${className}${loaded ? ' is-loaded' : ''}`}
      role="img"
      aria-label={loaded ? alt : t('avatarFallback')}
      data-testid={testId}
    >
      {!loaded && <span className={`eli-avatar-fallback${fallbackClassName ? ` ${fallbackClassName}` : ''}`} aria-hidden="true">{t('brandMark')}</span>}
      <img
        className={`eli-avatar-image${loaded ? ' is-loaded' : ''}`}
        src={eliAvatarSrc}
        alt=""
        aria-hidden="true"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </span>
  );
}

function Home() {
  const { t, language } = useLanguage();
  const { setPreferredMode } = useProgress();
  const [, setLocation] = useLocation();
  const signedInitData = window.Telegram?.WebApp?.initData?.trim() || '';
  const [snapshot, setSnapshot] = useState<MiniAppProfileSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [coachLoading, setCoachLoading] = useState<MiniAppCoachingAction | null>(null);
  const [coachResult, setCoachResult] = useState<{ action: MiniAppCoachingAction; kind: string; text: string } | null>(null);
  const [coachError, setCoachError] = useState(false);
  const canRunCoaching = (import.meta.env.VITE_ELI_MINI_APP_STAGING_ENABLED === 'true' || import.meta.env.PROD) &&
    window.isSecureContext && window.location.protocol === 'https:' &&
    Boolean(window.Telegram?.WebApp?.platform && signedInitData);

  async function runCoaching(action: MiniAppCoachingAction) {
    if (!canRunCoaching || coachLoading) return;
    setCoachLoading(action);
    setCoachError(false);
    setCoachResult(null);
    try {
      const result = await requestMiniAppCoaching(signedInitData, action);
      setCoachResult({ action, ...result });
    } catch (error) {
      setCoachError(true);
      if (error instanceof MiniAppStageError && error.status === 429) {
        setCoachError(true);
      }
    } finally {
      setCoachLoading(null);
    }
  }

  useEffect(() => {
    let active = true;
    if (!signedInitData || !window.isSecureContext) {
      setSnapshotLoading(false);
      setSnapshotUnavailable(true);
      return;
    }
    void getMiniAppProfileSnapshot(signedInitData).then((result) => {
      if (!active) return;
      setSnapshot(result);
      setSnapshotUnavailable(false);
    }).catch(() => {
      if (active) setSnapshotUnavailable(true);
    }).finally(() => {
      if (active) setSnapshotLoading(false);
    });
    return () => { active = false; };
  }, [signedInitData]);
  const en = language === 'en';
  return (
    <main className="page-wrap">
      <section className="home-grid">
        <div className="hero-copy animate-in">
          <div className="eyebrow"><i className="eyebrow-line" /> {t('homeEyebrow')}</div>
          <h1>{t('heroTitleFirst')}<span>{t('heroTitleSecond')}</span></h1>
          <p className="welcome-greeting" data-testid="text-welcome-greeting">{t('greeting')}</p>
          <p>{t('homeDescription')}</p>
          <div className="hero-actions mode-action-grid" role="group" aria-label={t('modeActionsAria')}>
            <Link href="/chat" className="mode-action mode-action-primary" data-testid="button-home-mode-text">
              <MessageCircle className="mode-action-icon" size={18} />
              <span className="mode-action-copy"><strong>{t('actionText')}</strong><small>{t('actionTextHint')}</small></span>
              <ArrowRight className="mode-action-arrow" size={15} />
            </Link>
            <button className="mode-action" type="button" data-testid="button-home-mode-voice" aria-label={t('actionVoice')} onClick={() => { setPreferredMode('voice'); setLocation('/chat'); }}>
              <AudioLines className="mode-action-icon" size={18} />
              <span className="mode-action-copy"><strong>{t('actionVoice')}</strong><small>{t('actionVoiceHint')}</small></span>
            </button>
            <button className="mode-action" type="button" data-testid="button-home-mode-avatar" aria-label={t('actionAvatar')} onClick={() => { setPreferredMode('avatar'); setLocation('/chat'); }}>
              <Video className="mode-action-icon" size={18} />
              <span className="mode-action-copy"><strong>{t('actionAvatar')}</strong><small>{t('actionAvatarHint')}</small></span>
            </button>
          </div>
          <p className="quiet-note">{t('quietNote')}</p>
        </div>
        <div className="orbit-stage animate-in delay-1" aria-label={t('orbitAlt')} data-testid="visual-orbit">
          <div className="orbit one" /><div className="orbit two" /><div className="orbit three" />
          <span className="orbit-node node-a" /><span className="orbit-node node-b" />
          <span className="orbit-label left">{t('rhythm')}</span><span className="orbit-label right">{t('balance')}</span>
          <div className="orbit-core">
            <EliAvatar className="home-avatar-slot" fallbackClassName="core-mark" alt={t('avatarHomeAlt')} testId="image-eli-home" />
          </div>
          <div className="float-card metric"><small>{t('dailyFocus')}</small><strong className="metric-value">+ {t('movement').toLowerCase()}</strong></div>
          <div className="float-card streak"><small>{t('consistency')}</small><strong>{t('dayByDay')}</strong></div>
        </div>
      </section>
      <section className="home-live-panel panel" aria-labelledby="home-live-title" data-testid="content-home-live">
        <div className="home-live-heading">
          <div>
            <div className="eyebrow">{en ? 'Connected to Eli' : 'Свързано с Ели'}</div>
            <h2 id="home-live-title">{en ? 'Your account at a glance' : 'Твоят профил накратко'}</h2>
          </div>
          {snapshot?.entitlement.backendVerified && <span className="page-tag" data-testid="status-home-verified">{en ? 'VERIFIED' : 'ПОТВЪРДЕН'}</span>}
        </div>
        {snapshotLoading
          ? <p role="status" data-testid="status-home-loading">{en ? 'Loading your bot records…' : 'Зареждам записите от бота…'}</p>
          : snapshot && !snapshotUnavailable
            ? <div className="home-live-grid" data-testid="content-home-account">
              <div><span>{en ? 'Plan' : 'План'}</span><strong data-testid="value-home-plan">{snapshot.entitlement.backendVerified ? snapshot.entitlement.plan : (en ? 'Unverified' : 'Непотвърден')}</strong></div>
              <div><span>{en ? 'Chat access' : 'Достъп до чат'}</span><strong data-testid="value-home-chat-access">{snapshot.entitlement.backendVerified
                ? (snapshot.entitlement.canChat ? (en ? 'Available' : 'Достъпен') : (en ? 'Unavailable' : 'Недостъпен'))
                : (en ? 'Unverified' : 'Непотвърден')}</strong></div>
              <div><span>{en ? 'Saved check-ins' : 'Записани check-in-и'}</span><strong data-testid="value-home-checkins">{snapshot.checkins.length}</strong></div>
              <div><span>{en ? 'Reminders' : 'Напомняния'}</span><strong data-testid="value-home-reminders">{snapshot.reminders.length}</strong></div>
              <div className="home-live-actions">
                <Link href="/chat" className="secondary-button" data-testid="link-home-live-chat">{en ? 'Open chat' : 'Отвори разговора'}</Link>
                <Link href="/profile" className="secondary-button" data-testid="link-home-live-records">{en ? 'Manage records' : 'Управлявай записите'}</Link>
              </div>
            </div>
            : <div className="home-live-unavailable" role="status" data-testid="status-home-session">
              <p>{en
                ? 'Open Eli from the Telegram Mini App to connect your account. No sample records are shown here.'
                : 'Отвори Ели от Telegram Mini App, за да свържеш профила си. Тук не показваме примерни записи.'}</p>
              <Link href="/chat" className="secondary-button" data-testid="link-home-unavailable-chat">{en ? 'Go to chat' : 'Към разговора'}</Link>
            </div>}
      </section>
      <section className="home-live-panel panel" aria-labelledby="home-coach-title" data-testid="content-home-coaching">
        <div className="home-live-heading">
          <div>
            <div className="eyebrow">{en ? 'Bot coaching tools' : 'Коучинг от бота'}</div>
            <h2 id="home-coach-title">{en ? 'Get a focused coaching response' : 'Избери коучинг отговор'}</h2>
          </div>
        </div>
        <div className="coach-action-grid" role="group" aria-label={en ? 'Coaching actions' : 'Коучинг действия'}>
          {([
            ['coach', en ? 'Daily coaching' : 'Дневен коучинг'],
            ['motivate', en ? 'Motivate me' : 'Мотивирай ме'],
            ['nextstep', en ? 'One step today' : 'Една стъпка днес'],
            ['weeklyreview', en ? 'Weekly review' : 'Седмичен преглед'],
          ] as const).map(([action, label]) => (
            <button key={action} type="button" className="secondary-button" data-testid={`button-coach-${action}`}
              disabled={!canRunCoaching || coachLoading !== null}
              aria-busy={coachLoading === action}
              onClick={() => { void runCoaching(action); }}>
              {coachLoading === action ? (en ? 'Working…' : 'Подготвям…') : label}
            </button>
          ))}
        </div>
        {!canRunCoaching && <p className="coach-result-note" role="status">{en
          ? 'Open the secure Telegram Mini App to use coaching. Requests run only when you choose an action.'
          : 'Отвори защитения Telegram Mini App за коучинг. Заявка се изпраща само след избор на действие.'}</p>}
        {coachError && <p className="coach-result-note" role="alert" data-testid="status-coach-error">{en
          ? 'The request could not be completed. Wait a moment and try again.'
          : 'Заявката не беше изпълнена. Изчакай малко и опитай отново.'}</p>}
        {coachResult && <div className="coach-result" role="status" data-testid="result-coaching">
          {coachResult.kind === 'no_data'
            ? (en ? 'Add a few check-ins before requesting a weekly review.' : 'Добави няколко check-in записа, преди да поискаш седмичен преглед.')
            : coachResult.kind === 'access_denied'
              ? (en ? 'Chat access is not currently active.' : 'Достъпът до чата не е активен.')
              : coachResult.text}
        </div>}
      </section>
      <section className="home-bottom animate-in delay-2" aria-label={t('demoSection')}>
        <div className="intro-card">
          <span className="mini-icon"><HeartPulse size={19} strokeWidth={1.6} /></span>
          <p><strong>{t('demoStrong')}</strong> {t('demoBody')}</p>
        </div>
        <div className="quote-card">
          {t('quote')}
          <span>{t('quoteAttribution')}</span>
        </div>
      </section>
      <p className="footer-note" data-testid="text-prototype-disclosure">{t('homeFooter')}</p>
    </main>
  );
}

type LocalChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  attachment: ChatAttachment | null;
  replySource?: ChatReplySource;
  delivery?: ChatMessageDelivery;
  media?: { type: 'audio'; mimeType: 'audio/ogg'; data: string } | { type: 'video'; url: string };
};

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chat() {
  const { t, language } = useLanguage();
  const { preferredMode, setPreferredMode } = useProgress();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [stageError, setStageError] = useState<TranslationKey | null>(null);
  const [stageErrorCanRetry, setStageErrorCanRetry] = useState(false);
  const [ambiguousDraft, setAmbiguousDraft] = useState<string | null>(null);
  const [ambiguousAttachmentId, setAmbiguousAttachmentId] = useState<number | null>(null);
  const [chatEntitlement, setChatEntitlement] = useState<MiniAppProfileSnapshot['entitlement'] | null>(null);
  const [selectedMode, setSelectedMode] = useState<MiniAppTurnMode>(preferredMode);
  const selectedModeRef = useRef(selectedMode);
  selectedModeRef.current = selectedMode;
  const [sending, setSending] = useState(false);
  const [stageMode, setStageMode] = useState<'local' | 'checking' | 'live' | 'unavailable'>('local');
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const media = useChatMedia();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextMessageId = useRef(1);
  const sendLock = useRef(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const hasMountedConversation = useRef(false);
  const shouldFollowConversationRef = useRef(true);
  const telegram = window.Telegram?.WebApp;
  const signedInitData = telegram?.initData?.trim() || '';
  const canUseTelegramSession = (
    import.meta.env.VITE_ELI_MINI_APP_STAGING_ENABLED === 'true' ||
    import.meta.env.PROD
  ) &&
    window.isSecureContext &&
    window.location.protocol === 'https:' &&
    Boolean(telegram?.platform && signedInitData);
  function chooseMode(mode: MiniAppTurnMode) {
    setSelectedMode(mode);
    setPreferredMode(mode);
  }
  function modeEnabled(mode: MiniAppTurnMode) {
    return isMiniAppModeAllowed(chatEntitlement, mode);
  }

  useEffect(() => {
    if (!canUseTelegramSession) {
      setStageMode('local');
      return;
    }
    let current = true;
    setStageMode('checking');
    void getMiniAppProfileSnapshot(signedInitData).then((snapshot) => {
      if (current) {
        setChatEntitlement(snapshot.entitlement);
        const history = snapshot.history ?? [];
        setMessages(history.map((turn, index) => ({
          id: index + 1,
          role: turn.role,
          text: turn.content,
          attachment: null,
          delivery: 'api' as const,
          ...(turn.role === 'assistant' ? { replySource: 'bot_text' as const } : {}),
        })));
        nextMessageId.current = history.length + 1;
        const nextMode = snapshot.entitlement.backendVerified &&
          snapshot.entitlement.allowedModes.includes(selectedModeRef.current) ? selectedModeRef.current : 'text';
        setSelectedMode(nextMode);
        setPreferredMode(nextMode);
        setStageMode('live');
        setStageError(null);
        setStageErrorCanRetry(false);
      }
    }).catch((error) => {
      if (current) {
        setStageMode('unavailable');
        setStageError(stageErrorKey(error));
        setStageErrorCanRetry(true);
      }
    });
    return () => { current = false; };
  }, [canUseTelegramSession, signedInitData]);

  useLayoutEffect(() => {
    if (!hasMountedConversation.current) {
      hasMountedConversation.current = true;
      const conversation = conversationRef.current;
      if (conversation) {
        conversation.scrollTop = conversation.scrollHeight;
        shouldFollowConversationRef.current = true;
      }
      return;
    }
    const conversation = conversationRef.current;
    if (!conversation || !shouldFollowConversationRef.current) return;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function stageErrorKey(error: unknown): TranslationKey {
    if (!(error instanceof MiniAppStageError)) return 'stageNetworkError';
    if (error.status === 404) return 'stageDisabledError';
    if (error.status === 401 || error.status === 403) return 'stageSessionError';
    if (error.status === 429) return 'stageRateLimitError';
    if (error.code === 'telegram_auth_required') return 'stageSessionError';
    if (['unsupported_audio_type', 'file_type_or_signature_mismatch', 'invalid_audio'].includes(error.code)) return 'recordingFailed';
    if (['file_too_large', 'normalized_audio_too_large'].includes(error.code)) return 'recordingSizeError';
    if (error.code === 'audio_too_long') return 'recordingDurationLimit';
    if (error.status === 503 || error.status === 502) return 'stageAiUnavailable';
    if (error.code === 'request_timeout') return 'stageTimeoutError';
    return 'stageNetworkError';
  }

  async function submitMiniAppMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (sendLock.current || sending) return;
    if (!draft.trim() && !media.attachment) {
      setNotice('emptyDraftNotice');
      return;
    }
    if (canUseTelegramSession && !modeEnabled(selectedMode)) {
      setStageError('modeAccessDenied');
      setStageErrorCanRetry(false);
      return;
    }
    const conversation = conversationRef.current;
    shouldFollowConversationRef.current = !conversation ||
      conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 72;
    const text = draft.trim();
    const attachment = media.attachment;
    const sendText = canUseTelegramSession && Boolean(text);
    const sendVoice = canUseTelegramSession && attachment?.kind === 'voice';
    if (sendText && ambiguousDraft === text) {
      setStageError('stageProviderUncertain');
      setStageErrorCanRetry(false);
      return;
    }
    if (sendVoice && attachment && ambiguousAttachmentId === attachment.id) {
      setStageError('stageProviderUncertain');
      setStageErrorCanRetry(false);
      return;
    }
    setNotice(null);
    setStageError(null);
    setStageErrorCanRetry(false);
    if ((sendText || sendVoice) && stageMode === 'checking') {
      setStageError('stageCheckingError');
      setStageErrorCanRetry(true);
      return;
    }
    if (sendText || sendVoice) {
      sendLock.current = true;
      setSending(true);
      try {
        const result = sendVoice && attachment
          ? await sendMiniAppVoiceTurn(
            signedInitData, attachment.blob, attachment.name, language, selectedMode, text, fetch,
          )
          : await sendMiniAppTextTurn(signedInitData, text, fetch, selectedMode);
        const deliveredAttachment = media.detachForMessage();
        const visibleUserText = sendVoice
          ? (('transcript' in result && result.transcript) || t('voiceAttachment'))
          : text;
        setMessages((current) => [
          ...current,
          { id: nextMessageId.current++, role: 'user', text: visibleUserText, attachment: deliveredAttachment, delivery: 'api' },
          {
            id: nextMessageId.current++,
            role: 'assistant',
            text: result.reply,
            attachment: null,
            replySource: result.kind === 'voice' ? 'bot_voice' :
              result.kind === 'avatar' ? 'bot_avatar' : 'bot_text',
            ...(result.media ? { media: result.media } : {}),
          },
        ]);
        setStageMode('live');
        setStageError(null);
        setStageErrorCanRetry(false);
        setAmbiguousDraft(null);
        setAmbiguousAttachmentId(null);
        setDraft('');
        setAttachmentMenuOpen(false);
        if (attachment && attachment.kind !== 'voice') setNotice('attachmentLocalNotice');
        media.clearError();
      } catch (error) {
        const uncertain = error instanceof MiniAppStageError &&
          [0, 502, 503, 504].includes(error.status);
        if (uncertain) {
          if (sendVoice && attachment) setAmbiguousAttachmentId(attachment.id);
          else setAmbiguousDraft(text);
          setStageError('stageProviderUncertain');
        } else {
          setStageError(stageErrorKey(error));
        }
        setStageErrorCanRetry(false);
      } finally {
        sendLock.current = false;
        setSending(false);
      }
      return;
    }
    sendLock.current = true;
    const localAttachment = media.detachForMessage();
    setMessages((current) => [...current, {
      id: nextMessageId.current++,
      role: 'user',
      text,
      attachment: localAttachment,
      delivery: 'local',
    }]);
    if (attachment) setNotice('attachmentLocalNotice');
    else setNotice('localDraftNotice');
    setDraft('');
    setAttachmentMenuOpen(false);
    media.clearError();
    sendLock.current = false;
  }

  return (
    <main className="page-wrap chat-page">
      <div className="page-heading chat-page-heading animate-in">
        <div>
          <div className="eyebrow"><i className="eyebrow-line" /> {t(stageMode === 'live' ? 'liveChatEyebrow' : 'chatEyebrow')}</div>
          <h1>{t('chatTitle')}</h1>
          <p>{t(stageMode === 'live' ? 'liveChatDescription' : 'chatDescription')}</p>
        </div>
        <span className="page-tag"><CircleHelp size={14} /> {t(stageMode === 'live' ? 'livePreparedTag' : 'preparedTag')}</span>
      </div>
      <div className="chat-layout">
        <section className="panel chat-panel animate-in delay-1" aria-label={t(stageMode === 'live' ? 'liveChatAria' : 'chatAria')}>
          <div className="chat-top">
            <div className="coach-ident"><EliAvatar className="coach-avatar" alt={t('avatarChatAlt')} testId="image-eli-chat" /><span><strong>{t('eliName')}</strong><small>{t(stageMode === 'live' ? 'ownerLiveSubtitle' : 'coachSubtitle')}</small></span></div>
            <span className="local-chip"><i className="prototype-dot" /> {t(
              stageMode === 'live' ? 'botTextEngine' :
                  stageMode === 'checking' ? 'stageChecking' :
                    stageMode === 'unavailable' ? 'stageUnavailableShort' : 'localDemo'
            )}</span>
          </div>
          <div className="chat-mode-actions" role="group" aria-label={t('modeActionsAria')}>
            <button type="button" disabled={!modeEnabled('text')} aria-pressed={selectedMode === 'text'} aria-label={`${t('actionText')}${modeEnabled('text') ? '' : ` — ${t('modeUnavailable')}`}`} title={modeEnabled('text') ? t('actionText') : t('modeUnavailable')} data-testid="button-chat-mode-text" onClick={() => chooseMode('text')}>
              <MessageCircle size={15} /><span>{t('actionText')}</span>
            </button>
            <button type="button" disabled={!modeEnabled('voice')} aria-pressed={selectedMode === 'voice'} aria-label={`${t('actionVoice')}${modeEnabled('voice') ? '' : ` — ${t('modeUnavailable')}`}`} title={modeEnabled('voice') ? t('actionVoice') : t('modeUnavailable')} data-testid="button-chat-mode-voice" onClick={() => chooseMode('voice')}>
              <AudioLines size={15} /><span>{t('actionVoice')}</span>
            </button>
            <button type="button" disabled={!modeEnabled('avatar')} aria-pressed={selectedMode === 'avatar'} aria-label={`${t('actionAvatar')}${modeEnabled('avatar') ? '' : ` — ${t('modeUnavailable')}`}`} title={modeEnabled('avatar') ? t('actionAvatar') : t('modeUnavailable')} data-testid="button-chat-mode-avatar" onClick={() => chooseMode('avatar')}>
              <Video size={15} /><span>{t('actionAvatar')}</span>
            </button>
          </div>
          <p className="mode-disclosure" data-testid="mode-entitlement-note">{chatEntitlement?.backendVerified
            ? (chatEntitlement.allowedModes.includes('voice') && chatEntitlement.allowedModes.includes('avatar')
              ? t('modeLiveDisclosure') : t('modeLimitedDisclosure'))
            : t('modeCheckingDisclosure')}</p>
          <div
            className="conversation"
            ref={conversationRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              shouldFollowConversationRef.current =
                element.scrollHeight - element.clientHeight - element.scrollTop <= 72;
            }}
            aria-live="polite"
            data-testid="content-chat-example"
          >
            {showPreparedChatExamples(stageMode) && (
              <>
                <div className="date-divider">{t('dateDivider')}</div>
                <div className="message coach">
                  <EliAvatar className="message-avatar" alt={t('avatarChatAlt')} testId="image-eli-chat-message-1" />
                  <div className="coach-message-body">
                    <div className="message-label"><Sparkles size={11} /> {t('sampleText')}</div>
                    <div className="message-bubble">{t('openingMessage')}</div>
                    <span className="message-time">{t('sampleBeginning')}</span>
                  </div>
                </div>
                <div className="message user"><div className="message-bubble">{t('sampleUserMessage')}</div><span className="message-time">{t('sampleMessage')}</span></div>
                <div className="message coach">
                  <EliAvatar className="message-avatar" alt={t('avatarChatAlt')} testId="image-eli-chat-message-2" />
                  <div className="coach-message-body">
                    <div className="message-label"><Sparkles size={11} /> {t('preparedReply')}</div>
                    <div className="message-bubble">{t('initialReply')}</div>
                    <div className="prepared-box"><strong>{t('staticExampleStrong')}</strong>{t('staticExampleBody')}</div>
                  </div>
                </div>
              </>
            )}
            {messages.map((message) => message.role === 'assistant' ? (
              <div className="message coach" key={message.id} data-testid="message-stage-reply">
                <EliAvatar className="message-avatar" alt={t('avatarChatAlt')} testId="image-eli-stage-reply" />
                <div className="coach-message-body">
                  {getReplyLabelKey(message.replySource) && (
                    <div className="message-label">
                      <Sparkles size={11} /> {t(getReplyLabelKey(message.replySource)!)}
                    </div>
                  )}
                  <div className="message-bubble">{message.text}</div>
                  {message.media?.type === 'audio' && (
                    <audio controls preload="metadata" src={`data:${message.media.mimeType};base64,${message.media.data}`} aria-label={t('localAudioPlayback')} />
                  )}
                  {message.media?.type === 'video' && (
                    <video controls preload="metadata" playsInline src={message.media.url} aria-label={t('actionAvatar')} />
                  )}
                </div>
              </div>
            ) : (
              <div className="message user" key={message.id} data-testid="message-local-attachment">
                <div className="message-bubble attachment-message">
                  {message.text && <p className="attachment-caption">{message.text}</p>}
                  {message.attachment?.kind === 'image' && (
                    <img className="sent-image-preview" src={message.attachment.url} alt={t('imageAttachment')} />
                  )}
                  {message.attachment?.kind === 'voice' && (
                    <div className="sent-file-card">
                      <Mic size={15} /><span>{t('voiceAttachment')} · {formatFileSize(message.attachment.size)}</span>
                      <audio controls preload="metadata" src={message.attachment.url} aria-label={t('localAudioPlayback')} />
                    </div>
                  )}
                  {message.attachment?.kind === 'file' && (
                    <div className="sent-file-card">
                      <FileText size={16} />
                      <span className="sent-file-name">{message.attachment.name}</span>
                      <small>{formatFileSize(message.attachment.size)}</small>
                    </div>
                  )}
                  {message.attachment && !message.attachment.supported && (
                    <p className="unsupported-file-note">{t('unsupportedFileNotice')}</p>
                  )}
                </div>
                {getUserMessageTimeKey(message.delivery) && (
                  <span className="message-time">{t(getUserMessageTimeKey(message.delivery)!)}</span>
                )}
              </div>
            ))}
            {notice && <div className="local-notice" role="status" data-testid="status-local-message">{t(notice)}</div>}
          </div>
          {media.attachment && (
            <div className="attachment-draft" data-testid="attachment-draft">
              {media.attachment.kind === 'image'
                ? <img src={media.attachment.url} alt={t('imageAttachment')} />
                : media.attachment.kind === 'voice'
                  ? <Mic className="attachment-file-icon" size={17} />
                  : <FileText className="attachment-file-icon" size={17} />}
              <div className="attachment-draft-info">
                <strong>{media.attachment.kind === 'voice' ? t('voiceAttachment') : media.attachment.name}</strong>
                <span>{formatFileSize(media.attachment.size)}</span>
                {media.attachment.kind === 'file' && !media.attachment.supported && (
                  <small>{t('unsupportedFileNotice')}</small>
                )}
              </div>
              {media.attachment.kind === 'voice' && (
                <audio controls preload="metadata" src={media.attachment.url} aria-label={t('localAudioPlayback')} />
              )}
              <button type="button" className="icon-button attachment-remove" aria-label={t('removeAttachment')} onClick={media.discardAttachment}>
                <X size={15} />
              </button>
            </div>
          )}
          {media.recording === 'recording' && (
            <div className="recording-status" role="status" aria-live="polite">
              <span className="recording-dot" /> {t('recordingIndicator')} · {String(Math.floor(media.elapsedSeconds / 60)).padStart(2, '0')}:{String(media.elapsedSeconds % 60).padStart(2, '0')}
              <button type="button" className="icon-button" aria-label={t('stopRecording')} onClick={() => media.stopRecording()}>
                <Square size={14} />
              </button>
              <button type="button" className="icon-button" aria-label={t('cancelRecording')} onClick={() => media.stopRecording(true)}>
                <X size={15} />
              </button>
            </div>
          )}
          {media.errorKey && <p className="media-error" role="alert">{t(media.errorKey)}</p>}
          {sending && <div className="local-notice" role="status" aria-live="polite">{t(selectedMode === 'avatar' ? 'avatarGenerating' : selectedMode === 'voice' ? 'voiceProcessing' : 'stageSending')}</div>}
          {stageError && <div className="stage-error" role="alert" data-testid="status-stage-error"><span>{t(stageError)}</span>{stageErrorCanRetry ? <button type="button" onClick={() => void submitMiniAppMessage()} disabled={sending || stageMode === 'checking'} data-testid="button-stage-retry">{t('retry')}</button> : <button type="button" onClick={() => { setStageError(null); setStageErrorCanRetry(false); }} data-testid="button-stage-dismiss">{t('dismiss')}</button>}</div>}
          <form className="composer" onSubmit={(event) => void submitMiniAppMessage(event)}>
            <div className="attachment-menu-wrap">
              <button
                type="button"
                className="icon-button composer-icon-button"
                aria-label={t('attachButton')}
                aria-haspopup="menu"
                aria-expanded={attachmentMenuOpen}
                onClick={() => setAttachmentMenuOpen((open) => !open)}
              >
                <Paperclip size={18} />
              </button>
              {attachmentMenuOpen && (
                <div className="attachment-menu" role="menu" aria-label={t('attachmentMenuAria')}>
                  <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); photoInputRef.current?.click(); }}>
                    <ImagePlus size={16} /> {t('photoAction')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); fileInputRef.current?.click(); }}>
                    <FileText size={16} /> {t('fileAction')}
                  </button>
                </div>
              )}
            </div>
            <input
              ref={photoInputRef}
              className="visually-hidden-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              aria-label={t('photoAction')}
              onChange={(event) => { media.selectFile(event.currentTarget.files?.[0], 'image'); event.currentTarget.value = ''; }}
            />
            <input
              ref={fileInputRef}
              className="visually-hidden-file-input"
              type="file"
              aria-label={t('fileAction')}
              onChange={(event) => { media.selectFile(event.currentTarget.files?.[0], 'file'); event.currentTarget.value = ''; }}
            />
            <button
              type="button"
              className={`icon-button composer-icon-button${media.recording === 'recording' ? ' is-recording' : ''}`}
              aria-label={media.recording === 'recording' ? t('stopRecording') : t('startRecording')}
                disabled={sending || media.recording === 'processing'}
              onClick={() => media.recording === 'recording' ? media.stopRecording() : void media.startRecording()}
            >
              {media.recording === 'recording' ? <Square size={15} /> : <Mic size={18} />}
            </button>
            <input
              aria-label={t('inputAria')}
              placeholder={t('inputPlaceholder')}
              enterKeyHint="send"
              autoComplete="off"
              value={draft}
              disabled={sending}
              onChange={(event) => {
                const nextDraft = event.target.value;
                setDraft(nextDraft);
                if (ambiguousDraft !== null && nextDraft.trim() !== ambiguousDraft) {
                  setAmbiguousDraft(null);
                  setStageError(null);
                  setStageErrorCanRetry(false);
                }
                media.clearError();
              }}
              data-testid="input-demo-message"
            />
            <button className="send-button" type="submit" aria-label={t(canUseTelegramSession ? 'sendAriaStage' : 'sendAria')} data-testid="button-demo-send" disabled={sending || (canUseTelegramSession && stageMode === 'checking') || (ambiguousDraft !== null && ambiguousDraft === draft.trim()) || (ambiguousAttachmentId !== null && media.attachment?.id === ambiguousAttachmentId) || (!draft.trim() && !media.attachment)}>
              {sending ? <Clock3 size={16} /> : <Send size={16} />}
            </button>
          </form>
          <p className="composer-disclosure">{t(
            stageMode === 'live'
              ? 'stagingLiveDisclosure'
              :
              canUseTelegramSession ? 'stagingComposerDisclosure' : 'composerDisclosure'
          )}</p>
        </section>
      </div>
    </main>
  );
}

function DemoProfile() {
  const { t, language } = useLanguage();
  const { entries, setEntries } = useProgress();
  const dates = getRecentDateKeys();
  const today = localDateKey();
  const [selectedDate, setSelectedDate] = useState(today);
  const [draft, setDraft] = useState<DailyEntryDraft>(() => emptyDailyEntryDraft(today));
  const [errors, setErrors] = useState<Partial<Record<EntryField, string>>>({});
  const [openRanges, setOpenRanges] = useState({ energy: false, mood: false });
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const currentEntry = entries.find((entry) => entry.date === selectedDate);
  const summary = summarizeWeek(entries, dates);
  const dateFormatter = new Intl.DateTimeFormat(language === 'bg' ? 'bg-BG' : 'en-GB', { day: 'numeric', month: 'short' });
  const weekdayFormatter = new Intl.DateTimeFormat(language === 'bg' ? 'bg-BG' : 'en-GB', { weekday: 'short' });

  function chooseDate(date: string) {
    setSelectedDate(date);
    const entry = entries.find((item) => item.date === date);
    setDraft(entry ? dailyEntryToDraft(entry) : emptyDailyEntryDraft(date));
    setErrors({});
    setNotice(null);
    setDeleteConfirm(false);
    setOpenRanges({ energy: false, mood: false });
  }

  function updateDraft(field: keyof DailyEntryDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, entry: undefined }));
    setNotice(null);
  }

  function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateDailyEntry(draft, dates);
    if (!validation.ok) {
      setErrors(validation.errors);
      setNotice(null);
      return;
    }
    if (draft.sleepHours.trim() && Number(draft.sleepHours) * 4 % 1 !== 0) {
      setErrors({ sleepHours: 'step' });
      setNotice(null);
      return;
    }
    setEntries(upsertDailyEntry(entries, validation.value));
    setDraft(dailyEntryToDraft(validation.value));
    setErrors({});
    setNotice(currentEntry ? 'progressUpdated' : 'progressSaved');
    setDeleteConfirm(false);
  }

  function deleteEntry() {
    setEntries(removeDailyEntry(entries, selectedDate));
    setDraft(emptyDailyEntryDraft(selectedDate));
    setErrors({});
    setDeleteConfirm(false);
    setNotice('progressDeleted');
  }

  const errorCopy: Partial<Record<EntryField, TranslationKey>> = {
    date: 'errorDateOutside',
    movementMinutes: 'errorMovement',
    sleepHours: 'errorSleep',
    energy: 'errorEnergy',
    mood: 'errorMood',
    waterMl: 'errorWater',
    entry: 'errorRequiredMeasurement',
  };

  function fieldError(field: EntryField) {
    const code = errors[field];
    if (!code) return null;
    const key = field === 'sleepHours' && code === 'step' ? 'errorSleepStep' : errorCopy[field];
    return key ? <span className="progress-error" id={`error-${field}`} role="alert">{t(key)}</span> : null;
  }

  function dayLabel(date: string) {
    const value = new Date(`${date}T12:00:00`);
    return `${weekdayFormatter.format(value)} ${dateFormatter.format(value)}`;
  }

  function metric(value: number | null, decimals = 1) {
    return value === null ? '—' : Number(value.toFixed(decimals)).toString();
  }

  const points = summary.energyByDay.map(({ energy }, index) => energy === null ? null : ({
    x: (index / 6) * 600,
    y: 145 - ((energy - 1) / 9) * 120,
  }));
  const segments: string[] = [];
  let segment: string[] = [];
  points.forEach((point) => {
    if (!point) {
      if (segment.length) segments.push(segment.join(' '));
      segment = [];
    } else {
      segment.push(`${segment.length ? 'L' : 'M'}${point.x} ${point.y}`);
    }
  });
  if (segment.length) segments.push(segment.join(' '));

  return (
    <main className="page-wrap progress-page">
      <div className="page-heading animate-in">
        <div><div className="eyebrow"><i className="eyebrow-line" /> {t('profileEyebrow')}</div><h1>{t('profileTitle')}</h1><p>{t('profileDescription')}</p></div>
        <span className="page-tag progress-mode-tag" data-testid="status-demo-unsynced">{t('demoUnsynced')}</span>
      </div>
      <div className="profile-grid">
        <div className="profile-main">
          <section className="panel summary-panel progress-summary animate-in delay-1" data-testid="content-profile-summary">
            <div className="user-row"><EliAvatar className="initial-avatar" alt={t('avatarProfileAlt')} testId="image-eli-profile" /><span><h2>{t('profileSummary')}</h2><p>{t('sessionOnly')}</p></span></div>
            <div className="session-disclosure" data-testid="text-session-disclosure">{t('sessionDisclosure')}</div>
          </section>
          {summary.entries > 0 && <section className="stats-row progress-stats animate-in delay-1" aria-label={t('statsAria')} data-testid="content-profile-metrics">
            <div className="stat"><div className="stat-label"><Activity size={12} /> {t('checkinDays')}</div><strong data-testid="value-checkin-days">{summary.activeDays}<span> / 7 {t('days')}</span></strong><small>{t('checkinDaysHelp')}</small></div>
            <div className="stat"><div className="stat-label"><Moon size={12} /> {t('sleep')}</div><strong data-testid="value-average-sleep">{metric(summary.averageSleepHours)}<span>{t('averageHours')}</span></strong></div>
            <div className="stat"><div className="stat-label"><HeartPulse size={12} /> {t('energy')}</div><strong data-testid="value-average-energy">{metric(summary.averageEnergy)}<span> / 10</span></strong></div>
          </section>}
          {summary.entries === 0
            ? <section className="panel progress-empty animate-in delay-2" data-testid="content-progress-empty"><span className="empty-mark"><Activity size={20} /></span><h2>{t('emptyProgressTitle')}</h2><p>{t('emptyProgressBody')}</p></section>
            : <section className="panel chart-panel progress-chart animate-in delay-2" data-testid="content-energy-chart">
              <div className="panel-head"><div><h2>{t('chartTitle')}</h2><p>{t('chartScale')}</p></div><span className="chart-key"><i className="key-dot" /> {t('energy')}</span></div>
              <div className="chart" role="img" aria-label={t('chartAria')} data-testid="chart-energy-by-day">
                <svg viewBox="0 0 600 165" preserveAspectRatio="none" aria-hidden="true">
                  {segments.map((path, index) => <path key={index} d={path} fill="none" stroke="#baff61" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
                  {points.map((point, index) => point && <circle key={index} cx={point.x} cy={point.y} r="4" fill="#c0ff5b" />)}
                </svg>
              </div>
              <div className="chart-labels">{dates.map((date) => <span key={date}>{weekdayFormatter.format(new Date(`${date}T12:00:00`))}</span>)}</div>
            </section>}
        </div>
        <aside className="profile-side">
          <section className="panel weekly-panel progress-week animate-in delay-2">
            <div className="panel-head"><div><h2>{t('rollingWeek')}</h2><p>{t('checkinDaysHelp')}</p></div><span className="week-count" data-testid="value-week-percent">{summary.entries > 0 ? `${summary.goalPercent}%` : '—'}</span></div>
            <div className="week-days progress-days" role="group" aria-label={t('selectDateAria')} data-testid="date-selector">
              {dates.map((date) => {
                const hasEntry = entries.some((entry) => entry.date === date);
                const isToday = date === today;
                return <button type="button" key={date} className={`day date-day${hasEntry ? ' done' : ''}${isToday ? ' today' : ''}${selectedDate === date ? ' selected' : ''}`} onClick={() => chooseDate(date)} aria-label={`${dayLabel(date)}${isToday ? `, ${t('today')}` : ''}${hasEntry ? `, ${t('hasCheckin')}` : ''}`} aria-pressed={selectedDate === date} data-testid={`button-date-${date}`}>
                  <span>{weekdayFormatter.format(new Date(`${date}T12:00:00`))}</span><span className="day-mark">{hasEntry && <Check size={12} />}</span><small>{date.slice(8)}</small>
                </button>;
              })}
            </div>
            <div className="weekly-note">{t('weeklyProgressNote')}</div>
          </section>
          <section className="panel entry-panel animate-in delay-3" data-testid="content-daily-entry">
            <div className="entry-heading"><div><span className="entry-date-label">{t('selectedDate')}</span><h2>{dayLabel(selectedDate)}{selectedDate === today ? ` · ${t('today')}` : ''}</h2></div>
              {currentEntry && <span className="editing-pill">{t('editingEntry')}</span>}
            </div>
            <p className="entry-hint">{t('entryOptionalHint')}</p>
            <form onSubmit={saveEntry} noValidate data-testid="form-daily-entry">
              <div className="entry-field">
                <label htmlFor="movement-input">{t('movementMinutes')}</label><div className="input-with-unit"><input id="movement-input" type="number" min="0" max="1440" step="1" inputMode="numeric" value={draft.movementMinutes} onChange={(event) => updateDraft('movementMinutes', event.target.value)} aria-invalid={Boolean(errors.movementMinutes)} aria-describedby={errors.movementMinutes ? 'error-movementMinutes' : 'hint-movement-minutes'} data-testid="input-movement-minutes" /><span>{t('minutesUnit')}</span></div><small className="field-hint" id="hint-movement-minutes">{t('movementHint')}</small>{fieldError('movementMinutes')}
              </div>
              <div className="entry-field">
                <label htmlFor="sleep-input">{t('sleepHours')}</label><div className="input-with-unit"><input id="sleep-input" type="number" min="0.1" max="24" step="0.25" inputMode="decimal" value={draft.sleepHours} onChange={(event) => updateDraft('sleepHours', event.target.value)} aria-invalid={Boolean(errors.sleepHours)} aria-describedby={errors.sleepHours ? 'error-sleepHours' : undefined} data-testid="input-sleep-hours" /><span>{t('hoursUnit')}</span></div>{fieldError('sleepHours')}
              </div>
              {(['energy', 'mood'] as const).map((field) => <div className="entry-field range-field" key={field}>
                <div className="range-label-row"><label htmlFor={`${field}-input`}>{t(field)}</label>{draft[field] !== '' && <button className="text-button" type="button" onClick={() => updateDraft(field, '')} aria-label={`${t('clearValue')} ${t(field)}`} data-testid={`button-clear-${field}`}>{t('clearValue')}</button>}</div>
                {draft[field] === '' && !openRanges[field] ? <button className="range-enable" type="button" onClick={() => setOpenRanges((current) => ({ ...current, [field]: true }))} data-testid={`button-add-${field}`}>{t('addMeasurement')}</button>
                  : <div className="range-control"><input id={`${field}-input`} type="range" min="1" max="10" step="1" value={draft[field] || '5'} onChange={(event) => updateDraft(field, event.target.value)} onClick={(event) => { if (!draft[field]) updateDraft(field, event.currentTarget.value); }} aria-label={t(field)} aria-valuetext={draft[field] ? `${draft[field]} / 10` : t('chooseRating')} data-testid={`input-${field}`} /><output htmlFor={`${field}-input`}>{draft[field] || '—'}<span>{draft[field] ? ' / 10' : ''}</span></output></div>}
                {fieldError(field)}
              </div>)}
              <div className="entry-field">
                <label htmlFor="water-input">{t('waterMl')}</label><div className="input-with-unit"><input id="water-input" type="number" min="0" max="20000" step="1" inputMode="numeric" value={draft.waterMl} onChange={(event) => updateDraft('waterMl', event.target.value)} aria-invalid={Boolean(errors.waterMl)} aria-describedby={errors.waterMl ? 'error-waterMl' : undefined} data-testid="input-water-ml" /><span>{t('millilitersUnit')}</span></div>{fieldError('waterMl')}
              </div>
              {fieldError('entry')}
              {notice && <p className={`entry-notice${notice === 'progressDeleted' ? ' destructive' : ''}`} role="status" aria-live="polite" data-testid="status-progress">{t(notice)}</p>}
              {deleteConfirm && <div className="delete-confirm" role="alert" data-testid="confirm-delete-entry"><p>{t('confirmDeleteEntry')}</p><div><button type="button" className="text-button destructive-button" onClick={deleteEntry} data-testid="button-confirm-delete">{t('confirmDelete')}</button><button type="button" className="text-button" onClick={() => setDeleteConfirm(false)} data-testid="button-cancel-delete">{t('cancel')}</button></div></div>}
              <div className="entry-actions">
                <button type="submit" className="primary-button entry-save" data-testid="button-save-entry"><Save size={15} />{currentEntry ? t('updateEntry') : t('saveEntry')}</button>
                {currentEntry && <button type="button" className="delete-button" onClick={() => { setNotice(null); setDeleteConfirm(true); }} aria-label={t('deleteEntry')} data-testid="button-delete-entry"><Trash2 size={15} /><span>{t('deleteEntry')}</span></button>}
              </div>
            </form>
          </section>
        </aside>
      </div>
      <p className="footer-note" data-testid="text-profile-session-note">{t('profileSessionFooter')}</p>
    </main>
  );
}
void DemoProfile;

function Profile() {
  const { language } = useLanguage();
  const telegram = window.Telegram?.WebApp;
  const initData = telegram?.initData?.trim() || '';
  const [snapshot, setSnapshot] = useState<MiniAppProfileSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationMessage, setMutationMessage] = useState('');
  const [profileField, setProfileField] = useState('age');
  const [profileValue, setProfileValue] = useState('');
  const [memoryField, setMemoryField] = useState('dailyHabits');
  const [memoryValue, setMemoryValue] = useState('');
  const [healthText, setHealthText] = useState('');
  const [checkin, setCheckin] = useState({
    water: false, trained: false, nutrition: false, sleep: '', mood: '', energy: '',
  });
  const [deleteDate, setDeleteDate] = useState('');

  useEffect(() => {
    let active = true;
    if (!initData || !window.isSecureContext) {
      setLoading(false);
      setError(true);
      return;
    }
    void getMiniAppProfileSnapshot(initData).then((result) => {
      if (active) { setSnapshot(result); setError(false); setLoading(false); }
    }).catch(() => {
      if (active) { setError(true); setLoading(false); }
    });
    return () => { active = false; };
  }, [initData]);

  const en = language === 'en';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const todayCheckin = snapshot?.checkins.find((entry) => entry.date === today);
  useEffect(() => {
    if (todayCheckin) {
      setCheckin({
        water: Boolean(todayCheckin.water),
        trained: Boolean(todayCheckin.trained),
        nutrition: Boolean(todayCheckin.nutrition),
        sleep: String(todayCheckin.sleep ?? ''),
        mood: String(todayCheckin.mood ?? ''),
        energy: String(todayCheckin.energy ?? ''),
      });
    }
  }, [todayCheckin]);

  async function saveMutation(action: 'profile.update' | 'memory.update' | 'health.append' | 'checkin.save' | 'checkin.delete' | 'reminder.create' | 'reminder.update' | 'reminder.delete', payload: Record<string, unknown>): Promise<boolean> {
    if (!initData || !window.isSecureContext || mutationBusy) return false;
    setMutationBusy(true);
    setMutationMessage('');
    try {
      await mutateMiniAppRecord(initData, { action, payload });
      const fresh = await getMiniAppProfileSnapshot(initData);
      setSnapshot(fresh);
      setMutationMessage(en ? 'Saved to Eli’s bot records.' : 'Записано в данните на бота Ели.');
      return true;
    } catch (cause) {
      const code = cause instanceof MiniAppStageError ? cause.code : 'request_failed';
      const message = code === 'health_event_not_recognized'
        ? (en ? 'No supported health entry was recognized. Nothing was saved.' : 'Не разпознах поддържан здравен запис. Нищо не е записано.')
        : code === 'owner_only'
          ? (en ? 'This action is not allowed for the owner account.' : 'Тази операция не е разрешена за owner акаунта.')
          : (en ? 'Could not save. Check the values and try again.' : 'Записът не мина. Провери стойностите и опитай отново.');
      setMutationMessage(message);
      return false;
    } finally {
      setMutationBusy(false);
    }
  }
  const format = (value: unknown): string => {
    if (value == null || value === '') return en ? 'Not recorded' : 'Няма запис';
    if (typeof value === 'boolean') return value ? (en ? 'Yes' : 'Да') : (en ? 'No' : 'Не');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.length ? value.map(format).join(', ') : (en ? 'None' : 'Няма');
    return JSON.stringify(value);
  };
  const card = (title: string, rows: Array<[string, unknown]>) => (
    <section className="panel" key={title}>
      <h2>{title}</h2>
      {rows.length ? <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}</dl>
        : <p>{en ? 'No saved records.' : 'Няма записани данни.'}</p>}
    </section>
  );
  const rows = (record: Record<string, unknown> | null, fields: string[]) =>
    record ? fields.filter((key) => record[key] !== undefined && record[key] !== null && record[key] !== '')
      .map((key) => [key, record[key]] as [string, unknown]) : [];
  const statusLabels: Record<string, string> = en ? {
    owner: 'Owner',
    paid: 'Active paid plan',
    trial: 'Trial active',
    trial_expired: 'Trial expired',
    paid_expired: 'Paid plan expired',
    trial_not_started: 'Trial not started',
    unverified: 'Status not verified',
    backend_unavailable: 'Billing status unavailable',
  } : {
    owner: 'Собственик',
    paid: 'Активен платен план',
    trial: 'Активен пробен период',
    trial_expired: 'Пробният период е изтекъл',
    paid_expired: 'Платеният план е изтекъл',
    trial_not_started: 'Пробният период не е започнат',
    unverified: 'Статусът не е потвърден',
    backend_unavailable: 'Платежният статус не е достъпен',
  };
  const modeLabels: Record<string, string> = en
    ? { text: 'Text', voice: 'Voice', avatar: 'Avatar' }
    : { text: 'Текст', voice: 'Глас', avatar: 'Аватар' };
  const planLabels: Record<string, string> = en
    ? { owner: 'Owner', free: 'Free', seven_day: '7-day', monthly: 'Monthly', yearly: 'Yearly', unknown: 'Unknown' }
    : { owner: 'Собственик', free: 'Безплатен', seven_day: '7-дневен', monthly: 'Месечен', yearly: 'Годишен', unknown: 'Неизвестен' };
  const formatTimestamp = (timestamp: number | null) =>
    timestamp ? new Date(timestamp).toLocaleString(en ? 'en-GB' : 'bg-BG') : null;
  const isOwner = snapshot?.entitlement.plan === 'owner' || snapshot?.entitlement.state === 'owner';
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderTime, setReminderTime] = useState('09:00');
  const [reminderDays, setReminderDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [reminderCategory, setReminderCategory] = useState('custom');
  const [editingReminder, setEditingReminder] = useState<string | null>(null);
  const [deleteReminderId, setDeleteReminderId] = useState<string | null>(null);
  const reminderWeekdays = en
    ? [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']] as const
    : [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Нд']] as const;

  return (
    <main className="page-wrap progress-page">
      <div className="page-heading">
        <div><div className="eyebrow">{en ? 'Synced from Eli' : 'Свързано с Ели'}</div>
          <h1>{en ? 'Your profile & progress' : 'Профил и прогрес'}</h1>
          <p>{en ? 'Your Telegram records, updated through Eli’s existing bot services.' : 'Твоите записи от Telegram, управлявани чрез съществуващите услуги на бота Ели.'}</p>
        </div>
        <span className="page-tag">{en ? 'BOT-SYNCED' : 'СИНХРОНИЗИРАНО С БОТА'}</span>
      </div>
      {loading && <section className="panel records-loading" role="status" data-testid="status-profile-loading"><span className="skeleton-line" /><span className="skeleton-line short" />{en ? 'Loading your records…' : 'Зареждам записите…'}</section>}
      {error && !loading && <section className="panel" role="alert" data-testid="status-profile-unavailable">
        <h2>{en ? 'Records unavailable' : 'Записите не са достъпни'}</h2>
        <p>{en ? 'Open Eli from Telegram again. No local or sample data is shown.' : 'Отвори Ели от Telegram отново. Не показваме локални или примерни данни.'}</p>
        <button type="button" className="primary-button" data-testid="button-profile-retry" onClick={() => { setLoading(true); setError(false); void getMiniAppProfileSnapshot(initData).then(setSnapshot).catch(() => setError(true)).finally(() => setLoading(false)); }}>{en ? 'Try again' : 'Опитай отново'}</button>
      </section>}
      {snapshot && !loading && <>
        {mutationMessage && <p role="status" aria-live="polite" className="panel">{mutationMessage}</p>}
        {card(en ? 'Profile' : 'Профил', rows(snapshot.profile, [
          'firstName', 'age', 'gender', 'height', 'weight', 'goal', 'activityLevel',
          'trainingExperience', 'foodPreferences', 'medicalNotes',
        ]))}
        {card(en ? 'Legacy memory' : 'Запазена памет', rows(snapshot.legacyMemory, [
          'injuries', 'allergies', 'favoriteFoods', 'dislikedFoods', 'dailyHabits',
          'motivationLevel', 'lastWorkout', 'weightLog', 'plans',
        ]))}
        {card(en ? 'Relationship memory · read only' : 'Памет за отношения · само за преглед', snapshot.relationshipMemory.map((entry) =>
          [String(entry.category || 'memory'), entry.value] as [string, unknown]))}
        {card(en ? 'Recent chat history' : 'Последна история на разговора', (snapshot.history ?? []).map((turn, index) =>
          [`${index + 1} · ${turn.role}`, turn.content] as [string, unknown]))}
        {card(en ? 'Recent check-ins — latest 30' : 'Последни check-in записи — до 30', snapshot.checkins.map((entry) =>
          [String(entry.date || 'check-in'), entry] as [string, unknown]))}
        {card(en ? 'Health log — last 30 days' : 'Здравни записи — последните 30 дни', snapshot.healthLogs.map((entry) =>
          [`${String(entry.date || '')} · ${String(entry.category || '')}`, entry.value]))}
        {card(en ? 'Reminders' : 'Напомняния', snapshot.reminders.map((entry) =>
          [String(entry.title || entry.id || 'reminder'), {
            time: entry.time, days: entry.days, paused: entry.paused,
          }] as [string, unknown]))}
        {card(en ? 'Plan access' : 'План и достъп', [
          [en ? 'Plan' : 'План', planLabels[snapshot.entitlement.plan] || snapshot.entitlement.plan],
          [en ? 'Status' : 'Статус', snapshot.entitlement.backendVerified
            ? (statusLabels[snapshot.entitlement.state] || statusLabels.unverified)
            : statusLabels.unverified],
          [en ? 'Available modes' : 'Достъпни режими', snapshot.entitlement.backendVerified
            ? snapshot.entitlement.allowedModes.map((mode) => modeLabels[mode] || mode)
            : (en ? 'Unverified' : 'Непотвърдени')],
          [en ? 'Chat access' : 'Достъп до чат', snapshot.entitlement.backendVerified
            ? (snapshot.entitlement.canChat ? (en ? 'Available' : 'Достъпен') : (en ? 'Unavailable' : 'Недостъпен'))
            : (en ? 'Unverified' : 'Непотвърден')],
          [en ? 'Verified by billing service' : 'Потвърдено от платежната услуга', snapshot.entitlement.backendVerified],
          [en ? 'Trial expires' : 'Пробният период изтича', formatTimestamp(snapshot.entitlement.trialExpiresAt)],
          [en ? 'Plan expires' : 'Планът изтича', formatTimestamp(snapshot.entitlement.planExpiresAt)],
        ])}
        {snapshot.ownerDossier && card(en ? 'Owner dossier' : 'Owner досие',
          snapshot.ownerDossier.map((entry) => [String(entry.id), entry.value] as [string, unknown]))}
        <section className="panel">
          <h2>{en ? 'Edit profile' : 'Редактирай профила'}</h2>
          <form onSubmit={(event) => {
            event.preventDefault();
            void saveMutation('profile.update', { field: profileField, value: profileValue });
          }}>
            <label className="entry-field">{en ? 'Field' : 'Поле'}
              <select value={profileField} onChange={(event) => {
                const field = event.target.value;
                setProfileField(field);
                setProfileValue(String(snapshot.profile?.[field] ?? ''));
              }}>
                {['firstName', 'age', 'gender', 'height', 'weight', 'goal', 'activityLevel', 'trainingExperience', 'foodPreferences', 'medicalNotes']
                  .map((field) => <option key={field} value={field}>{field}</option>)}
              </select>
            </label>
            {['gender', 'goal', 'activityLevel', 'trainingExperience'].includes(profileField)
              ? <label className="entry-field">{en ? 'Value' : 'Стойност'}
                <select value={profileValue} onChange={(event) => setProfileValue(event.target.value)}>
                  {(profileField === 'gender'
                    ? ['Мъж', 'Жена', 'Предпочитам да не споделям', 'Пропусни']
                    : profileField === 'goal'
                      ? ['Отслабване', 'Качване на мускулна маса', 'Здравословен начин на живот', 'По-добър сън', 'Повече енергия']
                      : profileField === 'activityLevel'
                        ? ['Ниска', 'Средна', 'Висока']
                        : ['Начинаещ', 'Средно ниво', 'Напреднал']).map((value) =>
                    <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              : <label className="entry-field">{en ? 'Value' : 'Стойност'}
                <input value={profileValue} onChange={(event) => setProfileValue(event.target.value)} />
              </label>}
            <button className="primary-button" type="submit" disabled={mutationBusy}>
              {mutationBusy ? (en ? 'Saving…' : 'Записвам…') : (en ? 'Save profile field' : 'Запиши полето')}
            </button>
          </form>
        </section>
        <section className="panel">
          <h2>{en ? 'Legacy memory' : 'Запазена памет'}</h2>
          <p>{en ? 'Updates the bot’s existing memory fields; it does not write Universal Memory.' : 'Променя съществуващите полета на паметта на бота; не записва в Universal Memory.'}</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            void saveMutation('memory.update', { field: memoryField, value: memoryValue });
          }}>
            <label className="entry-field">{en ? 'Memory field' : 'Поле от паметта'}
              <select value={memoryField} onChange={(event) => setMemoryField(event.target.value)}>
                {['injuries', 'allergies', 'favoriteFoods', 'dislikedFoods', 'dailyHabits', 'motivationLevel'].map((field) =>
                  <option key={field} value={field}>{field}</option>)}
              </select>
            </label>
            <label className="entry-field">{en ? 'Value (type “Изчисти” to clear)' : 'Стойност (напиши „Изчисти“ за изчистване)'}
              <input value={memoryValue} onChange={(event) => setMemoryValue(event.target.value)} />
            </label>
            <button className="primary-button" type="submit" disabled={mutationBusy}>{en ? 'Save memory field' : 'Запиши паметта'}</button>
          </form>
        </section>
        <section className="panel">
          <h2>{en ? 'Add a health log entry' : 'Добави здравен запис'}</h2>
          <p>{en ? 'Use a factual sentence such as “I drank 500 ml water” or “I slept 7 hours”.' : 'Опиши факт, например „Изпих 500 мл вода“ или „Спах 7 часа“.'}</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            void saveMutation('health.append', { text: healthText }).then((saved) => {
              if (saved) setHealthText('');
            });
          }}>
            <label className="entry-field">
              <textarea maxLength={1200} value={healthText} onChange={(event) => setHealthText(event.target.value)} required />
            </label>
            <button className="primary-button" type="submit" disabled={mutationBusy || !healthText.trim()}>{en ? 'Add health entry' : 'Добави запис'}</button>
          </form>
        </section>
        <section className="panel">
          <h2>{en ? 'Daily check-in' : 'Дневен check-in'}</h2>
          <p>{en ? 'This saves the same fields used by the bot check-in.' : 'Записва същите полета като check-in-ът в бота.'}</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            void saveMutation('checkin.save', { answers: {
              water: checkin.water, trained: checkin.trained, nutrition: checkin.nutrition,
              sleep: Number(checkin.sleep), mood: Number(checkin.mood), energy: Number(checkin.energy),
            } });
          }}>
            {(['water', 'trained', 'nutrition'] as const).map((field) => <label className="entry-field" key={field}>
              <input type="checkbox" checked={checkin[field]} onChange={(event) =>
                setCheckin((current) => ({ ...current, [field]: event.target.checked }))} />
              {field}
            </label>)}
            {(['sleep', 'mood', 'energy'] as const).map((field) => <label className="entry-field" key={field}>{field}
              <input type="number" min={field === 'sleep' ? 0 : 1} max={field === 'sleep' ? 24 : 10}
                step={field === 'sleep' ? 0.1 : 1} value={checkin[field]}
                onChange={(event) => setCheckin((current) => ({ ...current, [field]: event.target.value }))} required />
            </label>)}
            <button className="primary-button" type="submit" disabled={mutationBusy}>{todayCheckin ? (en ? 'Update today’s check-in' : 'Обнови днешния check-in') : (en ? 'Save today’s check-in' : 'Запиши днешния check-in')}</button>
          </form>
          {snapshot.checkins.map((entry) => <div className="entry-actions" key={String(entry.date)}>
            <span>{String(entry.date)}</span>
            {deleteDate === entry.date
              ? <><button type="button" className="delete-button" onClick={() => {
                void saveMutation('checkin.delete', { date: deleteDate }); setDeleteDate('');
              }}>{en ? 'Confirm delete' : 'Потвърди изтриване'}</button>
                <button type="button" onClick={() => setDeleteDate('')}>{en ? 'Cancel' : 'Отказ'}</button></>
              : <button type="button" className="delete-button" onClick={() => setDeleteDate(String(entry.date))}>{en ? 'Delete check-in' : 'Изтрий check-in'}</button>}
          </div>)}
        </section>
        <section className="panel">
          <h2>{en ? 'Reminders' : 'Напомняния'}</h2>
          {isOwner ? <p className="policy-note" data-testid="text-reminder-policy">{en ? 'Reminder management is disabled for the owner account by existing bot policy. These records are read-only.' : 'Съществуващите правила на бота изключват управлението на напомняния за owner акаунта. Записите са само за преглед.'}</p> : <>
            <p>{en ? 'Changes are saved through Eli’s existing bot records.' : 'Промените се записват чрез съществуващите данни на бота Ели.'}</p>
            <form className="reminder-form" data-testid="form-reminder" onSubmit={(event) => {
              event.preventDefault();
              const days = reminderDays.map((day) => ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][day]).join(' ');
              const payload = { title: reminderTitle, time: reminderTime, days, category: reminderCategory };
              void saveMutation(editingReminder ? 'reminder.update' : 'reminder.create',
                editingReminder ? { id: editingReminder, patch: payload } : payload).then((saved) => {
                  if (saved) { setEditingReminder(null); setReminderTitle(''); }
                });
            }}>
              <h3>{editingReminder ? (en ? 'Edit reminder' : 'Редакция на напомняне') : (en ? 'Add a reminder' : 'Добави напомняне')}</h3>
              <label className="entry-field">{en ? 'Reminder' : 'Напомняне'}
                <input data-testid="input-reminder-title" aria-label={en ? 'Reminder title' : 'Заглавие на напомнянето'} value={reminderTitle} maxLength={80} required onChange={(event) => setReminderTitle(event.target.value)} />
              </label>
              <div className="reminder-fields">
                <label className="entry-field">{en ? 'Time' : 'Час'}
                  <input data-testid="input-reminder-time" aria-label={en ? 'Reminder time' : 'Час на напомнянето'} type="time" required value={reminderTime} onChange={(event) => setReminderTime(event.target.value)} />
                </label>
                <label className="entry-field">{en ? 'Category' : 'Категория'}
                  <select data-testid="select-reminder-category" aria-label={en ? 'Reminder category' : 'Категория на напомнянето'} value={reminderCategory} onChange={(event) => setReminderCategory(event.target.value)}>
                    {[
                      ['water', en ? 'Water' : 'Вода'], ['workout', en ? 'Workout' : 'Тренировка'],
                      ['meal', en ? 'Meal' : 'Хранене'], ['sleep', en ? 'Sleep' : 'Сън'],
                      ['medication', en ? 'Medication' : 'Лекарство'], ['custom', en ? 'Custom' : 'Друго'],
                    ].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
              </div>
              <fieldset className="entry-field reminder-day-picker">
                <legend>{en ? 'Repeat on' : 'Повтаряй в'}</legend>
                {reminderWeekdays.map(([day, label]) => <label key={day}>
                  <input type="checkbox" data-testid={`checkbox-reminder-day-${day}`} checked={reminderDays.includes(day)}
                    onChange={(event) => setReminderDays((current) => event.target.checked
                      ? [...current, day].sort((left, right) => left - right)
                      : current.filter((value) => value !== day))} />
                  {label}
                </label>)}
              </fieldset>
              <div className="reminder-actions">
                <button className="primary-button" type="submit" data-testid="button-reminder-save" disabled={mutationBusy || !reminderTitle.trim() || !reminderDays.length}>{mutationBusy ? (en ? 'Saving…' : 'Записвам…') : (editingReminder ? (en ? 'Save changes' : 'Запази промените') : (en ? 'Create reminder' : 'Създай напомняне'))}</button>
                {editingReminder && <button type="button" className="secondary-button" data-testid="button-reminder-cancel" onClick={() => { setEditingReminder(null); setReminderTitle(''); }}>{en ? 'Cancel' : 'Отказ'}</button>}
              </div>
            </form>
          </>}
          {!snapshot.reminders.length && <p className="empty-records" data-testid="empty-reminders">{en ? 'No reminders in the synced records.' : 'Няма напомняния в синхронизираните записи.'}</p>}
          <div className="reminder-list">
            {snapshot.reminders.map((entry, index) => {
              const id = String(entry.id ?? '');
              return <article className="reminder-row" key={id || index} data-testid={`reminder-${id || index}`}>
                <div><strong>{String(entry.title ?? (en ? 'Untitled reminder' : 'Напомняне'))}</strong><span>{String(entry.time ?? '—')} · {format(entry.days)} · {String(entry.category ?? 'custom')}</span></div>
                {!isOwner && <div className="reminder-actions">
                  <button type="button" className="secondary-button" data-testid={`button-reminder-toggle-${id}`}
                    aria-label={`${Boolean(entry.paused) ? (en ? 'Resume reminder' : 'Включи напомнянето') : (en ? 'Pause reminder' : 'Пауза на напомнянето')} ${String(entry.title ?? '')}`}
                    disabled={mutationBusy}
                    onClick={() => { void saveMutation('reminder.update', { id, patch: { paused: !Boolean(entry.paused) } }); }}>
                    {Boolean(entry.paused) ? (en ? 'Resume' : 'Включи') : (en ? 'Pause' : 'Пауза')}
                  </button>
                  {deleteReminderId === id
                    ? <><button type="button" className="delete-button" data-testid={`button-reminder-confirm-delete-${id}`} disabled={mutationBusy} onClick={() => { void saveMutation('reminder.delete', { id }).then((saved) => { if (saved) setDeleteReminderId(null); }); }}>{en ? 'Confirm delete' : 'Потвърди изтриване'}</button><button type="button" className="secondary-button" onClick={() => setDeleteReminderId(null)}>{en ? 'Cancel' : 'Отказ'}</button></>
                    : <><button type="button" className="secondary-button" data-testid={`button-reminder-edit-${id}`} aria-label={`${en ? 'Edit reminder' : 'Редактирай напомнянето'} ${String(entry.title ?? '')}`} onClick={() => { setEditingReminder(id); setReminderTitle(String(entry.title ?? '')); setReminderTime(String(entry.time ?? '09:00')); setReminderDays(Array.isArray(entry.days) ? entry.days.map(Number).filter((day): day is 0 | 1 | 2 | 3 | 4 | 5 | 6 => Number.isInteger(day) && day >= 0 && day <= 6) : []); setReminderCategory(String(entry.category ?? 'custom')); }}>{en ? 'Edit' : 'Редакция'}</button><button type="button" className="delete-button" data-testid={`button-reminder-delete-${id}`} aria-label={`${en ? 'Delete reminder' : 'Изтрий напомнянето'} ${String(entry.title ?? '')}`} onClick={() => setDeleteReminderId(id)}>{en ? 'Delete' : 'Изтрий'}</button></>}
                </div>}
              </article>;
            })}
          </div>
          {mutationMessage && <p role="status" aria-live="polite" data-testid="status-mutation" className="mutation-status">{mutationMessage}</p>}
        </section>
      </>}
    </main>
  );
}

function NotFound() {
  const { t } = useLanguage();
  return <main className="page-wrap"><div className="panel side-card"><div className="eyebrow">{t('notFoundEyebrow')}</div><h1>{t('notFoundTitle')}</h1><Link href="/" className="primary-button" data-testid="link-back-home">{t('backHome')} <ArrowRight size={15} /></Link></div></main>;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/chat" component={Chat} />
        <Route path="/profile" component={Profile} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useEffect(() => connectTelegramWebApp(), []);
  return (
    <LanguageProvider>
      <ProgressProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
      </ProgressProvider>
    </LanguageProvider>
  );
}

export default App;
