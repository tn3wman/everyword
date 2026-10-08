import {createHash} from 'node:crypto';
import {mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

function limit(value,name){if(!Number.isSafeInteger(value)||value<0)throw new RangeError(`${name} must be a non-negative safe integer.`);return value;}
const digest=key=>createHash('sha256').update(key).digest('hex');

/** SQLite storage in a file chosen and owned by the embedding application. */
export function diskCache({path,namespace='default',maxEntries=10000,maxBytes=32*1024*1024,migrate=true,readOnly=false}={}){
  if(typeof path!=='string'||!path)throw new TypeError('Choose an application-owned SQLite path.');
  if(typeof namespace!=='string'||!namespace||namespace.length>200)throw new TypeError('Choose a cache namespace of 1–200 characters.');
  maxEntries=limit(maxEntries,'maxEntries');maxBytes=limit(maxBytes,'maxBytes');
  if(!migrate&&!existsSync(path))throw new Error('Translation database is not initialized. Run everyword cache migrate.');
  if(migrate&&!readOnly)mkdirSync(dirname(path),{recursive:true});
  const database=new DatabaseSync(path,{readOnly});
  try{
    database.exec('PRAGMA busy_timeout = 5000;');
    if(!readOnly){
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      if(migrate)database.exec(`CREATE TABLE IF NOT EXISTS everyword_translations (
        namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,bytes INTEGER NOT NULL,accessed_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,key)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS everyword_translations_lru ON everyword_translations(namespace,accessed_at);`);
    }
    const read=database.prepare('SELECT value FROM everyword_translations WHERE namespace=? AND key=?');
    const totals=database.prepare('SELECT count(*) AS entries,coalesce(sum(bytes),0) AS bytes FROM everyword_translations WHERE namespace=?');
    const touch=readOnly?undefined:database.prepare(`UPDATE everyword_translations SET accessed_at=max(accessed_at+1,(SELECT coalesce(max(accessed_at),0)+1 FROM everyword_translations WHERE namespace=?)) WHERE namespace=? AND key=?`);
    const write=readOnly?undefined:database.prepare(`INSERT INTO everyword_translations(namespace,key,value,bytes,accessed_at) VALUES(?,?,?,?,(SELECT coalesce(max(accessed_at),0)+1 FROM everyword_translations WHERE namespace=?)) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,accessed_at=excluded.accessed_at`);
    const oldest=database.prepare('SELECT key,bytes FROM everyword_translations WHERE namespace=? ORDER BY accessed_at,key LIMIT 1');
    const remove=readOnly?undefined:database.prepare('DELETE FROM everyword_translations WHERE namespace=? AND key=?');
    const removeAll=readOnly?undefined:database.prepare('DELETE FROM everyword_translations WHERE namespace=?');
    const assertKey=key=>{if(typeof key!=='string')throw new TypeError('Cache keys must be strings.');};
    const writable=()=>{if(readOnly)throw new Error('Cache was opened read-only.');};
    let closed=false;
    return {
      get(key){assertKey(key);const hashed=digest(key),row=read.get(namespace,hashed);if(!row)return undefined;try{const value=JSON.parse(row.value);touch?.run(namespace,namespace,hashed);return value;}catch{remove?.run(namespace,hashed);return undefined;}},
      set(key,value){writable();assertKey(key);const serialized=JSON.stringify(value);if(serialized===undefined)throw new TypeError('Cache values must be JSON-serializable.');const bytes=Buffer.byteLength(serialized);if(bytes>maxBytes||maxEntries===0)return;
        database.exec('BEGIN IMMEDIATE');
        try{write.run(namespace,digest(key),serialized,bytes,namespace);let current=totals.get(namespace);while(current.entries>maxEntries||current.bytes>maxBytes){const row=oldest.get(namespace);if(!row)break;remove.run(namespace,row.key);current={entries:current.entries-1,bytes:current.bytes-row.bytes};}database.exec('COMMIT');}
        catch(error){database.exec('ROLLBACK');throw error;}
      },
      clear(){writable();removeAll.run(namespace);},flush(){},
      close(){if(!closed){closed=true;database.close();}},
      stats(){return {...totals.get(namespace),persistent:true,type:'sqlite',namespace};}
    };
  }catch(error){database.close();throw error;}
}
