import {createInterface} from 'node:readline';

const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function translate(text, targetLocale, batchSize) {
  if(text==='File')return 'File';
  if(text==='file')return 'Archivo';
  if(text==='A sentence never seen before')return 'Una frase nunca vista antes';
  const repairs = new Map([
    ['Hello', 'Hola'],
    [', you have', ', tienes'],
    ['notes.', 'notas.'],
  ]);
  if (repairs.has(text)) return repairs.get(text);
  if (text.includes('Hello') && text.includes('you have') && text.includes('notes.')) {
    // Preserve the first decimal marker but deliberately drop the second. The
    // provider must detect the lost protected value and use its repair path.
    const markers = text.match(/\d+/g) ?? [];
    return `Hola ${markers[0] ?? 'persona'}, tienes notas.`;
  }
  return `${targetLocale}:${text}:batch=${batchSize}`;
}

send({
  event: 'ready',
  languages: [
    {code: 'en', name: 'English', ready: true},
    {code: 'es', name: 'Spanish', ready: true},
    {code: 'fr', name: 'French', ready: true},
  ],
});

const lines = createInterface({input: process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'cancel') {
    clearTimeout(pending.get(request.id));
    pending.delete(request.id);
    return;
  }
  if (request.targetLocale === 'zz') {
    send({id: request.id, error: {code: 'unsupported-language', message: 'Language pair en → zz is unavailable.'}});
    return;
  }

  const respond = () => {
    pending.delete(request.id);
    send({
      id: request.id,
      texts: request.texts.map(text => translate(text, request.targetLocale, request.texts.length)),
    });
  };
  if (request.texts.includes('SLOW')) {
    pending.set(request.id, setTimeout(respond, 500));
    send({event:'progress',source:'en',target:request.targetLocale,phase:'loading'});
  }
  else respond();
});
