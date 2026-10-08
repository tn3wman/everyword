import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,stat,rename,unlink} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';

// Official Apache-2.0 weights, pinned by commit and SHA-256.
// https://huggingface.co/tencent/Hy-MT2-7B-GGUF
export const QUALITY_MODEL={name:'Hy-MT2-7B Q8_0',revision:'ab8472660ac61fac25f1af43fac2599d52a8a775',size:7981928896,
  hash:'58b3ad55dd6f6fa08c695cddc34fb5f8f708a844f78ae10508071914b0ed67c0'};
const cacheRoot=()=>process.env.EVERYWORD_CACHE_DIR??join(homedir(),'.cache/everyword');
const modelPath=()=>join(cacheRoot(),'models/hy-mt2-7b-q8/model.gguf');

export function llamaExecutable(){
  const binary=process.env.EVERYWORD_LLAMA_SERVER??'llama-server';
  // Some CUDA builds initialize a GPU even for --version. A busy GPU must not
  // make an installed executable look missing. Inference keeps its normal env.
  const probe=spawnSync(binary,['--version'],{stdio:'ignore',timeout:10000,env:{...process.env,CUDA_VISIBLE_DEVICES:''}});
  if(probe.status!==0)throw Object.assign(new Error('Install llama-server from https://github.com/ggml-org/llama.cpp, then run npm run setup. Or use --engine fast for the smaller offline engine.'),{userFacing:true});
  return binary;
}

export async function prepareQualityModel(onProgress=()=>{},signal){
  const path=modelPath();
  // Successfully verified downloads have this exact name; interrupted downloads do not.
  if((await stat(path).catch(()=>null))?.size===QUALITY_MODEL.size)return path;
  await mkdir(join(cacheRoot(),'models/hy-mt2-7b-q8'),{recursive:true});
  const partial=path+'.partial';
  const url=`https://huggingface.co/tencent/Hy-MT2-7B-GGUF/resolve/${QUALITY_MODEL.revision}/HY-MT2-7B-Q8_0.gguf?download=true`;
  onProgress({model:QUALITY_MODEL.name,phase:'downloading',percent:0});
  const response=await fetch(url,{signal});
  if(!response.ok||!response.body)throw Object.assign(new Error('Could not download the local translation model. Check the connection and retry.'),{userFacing:true});
  const hash=createHash('sha256');let received=0,last=-1;
  const monitor=new Transform({transform(chunk,encoding,done){
    received+=chunk.length;hash.update(chunk);
    if(received>QUALITY_MODEL.size){done(new Error('Invalid model download size.'));return;}
    const percent=Math.floor(received/QUALITY_MODEL.size*100);
    if(percent!==last){last=percent;onProgress({model:QUALITY_MODEL.name,phase:'downloading',percent});}
    done(null,chunk);
  }});
  try{
    await pipeline(response.body,monitor,createWriteStream(partial),{signal});
    if(received!==QUALITY_MODEL.size||hash.digest('hex')!==QUALITY_MODEL.hash)throw new Error('The model download failed its integrity check. Retry setup.');
    await rename(partial,path);return path;
  }catch(error){await unlink(partial).catch(()=>{});throw error;}
}

export async function verifyQualityDownload(path){
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  if(hash.digest('hex')!==QUALITY_MODEL.hash)throw new Error('Invalid translation model checksum.');
}

async function freePort(){
  const socket=createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}

/** Own one resident loopback process; connecting to another runner never gives ownership. */
export function modelRuntime({baseURL}={}){
  let child,startPromise,url=baseURL,ready=false,loading=null,stopped=false;
  const controller=new AbortController();
  async function start(){
    if(stopped)throw new Error('Local model runtime is closed.');
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      if(!url){
        const binary=llamaExecutable();
        const path=await prepareQualityModel(progress=>{loading=progress;},controller.signal);
        controller.signal.throwIfAborted();
        loading={model:QUALITY_MODEL.name,phase:'loading'};
        const port=await freePort();url=`http://127.0.0.1:${port}/v1`;
        child=spawn(binary,['--model',path,'--host','127.0.0.1','--port',String(port),'--ctx-size','32768','--parallel','4','--gpu-layers','99','--threads','8','--no-context-shift','--log-disable'],{stdio:'ignore'});
        const owned=child;
        owned.on('error',()=>{if(child===owned)ready=false;});
        owned.on('exit',()=>{if(child===owned){ready=false;startPromise=undefined;url=undefined;}});
      }
      const endpoint=new URL(url);
      if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw new TypeError('Use a loopback local model URL.');
      for(let attempt=0;attempt<240;attempt++){
        controller.signal.throwIfAborted();
        if(child&&(child.exitCode!==null||child.signalCode!==null))throw new Error('The local model could not start. Check llama-server compatibility with Hy-MT2.');
        try{
          const response=await fetch(new URL('/health',endpoint),{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1000)])});
          if(response.ok){ready=true;loading=null;return url;}
        }catch{}
        await delay(250,undefined,{signal:controller.signal});
      }
      throw new Error('The local model did not become ready. Retry the service.');
    })().catch(error=>{loading=null;child?.kill();startPromise=undefined;if(!baseURL)url=undefined;throw error;});
    return startPromise;
  }
  return {start,endpoint:async()=>{await start();return url;},
    status:()=>({ready,loading,model:QUALITY_MODEL.name}),
    close(){stopped=true;ready=false;loading=null;controller.abort();child?.kill();}
  };
}
