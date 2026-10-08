import {build} from 'esbuild';
await build({entryPoints:['src/index.js'],outfile:'dist/everyword.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,sourcemap:true});
await build({entryPoints:['src/index.js'],outfile:'dist/everyword.global.js',bundle:true,format:'iife',globalName:'Everyword',platform:'browser',target:'es2022',minify:true,sourcemap:true});
console.log('Built ESM and script-tag bundles in dist/.');
