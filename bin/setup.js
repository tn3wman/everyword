import {prepareQualityModel,llamaExecutable} from '../src/model-runtime.js';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.EVERYWORD_PYTHON ?? resolve(root,'.venv/bin/python');
function run(command,args){return new Promise((done,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error(`${command} exited with code ${code}.`)));});}
try {
  if(!process.argv.includes('--fast')){
    llamaExecutable();
    let last=-1;await prepareQualityModel(progress=>{if(progress.percent%10===0&&progress.percent!==last){last=progress.percent;console.error(`Local quality model download: ${progress.percent}%`);}});
    console.error('Hy-MT2-7B Q8 is ready. Run npm start.');
  }else{
  if(!existsSync(python))await run('python3',['-m','venv',resolve(root,'.venv')]);
  if(spawnSync('uv',['--version'],{stdio:'ignore'}).status===0)await run('uv',['pip','install','--python',python,'-r',resolve(root,'python/requirements.txt')]);
  else await run(python,['-m','pip','install','--disable-pip-version-check','-r',resolve(root,'python/requirements.txt')]);
  console.error('Downloading and warming the default language models. Translation will run locally.');
  await run(python,[resolve(root,'python/worker.py'),'--prepare','en','es','fr','ja','ar']);
  console.error('Argos is ready. Run npm start -- --engine fast.');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
