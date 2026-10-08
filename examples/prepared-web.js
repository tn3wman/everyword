import {canonicalLocale, createEngine} from 'everyword/core';
import {wrapDOM} from 'everyword/dom';
import {httpProvider} from 'everyword/providers';
import {availableLocales} from 'everyword/readiness';

/** Mount a DOM translator that can select only languages prepared on the server. */
export async function mountPreparedDOM(root, {
  endpoint = '/everyword',
  sourceLocale = 'en',
  locale = 'en',
  locales,
  onReport,
} = {}) {
  const base = endpoint.replace(/\/$/, '');
  const prepared = await availableLocales({
    endpoint: `${base}/api/languages`,
    sourceLocale,
    locales,
  });
  const source = prepared[0];
  const requested = canonicalLocale(locale);
  const initial = prepared.includes(requested) ? requested : source;
  const engine = createEngine({
    sourceLocale: source,
    provider: httpProvider({endpoint: `${base}/api/translate`, cacheOnly: true}),
  });
  const controller = wrapDOM(root, {engine, locale: initial, onReport});

  return {
    availableLocales: prepared,
    ready: controller.ready,
    setLocale(nextLocale) {
      const next = canonicalLocale(nextLocale);
      if (!prepared.includes(next)) {
        throw new RangeError(`Language ${next} is not prepared.`);
      }
      return controller.setLocale(next);
    },
    refresh: () => controller.refresh(),
    report: () => controller.report(),
    disconnect: (options) => controller.disconnect(options),
  };
}
