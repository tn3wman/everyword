import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localeDirection,
  translateElectronMenu,
  translateMessages,
  translateObject,
  wrapAdapter,
} from '../src/adapters.js';

function engineWith(translate) {
  return { sourceLocale: 'en', translate };
}

const translatingEngine = engineWith(async (segments, { locale }) => segments.map((segment) => ({
  ...segment,
  text: `${locale}:${segment.source}`,
  status: locale === 'en' ? 'source' : 'translated',
  reviewed: true,
})));

test('translateObject only translates whitelisted text and preserves immutable structure', async () => {
  const callback = () => 'clicked';
  const input = {
    id: 'save',
    label: 'Save',
    count: 2,
    onClick: callback,
    nested: { title: 'Settings', slug: 'settings' },
    user: { userInput: true, text: 'A user wrote this' },
    disabled: { localize: false, description: 'Internal' },
    explicit: { translate: 'no', message: 'Keep me' },
    rows: [{ placeholder: 'Name', value: 'Ada' }],
  };

  const { value, report } = await translateObject(input, { engine: translatingEngine, locale: 'fr' });
  assert.notEqual(value, input);
  assert.equal(input.label, 'Save');
  assert.equal(value.label, 'fr:Save');
  assert.equal(value.nested.title, 'fr:Settings');
  assert.equal(value.rows[0].placeholder, 'fr:Name');
  assert.equal(value.id, 'save');
  assert.equal(value.nested.slug, 'settings');
  assert.equal(value.rows[0].value, 'Ada');
  assert.equal(value.user.text, 'A user wrote this');
  assert.equal(value.disabled.description, 'Internal');
  assert.equal(value.explicit.message, 'Keep me');
  assert.equal(value.onClick, callback);
  assert.equal(report.total, 3);
  assert.equal(report.translated, 3);
});

test('translateObject supports an explicit key set and message alias', async () => {
  const input = { heading: 'Hello', title: 'Untouched' };
  const output = await translateMessages(input, { engine: translatingEngine, locale: 'es', keys: ['heading'] });
  assert.deepEqual(output.value, { heading: 'es:Hello', title: 'Untouched' });
});

test('unsafe engine results retain source text and appear in coverage', async () => {
  const engine = engineWith(async ([segment]) => [{ ...segment, text: '<script>', status: 'rejected', reviewed: false, reason: 'markup' }]);
  const input = { message: 'Safe' };
  const output = await translateObject(input, { engine, locale: 'de' });
  assert.equal(output.value, input);
  assert.equal(output.report.rejected, 1);
  assert.equal(output.report.issues[0].reason, 'markup');
});

test('wrapAdapter allows only the latest locale to apply', async () => {
  const pending = new Map();
  const engine = engineWith((segments, { locale }) => new Promise((resolve) => {
    pending.set(locale, () => resolve(segments.map((segment) => ({
      ...segment,
      text: `${locale}:${segment.source}`,
      status: 'translated',
      reviewed: true,
    }))));
  }));
  const applied = [];
  const wrapper = wrapAdapter({
    capture: () => [{ id: 'greeting', source: 'Hello' }],
    apply: (results, options) => applied.push({ results, options }),
  }, { engine, locale: 'fr' });

  const french = wrapper.refresh();
  await new Promise(setImmediate);
  const arabic = wrapper.setLocale('ar-EG');
  await new Promise(setImmediate);
  pending.get('ar-EG')();
  await arabic;
  pending.get('fr')();
  await french;

  assert.equal(applied.length, 1);
  assert.equal(applied[0].options.locale, 'ar-EG');
  assert.equal(applied[0].options.direction, 'rtl');
  assert.equal(wrapper.report().locale, 'ar-EG');
});

test('wrapAdapter reports a failure and recovers on refresh', async () => {
  let calls = 0;
  const applied = [];
  const wrapper = wrapAdapter({
    capture: () => [{ id: 'one', source: 'One' }],
    apply: (results) => applied.push(results),
  }, {
    engine: engineWith(async (segments) => {
      if (++calls === 1) throw new Error('offline');
      return segments.map((segment) => ({ ...segment, text: 'Uno', status: 'translated', reviewed: true }));
    }),
    locale: 'es',
  });
  const failed = await wrapper.refresh();
  assert.equal(failed.errors, 1);
  assert.equal(failed.issues[0].reason, 'offline');
  const recovered = await wrapper.refresh();
  assert.equal(recovered.translated, 1);
  assert.equal(applied.length, 1);
});

test('disconnect aborts work and restores the host', async () => {
  let restored = false;
  let applied = false;
  const wrapper = wrapAdapter({
    capture: () => [{ id: 'one', source: 'One' }],
    apply: () => { applied = true; },
    restore: () => { restored = true; },
  }, { engine: engineWith(() => new Promise(() => {})), locale: 'fr' });
  void wrapper.refresh();
  await wrapper.disconnect();
  assert.equal(restored, true);
  assert.equal(applied, false);
});

test('Electron menu translation only changes recursive labels', async () => {
  const click = () => {};
  const template = [{ label: 'File', role: 'fileMenu', click, submenu: [{ label: 'Quit', role: 'quit' }] }];
  const { value } = await translateElectronMenu(template, { engine: translatingEngine, locale: 'nl' });
  assert.equal(value[0].label, 'nl:File');
  assert.equal(value[0].submenu[0].label, 'nl:Quit');
  assert.equal(value[0].role, 'fileMenu');
  assert.equal(value[0].click, click);
  assert.equal(template[0].label, 'File');
});

test('localeDirection recognizes RTL language tags', () => {
  assert.equal(localeDirection('fa-IR'), 'rtl');
  assert.equal(localeDirection('en-US'), 'ltr');
});

test('JSON fields named __proto__ cannot change output prototypes',async()=>{
  const {createEngine}=await import('../src/core.js');const {catalogProvider}=await import('../src/providers.js');
  const value=JSON.parse('{"__proto__":{"title":"Hello"},"title":"Hello"}');
  const translated=await translateObject(value,{engine:createEngine({provider:catalogProvider({es:{Hello:'Hola'}})}),locale:'es'});
  assert.equal(Object.getPrototypeOf(translated.value),Object.prototype);
  assert.ok(Object.hasOwn(translated.value,'__proto__'));
  assert.equal(translated.value.__proto__.title,'Hola');assert.equal(value.title,'Hello');
});
