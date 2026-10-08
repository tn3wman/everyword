import {readdir, readFile} from 'node:fs/promises';
import {resolve, relative, extname} from 'node:path';
const skip = new Set(['node_modules','.git','.next','dist','build','Pods','.gradle','.venv','vendor','.everyword','__pycache__','target']);
const supported = new Set(['.html','.jsx','.tsx','.vue','.svelte','.swift','.kt','.dart','.xaml','.py','.json','.js','.ts']);

export async function inspectProject(directory) {
  const root = resolve(directory); const files = []; const frameworks = new Set(); const gaps = new Set();
  let truncated = false;
  async function walk(path, depth = 0) {
    if (depth > 16 || files.length >= 10000) { truncated = true; return; }
    for (const entry of await readdir(path,{withFileTypes:true})) {
      if (skip.has(entry.name) || entry.name.startsWith('.env') || entry.isSymbolicLink()) continue;
      const full = resolve(path,entry.name);
      if (entry.isDirectory()) await walk(full,depth+1);
      else if (entry.isFile()) {
        if (files.length >= 10000) { truncated = true; break; }
        if (entry.name === 'package.json') {
          const pkg = await readFile(full,'utf8').then(JSON.parse).catch(() => null);
          for (const dependency of Object.keys({...pkg?.dependencies,...pkg?.devDependencies})) {
            if (['react','next','vue','svelte','electron','react-native','@angular/core'].includes(dependency)) frameworks.add(dependency);
          }
        }
        if (supported.has(extname(entry.name))) files.push(relative(root,full));
        if (extname(entry.name) === '.swift') frameworks.add('Swift / native');
        if (extname(entry.name) === '.kt') frameworks.add('Kotlin / native');
        if (extname(entry.name) === '.dart') frameworks.add('Dart / Flutter');
        if (/\.(png|jpg|jpeg|webp|pdf)$/.test(entry.name)) gaps.add('Text in image/PDF assets requires an asset adapter or translated asset.');
      }
    }
  }
  await walk(root);
  const native = [...frameworks].some(f => /native|Swift|Kotlin|Flutter/.test(f));
  return {root, frameworks:[...frameworks].sort(), sourceFiles:files.length, files, truncated,
    integrations:[
      ...(!native || [...frameworks].some(f => ['react','next','vue','svelte','electron','@angular/core'].includes(f)) ? ['Mount wrapDOM() on the web document or Electron renderer.'] : []),
      ...(native ? ['Implement capture/apply through wrapAdapter() for native UI. Framework-specific automatic native interception is not included.'] : []),
      'Use translateObject() for owned JSON messages, notifications, and email copy.'
    ], gaps:[...gaps,'Runtime capture covers visited and mounted content only.','A source-file inventory does not establish text coverage or translation accuracy.']};
}
