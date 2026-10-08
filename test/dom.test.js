import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { wrapDOM } from '../src/dom.js';

function engine(translate = async (segments, { locale }) => segments.map((segment) => ({
  ...segment,
  text: `${locale}:${segment.source}`,
  status: 'translated',
  reviewed: true,
}))) {
  return { sourceLocale: 'en', translate };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('translates text and safe attributes, then restores their source', async () => {
  const dom = new JSDOM('<title>Home</title><main title="Tip"> Hello <input placeholder="Name" value="typed"><input type="submit" value="Send"></main>');
  const wrapper = wrapDOM(dom.window.document, { engine: engine() });

  const report = await wrapper.setLocale('fr');
  assert.equal(dom.window.document.title, 'fr:Home');
  assert.match(dom.window.document.querySelector('main').textContent, /fr: Hello /);
  assert.equal(dom.window.document.querySelector('main').title, 'fr:Tip');
  assert.equal(dom.window.document.querySelector('input').placeholder, 'fr:Name');
  assert.equal(dom.window.document.querySelector('input').value, 'typed');
  assert.equal(dom.window.document.querySelector('[type=submit]').value, 'fr:Send');
  assert.equal(report.translated, report.total);

  await wrapper.setLocale('en');
  assert.equal(dom.window.document.title, 'Home');
  assert.equal(dom.window.document.querySelector('main').title, 'Tip');
  assert.equal(dom.window.document.querySelector('[type=submit]').value, 'Send');
  wrapper.disconnect();
});

test('observes new content and application edits without translating its own writes in a loop', async () => {
  const dom = new JSDOM('<main><p>One</p></main>');
  let calls = 0;
  const wrapper = wrapDOM(dom.window.document, { engine: engine(async (segments, { locale }) => {
    calls++;
    return segments.map((segment) => ({ ...segment, text: `${locale}:${segment.source}`, status: 'translated' }));
  }) });
  await wrapper.setLocale('es');
  const paragraph = dom.window.document.querySelector('p');
  paragraph.textContent = 'Two';
  const added = dom.window.document.createElement('span');
  added.textContent = 'Three';
  dom.window.document.querySelector('main').append(added);
  await tick();
  await tick();
  assert.equal(paragraph.textContent, 'es:Two');
  assert.equal(added.textContent, 'es:Three');
  assert.ok(calls <= 3, `unexpected translation loop: ${calls} calls`);
  wrapper.disconnect();
});

test('latest locale wins and an application edit invalidates an in-flight result', async () => {
  const dom = new JSDOM('<p>Hello</p>');
  const pending = new Map();
  const controlled = engine((segments, { locale }) => new Promise((resolve) => pending.set(locale, () => resolve(
    segments.map((segment) => ({ ...segment, text: `${locale}:${segment.source}`, status: 'translated' })),
  ))));
  const wrapper = wrapDOM(dom.window.document, { engine: controlled });
  const french = wrapper.setLocale('fr');
  const german = wrapper.setLocale('de');
  pending.get('de')();
  await german;
  pending.get('fr')();
  await french;
  assert.equal(dom.window.document.querySelector('p').textContent, 'de:Hello');

  const italian = wrapper.setLocale('it');
  dom.window.document.querySelector('p').textContent = 'Changed by app';
  pending.get('it')();
  await italian;
  assert.equal(dom.window.document.querySelector('p').textContent, 'Changed by app');
  await wrapper.setLocale('en');
  assert.equal(dom.window.document.querySelector('p').textContent, 'Changed by app');
  wrapper.disconnect();
});

test('report-driven status changes inside ignored controls do not restart translation', async () => {
  const dom = new JSDOM('<main><button>Settings</button><p data-everyword-ignore role="status"></p></main>');
  let calls = 0, reports = 0;
  const wrapper = wrapDOM(dom.window.document, {
    engine: engine(async (segments, {locale}) => {
      calls++;
      return segments.map(segment => ({...segment,text:`${locale}:${segment.source}`,status:'translated'}));
    }),
    onReport(report) {
      if (++reports < 8) dom.window.document.querySelector('[role=status]').textContent = report.pending ? 'Translating' : 'Ready';
    },
  });
  await wrapper.setLocale('es');
  await tick();
  assert.equal(calls, 1);
  assert.equal(wrapper.report().pending, false);
  assert.equal(dom.window.document.querySelector('[role=status]').textContent, 'Ready');
  wrapper.disconnect();
});

test('does not recreate an attribute removed during translation', async () => {
  const dom = new JSDOM('<img alt="Portrait">');
  let resolveTranslation;
  const wrapper = wrapDOM(dom.window.document, { engine: engine((segments) => new Promise((resolve) => {
    resolveTranslation = () => resolve(segments.map((segment) => ({ ...segment, text: 'Portrait traduit', status: 'translated' })));
  })) });
  const request = wrapper.setLocale('fr');
  dom.window.document.querySelector('img').removeAttribute('alt');
  resolveTranslation();
  await request;
  assert.equal(dom.window.document.querySelector('img').hasAttribute('alt'), false);
  wrapper.disconnect();
});

test('honors exclusions and translates open shadow roots', async () => {
  const dom = new JSDOM('<main><code>code</code><div translate="no">No</div><div data-everyword-ignore>Ignored</div><div contenteditable>Draft</div><x-card></x-card></main>');
  const host = dom.window.document.querySelector('x-card');
  host.attachShadow({ mode: 'open' }).innerHTML = '<span aria-label="Label">Shadow</span>';
  const wrapper = wrapDOM(dom.window.document, { engine: engine() });
  await wrapper.setLocale('nl');
  assert.equal(dom.window.document.querySelector('code').textContent, 'code');
  assert.equal(dom.window.document.querySelector('[translate=no]').textContent, 'No');
  assert.equal(dom.window.document.querySelector('[data-everyword-ignore]').textContent, 'Ignored');
  assert.equal(dom.window.document.querySelector('[contenteditable]').textContent, 'Draft');
  assert.equal(host.shadowRoot.querySelector('span').textContent, 'nl:Shadow');
  assert.equal(host.shadowRoot.querySelector('span').getAttribute('aria-label'), 'nl:Label');
  wrapper.disconnect();
});

test('scanning continues past an excluded last child into later parent siblings', async () => {
  const dom=new JSDOM('<head><script>const code="untouched"</script></head><body><section><code>Code</code></section><main><p>Hello</p></main></body>');
  const wrapper=wrapDOM(dom.window.document,{engine:engine(),locale:'fr'});
  await wrapper.ready;
  assert.equal(dom.window.document.querySelector('p').textContent,'fr:Hello');
  assert.equal(dom.window.document.querySelector('code').textContent,'Code');
  wrapper.disconnect();
});

test('source metadata, RTL direction and initial locale work without a manual refresh',async()=>{
  const dom=new JSDOM('<main lang="en-GB" dir="ltr"><h2>Battery settings</h2><button>Charge</button><p contenteditable="false">Help</p></main>');
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:engine(),locale:'ar'});
  const report=await wrapper.ready;
  assert.equal(dom.window.document.querySelector('main').dir,'rtl');
  assert.equal(dom.window.document.querySelector('main').lang,'ar');
  assert.equal(dom.window.document.querySelector('p').textContent,'ar:Help');
  assert.ok(report.segments.find(s=>s.source==='Charge').context.includes('Battery settings'));
  await wrapper.setLocale('fr');
  assert.ok(wrapper.report().segments.find(s=>s.source==='Charge').context.includes('Battery settings'));
  wrapper.disconnect();
  assert.equal(dom.window.document.querySelector('main').lang,'en-GB');
  assert.equal(dom.window.document.querySelector('main').dir,'ltr');
});

