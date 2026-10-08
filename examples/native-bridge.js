import { wrapAdapter } from 'everyword/adapters';

// The host app owns view discovery and mutation. This bridge is the small,
// versioned boundary that a Swift/Kotlin shell can expose to JavaScript.
export function attachNativeLocalization(host, engine, locale) {
  if (host?.apiVersion !== 1) throw new Error('Unsupported localization bridge version');
  if (typeof host.captureText !== 'function' || typeof host.applyText !== 'function') {
    throw new TypeError('The native host must implement captureText and applyText');
  }

  return wrapAdapter({
    async capture() {
      return (await host.captureText()).map((item) => {
        if (!['label', 'button', 'textField', 'accessibility'].includes(item.kind)) {
          throw new Error(`Unsupported native text kind: ${item.kind}`);
        }
        return {
          id: item.runtimeId,
          source: item.text,
          context: item.screen,
          kind: item.kind,
        };
      });
    },
    async apply(results, state) {
      await host.applyText({
        locale: state.locale,
        direction: state.direction,
        // The host must retain original source strings and ignore a canceled commit.
        signal: state.signal,
        isCurrent: state.isCurrent,
        updates: results.map(({ id, text, source }) => ({ runtimeId: id, source, text })),
      });
    },
    restore: () => host.restoreText?.(),
  }, { engine, locale });
}
