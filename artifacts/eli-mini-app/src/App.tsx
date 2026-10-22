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
  Send,
  Sparkles,
  Square,
  Sun,
  Video,
  X,
} from 'lucide-react';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import { translate, type Language, type TranslationKey } from './i18n';
import { connectTelegramWebApp } from './telegramWebApp';
import { useChatMedia, type ChatAttachment } from './useChatMedia';

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

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
  text: string;
  attachment: ChatAttachment | null;
};

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chat() {
  const { t } = useLanguage();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const media = useChatMedia();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextMessageId = useRef(1);
  const conversationRef = useRef<HTMLDivElement>(null);
  const hasMountedConversation = useRef(false);

  useEffect(() => {
    if (!hasMountedConversation.current) {
      hasMountedConversation.current = true;
      return;
    }
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
  }, [messages, notice, media.attachment]);

  function submitDemoMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() && !media.attachment) {
      setNotice('emptyDraftNotice');
      return;
    }
    const attachment = media.detachForMessage();
    setMessages((current) => [...current, {
      id: nextMessageId.current++,
      text: draft.trim(),
      attachment,
    }]);
    setNotice(attachment ? 'attachmentLocalNotice' : 'localDraftNotice');
    setDraft('');
    setAttachmentMenuOpen(false);
    media.clearError();
  }

  return (
    <main className="page-wrap chat-page">
      <div className="page-heading chat-page-heading animate-in">
        <div><div className="eyebrow"><i className="eyebrow-line" /> {t('chatEyebrow')}</div><h1>{t('chatTitle')}</h1><p>{t('chatDescription')}</p></div>
        <span className="page-tag"><CircleHelp size={14} /> {t('preparedTag')}</span>
      </div>
      <div className="chat-layout">
        <section className="panel chat-panel animate-in delay-1" aria-label={t('chatAria')}>
          <div className="chat-top">
            <div className="coach-ident"><EliAvatar className="coach-avatar" alt={t('avatarChatAlt')} testId="image-eli-chat" /><span><strong>{t('eliName')}</strong><small>{t('coachSubtitle')}</small></span></div>
            <span className="local-chip"><i className="prototype-dot" /> {t('localDemo')}</span>
          </div>
          <div className="chat-mode-actions" role="group" aria-label={t('modeActionsAria')}>
            <button type="button" aria-label={t('actionText')} title={t('actionText')} data-testid="button-chat-mode-text" onClick={() => setNotice('modeTextNotice')}>
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
            {messages.map((message) => (
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
                <span className="message-time">{t('localMessageTime')}</span>
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
          <form className="composer" onSubmit={submitDemoMessage}>
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
              disabled={media.recording === 'processing'}
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
              onChange={(event) => { setDraft(event.target.value); media.clearError(); }}
              data-testid="input-demo-message"
            />
            <button className="send-button" type="submit" aria-label={t('sendAria')} data-testid="button-demo-send" disabled={!draft.trim() && !media.attachment}>
              <Send size={16} />
            </button>
          </form>
          <p className="composer-disclosure">{t('composerDisclosure')}</p>
        </section>
      </div>
    </main>
  );
}

const week = [
  { dayKey: 'mon', testDay: 'ПН', done: true, today: false }, { dayKey: 'tue', testDay: 'ВТ', done: true, today: false }, { dayKey: 'wed', testDay: 'СР', done: false, today: false },
  { dayKey: 'thu', testDay: 'ЧТ', done: true, today: false }, { dayKey: 'fri', testDay: 'ПТ', done: false, today: true }, { dayKey: 'sat', testDay: 'СБ', done: false, today: false }, { dayKey: 'sun', testDay: 'НД', done: false, today: false },
] as const;

function Profile() {
  const { t } = useLanguage();
  return (
    <main className="page-wrap">
      <div className="page-heading animate-in">
        <div><div className="eyebrow"><i className="eyebrow-line" /> {t('profileEyebrow')}</div><h1>{t('profileTitle')}</h1><p>{t('profileDescription')}</p></div>
        <span className="page-tag"><Clock3 size={14} /> {t('weekRange')}</span>
      </div>
      <div className="profile-grid">
        <div className="profile-main">
          <section className="panel summary-panel animate-in delay-1" data-testid="content-example-profile">
            <div className="user-row"><EliAvatar className="initial-avatar" alt={t('avatarProfileAlt')} testId="image-eli-profile" /><span><h2>{t('profileSummary')}</h2><p>{t('noAccount')}</p></span></div>
            <span className="example-ribbon">{t('sampleData')}</span>
          </section>
          <section className="stats-row animate-in delay-1" aria-label={t('statsAria')}>
            <div className="stat"><div className="stat-label"><Activity size={12} /> {t('movement')}</div><span className="sample-label">{t('sample')}</span><strong>4<span>{t('days')}</span></strong></div>
            <div className="stat"><div className="stat-label"><Moon size={12} /> {t('sleep')}</div><span className="sample-label">{t('sample')}</span><strong>7.2<span>{t('averageHours')}</span></strong></div>
            <div className="stat"><div className="stat-label"><HeartPulse size={12} /> {t('energy')}</div><span className="sample-label">{t('sample')}</span><strong>6.8<span>/ 10</span></strong></div>
          </section>
          <section className="panel chart-panel animate-in delay-2">
            <div className="panel-head"><div><h2>{t('chartTitle')}</h2><p>{t('sampleScale')}</p></div><span className="chart-key"><i className="key-dot" /> {t('sample')}</span></div>
            <div className="chart" role="img" aria-label={t('chartAria')}>
              <svg viewBox="0 0 600 165" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id="lineGlow" x1="0" x2="1"><stop offset="0" stopColor="#8ac849" /><stop offset="1" stopColor="#c0ff5b" /></linearGradient></defs>
                <path d="M0 118 C40 109 49 103 85 105 S140 127 170 112 S225 86 255 96 S300 111 340 83 S390 78 425 86 S475 61 510 69 S557 43 600 49" fill="none" stroke="url(#lineGlow)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                <path d="M0 118 C40 109 49 103 85 105 S140 127 170 112 S225 86 255 96 S300 111 340 83 S390 78 425 86 S475 61 510 69 S557 43 600 49 L600 165 L0 165Z" fill="rgba(165,229,92,.07)" />
                <circle cx="600" cy="49" r="4" fill="#c0ff5b" />
              </svg>
            </div>
            <div className="chart-labels">{week.map(({ dayKey }) => <span key={dayKey}>{t(dayKey)}</span>)}</div>
          </section>
        </div>
        <aside className="profile-side">
          <section className="panel weekly-panel animate-in delay-2">
            <div className="panel-head"><div><h2>{t('thisWeek')}</h2><p>{t('sampleHabitMarks')}</p></div><span className="page-tag" style={{ padding: '7px 9px', fontSize: 9 }}>{t('sampleThreeOfSeven')}</span></div>
            <div className="week-days">
              {week.map(({ dayKey, testDay, done, today }) => <div key={dayKey} className={`day${done ? ' done' : ''}${today ? ' today' : ''}`} data-testid={`day-sample-${testDay}`}><span>{t(dayKey)}</span><span className="day-mark">{done && <Check size={12} />}</span></div>)}
            </div>
            <div className="weekly-note">{t('weekNote')}</div>
          </section>
          <section className="panel goal-panel animate-in delay-3">
            <div className="goal-top"><h2>{t('sampleGoal')}</h2><span className="goal-value">{t('sampleSixtyEight')}</span></div>
            <div className="goal-bar" role="img" aria-label={t('progressAria')}><span /></div>
            <div className="goal-caption"><span>{t('shortWalks')}</span><span>{t('fourOfSixDays')}</span></div>
            <div className="prototype-note" data-testid="text-profile-disclosure">{t('profileDisclosure')}</div>
          </section>
        </aside>
      </div>
      <p className="footer-note">{t('profileFooter')}</p>
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
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
    </LanguageProvider>
  );
}

export default App;
