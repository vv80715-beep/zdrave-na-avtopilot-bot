type TelegramInsets = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
};

type TelegramThemeParams = {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  button_color?: string;
  button_text_color?: string;
};

type TelegramWebAppApi = {
  initData?: string;
  platform?: string;
  version?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: TelegramThemeParams;
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: TelegramInsets;
  contentSafeAreaInset?: TelegramInsets;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  isVersionAtLeast?: (version: string) => boolean;
  onEvent?: (event: string, callback: () => void) => void;
  offEvent?: (event: string, callback: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppApi;
    };
  }
}

const BRAND_BACKGROUND = '#08110d';
const INSET_PROPERTIES = [
  ['top', '--telegram-safe-top'],
  ['right', '--telegram-safe-right'],
  ['bottom', '--telegram-safe-bottom'],
  ['left', '--telegram-safe-left'],
] as const;

function safeInset(value: number | undefined) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value!))}px` : '0px';
}

function safeDarkThemeBackground(value: string | undefined, colorScheme: string | undefined) {
  if (colorScheme !== 'dark' || !value || !/^#[\da-f]{6}$/i.test(value)) {
    return BRAND_BACKGROUND;
  }
  const rgb = value.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || [];
  const luminance = rgb.length === 3
    ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    : 1;
  return luminance < 0.35 ? value : BRAND_BACKGROUND;
}

export function connectTelegramWebApp() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return () => undefined;

  const root = document.documentElement;
  const updateInsetsAndViewport = () => {
    const viewportHeight = webApp.viewportHeight || webApp.viewportStableHeight;
    if (Number.isFinite(viewportHeight) && viewportHeight! > 0) {
      root.style.setProperty('--telegram-viewport-height', `${Math.round(viewportHeight!)}px`);
    }

    INSET_PROPERTIES.forEach(([side, property]) => {
      const safe = safeInset(webApp.safeAreaInset?.[side]);
      const contentSafe = safeInset(webApp.contentSafeAreaInset?.[side]);
      root.style.setProperty(property, safe);
      root.style.setProperty(`--telegram-content-safe-${side}`, contentSafe);
    });
  };

  const updateTheme = () => {
    root.dataset.telegramColorScheme = webApp.colorScheme || 'unknown';
    const background = safeDarkThemeBackground(webApp.themeParams?.bg_color, webApp.colorScheme);
    root.style.setProperty('--telegram-theme-background', background);
    try {
      if (webApp.isVersionAtLeast?.('6.1')) {
      webApp.setHeaderColor?.(background);
      webApp.setBackgroundColor?.(background);
      }
    } catch {
      // Keep the demo usable if an older Telegram client lacks a theme method.
    }
  };

  try {
    webApp.ready?.();
    webApp.expand?.();
  } catch {
    // Optional SDK capabilities must not break the browser demo.
  }

  root.classList.add('telegram-webapp');
  updateInsetsAndViewport();
  updateTheme();

  const listeners = [
    ['viewportChanged', updateInsetsAndViewport],
    ['safeAreaChanged', updateInsetsAndViewport],
    ['contentSafeAreaChanged', updateInsetsAndViewport],
    ['themeChanged', updateTheme],
  ] as const;
  listeners.forEach(([event, callback]) => webApp.onEvent?.(event, callback));

  return () => {
    listeners.forEach(([event, callback]) => webApp.offEvent?.(event, callback));
    root.classList.remove('telegram-webapp');
    delete root.dataset.telegramColorScheme;
    root.style.removeProperty('--telegram-viewport-height');
    root.style.removeProperty('--telegram-theme-background');
    INSET_PROPERTIES.forEach(([, property]) => root.style.removeProperty(property));
    INSET_PROPERTIES.forEach(([side]) => root.style.removeProperty(`--telegram-content-safe-${side}`));
  };
}
