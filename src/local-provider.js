import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonicalLocale, protectedTokens, validateTranslation} from './core.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const defaultPython=resolve(root,'.venv/bin/python');
const safeCodes=new Set(['unsupported-language','model-registry-unavailable','model-download-failed','invalid-model']);

function escapeRegExp(text){return text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

/** Local neural inference. No approved strings, account, or translation database. */
export function localProvider({python=process.env.EVERYWORD_PYTHON ?? defaultPython,workerPath=resolve(root,'python/worker.py'),timeoutMs=180000,spawn:spawnImpl=spawn}={}) {
  const pending=new Map(), loading=new Map(), loaded=new Map();
  let child, sequence=0, stopped=false, ready=false, languages=[], startPromise, modelRevision;
  const state=()=>({ready,languages,loaded:[...loaded.values()],loading:[...loading.values()][0] ?? null});
  function failAll(error){for(const request of pending.values()){clearTimeout(request.timer);request.cleanup();request.reject(error);}pending.clear();}
  function start(){
    if(stopped)throw new Error('The local translator has stopped.');
    if(startPromise)return startPromise;
    if(spawnImpl===spawn&&!existsSync(python))throw Object.assign(new Error('Run npm run setup to install the local translation runtime.'),{code:'local-setup-required',userFacing:true});
    startPromise=new Promise((resolveReady,rejectReady)=>{
      child=spawnImpl(python,[workerPath],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1'}});
      const startupTimer=setTimeout(()=>{rejectReady(new Error('The local translation engine took too long to start.'));child.kill();},60000);
      startupTimer.unref();
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        let message;try{message=JSON.parse(line);}catch{return;}
        if(message.event==='ready'){ready=true;languages=message.languages;modelRevision=message.revision??'unknown';clearTimeout(startupTimer);resolveReady();return;}
        if(message.event==='progress'){
          const key=message.source+'>'+message.target;
          if(message.phase==='ready'){loading.delete(key);loaded.set(key,{source:message.source,target:message.target});}
          else if(message.phase==='failed')loading.delete(key);
          else loading.set(key,{source:message.source,target:message.target,phase:message.phase,percent:message.percent});
          return;
        }
        const request=pending.get(message.id);if(!request)return;
        pending.delete(message.id);clearTimeout(request.timer);request.cleanup();
        if(message.error){const error=new Error(message.error.message);error.code=message.error.code;error.userFacing=safeCodes.has(error.code);request.reject(error);}
        else request.resolve(message);
      });
      // Python errors never include input copy or credential values.
      let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-2000);});
      child.on('error',error=>{clearTimeout(startupTimer);ready=false;startPromise=undefined;rejectReady(error);failAll(error);});
      child.on('exit',()=>{clearTimeout(startupTimer);ready=false;loaded.clear();loading.clear();startPromise=undefined;const error=new Error(diagnostic.trim() || 'The local translation worker stopped.');rejectReady(error);failAll(error);});
      child.stdin.on('error',()=>{});
    });
    return startPromise;
  }
  async function infer(texts,{sourceLocale,targetLocale,signal}){
    signal?.throwIfAborted();await start();signal?.throwIfAborted();
    if(pending.size>=32)throw new Error('The local translation engine is busy. Retry shortly.');
    return new Promise((resolveResult,reject)=>{
      const id=++sequence;
      const cancel=()=>{pending.delete(id);clearTimeout(timer);cleanup();child?.stdin.write(JSON.stringify({operation:'cancel',id})+'\n');reject(signal?.reason ?? new DOMException('Translation canceled.','AbortError'));};
      const cleanup=()=>signal?.removeEventListener('abort',cancel);
      const timer=setTimeout(()=>{pending.delete(id);cleanup();child?.stdin.write(JSON.stringify({operation:'cancel',id})+'\n');reject(new Error('Local translation timed out. Retry after the language model finishes downloading.'));},timeoutMs);
      timer.unref();
      pending.set(id,{resolve:resolveResult,reject,timer,cleanup});signal?.addEventListener('abort',cancel,{once:true});
      child.stdin.write(JSON.stringify({id,sourceLocale,targetLocale,texts})+'\n');
    });
  }
  return {
    type:'local',status:state,start,
    async cacheKey(){await start();return `argos-ct2:protected-spans-v2:${modelRevision}`;},
    async translate({sourceLocale,targetLocale,segments,glossary={},signal}){
      sourceLocale=canonicalLocale(sourceLocale);targetLocale=canonicalLocale(targetLocale);
      if(!segments.length)return [];
      // Batch equal phrases once. Context is retained in the shared engine and model-provider API.
      const sources=[...new Set(segments.map(s=>s.source))];
      // Decimal markers survive these models more reliably than interpolation syntax.
      // Restore them before validation. A changed marker falls back to span translation.
      const masks=sources.map(source=>{
        const terms=Object.keys(glossary).map(term=>`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`);
        const tokens=[...new Set(protectedTokens(source))].sort((a,b)=>b.length-a.length).map(escapeRegExp);
        const literals=new Map();let next=876543210;
        const pattern=[...tokens,...terms].join('|');
        const text=pattern?source.replace(new RegExp(pattern,'gu'),literal=>{
          while(source.includes(String(next))||literals.has(String(next)))next++;
          const marker=String(next++);literals.set(marker,Object.hasOwn(glossary,literal)?glossary[literal]:literal);return marker;
        }):source;
        return {text,literals};
      });
      const response=await infer(masks.map(mask=>mask.text),{sourceLocale,targetLocale,signal});
      if(!Array.isArray(response.texts)||response.texts.length!==sources.length)throw new Error('Invalid local translation response.');
      const outputs=new Map(sources.map((source,i)=>{
        let output=response.texts[i];
        if(typeof output!=='string')throw new Error('Invalid local translation response.');
        if(masks[i].literals.size){
          output=output.replace(/[٠-٩۰-۹]/g,digit=>String(digit.charCodeAt(0)-(digit>='۰'?0x6f0:0x660)));
          output=output.replace(/\d+/g,number=>masks[i].literals.get(number)??number);
        }
        return [source,output];
      }));
      // Older models sometimes treat a title-cased menu noun as a proper name.
      // Retry only unchanged menu labels in lowercase, preserving brands elsewhere.
      const menuRetries=sources.filter(source=>outputs.get(source)===source&&/^\p{Lu}\p{Ll}+$/u.test(source)&&segments.some(segment=>segment.source===source&&segment.kind==='menu-label'));
      if(menuRetries.length){
        const retried=await infer(menuRetries.map(source=>source.toLocaleLowerCase(sourceLocale)),{sourceLocale,targetLocale,signal});
        if(!Array.isArray(retried.texts)||retried.texts.length!==menuRetries.length)throw new Error('Invalid local menu response.');
        menuRetries.forEach((source,index)=>{
          const text=retried.texts[index];
          if(typeof text==='string'&&text!==source.toLocaleLowerCase(sourceLocale)&&!validateTranslation(source,text,{glossary}))outputs.set(source,text);
        });
      }
      // Neural models can alter interpolation syntax. Repair automatically by translating
      // only the natural-language spans around data tokens, without requesting approval.
      const repairs=sources.filter(source=>validateTranslation(source,outputs.get(source),{glossary}));
      if(repairs.length){
        const spans=[];
        const layouts=repairs.map(source=>{
          const protectedText=[...protectedTokens(source),...(source.match(/\d+(?:[.,]\d+)*/g)??[])].filter(Boolean);
          const replacements=new Map(Object.entries(glossary));
          const terms=Object.keys(glossary).map(term=>`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`);
          const alternatives=[...new Set(protectedText)].sort((a,b)=>b.length-a.length).map(escapeRegExp).concat(terms);
          const pattern=alternatives.length?new RegExp('('+alternatives.join('|')+')','gu'):null;
          const parts=pattern?source.split(pattern):[source];
          return {source,parts:parts.map((part,index)=>{
            if(pattern&&index%2)return {literal:replacements.get(part)??part};
            if(!part.trim()||!/\p{L}/u.test(part))return {literal:part};
            const leading=part.match(/^\s*/)[0],trailing=part.match(/\s*$/)[0];
            const position=spans.length;spans.push(part.trim());return {position,leading,trailing};
          })};
        });
        if(spans.length){const repaired=await infer(spans,{sourceLocale,targetLocale,signal});
          if(!Array.isArray(repaired.texts)||repaired.texts.length!==spans.length)throw new Error('Invalid local repair response.');
          for(const layout of layouts)outputs.set(layout.source,layout.parts.map(part=>'literal' in part?part.literal:part.leading+repaired.texts[part.position].trim()+part.trailing).join(''));
        }
      }
      return segments.map(segment=>({id:segment.id,text:outputs.get(segment.source),reviewed:false}));
    },
    async warm(locales=['es','fr','ja','ar']){await start();await Promise.all(locales.map(targetLocale=>infer(['Hello.'],{sourceLocale:'en',targetLocale})));},
    close(){stopped=true;ready=false;loaded.clear();loading.clear();failAll(new DOMException('Translator closed.','AbortError'));child?.stdin.end();child?.kill();}
  };
}
