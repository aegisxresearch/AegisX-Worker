import {
  getLocale,
  isLocale,
  isMessageKey,
  setLocale,
  t,
  type Locale,
} from '../../../shared/i18n.ts';

const STORAGE_KEY = 'agent-office.locale';

/**
 * The language the operator chose last time, or the browser's own preference.
 * Persisted locally: it is a display choice, not office state, so it must not
 * depend on the server being reachable.
 */
export function bootLocale(): Locale {
  // `?lang=id` is a real link (share a screen in one language) and the handle a
  // browser test uses to load the page in a known language.
  const requested = new URLSearchParams(window.location.search).get('lang');
  const stored = requested ?? localStorage.getItem(STORAGE_KEY);
  const locale: Locale = isLocale(stored) ? stored : browserLocale();
  applyLocale(locale);
  return locale;
}

function browserLocale(): Locale {
  return navigator.language.toLowerCase().startsWith('id') ? 'id' : 'en';
}

/** Switches language, persists it, and rewrites the static parts of the page. */
export function applyLocale(locale: Locale): void {
  setLocale(locale);
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  translateDom();
}

/**
 * Every element that carries a `data-i18n*` attribute is rewritten from the
 * dictionary. Dynamic panels call `t()` themselves and re-render on the store
 * event that follows a language switch.
 */
export function translateDom(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = translate(key);
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    const key = node.dataset.i18nPlaceholder;
    if (key) node.setAttribute('placeholder', translate(key));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = node.dataset.i18nTitle;
    if (key) node.setAttribute('title', translate(key));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    const key = node.dataset.i18nAria;
    if (key) node.setAttribute('aria-label', translate(key));
  }
  document.title = translate('app.title');
}

/** A key typed in HTML is a string; an unknown one is a bug worth shouting about. */
function translate(key: string): string {
  if (!isMessageKey(key)) {
    console.warn(`i18n: "${key}" is not in the dictionary`);
    return key;
  }
  return t(key);
}

export { getLocale };
