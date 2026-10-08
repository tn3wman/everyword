import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {stat} from 'node:fs/promises';
import {diskCache} from './disk-cache.js';
import {browserCache} from './cache.js';
import {postgresCache} from './postgres-cache.js';
import {readProjectConfig,validateProjectConfig} from './project.js';
import {llamaExecutable,QUALITY_MODEL} from './model-runtime.js';

export async function openProjectStorage(config,{directory='.',migrate=false,readOnly=false,pool}={}){
  validateProjectConfig(config);
  const cache=config.cache;
  const info={owner:'application',type:cache.type,namespace:cache.namespace,location:cache.type==='sqlite'?cache.path:cache.type==='postgres'?`PostgreSQL via ${cache.connectionEnv}`:'Process memory'};
  let storage,ownedPool;
  try{
    if(cache.type==='sqlite')storage=diskCache({path:resolve(directory,cache.path),namespace:cache.namespace,migrate,readOnly});
    else if(cache.type==='postgres'){
      if(!pool){
        const connectionString=process.env[cache.connectionEnv];
        if(!connectionString)throw new Error(`Inject ${cache.connectionEnv} with Infisical before database setup.`);
        const {Pool}=await import('pg');
        ownedPool=new Pool({connectionString,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,query_timeout:5000});
        ownedPool.on('error',()=>{});
        pool=ownedPool;
      }
      storage=postgresCache({pool,namespace:cache.namespace});
      if(migrate)await storage.migrate();
    }else storage=browserCache({storage:null});
    await storage.stats();
    let closed=false;
    return {storage,info,async close(){if(!closed){closed=true;try{await storage.close?.();}finally{await ownedPool?.end();}}}};
  }catch(error){
    await storage?.close?.();await ownedPool?.end();
    if(cache.type==='postgres')throw new Error(process.env[cache.connectionEnv]||pool?'PostgreSQL cache unavailable. Check its connection and run everyword cache migrate.':`Inject ${cache.connectionEnv} with Infisical before database setup.`);
    throw error;
  }
}

/** A read-only setup check; does not download models, create tables, or modify app files. */
export async function doctorProject(directory='.'){
  const config=await readProjectConfig(directory);
  if(!config)return {ready:false,checks:[{name:'project',ok:false,message:'Run everyword init in the app project.'}]};
  const checks=[{name:'project',ok:true,message:'App-owned configuration found.'}];
  let opened;
  try{opened=await openProjectStorage(config,{directory,readOnly:true});checks.push({name:'database',ok:true,...opened.info,...await opened.storage.stats()});}
  catch(error){checks.push({name:'database',ok:false,message:error.message});}
  finally{await opened?.close();}
  try{llamaExecutable();checks.push({name:'runtime',ok:true,message:'llama-server is available.'});}
  catch{checks.push({name:'runtime',ok:false,message:'Install llama-server or connect an existing local runner with --local-url.'});}
  const path=resolve(process.env.EVERYWORD_CACHE_DIR??resolve(homedir(),'.cache/everyword'),'models/hy-mt2-7b-q8/model.gguf');
  const available=(await stat(path).catch(()=>null))?.size===QUALITY_MODEL.size;
  checks.push({name:'model',ok:available,message:available?QUALITY_MODEL.name:'Run npm run setup to download the local translation model.'});
  return {ready:checks.every(check=>check.ok),adapter:config.adapter,checks};
}
