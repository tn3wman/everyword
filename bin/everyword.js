#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createTranslationServer,translationRevision} from '../src/server.js';
import {cachedProvider} from '../src/cache.js';
import {initializeProject,readProjectConfig} from '../src/project.js';
import {openProjectStorage,doctorProject} from '../src/storage.js';
import {modelProvider,httpProvider} from '../src/providers.js';
import {localProvider} from '../src/local-provider.js';
import {localQualityProvider} from '../src/local-quality.js';
import {createEngine} from '../src/core.js';
import {inspectProject} from '../src/inspect.js';
import {translateObject} from '../src/adapters.js';
import {warmTranslations} from '../src/warm.js';
import {translateCatalog} from '../src/catalog.js';
const cleanup=[];

function options(args) {
  const result = {_:[]};
  for (let i=0;i<args.length;i++) {
    const item=args[i];
    if (!item.startsWith('--')) result._.push(item);
    else if (['--json','--help'].includes(item)) result[item.slice(2)]=true;
    else {
      if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing value for ${item}.`);
      result[item.slice(2)]=args[++i];
    }
  }
  return result;
}

async function providerFrom(opts) {
  const model = opts.model ?? process.env.EVERYWORD_MODEL;
  if (model) return modelProvider({model,baseURL:opts['model-url'] ?? process.env.EVERYWORD_MODEL_URL,apiKey:process.env.EVERYWORD_API_KEY});
  const engine=opts.engine??'quality';
  if(engine==='fast')return localProvider();
  if(engine!=='quality')throw new Error('Choose --engine quality or --engine fast.');
  return localQualityProvider({baseURL:opts['local-url']});
}

try {
  const [command='serve',...args]=process.argv.slice(2);
  const opts=options(args);
  const project=opts.project??'.';
  const display=value=>console.log(JSON.stringify(value,null,2));
  if (opts.help || command==='help') {
    console.log(`Everyword\n\n  everyword init [project] [--storage sqlite|postgres|memory]\n                 [--database-env EVERYWORD_DATABASE_URL] [--adapter web|electron|native|messages]\n  everyword cache migrate [--project directory]\n  everyword cache status [--project directory]\n  everyword doctor [--project directory] [--json]\n  npm run setup                         Download the local quality model (requires llama-server)\n  everyword serve [--project directory] [--port 4317] [--host 127.0.0.1]
                  [--engine quality|fast] [--local-url http://127.0.0.1:PORT/v1]\n                  [--model name] [--model-url http://127.0.0.1:11434/v1]\n                  [--allow-origin https://your-app.example]\n  everyword inspect <project-directory> [--json]\n  everyword warm --input capture.json --locales es,fr,ja,ar\n  everyword translate --input content.json --locale es\n  everyword catalog --source locales/en.json --locales es,fr,ja --output 'locales/{locale}.json'\n                    [--glossary glossary.json] [--style style.json] [--context 'What the app is']\n\nDefault: Hy-MT2-7B Q8, running locally with llama-server. No account or approval required.\nThe model downloads once. Generated translations are cached automatically.\nFor the smaller offline engine: npm run setup -- --fast, then serve --engine fast.\nFor a credentialed compatible model provider, inject EVERYWORD_API_KEY with Infisical.`);
  } else if(command==='init'){
    const directory=opts._[0]??project;
    const result=await initializeProject(directory,{storage:opts.storage??'sqlite',databaseEnv:opts['database-env']??'EVERYWORD_DATABASE_URL',cachePath:opts['cache-path']??'.everyword/translations.sqlite',endpoint:opts.endpoint??'http://127.0.0.1:4317',locale:opts.locale??'es',sourceLocale:opts['source-locale']??'en',adapter:opts.adapter??'auto'});
    if(result.config.cache.type==='sqlite'){const opened=await openProjectStorage(result.config,{directory,migrate:true});await opened.close();}
    if(opts.json)display(result);
    else console.log(`Configuration: ${result.configPath}\nIntegration: ${result.integrationPath}\n${result.instructions}\nStorage: ${result.config.cache.type==='sqlite'?result.config.cache.path:result.config.cache.type}\n${result.config.cache.type==='postgres'?'Inject the configured connection variable with Infisical, then run everyword cache migrate.\n':''}${result.inspection?.gaps?.join('\n')??result.gaps?.join('\n')??''}`);
  } else if(command==='doctor'){
    const report=await doctorProject(project);if(opts.json)display(report);else for(const check of report.checks)console.log(`${check.ok?'OK':'FIX'} ${check.name}: ${check.message??check.location}`);if(!report.ready)process.exitCode=2;
  } else if(command==='cache'){
    if(!['migrate','status'].includes(opts._[0]))throw new Error('Use everyword cache migrate or cache status.');
    const config=await readProjectConfig(project);if(!config)throw new Error('Run everyword init in the app project first.');
    const opened=await openProjectStorage(config,{directory:project,migrate:opts._[0]==='migrate',readOnly:opts._[0]==='status'});
    try{display({...opened.info,...await opened.storage.stats(),ready:true});}finally{await opened.close();}
  } else if (command==='serve') {
    const config=await readProjectConfig(project);if(!config)throw new Error('Choose app-owned storage with everyword init, then serve.');
    const provider=await providerFrom(opts);
    cleanup.push(()=>provider.close?.());
    const port=Number(opts.port ?? 4317);
    if (!Number.isInteger(port)||port<0||port>65535) throw new Error('Port must be between 0 and 65535.');
    const host=opts.host ?? '127.0.0.1';
    const opened=await openProjectStorage(config,{directory:project});cleanup.push(()=>opened.close());
    const contentManifest=async()=>{
      try{
        const data=await readFile(resolve(project,'.everyword/content.json'));
        if(data.length>8_388_608)throw new TypeError('The content manifest exceeds 8 MiB.');
        return JSON.parse(data.toString('utf8'));
      }catch(error){if(error.code==='ENOENT')return null;throw error;}
    };
    const server=createTranslationServer({provider,sourceLocale:config.sourceLocale,cacheStorage:opened.storage,cacheInfo:opened.info,cacheVersion:config.cache.namespace,contentManifest,allowedOrigins:opts['allow-origin']?.split(',') ?? [], mode:provider.type==='local' ? 'live local model' : 'configured model'});
    server.once('close',()=>void opened.close());
    server.on('error', error => {console.error(`Everyword: ${error.message}`);provider.close?.();void opened.close();process.exitCode=1;});
    server.listen(port,host,()=>console.log(`Everyword is ready at http://${host==='0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}\nProvider: ${provider.name??(provider.type==='local'?'Argos fast local translation':'configured model')}\nApp-owned cache: ${opened.info.location}`));
    if(provider.type==='local')provider.warm().then(async()=>console.log(`Local translation model is ready.${provider.endpoint?`\nLocal inference: ${await provider.endpoint()}`:''}`)).catch(error=>console.error(error.message));
    for (const sig of ['SIGINT','SIGTERM']) process.once(sig,()=>{server.close(); server.closeIdleConnections();provider.close?.();});
  } else if (command==='inspect') {
    const report=await inspectProject(opts._[0] ?? '.');
    if (opts.json) console.log(JSON.stringify(report,null,2));
    else console.log(`${report.root}\n${report.sourceFiles} source files${report.truncated?' (inventory truncated)':''}\nFrameworks: ${report.frameworks.join(', ') || 'not detected'}\n\n${report.integrations.join('\n')}\n\n${report.gaps.join('\n')}`);
  } else if (command==='warm') {
    if(!opts.input)throw new Error('warm requires --input with a captured segment manifest.');
    const config=await readProjectConfig(project);if(!config)throw new Error('Run everyword init to choose app-owned storage first.');
    const manifest=JSON.parse(await readFile(opts.input,'utf8'));
    if(!manifest||manifest.sourceLocale!==config.sourceLocale||!Array.isArray(manifest.segments))throw new Error('The capture must contain segments in the project source language.');
    const locales=(opts.locales??opts.locale??config.locale).split(',').map(value=>value.trim());
    const endpoint=new URL(opts.endpoint??config.endpoint);
    if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Choose a credential-free HTTP service endpoint.');
    const base=endpoint.href.replace(/\/$/,'');
    const validation=createEngine({sourceLocale:config.sourceLocale,provider:{translate(){throw new Error('Validation must not translate.');}}});
    await validation.translate(manifest.segments,{locale:config.sourceLocale});
    const statusResponse=await fetch(`${base}/api/status`,{signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!statusResponse.ok)throw new Error('The app translation service is unavailable. Start it before preparing translations.');
    const status=await statusResponse.json();
    if(status.cache?.owner!=='application'||status.cache?.namespace!==config.cache.namespace||!status.cache?.persistent||!status.cache?.healthy)throw new Error('The service must use this project’s healthy, persistent app-owned cache.');
    const report=await warmTranslations({provider:httpProvider({endpoint:`${base}/api/translate`}),sourceLocale:config.sourceLocale,locales,segments:manifest.segments,
      onProgress:opts.json?undefined:({locale,completed,total,translated,errors,rejected,missing,needsReview})=>console.error(`${locale}: processed ${completed}/${total} strings (${translated} translated, ${errors+rejected+missing+needsReview} failed)`)});
    display(report);
    if(!report.ready)process.exitCode=2;
  } else if (command==='translate') {
    if (!opts.input || !opts.locale) throw new Error('translate requires --input and --locale.');
    const config=await readProjectConfig(project);if(!config)throw new Error('Run everyword init to choose app-owned storage first.');
    const value=JSON.parse(await readFile(opts.input,'utf8'));
    const opened=await openProjectStorage(config,{directory:project});
    cleanup.push(()=>opened.close());
    const upstream=await providerFrom(opts);
    cleanup.push(()=>upstream.close?.());
    const provider=cachedProvider(upstream,{storage:opened.storage,version:()=>translationRevision(upstream,config.cache.namespace)});
    let result;
    try {result=await translateObject(value,{engine:createEngine({sourceLocale:config.sourceLocale,provider}),locale:opts.locale});}
    finally {try{await upstream.close?.();}finally{await opened.close();}}
    console.log(JSON.stringify(result,null,2));
    if (result.report.missing || result.report.errors || result.report.rejected || result.report.needsReview) process.exitCode=2;
  } else if (command==='catalog') {
    if(!opts.source||!opts.locales||!opts.output)throw new Error('catalog requires --source, --locales and --output.');
    if(!opts.output.includes('{locale}'))throw new Error('--output must contain {locale}, for example locales/{locale}.json.');
    const glossaries=opts.glossary?JSON.parse(await readFile(opts.glossary,'utf8')):{};
    const styles=opts.style?JSON.parse(await readFile(opts.style,'utf8')):{};
    const provider=await providerFrom(opts);
    cleanup.push(()=>provider.close?.());
    let report;
    try{
      report=await translateCatalog({source:opts.source,locales:opts.locales.split(',').map(value=>value.trim()),output:locale=>opts.output.replaceAll('{locale}',locale),
        provider,sourceLocale:opts['source-locale']??'en',glossaries,styles,context:opts.context,
        onProgress:opts.json?undefined:({locale,completed,total,failed})=>console.error(`${locale}: ${completed}/${total} new strings (${failed} failed)`)});
    }finally{cleanup.pop();await provider.close?.();}
    if(opts.json)display(report);
    else for(const {locale,total,reused,translated,failures} of report.locales){
      console.log(`${locale}: ${total} strings, ${reused} kept, ${translated} translated, ${failures.length} failed`);
      for(const failure of failures)console.log(`  ${failure.status}: ${JSON.stringify(failure.source.slice(0,120))} (${failure.reason})`);
    }
    if(!report.ready)process.exitCode=2;
  } else throw new Error(`Unknown command: ${command}. Use everyword help.`);
} catch(error) { console.error(`Everyword: ${error.message}`);for(const close of cleanup.reverse())try{await close();}catch{}process.exitCode=1; }
