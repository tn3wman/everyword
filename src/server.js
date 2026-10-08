import {createServer} from 'node:http';
import {readFile, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
import {createEngine, canonicalLocale, summarize} from './core.js';
import {localQualityProvider} from './local-quality.js';
import {cachedProvider} from './cache.js';
import {createHash,randomUUID} from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.woff2':'font/woff2', '.svg':'image/svg+xml'};

export async function translationRevision(provider,cacheVersion=''){
  return createHash('sha256').update(JSON.stringify(['everyword-cache-v1',cacheVersion||process.env.EVERYWORD_CACHE_REVISION||'',await provider.cacheKey?.()??provider.type??'custom'])).digest('hex');
}

function send(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}

async function readJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('Send application/json.'), {status:415});
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw Object.assign(new Error('Request exceeds 1 MiB.'), {status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), {status:400}); }
}

export function createTranslationServer({provider, sourceLocale='en', allowedOrigins = [], mode, root = packageRoot, cacheStorage, cacheVersion, cacheInfo, closeCache=false, contentManifest} = {}) {
  const ownsProvider=!provider;
  provider ??= localQualityProvider();
  mode ??= provider.type==='local' ? 'live local model' : 'configured model';
  const upstream=provider;
  sourceLocale=canonicalLocale(sourceLocale);
  const identified=typeof upstream.cacheKey==='function'||cacheVersion;
  const anonymousRevision=identified?undefined:randomUUID();
  const revision=()=>translationRevision(upstream,cacheVersion??anonymousRevision);
  // Embedders own storage and its lifetime. Without an adapter, use memory only.
  const storage=cacheStorage||undefined;
  cacheInfo??={owner:'application',type:storage?'custom':cacheStorage===false?'none':'memory',location:storage?'Application storage adapter':'Process memory'};
  if(cacheStorage!==false)provider=cachedProvider(upstream,{...(storage?{storage}:{}),version:revision});
  const origins = new Set(allowedOrigins.map(origin => new URL(origin).origin));
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const ownOrigin = `http://${req.headers.host}`;
    const origin = req.headers.origin;
    if (origin && origin !== ownOrigin && !origins.has(origin)) return send(res,403,{error:'This origin is not allowed. Configure --allow-origin for your application.'});
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type'});
      return res.end();
    }
    try {
      const pathname = new URL(req.url, ownOrigin).pathname;
      if (pathname === '/api/status' && req.method === 'GET') return send(res,200,{mode,sourceLocale,revision:await revision(),cache:{...cacheInfo,...await provider.cacheStats?.()},languages:provider.status?.().languages ?? [],engine:provider.status?.() ?? {ready:true,loaded:[],loading:null}});
      if (pathname === '/api/languages' && req.method === 'GET') {
        // Model support says nothing about prepared app content. Check the current
        // capture against the current cache revision, without generating any text.
        const locales=[sourceLocale];
        const manifest=typeof contentManifest==='function'?await contentManifest():contentManifest;
        if (!manifest || cacheStorage===false) return send(res,200,{sourceLocale,locales});
        if (manifest.sourceLocale!==sourceLocale || !Array.isArray(manifest.segments)) throw new TypeError('The content manifest must use the project source language.');
        const controller=new AbortController();
        res.on('close',()=>{if(!res.writableEnded)controller.abort();});
        const engine=createEngine({sourceLocale,cacheSize:0,provider:{translate(request){return provider.translate({...request,cacheOnly:true});}}});
        await engine.translate(manifest.segments,{locale:sourceLocale,signal:controller.signal});
        if (!manifest.segments.length) return send(res,200,{sourceLocale,locales});
        const requested=new URL(req.url,ownOrigin).searchParams.get('locales');
        const candidates=requested===null?(provider.status?.().languages??[]).map(language=>language.code):requested.split(',');
        if(candidates.length>40)throw new TypeError('Choose at most 40 candidate languages.');
        for(const locale of new Set(candidates.map(canonicalLocale))){
          if(locale===sourceLocale)continue;
          let ready=true;
          for(let offset=0;offset<manifest.segments.length;offset+=256){
            const results=await engine.translate(manifest.segments.slice(offset,offset+256),{locale,signal:controller.signal});
            if(results.some(result=>!['translated','source'].includes(result.status))){ready=false;break;}
          }
          if(ready)locales.push(locale);
        }
        return send(res,200,{sourceLocale,locales});
      }
      if (pathname === '/api/translate' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res,400,{error:'Expected a JSON object.'});
        if (body.cacheOnly !== undefined && typeof body.cacheOnly !== 'boolean') return send(res,400,{error:'cacheOnly must be a boolean.'});
        if (!Array.isArray(body.segments) || body.segments.length > 256) return send(res,400,{error:'Send at most 256 segments per request.'});
        const locale = canonicalLocale(body.targetLocale);
        const glossary = body.glossary ?? {};
        if (Object.keys(glossary).length > 100 || Object.entries(glossary).some(([k,v]) => k.length > 200 || typeof v !== 'string' || v.length > 200)) return send(res,400,{error:'Glossary is too large or invalid.'});
        const requestProvider=body.cacheOnly===true&&cacheStorage===false
          ? {translate({segments,signal}){signal?.throwIfAborted();return segments.map(({id})=>({id,status:'missing',reason:'This label has not been prepared in the selected language.'}));}}
          : {translate(request){return provider.translate({...request,...(body.cacheOnly===true?{cacheOnly:true}:{})});}};
        const engine = createEngine({sourceLocale: body.sourceLocale ?? sourceLocale, provider:requestProvider, glossary});
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        const results = await engine.translate(body.segments,{locale, signal:controller.signal});
        return send(res,200,{
          translations:results.filter(r => ['translated','source'].includes(r.status)).map(({id,text,reviewed}) => ({id,text,reviewed})),
          report:summarize(results,locale)
        });
      }
      if (pathname.startsWith('/api/')) return send(res,404,{error:'Unknown endpoint.'});
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res,405,{error:'Use GET or HEAD for static files.'});
      let filePath;
      if (pathname === '/' || pathname === '/index.html') filePath = resolve(root,'demo/index.html');
      else if (/^\/(demo|src|dist)\//.test(pathname)) filePath = resolve(root, `.${decodeURIComponent(pathname)}`);
      else return send(res,404,{error:'File not found.'});
      const actual = await realpath(filePath).catch(() => null);
      const actualRoot = await realpath(root);
      if (!actual || !actual.startsWith(actualRoot + sep) || !types[extname(actual)]) return send(res,404,{error:'File not found.'});
      const data = await readFile(actual);
      res.writeHead(200,{'Content-Type':types[extname(actual)], 'Cache-Control':'no-cache',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error.status ?? (error instanceof TypeError || error instanceof RangeError || error instanceof URIError ? 400 : 500);
      send(res,status,{error:status < 500 ? error.message : 'Translation failed. Check the provider configuration and retry.'});
    }
  });
  server.on('close',()=>{if(closeCache)Promise.resolve(storage?.close?.()).catch(()=>{});if(ownsProvider)upstream.close?.();});
  server.requestTimeout = 190000;
  server.headersTimeout = 10000;
  return server;
}
