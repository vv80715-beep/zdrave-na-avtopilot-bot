import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
  getOwnerTextAiStatus,
  MiniAppStageError,
  sendOwnerDemoChat,
  sendOwnerTextAi,
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
};
const ProgressContext = createContext<ProgressContextValue | null>(null);

function ProgressProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  return <ProgressContext.Provider value={{ entries, setEntries }}>{children}</ProgressContext.Provider>;
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
  const { t } = useLanguage();
  const [modeNotice, setModeNotice] = useState<TranslationKey | null>(null);
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
            <button className="mode-action" type="button" data-testid="button-home-mode-voice" onClick={() => setModeNotice('modeVoiceNotice')}>
              <AudioLines className="mode-action-icon" size={18} />
              <span className="mode-action-copy"><strong>{t('actionVoice')}</strong><small>{t('actionVoiceHint')}</small></span>
            </button>
            <button className="mode-action" type="button" data-testid="button-home-mode-avatar" onClick={() => setModeNotice('modeAvatarNotice')}>
              <Video className="mode-action-icon" size={18} />
              <span className="mode-action-copy"><strong>{t('actionAvatar')}</strong><small>{t('actionAvatarHint')}</small></span>
            </button>
          </div>
          {modeNotice && <p className="mode-action-status" role="status" aria-live="polite">{t(modeNotice)}</p>}
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
};

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chat() {
  const { t, language } = useLanguage();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [stageError, setStageError] = useState<TranslationKey | null>(null);
  const [stageErrorCanRetry, setStageErrorCanRetry] = useState(false);
  const [ambiguousDraft, setAmbiguousDraft] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stageMode, setStageMode] = useState<'local' | 'checking' | 'mock' | 'live' | 'unavailable'>('local');
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const media = useChatMedia();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextMessageId = useRef(1);
  const sendLock = useRef(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const hasMountedConversation = useRef(false);
  const telegram = window.Telegram?.WebApp;
  const signedInitData = telegram?.initData?.trim() || '';
  const canUseOwnerStage = import.meta.env.VITE_ELI_MINI_APP_STAGING_ENABLED === 'true' &&
    window.isSecureContext &&
    window.location.protocol === 'https:' &&
    Boolean(telegram?.platform && signedInitData);

  useEffect(() => {
    if (!canUseOwnerStage) {
      setStageMode('local');
      return;
    }
    let current = true;
    setStageMode('checking');
    void getOwnerTextAiStatus(signedInitData).then((mode) => {
      if (current) {
        setStageMode(mode === 'test_ai' ? 'live' : 'mock');
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
  }, [canUseOwnerStage, signedInitData]);

  useEffect(() => {
    if (!hasMountedConversation.current) {
      hasMountedConversation.current = true;
      return;
    }
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
  }, [messages, notice, media.attachment]);

  function stageErrorKey(error: unknown): TranslationKey {
    if (!(error instanceof MiniAppStageError)) return 'stageNetworkError';
    if (error.status === 404) return 'stageDisabledError';
    if (error.status === 401 || error.status === 403) return 'stageSessionError';
    if (error.status === 429) return 'stageRateLimitError';
    if (error.code === 'telegram_auth_required') return 'stageSessionError';
    if (error.status === 503 || error.status === 502) return 'stageAiUnavailable';
    if (error.code === 'request_timeout') return 'stageTimeoutError';
    return 'stageNetworkError';
  }

  async function submitDemoMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (sendLock.current || sending) return;
    if (!draft.trim() && !media.attachment) {
      setNotice('emptyDraftNotice');
      return;
    }
    const text = draft.trim();
    const attachment = media.attachment;
    const sendText = canUseOwnerStage && Boolean(text);
    if (sendText && ambiguousDraft === text) {
      setStageError('stageProviderUncertain');
      setStageErrorCanRetry(false);
      return;
    }
    setNotice(null);
    setStageError(null);
    setStageErrorCanRetry(false);
    if (sendText && stageMode === 'checking') {
      setStageError('stageCheckingError');
      setStageErrorCanRetry(true);
      return;
    }
    if (sendText) {
      sendLock.current = true;
      setSending(true);
      let phase: 'status' | 'mock' | 'live' = 'status';
      try {
        let mode: 'mock' | 'live';
        if (stageMode === 'mock' || stageMode === 'live') {
          mode = stageMode;
        } else {
          const checkedMode = await getOwnerTextAiStatus(signedInitData);
          mode = checkedMode === 'test_ai' ? 'live' : 'mock';
          setStageMode(mode);
        }

        let result: { reply: string; mode: 'mock' | 'test_ai' };
        if (mode === 'live') {
          phase = 'live';
          try {
            result = await sendOwnerTextAi(signedInitData, text, language);
          } catch (error) {
            if (!(error instanceof MiniAppStageError) || error.status !== 404) throw error;
            // A 404 is safe to re-check: the guarded route rejects before any provider call.
            phase = 'status';
            const checkedMode = await getOwnerTextAiStatus(signedInitData);
            mode = checkedMode === 'test_ai' ? 'live' : 'mock';
            setStageMode(mode);
            if (mode !== 'mock') throw error;
            setNotice('stageSwitchedToMock');
            phase = 'mock';
            result = {
              ...(await sendOwnerDemoChat(signedInitData, text, language)),
              mode: 'mock',
            };
          }
        } else {
          phase = 'mock';
          result = {
            ...(await sendOwnerDemoChat(signedInitData, text, language)),
            mode: 'mock',
          };
        }
        const deliveredAttachment = media.detachForMessage();
        setMessages((current) => [
          ...current,
          { id: nextMessageId.current++, role: 'user', text, attachment: deliveredAttachment, delivery: 'api' },
          {
            id: nextMessageId.current++,
            role: 'assistant',
            text: result.reply,
            attachment: null,
            replySource: result.mode === 'test_ai' ? 'test_ai' : 'mock',
          },
        ]);
        setStageMode(result.mode === 'test_ai' ? 'live' : 'mock');
        setStageError(null);
        setStageErrorCanRetry(false);
        setAmbiguousDraft(null);
        setDraft('');
        setAttachmentMenuOpen(false);
        if (attachment) setNotice('attachmentLocalNotice');
        media.clearError();
      } catch (error) {
        const safelyRejected = error instanceof MiniAppStageError && [401, 403, 404].includes(error.status);
        if (phase === 'live' && !safelyRejected) {
          setAmbiguousDraft(text);
          setStageError('stageProviderUncertain');
        } else {
          setStageError(stageErrorKey(error));
        }
        setStageErrorCanRetry(
          phase === 'status' ||
          safelyRejected,
        );
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
              stageMode === 'live' ? 'ownerAiTest' :
                stageMode === 'mock' ? 'ownerStageMock' :
                  stageMode === 'checking' ? 'stageChecking' :
                    stageMode === 'unavailable' ? 'stageUnavailableShort' : 'localDemo'
            )}</span>
          </div>
          <div className="chat-mode-actions" role="group" aria-label={t('modeActionsAria')}>
            <button type="button" aria-label={t('actionText')} title={t('actionText')} data-testid="button-chat-mode-text" onClick={() => setNotice(stageMode === 'live' ? 'liveTextModeNotice' : 'modeTextNotice')}>
              <MessageCircle size={15} /><span>{t('actionText')}</span>
            </button>
            <button type="button" aria-label={t('actionVoice')} title={t('actionVoice')} data-testid="button-chat-mode-voice" onClick={() => setNotice('modeVoiceNotice')}>
              <AudioLines size={15} /><span>{t('actionVoice')}</span>
            </button>
            <button type="button" aria-label={t('actionAvatar')} title={t('actionAvatar')} data-testid="button-chat-mode-avatar" onClick={() => setNotice('modeAvatarNotice')}>
              <Video size={15} /><span>{t('actionAvatar')}</span>
            </button>
          </div>
          <p className="mode-disclosure">{t('modeDemoDisclosure')}</p>
          <div className="conversation" ref={conversationRef} aria-live="polite" data-testid="content-chat-example">
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
          {sending && <div className="local-notice" role="status" aria-live="polite">{t('stageSending')}</div>}
          {stageError && <div className="stage-error" role="alert" data-testid="status-stage-error"><span>{t(stageError)}</span>{stageErrorCanRetry ? <button type="button" onClick={() => void submitDemoMessage()} disabled={sending || stageMode === 'checking'} data-testid="button-stage-retry">{t('retry')}</button> : stageError !== 'stageProviderUncertain' ? <button type="button" onClick={() => { setStageError(null); setStageErrorCanRetry(false); }} data-testid="button-stage-dismiss">{t('dismiss')}</button> : null}</div>}
          <form className="composer" onSubmit={(event) => void submitDemoMessage(event)}>
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
                if (ambiguousDraft !== null) {
                  if (nextDraft.trim() === ambiguousDraft) {
                    setStageError('stageProviderUncertain');
                    setStageErrorCanRetry(false);
                  } else {
                    setStageError(null);
                    setStageErrorCanRetry(false);
                  }
                }
                media.clearError();
              }}
              data-testid="input-demo-message"
            />
            <button className="send-button" type="submit" aria-label={t(canUseOwnerStage ? 'sendAriaStage' : 'sendAria')} data-testid="button-demo-send" disabled={sending || (canUseOwnerStage && stageMode === 'checking') || (ambiguousDraft !== null && ambiguousDraft === draft.trim()) || (!draft.trim() && !media.attachment)}>
              {sending ? <Clock3 size={16} /> : <Send size={16} />}
            </button>
          </form>
          <p className="composer-disclosure">{t(
            stageMode === 'live' ? 'stagingLiveDisclosure' :
              canUseOwnerStage ? 'stagingComposerDisclosure' : 'composerDisclosure'
          )}</p>
        </section>
      </div>
    </main>
  );
}

function Profile() {
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
