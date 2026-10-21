import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  HeartPulse,
  Leaf,
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

const navItems = [
  { href: '/', label: 'Начало', Icon: Sun, testId: 'link-home' },
  { href: '/chat', label: 'Разговор', Icon: MessageCircle, testId: 'link-chat' },
  { href: '/profile', label: 'Прогрес', Icon: Activity, testId: 'link-profile' },
];

function Navigation() {
  const [location] = useLocation();
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" data-testid="link-brand" aria-label="Здраве на автопилот — Начало">
          <span className="brand-mark" aria-hidden="true">Е</span>
          <span>Здраве на автопилот<span className="brand-sub">личен wellness ритъм</span></span>
        </Link>
        <nav className="desktop-links" aria-label="Основна навигация">
          {navItems.map(({ href, label, testId }) => (
            <Link key={href} href={href} data-testid={testId} className={`desktop-link${location === href ? ' active' : ''}`}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <span>пространство за малки стъпки</span>
          <span className="prototype-pill"><i className="prototype-dot" /> ПРОТОТИП</span>
        </div>
      </header>
      <nav className="bottom-nav" aria-label="Навигация">
        {navItems.map(({ href, label, Icon, testId }) => (
          <Link key={href} href={href} data-testid={testId} className={`bottom-link${location === href ? ' active' : ''}`} aria-current={location === href ? 'page' : undefined}>
            <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
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

function Home() {
  return (
    <main className="page-wrap">
      <section className="home-grid">
        <div className="hero-copy animate-in">
          <div className="eyebrow"><i className="eyebrow-line" /> ТВОЯТА ПО-ЛЕКА ЕЖЕДНЕВНОСТ</div>
          <h1>Грижата за теб.<span>Без сложен план.</span></h1>
          <p className="welcome-greeting" data-testid="text-welcome-greeting">Здравей. Нека започнем с една малка стъпка.</p>
          <p>Малки, изпълними навици за повече енергия и спокойствие. Започни с една стъпка — и виж как се променя ритъмът ти.</p>
          <div className="hero-actions">
            <Link href="/chat" className="primary-button" data-testid="button-start-chat">
              Разгледай демо разговора <ArrowRight size={16} />
            </Link>
            <span className="quiet-note">Кратко. Лично. В твое темпо.</span>
          </div>
        </div>
        <div className="orbit-stage animate-in delay-1" aria-label="Орбитална графика за баланс и ежедневен ритъм" data-testid="visual-orbit">
          <div className="orbit one" /><div className="orbit two" /><div className="orbit three" />
          <span className="orbit-node node-a" /><span className="orbit-node node-b" />
          <span className="orbit-label left">ритъм</span><span className="orbit-label right">баланс</span>
          <div className="orbit-core"><span className="core-mark" aria-hidden="true">Е</span></div>
          <div className="float-card metric"><small>дневен фокус</small><strong className="metric-value">+ малко движение</strong></div>
          <div className="float-card streak"><small>постоянство</small><strong>ден по ден</strong></div>
        </div>
      </section>
      <section className="home-bottom animate-in delay-2" aria-label="Как работи демото">
        <div className="intro-card">
          <span className="mini-icon"><HeartPulse size={19} strokeWidth={1.6} /></span>
          <p><strong>Това е демо преживяване.</strong> Разгледай примерен разговор и фиксиран примерен прогрес — нищо не се изпраща и не се записва.</p>
        </div>
        <div className="quote-card">
          „Не търсим перфектния ден. Търсим следващата добра стъпка.“
          <span>ПОДХОДЪТ НА ЕЛИ · ЗДРАВЕ НА АВТОПИЛОТ</span>
        </div>
      </section>
      <p className="footer-note" data-testid="text-prototype-disclosure">Прототип на приложение · Всички разговори и стойности са примерни.</p>
    </main>
  );
}

const preparedExamples = [
  {
    title: 'Пример: кратка пауза за дишане',
    prompt: 'Искам малко повече спокойствие.',
    text: 'Опитай за минута: вдишай бавно през носа, после издишай малко по-дълго. Не е нужно да променяш нищо друго точно сега.',
  },
  {
    title: 'Пример: движение в натоварен ден',
    prompt: 'Как да се раздвижа между задачите?',
    text: 'Избери една кратка пауза днес — разходка до прозореца, няколко разтягания или стълбите вместо асансьора. Достатъчно е да започнеш.',
  },
  {
    title: 'Пример: по-спокойна вечер',
    prompt: 'Искам да забавя темпото вечер.',
    text: 'Можеш да оставиш екрана за десет минути и да подготвиш нещо за утре. Малък ритуал често помага на деня да приключи по-меко.',
  },
];

function Chat() {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [activeExample, setActiveExample] = useState<number | null>(null);
  const [localMessage, setLocalMessage] = useState('');
  const [selectedMode, setSelectedMode] = useState<'text' | 'voice' | 'avatar'>('text');
  const [quickAction, setQuickAction] = useState<'plan' | 'tip' | 'report' | null>(null);

  const quickContent = {
    plan: {
      title: 'Моят план · пример',
      text: 'За днес: избери една кратка разходка и остави няколко минути за почивка. Това е фиксиран пример, не личен или активен план.',
    },
    tip: {
      title: 'Съвет за днес · пример',
      text: 'Преди следващата задача, отпусни рамене и направи три спокойни вдишвания. Малката пауза е достатъчна.',
    },
    report: {
      title: 'Дневен отчет · пример',
      text: 'Примерен отчет: движение — 1 кратка пауза; настроение — спокойно; следваща стъпка — по твой избор. Няма реални измервания или проследяване.',
    },
  };

  const modes = [
    { id: 'text' as const, label: 'Текст', Icon: TextCursorInput },
    { id: 'voice' as const, label: 'Глас', Icon: AudioLines },
    { id: 'avatar' as const, label: 'Аватар', Icon: ScanLine },
  ];

  function submitDemoMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) {
      setNotice('Напиши демо текст, за да видиш локалното потвърждение.');
      return;
    }
    setLocalMessage(draft.trim());
    setNotice('Твоят текст е показан само тук като локален пример. Не е изпратен, записан или обработен.');
    setDraft('');
  }

  return (
    <main className="page-wrap">
      <div className="page-heading animate-in">
        <div><div className="eyebrow"><i className="eyebrow-line" /> ПРИМЕРЕН РАЗГОВОР</div><h1>Разговор</h1><p>Виж как може да изглежда една подкрепяща размяна.</p></div>
        <span className="page-tag"><CircleHelp size={14} /> Подготвено демо съдържание</span>
      </div>
      <div className="chat-layout">
        <section className="panel chat-panel animate-in delay-1" aria-label="Демо чат">
          <div className="chat-top">
            <div className="coach-ident"><span className="coach-avatar" aria-hidden="true">Е</span><span><strong>Ели</strong><small>Здраве на автопилот · пример</small></span></div>
            <span className="local-chip"><i className="prototype-dot" /> само локално демо</span>
          </div>
          <div className="mode-picker" role="group" aria-label="Избор на демо режим">
            {modes.map(({ id, label, Icon }) => (
              <button key={id} type="button" className={`mode-button${selectedMode === id ? ' active' : ''}`} aria-pressed={selectedMode === id} data-testid={`button-mode-${id}`} onClick={() => { setSelectedMode(id); setNotice(`${label}: само визуален демо режим. Реалната функция не е активна.`); }}>
                <Icon size={14} /><span>{label}</span><small>демо</small>
              </button>
            ))}
          </div>
          <div className="quick-actions" aria-label="Подготвени бързи действия">
            <button type="button" data-testid="button-quick-plan" onClick={() => setQuickAction('plan')}><NotebookTabs size={14} />Моят план</button>
            <button type="button" data-testid="button-quick-tip" onClick={() => setQuickAction('tip')}><Sparkles size={14} />Съвет за днес</button>
            <button type="button" data-testid="button-quick-report" onClick={() => setQuickAction('report')}><Activity size={14} />Дневен отчет</button>
          </div>
          <div className="conversation" aria-live="polite" data-testid="content-chat-example">
            <div className="date-divider">подготвен пример</div>
            <div className="message coach">
              <div className="message-label"><Sparkles size={11} /> Ели · ПРИМЕРЕН ТЕКСТ</div>
              <div className="message-bubble">Здравей! Как се чувстваш днес — имаш ли нужда от повече енергия, движение или малко спокойствие?</div>
              <span className="message-time">примерно начало</span>
            </div>
            <div className="message user"><div className="message-bubble">Малко съм разсеяна и ми се иска да се раздвижа.</div><span className="message-time">примерно съобщение</span></div>
            <div className="message coach">
              <div className="message-label"><Sparkles size={11} /> Ели · ПОДГОТВЕН ОТГОВОР</div>
              <div className="message-bubble">Нека бъде съвсем просто: отдели пет минути за лека разходка или разтягане. Каквото ти пасва в момента.</div>
              <div className="prepared-box"><strong>Това е статичен пример.</strong> Не е генериран от AI и не е отговор на живо.</div>
            </div>
            {activeExample !== null && (
              <>
                <div className="message user"><div className="message-bubble">{preparedExamples[activeExample].prompt}</div><span className="message-time">примерно действие</span></div>
                <div className="message coach">
                  <div className="message-label"><Sparkles size={11} /> ПОДГОТВЕН ПРИМЕР · НЕ НА ЖИВО</div>
                  <div className="message-bubble">{preparedExamples[activeExample].text}</div>
                  <div className="prepared-box"><strong>Предварително написано съдържание.</strong> Не е изпратена заявка и няма реален AI отговор.</div>
                </div>
              </>
            )}
            {quickAction && (
              <div className="quick-result" role="status">
                <div className="quick-result-heading"><span>{quickContent[quickAction].title}</span><span>ПРИМЕР · НЕ НА ЖИВО</span></div>
                <p>{quickContent[quickAction].text}</p>
                <strong>Фиксирано демонстрационно съдържание. Не е реален план, отчет или измерване.</strong>
              </div>
            )}
            {localMessage && <div className="message user"><div className="message-bubble">{localMessage}</div><span className="message-time">локално · не е изпратено</span></div>}
            {notice && <div className="local-notice" role="status" data-testid="status-local-message">{notice}</div>}
          </div>
          <form className="composer" onSubmit={submitDemoMessage}>
            <input aria-label="Текст за локално демо" placeholder="Напиши текст — остава тук" value={draft} onChange={(event) => setDraft(event.target.value)} data-testid="input-demo-message" />
            <button className="send-button" type="submit" aria-label="Покажи текст локално, без изпращане" data-testid="button-demo-send"><Send size={16} /></button>
          </form>
          <p className="composer-disclosure">Локален демо преглед · не се изпраща и не се записва</p>
        </section>
        <aside className="chat-side animate-in delay-2">
          <section className="panel side-card">
            <div className="eyebrow"><i className="eyebrow-line" /> ИЗБЕРИ ПРИМЕР</div>
            <h2 style={{ marginTop: 12 }}>Готови демо сценарии</h2>
            <p>Бутоните показват предварително написан текст. Няма AI, изпращане или реална комуникация.</p>
            <div className="prompt-list">
              {preparedExamples.map((example, index) => (
                <button key={example.title} type="button" className="prompt-button" onClick={() => setActiveExample(index)} data-testid={`button-example-${index}`}>
                  <span>{example.title.replace('Пример: ', '')}</span><ChevronRight size={14} />
                </button>
              ))}
            </div>
          </section>
          <div className="chat-warning" data-testid="text-chat-disclosure">Текстът в полето остава в тази страница. Изпращането е изключено; бутонът само показва локално съобщение.</div>
        </aside>
      </div>
      <p className="footer-note">Прототип · Всички реплики и действия са фиксирани примери без реална интеграция.</p>
    </main>
  );
}

const week = [
  { day: 'ПН', done: true }, { day: 'ВТ', done: true }, { day: 'СР', done: false },
  { day: 'ЧТ', done: true }, { day: 'ПТ', done: false, today: true }, { day: 'СБ', done: false }, { day: 'НД', done: false },
];

function Profile() {
  return (
    <main className="page-wrap">
      <div className="page-heading animate-in">
        <div><div className="eyebrow"><i className="eyebrow-line" /> МАЛКИТЕ СТЪПКИ СЕ НАТРУПВАТ</div><h1>Прогрес</h1><p>Примерен поглед към един по-балансиран ритъм.</p></div>
        <span className="page-tag"><Clock3 size={14} /> Седмица 12–18 май</span>
      </div>
      <div className="profile-grid">
        <div className="profile-main">
          <section className="panel summary-panel animate-in delay-1" data-testid="content-example-profile">
            <div className="user-row"><span className="initial-avatar">Е</span><span><h2>Твоят примерен профил</h2><p>Няма реален акаунт или запазени лични данни.</p></span></div>
            <span className="example-ribbon">примерни данни · не са личен резултат</span>
          </section>
          <section className="stats-row animate-in delay-1" aria-label="Примерни показатели">
            <div className="stat"><div className="stat-label"><Activity size={12} /> Движение</div><span className="sample-label">ПРИМЕРНО</span><strong>4<span>дни</span></strong></div>
            <div className="stat"><div className="stat-label"><Moon size={12} /> Сън</div><span className="sample-label">ПРИМЕРНО</span><strong>7.2<span>ч средно</span></strong></div>
            <div className="stat"><div className="stat-label"><HeartPulse size={12} /> Енергия</div><span className="sample-label">ПРИМЕРНО</span><strong>6.8<span>/ 10</span></strong></div>
          </section>
          <section className="panel chart-panel animate-in delay-2">
            <div className="panel-head"><div><h2>Енергия през седмицата</h2><p>ПРИМЕРНИ стойности · илюстративна скала 1–10</p></div><span className="chart-key"><i className="key-dot" /> ПРИМЕРНО</span></div>
            <div className="chart" role="img" aria-label="Примерна линия на енергията през седмицата, с леко покачване към края">
              <svg viewBox="0 0 600 165" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id="lineGlow" x1="0" x2="1"><stop offset="0" stopColor="#8ac849" /><stop offset="1" stopColor="#c0ff5b" /></linearGradient></defs>
                <path d="M0 118 C40 109 49 103 85 105 S140 127 170 112 S225 86 255 96 S300 111 340 83 S390 78 425 86 S475 61 510 69 S557 43 600 49" fill="none" stroke="url(#lineGlow)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                <path d="M0 118 C40 109 49 103 85 105 S140 127 170 112 S225 86 255 96 S300 111 340 83 S390 78 425 86 S475 61 510 69 S557 43 600 49 L600 165 L0 165Z" fill="rgba(165,229,92,.07)" />
                <circle cx="600" cy="49" r="4" fill="#c0ff5b" />
              </svg>
            </div>
            <div className="chart-labels"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span><span>СБ</span><span>НД</span></div>
          </section>
        </div>
        <aside className="profile-side">
          <section className="panel weekly-panel animate-in delay-2">
            <div className="panel-head"><div><h2>Тази седмица</h2><p>ПРИМЕРНИ отметки за навик</p></div><span className="page-tag" style={{ padding: '7px 9px', fontSize: 9 }}>ПРИМЕР · 3 / 7</span></div>
            <div className="week-days">
              {week.map(({ day, done, today }) => <div key={day} className={`day${done ? ' done' : ''}${today ? ' today' : ''}`} data-testid={`day-sample-${day}`}><span>{day}</span><span className="day-mark">{done && <Check size={12} />}</span></div>)}
            </div>
            <div className="weekly-note">Няма нужда от идеална серия. Върни се към навика, когато ти е удобно.</div>
          </section>
          <section className="panel goal-panel animate-in delay-3">
            <div className="goal-top"><h2>Примерна цел</h2><span className="goal-value">ПРИМЕР · 68%</span></div>
            <div className="goal-bar" aria-label="Примерната цел е изпълнена на 68 процента"><span /></div>
            <div className="goal-caption"><span>Кратки разходки</span><span>4 / 6 дни</span></div>
            <div className="prototype-note" data-testid="text-profile-disclosure">Всички стойности тук са демонстрационни и фиксирани. Те не са измерени, свързани с човек или съхранени.</div>
          </section>
        </aside>
      </div>
      <p className="footer-note">Прототип на приложение · примерни показатели, без акаунт и без съхранение.</p>
    </main>
  );
}

function NotFound() {
  return <main className="page-wrap"><div className="panel side-card"><div className="eyebrow">НЕ Е НАМЕРЕНО</div><h1>Тази страница липсва.</h1><Link href="/" className="primary-button" data-testid="link-back-home">Към началото <ArrowRight size={15} /></Link></div></main>;
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
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Router />
    </WouterRouter>
  );
}

export default App;
