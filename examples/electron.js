import { translateElectronMenu } from 'everyword/adapters';
import { wrapDOM } from 'everyword/dom';

// Renderer process: translate the live document and watch later UI changes.
export function localizeRenderer(engine, locale) {
  return wrapDOM(document, { engine, locale });
}

// Main process: pass Electron's Menu constructor in from the application entry
// point so this module remains testable without importing Electron itself.
export async function installTranslatedMenu({ Menu, engine, locale, template }) {
  const { value, report } = await translateElectronMenu(template, {
    engine,
    locale,
    context: 'application-menu',
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(value));
  return report;
}