test('moved shadow content leaves the owned wrapper and is never changed by later requests',async()=>{
  const dom=new JSDOM('<main><x-card></x-card></main><aside></aside>');
  const host=dom.window.document.querySelector('x-card');host.attachShadow({mode:'open'}).innerHTML='<p>Shadow</p>';
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:engine(),locale:'es'});
  await wrapper.ready;dom.window.document.querySelector('aside').append(host);
  await wrapper.setLocale('fr');assert.equal(host.shadowRoot.querySelector('p').textContent,'es:Shadow');
  assert.equal(wrapper.report().total,0);wrapper.disconnect();
});

test('real engine and DOM adapter reject broken placeholders without replacing source or breaking handlers',async()=>{
  const {createEngine}=await import('../src/core.js');const {catalogProvider}=await import('../src/providers.js');
  const dom=new JSDOM('<main><button>Save</button><p>You have {count} notes</p><input value="user text" placeholder="Search"></main>');
  let clicks=0;dom.window.document.querySelector('button').addEventListener('click',()=>clicks++);
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:createEngine({provider:catalogProvider({es:{Save:'Guardar',Search:'Buscar','You have {count} notes':'Tienes notas'}})}),locale:'es'});
  await wrapper.ready;dom.window.document.querySelector('button').click();
  assert.equal(clicks,1);assert.equal(dom.window.document.querySelector('p').textContent,'You have {count} notes');
  assert.equal(dom.window.document.querySelector('input').value,'user text');assert.equal(wrapper.report().rejected,1);
  wrapper.disconnect();
});

