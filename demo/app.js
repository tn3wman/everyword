import {createEngine, canonicalLocale, localeDirection, summarize} from '/src/core.js';
import {httpProvider} from '/src/providers.js';
import {cachedProvider, browserCache} from '/src/cache.js';
import {wrapDOM} from '/src/dom.js';
import {wrapAdapter, translateObject, translateElectronMenu} from '/src/adapters.js';

const $ = selector => document.querySelector(selector);
const fixture = $('#fixture');
const translationProvider=cachedProvider(httpProvider(),{storage:browserCache(),version:()=>state.service?.revision??'unavailable'});
const engine = createEngine({provider:translationProvider});
const state = {locale:'en',platform:'web',report:{locale:'en',total:0,segments:[]},wrapper:null,view:0,operation:0,sandbox:'',service:null};
let noticeTimer,sandboxTimer,messageController;
try{state.locale=canonicalLocale(localStorage.getItem('everyword:locale')??'en');}catch{}
if([...$('#language').options].some(option=>option.value===state.locale))$('#language').value=state.locale;
else{$('#language').value='custom';$('#custom-locale').hidden=false;$('#locale-code').value=state.locale;}
const iconPlus='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const iconSearch='<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="m12 12 5 5"/></svg>';
$('#web-integration-code').textContent=$('#web-integration-code').textContent.replaceAll('http://127.0.0.1:4317',location.origin);

function notify(text){$('#notice').textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').textContent='',5000);}
function run(action){Promise.resolve().then(action).catch(error=>notify(error.message||'The operation failed. Refresh and try again.'));}
function textElement(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;}
function isAttention(segment){return !['source','translated'].includes(segment.status);}

function acceptReport(report,view=state.view){
  if(view!==state.view)return;
  if(state.platform==='desktop'){
    state.domReport=report;
    if(!report.pending&&state.menuReport)report=summarize([...report.segments,...state.menuReport.segments],state.locale,report.issues);
  }
  $('#live-status').textContent=report.pending?'Translating…':state.locale==='en'?'Original':`Live translation · ${state.locale}`;
  if(report.pending)return;
  state.report=report;
  const attention=(report.segments??[]).filter(isAttention).length+(report.errors&&!report.segments?.length?report.errors:0);
  $('#count-total').textContent=report.total;
  $('#count-translated').textContent=report.translated??0;
  $('#count-attention').textContent=attention;
  $('#coverage-value').textContent=`${report.translated??0} / ${report.total}`;
  $('#coverage-fill').style.transform=`scaleX(${report.total?(report.translated??0)/report.total:0})`;
  $('#coverage-headline').textContent=state.locale==='en'?'Source language selected':attention?'Some text stayed in English':'Live translation complete';
  $('#coverage-description').textContent=state.locale==='en'?'Choose a language to translate the captured content.':attention?'Validation kept the source where a result was missing or changed a placeholder or numeric token.':'Captured content was translated by the local machine translation model.';
  $('#scope-note').textContent='Counts cover captured content in this view. Checks compare placeholders and numeric tokens; they do not measure linguistic accuracy or numeric meaning.';
  renderInventory();
}

function sampleHTML(desktop=false){return `${desktop?'<div class="window-header" data-everyword-ignore><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span>Sunday desktop renderer</span></div><div class="desktop-menu" data-everyword-ignore id="desktop-menu"></div>':''}
  <div class="sample-app"><div class="sample-nav"><span class="sample-brand" translate="no">sunday</span><a href="#" data-page="Home">Home</a><a href="#" data-page="Notes">Notes</a><a href="#" data-page="Archive">Archive</a><span class="avatar" translate="no">AL</span></div>
  <div class="sample-main"><p class="sample-greeting">Good morning, Alex.</p><h2>A little space for your big ideas.</h2><p class="sample-description">Capture a thought, start a project, or pick up where you left off.</p>
  <div class="sample-tools"><label class="sample-search">${iconSearch}<input id="sample-search" placeholder="Search your notes" aria-label="Search your notes"></label><button class="sample-new" id="sample-new">${iconPlus}<span>New note</span></button></div>
  <div class="sample-subhead"><span>Your workspace</span><span>{count} notes in your workspace</span></div>
  <div class="note-list" id="note-list"><article class="note-item" data-note="Product ideas"><h3>Product ideas</h3><p>Write something worth keeping.</p><div class="note-meta">Today</div><button class="note-open" title="Open note">Open note</button></article><article class="note-item" data-note="A better way to work"><h3>A better way to work</h3><p>Plan your next project</p><div class="note-meta">Today</div><button class="note-open" title="Open note">Open note</button></article></div>
  <form class="note-editor" id="note-editor" hidden><label for="note-title">Project name</label><input id="note-title" value="My project"><button>Save note</button></form><p id="sample-toast" class="sample-toast" role="status"></p><p id="custom-source" class="demo-gap"></p></div></div>`;}

function wireSample(){
  $('#custom-source').textContent=state.sandbox;
  $('#sample-new').addEventListener('click',()=>{addDynamic();notify('Added content. The DOM observer sent it for live translation.');});
  $('#sample-search').addEventListener('input',event=>{const query=event.target.value.toLowerCase();fixture.querySelectorAll('.note-item').forEach(note=>note.hidden=!`${note.textContent} ${note.dataset.note}`.toLowerCase().includes(query));});
  fixture.querySelectorAll('.sample-nav a').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();fixture.querySelectorAll('.note-item').forEach(note=>note.hidden=link.dataset.page==='Archive');$('#sample-toast').textContent=link.dataset.page==='Archive'?'Your archive is empty.':'';}));
  fixture.addEventListener('click',openNote);
  $('#note-editor').addEventListener('submit',event=>{event.preventDefault();$('#sample-toast').textContent='Note saved.';notify(`Saved “${$('#note-title').value}”. Form values are application data and stay untouched.`);});
}
function openNote(event){if(event.target.closest('.note-open')){$('#note-editor').hidden=false;$('#note-title').focus();}}

