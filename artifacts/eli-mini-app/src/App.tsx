import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  HeartPulse,
  Leaf,
  LockKeyhole,
  MessageCircle,
  Moon,
  NotebookTabs,
  ScanLine,
  Send,
  Sparkles,
  Sun,
  TextCursorInput,
} from 'lucide-react';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import { translate, type Language, type TranslationKey } from './i18n';

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return 'bg';
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
  return (
    <main className="page-wrap">
      <section className="home-grid">
        <div className="hero-copy animate-in">
          <div className="eyebrow"><i className="eyebrow-line" /> {t('homeEyebrow')}</div>
          <h1>{t('heroTitleFirst')}<span>{t('heroTitleSecond')}</span></h1>
          <p className="welcome-greeting" data-testid="text-welcome-greeting">{t('greeting')}</p>
          <p>{t('homeDescription')}</p>
          <div className="hero-actions">
            <Link href="/chat" className="primary-button" data-testid="button-start-chat">
              {t('startChat')} <ArrowRight size={16} />
            </Link>
            <span className="quiet-note">{t('quietNote')}</span>
          </div>
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

const preparedExamples = [
  {
    titleKey: 'exampleBreathTitle',
    promptKey: 'exampleBreathPrompt',
    textKey: 'exampleBreathText',
  },
  {
    titleKey: 'exampleMovementTitle',
    promptKey: 'exampleMovementPrompt',
    textKey: 'exampleMovementText',
  },
  {
    titleKey: 'exampleEveningTitle',
    promptKey: 'exampleEveningPrompt',
    textKey: 'exampleEveningText',
  },
] as const;

function Chat() {
  const { t } = useLanguage();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [activeExample, setActiveExample] = useState<number | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [localMessage, setLocalMessage] = useState('');
  const [selectedMode, setSelectedMode] = useState<'text' | 'voice' | 'avatar'>('text');
  const [quickAction, setQuickAction] = useState<'plan' | 'tip' | 'report' | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const hasMountedConversation = useRef(false);

  useEffect(() => {
    if (!hasMountedConversation.current) {
      hasMountedConversation.current = true;
      return;
    }
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
  }, [activeExample, quickAction, localMessage, notice]);

  const quickContent = {
    plan: { titleKey: 'quickPlanTitle', textKey: 'quickPlanText' },
    tip: { titleKey: 'quickTipTitle', textKey: 'quickTipText' },
    report: { titleKey: 'quickReportTitle', textKey: 'quickReportText' },
  } as const;

  const modes = [
    { id: 'text' as const, labelKey: 'modeText', noticeKey: 'modeTextNotice', Icon: TextCursorInput },
    { id: 'voice' as const, labelKey: 'modeVoice', noticeKey: 'modeVoiceNotice', Icon: AudioLines },
    { id: 'avatar' as const, labelKey: 'modeAvatar', noticeKey: 'modeAvatarNotice', Icon: ScanLine },
  ] as const;

  function submitDemoMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) {
      setNotice('emptyDraftNotice');
      return;
    }
    setLocalMessage(draft.trim());
    setNotice('localDraftNotice');
    setDraft('');
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
          <button className="chat-tools-toggle" type="button" aria-expanded={toolsOpen} aria-controls="chat-tools" onClick={() => setToolsOpen((open) => !open)}>
            <span>{t('chatTools')}</span><ChevronDown size={14} className={toolsOpen ? 'is-open' : ''} />
          </button>
          {toolsOpen && <div className="chat-tools" id="chat-tools">
          <div className="mode-picker" role="group" aria-label={t('modesAria')}>
            {modes.map(({ id, labelKey, noticeKey, Icon }) => (
              <button key={id} type="button" className={`mode-button${selectedMode === id ? ' active' : ''}`} aria-pressed={selectedMode === id} data-testid={`button-mode-${id}`} onClick={() => { setSelectedMode(id); setNotice(noticeKey); }}>
                {id === 'text' ? <Icon size={14} /> : <LockKeyhole size={13} />}
                <span>{t(labelKey)}</span><small>{t(id === 'text' ? 'demoShort' : 'locked')}</small>
              </button>
            ))}
          </div>
          <p className="mode-disclosure">{t('modeDemoDisclosure')}</p>
          <button className="scenario-toggle" type="button" aria-label={t('scenarioControlAria')} aria-expanded={scenariosOpen} aria-controls="demo-scenarios" onClick={() => setScenariosOpen((open) => !open)}>
            <span>{t('chooseExample')}</span><ChevronDown size={15} className={scenariosOpen ? 'is-open' : ''} />
          </button>
          {scenariosOpen && (
            <div className="scenario-list" id="demo-scenarios">
              {preparedExamples.map((example, index) => (
                <button key={example.titleKey} type="button" className="prompt-button" onClick={() => { setActiveExample(index); setScenariosOpen(false); setToolsOpen(false); }} data-testid={`button-example-${index}`}>
                  <span>{t(example.titleKey)}</span><ChevronRight size={14} />
                </button>
              ))}
            </div>
          )}
          <div className="quick-actions" aria-label={t('quickActionsAria')}>
            <button type="button" data-testid="button-quick-plan" onClick={() => setQuickAction('plan')}><NotebookTabs size={14} />{t('quickPlan')}</button>
            <button type="button" data-testid="button-quick-tip" onClick={() => setQuickAction('tip')}><Sparkles size={14} />{t('quickTip')}</button>
            <button type="button" data-testid="button-quick-report" onClick={() => setQuickAction('report')}><Activity size={14} />{t('quickReport')}</button>
          </div>
          </div>}
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
            {activeExample !== null && (
              <>
                <div className="message user"><div className="message-bubble">{t(preparedExamples[activeExample].promptKey)}</div><span className="message-time">{t('sampleAction')}</span></div>
                <div className="message coach">
                  <EliAvatar className="message-avatar" alt={t('avatarChatAlt')} testId="image-eli-chat-message-example" />
                  <div className="coach-message-body">
                    <div className="message-label"><Sparkles size={11} /> {t('preparedLive')}</div>
                    <div className="message-bubble">{t(preparedExamples[activeExample].textKey)}</div>
                    <div className="prepared-box"><strong>{t('preparedContent')}</strong>{t('noAiRequest')}</div>
                  </div>
                </div>
              </>
            )}
            {quickAction && (
              <div className="quick-result" role="status">
                <div className="quick-result-heading"><span>{t(quickContent[quickAction].titleKey)}</span><span>{t('sampleNotLive')}</span></div>
                <p>{t(quickContent[quickAction].textKey)}</p>
                <strong>{t('fixedDemoContent')}</strong>
              </div>
            )}
            {localMessage && <div className="message user"><div className="message-bubble">{localMessage}</div><span className="message-time">{t('localMessageTime')}</span></div>}
            {notice && <div className="local-notice" role="status" data-testid="status-local-message">{t(notice)}</div>}
          </div>
          <form className="composer" onSubmit={submitDemoMessage}>
            <input aria-label={t('inputAria')} placeholder={t('inputPlaceholder')} enterKeyHint="send" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} data-testid="input-demo-message" />
            <button className="send-button" type="submit" aria-label={t('sendAria')} data-testid="button-demo-send"><Send size={16} /></button>
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
  return (
    <LanguageProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
    </LanguageProvider>
  );
}

export default App;