test('layout audit reports clipped content while ignoring deliberate scroll containers',async()=>{
  const {auditDOM}=await import('../src/dom.js');
  const dom=new JSDOM('<div id="clip" style="overflow-x:hidden">Long translated text</div><div id="scroll" style="overflow-x:auto">Long translated text</div>');
  for(const element of dom.window.document.querySelectorAll('div')) for(const [name,value] of Object.entries({clientWidth:100,clientHeight:30,scrollWidth:200,scrollHeight:30}))Object.defineProperty(element,name,{value});
  assert.deepEqual(auditDOM(dom.window.document),[{element:'div#clip',axis:'horizontal'}]);
});

test('an unchanged word is retranslated when the application changes its semantic context',async()=>{
  const {createEngine}=await import('../src/core.js');const {catalogProvider}=await import('../src/providers.js');
  const dom=new JSDOM('<main><h2>Billing</h2><button>Charge</button></main>');
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:createEngine({provider:catalogProvider({es:{Billing:'Facturación',Battery:'Batería','button:text; heading=Billing\u0004Charge':'Cobrar','button:text; heading=Battery\u0004Charge':'Carga'}})}),locale:'es'});
  await wrapper.ready;assert.equal(dom.window.document.querySelector('button').textContent,'Cobrar');
  dom.window.document.querySelector('h2').textContent='Battery';await wrapper.refresh();
  assert.equal(dom.window.document.querySelector('button').textContent,'Carga');wrapper.disconnect();
});

test('context stays inside the owned root instead of borrowing unrelated parent headings',async()=>{
  const dom=new JSDOM('<section data-everyword-context="Private outer context"><h2>Private outer heading</h2><div id="owned"><h2>Public screen</h2><button>Charge</button></div></section>');
  const wrapper=wrapDOM(dom.window.document.querySelector('#owned'),{engine:engine(),locale:'es'});
  await wrapper.ready;const context=wrapper.report().segments.find(s=>s.source==='Charge').context;
  assert.ok(context.includes('Public screen'));assert.ok(!context.includes('Private'));wrapper.disconnect();
});

test('excluded private heading content never leaks through translation context',async()=>{
  const {createEngine}=await import('../src/core.js');
  const dom=new JSDOM('<main><h2 data-everyword-ignore>Private manuscript title</h2><button>Settings</button><section><h2>Workspace <span translate="no">Private account name</span></h2><button>Search</button></section></main>');
  const requests=[];
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:createEngine({provider:{async translate(request){requests.push(request);return request.segments.map(s=>({id:s.id,text:s.source}));}}}),locale:'es'});
  await wrapper.ready;
  const sent=JSON.stringify(requests);assert.ok(!sent.includes('Private manuscript'));assert.ok(!sent.includes('Private account'));assert.ok(sent.includes('Settings'));assert.ok(sent.includes('Workspace'));
  wrapper.disconnect();
});

test('mathematical notation is preserved while surrounding interface text translates',async()=>{
  const dom=new JSDOM('<main><h2>Equation</h2><math><mi>x</mi><mo>=</mo><mn>42</mn></math></main>');
  const wrapper=wrapDOM(dom.window.document.querySelector('main'),{engine:engine(),locale:'es'});await wrapper.ready;
  assert.equal(dom.window.document.querySelector('math').textContent,'x=42');assert.equal(dom.window.document.querySelector('h2').textContent,'es:Equation');assert.equal(wrapper.report().total,1);wrapper.disconnect();
});