const nativeSource={greeting:'Good morning, Alex.',title:'Your workspace',description:'A little space for your big ideas.',note:'Product ideas',noteDescription:'Write something worth keeping.',button:'New note',accessibilityLabel:'New note'};
let nativeModel;
function renderNative(model){
  fixture.replaceChildren();const phone=document.createElement('div');phone.className='native-preview';const top=document.createElement('div');top.className='native-top';top.append(document.createElement('span'));const body=document.createElement('div');body.className='native-body';
  body.append(textElement('p',model.greeting,'sample-greeting'),textElement('h2',model.title),textElement('p',model.description));const note=document.createElement('article');note.className='note-item';note.append(textElement('h3',model.note),textElement('p',model.noteDescription));body.append(note);
  if(model.dynamic)body.append(textElement('p',model.dynamic,'demo-gap'));if(model.custom)body.append(textElement('p',model.custom,'demo-gap'));
  const button=textElement('button',model.button,'sample-new');button.setAttribute('aria-label',model.accessibilityLabel);button.addEventListener('click',()=>run(addDynamic));body.append(button);phone.append(top,body);fixture.append(phone);fixture.setAttribute('dir',localeDirection(state.locale));fixture.setAttribute('lang',state.locale);
}

const messagesSource={email:{subject:'Your weekly digest',body:'You made space for {count} new ideas this week.',action:{label:'View your notes'}},notification:{title:'Your note is ready',body:'Open your workspace to keep writing.'}};
function renderMessages(value){
  fixture.replaceChildren();const wrap=document.createElement('div');wrap.className='message-preview';const email=document.createElement('article');email.className='message-card';email.append(textElement('div','Email · Template preview','message-label'),textElement('h3',value.email.subject),textElement('p',value.email.body));const action=textElement('button',value.email.action.label,'sample-new');action.addEventListener('click',()=>notify('The action callback is preserved. This preview does not send email.'));email.append(action);
  const notification=document.createElement('article');notification.className='message-card notification';notification.append(textElement('div','Push notification · Template preview','message-label'),textElement('h3',value.notification.title),textElement('p',value.notification.body));wrap.append(email,notification);if(value.extra)wrap.append(textElement('p',value.extra.body,'demo-gap'));fixture.append(wrap);fixture.setAttribute('dir',localeDirection(state.locale));fixture.setAttribute('lang',state.locale);
}
async function refreshMessages(){
  const operation=++state.operation,view=state.view,locale=state.locale;messageController?.abort();const requestController=new AbortController();messageController=requestController;
  const requestEngine={translate:(segments,options)=>engine.translate(segments,{...options,signal:requestController.signal})};$('#live-status').textContent='Translating…';const input=state.sandbox?{...messagesSource,extra:{body:state.sandbox}}:messagesSource;
  const {value,report}=await translateObject(input,{engine:requestEngine,locale,context:'messages'});if(operation!==state.operation||view!==state.view)return;renderMessages(value);acceptReport(report,view);
}

