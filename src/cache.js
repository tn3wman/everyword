import {canonicalLocale, validateTranslation} from './core.js';

// Storage is optional. Cache failures must never prevent live translation.
export function browserCache({storage, key='everyword:translations:v1', maxEntries=500, maxBytes=1_000_000}={}) {
  if(!Number.isInteger(maxEntries)||maxEntries<1||!Number.isInteger(maxBytes)||maxBytes<100)throw new TypeError('Invalid cache bounds.');
  if(storage===undefined){try{storage=globalThis.localStorage;}catch{storage=null;}}
  let entries=new Map(),dirty=false;
  try{
    const raw=storage?.getItem(key);
    if(raw&&raw.length*2<=maxBytes){
      const rows=JSON.parse(raw);
      if(Array.isArray(rows))entries=new Map(rows.filter(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string').slice(-maxEntries));
    }
  }catch{}
  const bytes=()=>JSON.stringify([...entries]).length*2;
  return {
    get(cacheKey){const value=entries.get(cacheKey);if(value!==undefined){entries.delete(cacheKey);entries.set(cacheKey,value);}return value;},
    set(cacheKey,value){entries.delete(cacheKey);entries.set(cacheKey,value);dirty=true;while(entries.size>maxEntries)entries.delete(entries.keys().next().value);},
    flush(){
      if(!dirty)return;
      while(entries.size&&bytes()>maxBytes)entries.delete(entries.keys().next().value);
      try{storage?.setItem(key,JSON.stringify([...entries]));dirty=false;}catch{/* Keep the bounded memory cache when storage is unavailable. */}
    },
    clear(){entries.clear();dirty=true;this.flush();},
    stats(){return {entries:entries.size,bytes:bytes(),persistent:!!storage};},
    close(){this.flush();}
  };
}

/** Generated translations are saved automatically, without any approval workflow. */
export function cachedProvider(provider,{storage=browserCache({storage:null}),version='v1'}={}) {
  if(typeof provider?.translate!=='function'||typeof storage?.get!=='function'||typeof storage?.set!=='function')throw new TypeError('A provider and cache storage are required.');
  const counters={hits:0,misses:0,writes:0,storageErrors:0};
  async function revision(){return String(typeof version==='function'?await version():version);}
  return {
    type:provider.type,status:provider.status?.bind(provider),start:provider.start?.bind(provider),warm:provider.warm?.bind(provider),revision,
    cacheStats(){
      const failed=()=>({...counters,persistent:false,healthy:false});
      const merge=stats=>({...counters,...stats,healthy:counters.storageErrors===0});
      try{const stats=storage.stats?.();return stats?.then?stats.then(merge,failed):merge(stats);}catch{return failed();}
    },
    async translate(request){
      request.signal?.throwIfAborted();
      const namespace=await revision();request.signal?.throwIfAborted();
      const glossary=Object.entries(request.glossary??{}).sort(([a],[b])=>a.localeCompare(b));
      const policy={glossary:request.glossary??{},preserveNumbers:request.preserveNumbers??true};
      const prefix=[namespace,canonicalLocale(request.sourceLocale),canonicalLocale(request.targetLocale),glossary,policy.preserveNumbers,...(request.style?[request.style]:[])];
      const prepared=request.segments.map(segment=>({segment,key:JSON.stringify([...prefix,segment.source,segment.context??'',segment.kind??'text'])}));
      const results=new Map(),missing=[];
      for(const {segment,key} of prepared){
        let cached;try{cached=await storage.get(key);}catch{counters.storageErrors++;}
        request.signal?.throwIfAborted();
        if(cached&&typeof cached.text==='string'&&!validateTranslation(segment.source,cached.text,policy)){
          results.set(segment.id,{id:segment.id,text:cached.text,reviewed:cached.reviewed===true});counters.hits++;
        }else{missing.push(segment);counters.misses++;}
      }
      if(request.cacheOnly===true){
        for(const segment of missing)results.set(segment.id,{id:segment.id,status:'missing',reason:'This label has not been prepared in the selected language.'});
        request.signal?.throwIfAborted();
        return request.segments.map(segment=>results.get(segment.id));
      }
      if(missing.length){
        const outputs=await provider.translate({...request,segments:missing});request.signal?.throwIfAborted();
        if(!Array.isArray(outputs))throw new TypeError('The provider response must be an array.');
        const expected=new Map(missing.map(segment=>[segment.id,segment]));
        const seen=new Set();
        // Check the entire response before writing anything to avoid cache poisoning.
        for(const output of outputs){if(!output||!expected.has(output.id)||seen.has(output.id))throw new TypeError('The provider returned duplicate or unknown IDs.');seen.add(output.id);}
        const keys=new Map(prepared.map(({segment,key})=>[segment.id,key]));
        for(const output of outputs){
          results.set(output.id,output);
          if((output.status===undefined||output.status==='translated')&&!validateTranslation(expected.get(output.id).source,output.text,policy)){
            try{await storage.set(keys.get(output.id),{text:output.text,reviewed:output.reviewed===true});counters.writes++;}catch{counters.storageErrors++;}
          }
        }
      }
      request.signal?.throwIfAborted();
      try{await storage.flush?.();}catch{counters.storageErrors++;}
      return request.segments.flatMap(segment=>results.has(segment.id)?[results.get(segment.id)]:[]);
    },
    async clear(){await storage.clear?.();},
    async close(){try{await storage.close?.();}finally{await provider.close?.();}}
  };
}
