# Everyword

Local translation for the interface your app already has. Wrap a web page, Electron renderer, native text bridge, or message object, translate its public text, and reuse the results from a database your app owns.

Everyword is an experimental JavaScript library and local service. It generates translations automatically; no approval catalog or cloud account is required. It does not promise flawless translation or automatic coverage of every platform.

## What it does

- Captures DOM text, titles, accessible labels, placeholders, and later UI changes.
- Translates Electron menu templates, structured messages, and text exposed by a native host adapter.
- Stores generated translations in app-owned SQLite, PostgreSQL, or custom storage.
- Supports preparation before use and cache-only display requests. Language pickers can offer only fully prepared languages.
- Keeps source text for reset and fallback, supports right-to-left languages, and checks placeholders, URLs, and numeric tokens.

## Try the playground

Requires **Node.js 22.13 or later** and a working [`llama-server`](https://github.com/ggml-org/llama.cpp) executable on your path. The default model download is about 8 GB; running it also requires memory for the model and context. CPU performance varies considerably. You can set `EVERYWORD_LLAMA_SERVER` to the executable's path.

```sh
git clone https://github.com/tn3wman/everyword.git
cd everyword
npm ci
node bin/everyword.js init . --storage sqlite --adapter web
npm run setup
npm start
```

Open **http://127.0.0.1:4317/**. The playground translates new sample text live and caches successful results. Its website, desktop, native bridge, and message previews demonstrate the adapters in a browser; they are not native app installers.

The default provider runs Tencent's [Hy-MT2-7B Q8 GGUF model](https://huggingface.co/tencent/Hy-MT2-7B-GGUF) locally. Downloads are pinned to a revision and verified by checksum. Model files live in your system user's `~/.cache/everyword` directory, configurable with `EVERYWORD_CACHE_DIR`. Translation data lives separately in the app's database.

For the smaller CTranslate2/Argos engine, install Python 3 with virtual environment support, then run `npm run setup -- --fast` and `npm start -- --engine fast`. This is an alternative provider, with different quality and language coverage.

## Add it to an app

Build the package from this checkout. This repository has not been published to npm.

```sh
# In the Everyword checkout
npm pack --pack-destination /tmp

# In your app project
npm install /tmp/everyword-0.1.0.tgz
npx everyword init . --storage sqlite --adapter web
npx everyword serve --project .
```

`init` creates `everyword.config.json`, an integration module under `everyword/`, and the SQLite tables. It preserves existing files. Adapter choices are `web`, `electron`, `native`, and `messages`; omitted adapters are detected from the project.

For a web app, proxy `/everyword` on your app's origin to the local service, stripping the `/everyword` prefix before forwarding. Preserve the original Host header, for example `changeOrigin: false` in a Vite proxy; otherwise allow your app's origin explicitly on the service. Configure this on the server or development proxy. Then mount the wrapper after your source-language content exists:

```js
import {createEngine, httpProvider, wrapDOM} from 'everyword';

const engine = createEngine({
  sourceLocale: 'en',
  provider: httpProvider({endpoint: '/everyword/api/translate'}),
});
const wrapper = wrapDOM(document, {engine, locale: 'es'});
await wrapper.ready;
// await wrapper.setLocale('fr');
// await wrapper.disconnect();
```

This live integration generates translations on a cache miss. A direct cross-origin integration must explicitly allow your app's origin with `everyword serve --allow-origin https://app.example`. Keep the service behind your application's access controls when sharing it beyond loopback.

## Prepare once, display from cache

Use this mode when visitors should never wait for model inference.

1. Capture each source-language screen and relevant state with `captureDOM(root, {sourceLocale: 'en'})`. Combine its `segments` into a manifest with unique IDs. Capture context and kind unchanged, so runtime lookups use the same keys. Exclude private content before capture.
2. Save `{ "sourceLocale": "en", "segments": [...] }` as `.everyword/content.json` in the app project. Recapture when public UI content or contexts change. An already translated screen is not a source-language capture.
3. With that app's service running, prepare translations:

   ```sh
   npx everyword warm --input .everyword/content.json --locales es,fr
   ```

4. Use a cache-only provider and fetch language availability for your picker:

   ```js
   import {availableLocales, createEngine, httpProvider, wrapDOM} from 'everyword';

   const locales = await availableLocales({
     endpoint: '/everyword/api/languages',
     sourceLocale: 'en',
     locales: ['en', 'es', 'fr', 'ja', 'ar'],
   });
   // Populate your language picker from `locales` only.
   const requestedLocale = 'fr';
   const locale = locales.includes(requestedLocale) ? requestedLocale : 'en';
   const engine = createEngine({
     sourceLocale: 'en',
     provider: httpProvider({endpoint: '/everyword/api/translate', cacheOnly: true}),
   });
   const wrapper = wrapDOM(document, {engine, locale});
   await wrapper.ready;
   ```

`GET /api/languages` checks the entire current manifest against the current cache revision. It never generates translations. Missing captures, incomplete caches, or failed client checks leave only the source language available. Availability describes captured content, not unvisited screens. Fetch it again after preparation or on a later page load.

The [prepared web example](examples/prepared-web.js) combines these steps and prevents switching to an unprepared language. A cache-only miss preserves source text. `warm` exits with code 2 if some strings could not be prepared, rather than claiming completion.

## Translate message catalogs

Apps that extract their copy into a source-keyed JSON catalog, as Lingui and gettext do (`{"Save": "Save"}`), can generate every other language from it:

```sh
npx everyword catalog --source locales/en.json --locales es,de,fr,zh-CN,hi \
  --output 'locales/{locale}.json' --glossary glossary.json --style style.json
```

Each run translates only messages a language's file lacks, keeps the rest, drops keys that left the source, and writes after every batch, so an interrupted run resumes where it stopped. A translation is kept only when its placeholders, numbered rich-text markers (`<0>…</0>`, `<1/>`), digit sequences and glossary terms match the source; the run lists anything it left out (in its report, or as JSON on stdout with `--json`; progress always goes to stderr) and exits with code 2, and the next run retries it. A passage that keeps failing is retried one sentence at a time, and a glossary term the model left in the source language is replaced with its required translation. To retranslate a message, delete its entry.

- `style.json` may give a language an object instead of a note: `{"de": {"note": "Address the reader informally with du.", "avoid": ["Sie", "Ihre"]}}`. A translation that uses an avoided word the source lacks is retried with the words named, then left out, and a kept catalog entry that uses one is translated again.
- `contexts.json` (`--contexts`) maps a message to its own context, which wins over `--context`: `{"Right": "the right-hand page margin", "Undo": "editor button that reverts the last edit"}`. A one- or two-word label is ambiguous without one ("Right" → "Okay"). A label that comes back with added clause punctuation, more than four words or more than eight CJK characters has absorbed its hint and is retried, then left out. Adding or changing a context does not retranslate an existing entry; delete it first.
- `glossary.json` maps terms per language, with `"*"` for every language: `{"*": {"Acme": "Acme"}, "de": {"Ridgeline": "Ridgeline"}}`. Source terms match whole words case-sensitively, so a product named "Contours" leaves the word "contours" free.
- `style.json` gives each language a short note, such as `{"de": "Address the reader informally with du, never Sie."}`. Hy-MT2 follows register notes reliably.
- `--context` adds background to every message. Hy-MT2 can copy context into short translations; Everyword rejects output that repeats it, but catalogs translate best without it.

The local runtime runs 16 concurrent sequences on machines with at least 48 GB of memory, 8 with 24 GB and 4 otherwise; set `EVERYWORD_PARALLEL` to override. On an M1 Max, 16 sequences produced about twice the throughput of 4.

## Your database, your data

SQLite defaults to `.everyword/translations.sqlite` in the app project. You can choose another path with `--cache-path`. PostgreSQL uses additive `everyword_translations` tables, with namespaces separating applications:

```sh
npx everyword init . --storage postgres --database-env EVERYWORD_DATABASE_URL
# Inject the connection variable through your secret manager, for example Infisical:
infisical run -- npx everyword cache migrate --project .
infisical run -- npx everyword serve --project .
```

For custom storage, pass an adapter with `get(key)` and `set(key, value)` to `cachedProvider`. Optional `stats`, `flush`, `clear`, and `close` methods handle storage lifecycle. Apps embedding `createTranslationServer` own the storage and its lifetime. `cache status` reports storage state; `doctor` checks the project, database, and default local model setup.

Cache keys include source and target languages, text, context, kind, glossary, and provider revision. Changing these causes new lookups. Cached translations are plain text, not encrypted secrets. Do not commit translation databases or captures containing private content.

The local providers do not send text to a cloud translation API. Initial setup downloads dependencies and model files. Optional `modelProvider` sends text to the endpoint you configure; keep its credentials on the server. The DOM wrapper ignores typed form values and elements marked `data-everyword-ignore` or `translate="no"`. Mark private content explicitly; public-looking DOM text can otherwise be captured.

## Other interfaces and limits

| Interface | Integration |
| --- | --- |
| Web and Electron renderer | `wrapDOM`, including DOM mutations and accessible text |
| Electron menus | `translateElectronMenu`; see [example](examples/electron.js) |
| Native/mobile views | `wrapAdapter` with an explicit host capture/apply/restore contract; see [example](examples/native-bridge.js) |
| Email, notifications, owned message data | `translateObject` or `translateMessages` |

Native view discovery is the host application's responsibility. Image pixels, canvas text, closed shadow roots, unvisited states, and operating-system-owned menus are not automatically covered. Rich HTML and ICU plural/select messages need appropriate parsing or message-format integrations. Layout checks are diagnostics, not a guarantee that every translated screen fits.

Validation checks structure and formatting, not linguistic accuracy. Numeric comparison compares digit sequences in any script, ignoring grouping and decimal separators (1,670 and 1.670 match), and from an English source (the engine and providers pass `sourceLocale`; a direct `validateTranslation` call without it gets no allowance) allows digits for words it spells out: a named month (April 12 → 4月12日), a number up to nineteen or a multiple of ten and their ordinals (fifteenth century → 15世纪), but not the parts of a compound such as twenty-one. A zero price ($0) may become a word such as "free". Validation does not establish that values keep their meaning or position. Such results retain the source text and are not cached. Generated translations are marked unreviewed. Fluent output can still be wrong; test your actual languages and interfaces.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests use synthetic fixtures and local test servers; the default suite does not download or benchmark a translation model. The PostgreSQL integration test runs when `EVERYWORD_TEST_DATABASE_URL` points to an isolated test database. GitHub Actions supplies an ephemeral PostgreSQL service and runs tests and bundle builds on Node 22 and 24.

Bug reports should include the adapter, source/target language, a minimal synthetic example, and the translation report. Keep credentials and private application content out of issues and test fixtures.

## License

Everyword's source is [MIT licensed](LICENSE). The bundled Figtree demo fonts retain their [SIL Open Font License](demo/fonts/LICENSE). Third-party model weights are downloaded separately and keep their own licenses: [Hy-MT2 GGUF](https://huggingface.co/tencent/Hy-MT2-7B-GGUF) is listed as Apache-2.0; consult the [Argos model registry](https://github.com/argosopentech/argospm-index) for the alternative engine's selected packages. Model weights are not included in this repository or npm tarball.