async function refreshMenu(view=state.view){
  if(state.platform!=='desktop')return;const template=[{label:'File',click:()=>notify('File menu callback preserved.')},{label:'Preferences',click:()=>notify('Preferences callback preserved.')}];const menuLocale=state.locale,menuOperation=state.operation;const {value,report}=await translateElectronMenu(template,{engine,locale:menuLocale});
  if(view!==state.view||state.platform!=='desktop'||menuLocale!==state.locale||menuOperation!==state.operation)return;const menu=$('#desktop-menu');menu.replaceChildren();for(const item of value){const button=textElement('button',item.label,'text-button');button.addEventListener('click',item.click);menu.append(button);}state.menuReport=report;if(state.domReport&&!state.domReport.pending)acceptReport(state.domReport,view);
}

async function mountPlatform(platform){
  const view=++state.view;state.operation++;messageController?.abort();const previous=state.wrapper;state.wrapper=null;if(previous)await previous.disconnect();if(view!==state.view)return;fixture.removeEventListener('click',openNote);state.platform=platform;state.domReport=null;state.menuReport=null;fixture.removeAttribute('dir');fixture.removeAttribute('lang');document.querySelectorAll('[data-platform]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.platform===platform)));
  const captions={web:'Live DOM adapter: text, accessible labels, placeholders, and later mutations.',desktop:'Electron renderer plus translated menu structures. Previewed in the browser.',native:'Explicit host capture/apply bridge. This preview does not claim automatic UIKit or Android coverage.',messages:'Structured email and notification fields with protected variables.'};$('#adapter-caption').textContent=captions[platform];
  if(platform==='web'||platform==='desktop'){fixture.innerHTML=sampleHTML(platform==='desktop');wireSample();state.wrapper=wrapDOM(fixture,{engine,locale:state.locale,onReport:report=>acceptReport(report,view)});await state.wrapper.ready;await refreshMenu(view);}
  else if(platform==='native'){nativeModel={...nativeSource,...(state.sandbox?{custom:state.sandbox}:{})};renderNative(nativeModel);state.wrapper=wrapAdapter({capture:()=>Object.entries(nativeModel).map(([id,source])=>({id,source,context:'native.notes',kind:id==='accessibilityLabel'?'accessibility':'label'})),apply:results=>{const localized={...nativeModel};for(const result of results){if(nativeModel[result.id]===result.source)localized[result.id]=result.text;}renderNative(localized);},restore:()=>renderNative(nativeModel)},{engine,locale:state.locale,onReport:report=>acceptReport(report,view)});await state.wrapper.refresh();}
  else await refreshMessages();
}

async function refresh(){state.operation++;if(state.wrapper)await state.wrapper.refresh();else await refreshMessages();await refreshMenu();}
function languageReady(locale){return state.service?.engine?.loaded?.some(item=>item.source==='en'&&item.target===locale.split('-')[0])??false;}
async function changeLanguage(locale){locale=canonicalLocale(locale);state.locale=locale;try{localStorage.setItem('everyword:locale',locale);}catch{}state.operation++;state.menuReport=null;messageController?.abort();if(locale!=='en'&&languageReady(locale)===false)notify('Preparing this language model for first use. Its download can take a moment.');if(state.wrapper)await state.wrapper.setLocale(locale);else await refreshMessages();await refreshMenu();void updateServiceStatus();}

function addDOMContent(source){const note=document.createElement('article');note.className='note-item';note.dataset.note=source;note.append(textElement('h3',source),textElement('p','Explore a new direction'));const button=textElement('button','Open note','note-open');button.title='Open note';note.append(button);$('#note-list').append(note);}
async function addDynamic(){if(state.platform==='web'||state.platform==='desktop')addDOMContent('A fresh start');else if(state.platform==='native'){nativeModel.dynamic='A fresh start';await refresh();}else{state.sandbox='Your new note is ready.';$('#sandbox-input').value=state.sandbox;await refreshMessages();}}
async function applySandbox(){const text=$('#sandbox-input').value.trim();state.sandbox=text;if(state.platform==='web'||state.platform==='desktop'){const node=$('#custom-source');if(node)node.textContent=text;}else if(state.platform==='native'){if(text)nativeModel.custom=text;else delete nativeModel.custom;await refresh();}else await refreshMessages();}

function translationStatus(result){if(result.status==='source')return ['Original','source'];if(result.status==='translated')return ['Live translation','translated'];return [{'missing':'No result','rejected':'Validation check','error':'Service error','needs-review':'Validation check'}[result.status]??result.status,result.status];}
function renderInventory(){const target=$('#inventory');target.replaceChildren();for(const result of state.report.segments??[]){const row=document.createElement('div');row.className='content-row';const original=textElement('div',result.source.trim(),'row-source');original.append(textElement('span',result.kind??result.context??result.id,'row-context'));const translation=textElement('div',result.text.trim(),`row-translation${isAttention(result)||result.status==='source'?' fallback':''}`);translation.dir=localeDirection(state.locale);const meta=document.createElement('div');meta.className='row-meta';const [label,status]=translationStatus(result);meta.append(textElement('span',label,`status-label ${status}`));row.append(original,translation,meta);if(result.reason)row.append(textElement('p',result.reason,'row-reason'));target.append(row);}if(!state.report.segments?.length)target.append(textElement('div','No captured text in this view.','empty-state'));$('#inventory-footer').textContent=`${state.report.total??0} captured strings. Source text remains available for reset and safe fallback.`;}

function describeService(service){if(service.engine?.loading){const loading=service.engine.loading;if(loading.model)return `${loading.model} · ${loading.phase}${loading.percent!=null?` ${loading.percent}%`:''}`;return `Preparing ${loading.source} → ${loading.target}${loading.phase?` · ${loading.phase}`:''}`;}return service.engine?.ready?(service.engine.model??'Local model ready'):'Local translation service starting';}
async function updateServiceStatus(){try{const response=await fetch('/api/status');if(!response.ok)throw new Error();const service=await response.json();const changed=state.service?.revision&&state.service.revision!==service.revision;state.service=service;if(changed){engine.clearCache();run(refresh);}$('#connection').replaceChildren(textElement('span','','status-dot'),document.createTextNode(describeService(service)));$('#cache-location').textContent=`App-owned cache: ${service.cache?.location??'process memory'}. ${service.cache?.healthy===false?'Storage needs attention; new text can still translate.':`${service.cache?.entries??0} saved translations.`} This demo also keeps a browser copy.`;$('#mode-caption').textContent=service.engine?.loading?'The local translation engine is preparing for first use.':`${service.engine?.model??'Local machine translation'}. Saved translations are reused automatically on reload.`;}catch{$('#connection').textContent='Service unavailable';$('#mode-caption').textContent='Start the local translation service to use the playground.';}}

$('#language').addEventListener('change',event=>{const custom=event.target.value==='custom';$('#custom-locale').hidden=!custom;if(!custom)run(()=>changeLanguage(event.target.value));else $('#locale-code').focus();});
$('#custom-locale').addEventListener('submit',event=>{event.preventDefault();run(()=>changeLanguage($('#locale-code').value));});
$('#reset').addEventListener('click',()=>{$('#language').value='en';$('#custom-locale').hidden=true;run(()=>changeLanguage('en'));});
$('#refresh').addEventListener('click',()=>run(async()=>{await translationProvider.clear();engine.clearCache();await refresh();}));
$('#add-content').addEventListener('click',()=>run(addDynamic));
$('#sandbox-input').addEventListener('input',()=>{clearTimeout(sandboxTimer);sandboxTimer=setTimeout(()=>run(applySandbox),250);});
for(const button of document.querySelectorAll('[data-platform]'))button.addEventListener('click',()=>run(()=>mountPlatform(button.dataset.platform)));
for(const [id,other] of [['playground','integration'],['integration','playground']])$(`#${id}-tab`).addEventListener('click',()=>{$(`#${id}`).hidden=false;$(`#${other}`).hidden=true;$(`#${id}-tab`).classList.add('active');$(`#${other}-tab`).classList.remove('active');$(`#${id}-tab`).setAttribute('aria-pressed','true');$(`#${other}-tab`).setAttribute('aria-pressed','false');});

await updateServiceStatus();
setInterval(()=>{if(document.visibilityState==='visible')void updateServiceStatus();},2000);
await mountPlatform('web');
window.everywordDemo={get report(){return structuredClone(state.report);},get locale(){return state.locale;},get platform(){return state.platform;},get cache(){return translationProvider.cacheStats();}};
