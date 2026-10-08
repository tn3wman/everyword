"""Local neural translation. Language weights are downloaded, never translation catalogs.

Model format and registry: https://github.com/argosopentech/argos-translate
Inference API: https://opennmt.net/CTranslate2/python/ctranslate2.Translator.html
The JSON-lines channel carries only protocol messages; diagnostics go to stderr.
"""
import concurrent.futures
import json
import hashlib
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from collections import OrderedDict

INDEX_URL = "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
CACHE = pathlib.Path(os.environ.get("EVERYWORD_CACHE_DIR", pathlib.Path.home() / ".cache" / "everyword"))
CACHE.mkdir(parents=True, exist_ok=True)
PRINT_LOCK = threading.Lock()
MODELS_LOCK = threading.Lock()
PAIR_LOCKS = {}
MODELS = OrderedDict()
FUTURES = {}
CANCELED = set()
MAX_LOADED = 6


def emit(value):
    with PRINT_LOCK:
        print(json.dumps(value, ensure_ascii=False), flush=True)


class TranslationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def remote(url, timeout=45):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Everyword/0.1"}), timeout=timeout)


def get_index():
    path = CACHE / "index.json"
    if path.exists():
        try:
            rows = json.loads(path.read_text())
            if isinstance(rows, list) and rows:
                return rows
        except (ValueError, OSError):
            pass
    try:
        with remote(INDEX_URL) as response:
            rows = json.load(response)
        if not isinstance(rows, list) or not rows:
            raise ValueError("Invalid model registry")
        temporary = path.with_suffix(".partial")
        temporary.write_text(json.dumps(rows))
        temporary.replace(path)
        return rows
    except Exception as error:
        raise TranslationError("model-registry-unavailable", "Could not load the language model registry. Check the host's connection and retry.") from error


def model_code(locale):
    locale = locale.lower()
    if locale.startswith("pt-br"):
        return "pb"
    if locale.startswith(("zh-tw", "zh-hant", "zh-hk")):
        return "zt"
    language = locale.split("-")[0]
    return {"no": "nb", "fil": "tl"}.get(language, language)


def language_code(code):
    return {"pb": "pt-BR", "zt": "zh-Hant"}.get(code, code)


def registry():
    result = {}
    for row in get_index():
        source, target = row.get("from_code"), row.get("to_code")
        if not source or not target or not re.fullmatch(r"[a-z]{2,3}", source + ""): continue
        if not re.fullmatch(r"[a-z]{2,3}", target): continue
        key = (source, target)
        version = tuple(int(n) for n in str(row.get("package_version", "0")).split(".") if n.isdigit())
        if key not in result or version > result[key][0]:
            result[key] = (version, row)
    return {key: value[1] for key, value in result.items()}


REGISTRY = registry()


def languages():
    names = {"en": "English"}
    for row in REGISTRY.values():
        if row["from_code"] == "en": names[language_code(row["to_code"])] = row["to_name"]
    return [{"code": code, "name": name} for code, name in sorted(names.items(), key=lambda item: item[1])]


def progress(source, target, phase, percent=None):
    emit({"event": "progress", "source": language_code(source), "target": language_code(target), "phase": phase, "percent": percent})


def install_model(source, target):
    key = (source, target)
    row = REGISTRY.get(key)
    if not row:
        raise TranslationError("unsupported-language", "No local model is available for this language pair.")
    version = re.sub(r"[^a-zA-Z0-9_.-]", "", str(row.get("package_version", "1")))
    destination = CACHE / "models" / f"{source}_{target}_{version}"
    if (destination / "model" / "model.bin").is_file() and (destination / "sentencepiece.model").is_file():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    progress(source, target, "downloading", 0)
    links = [link for link in row.get("links", []) if link.startswith("https://")]
    links.extend("https://data.argosopentech.com/argospm/v1/" + link.rsplit("/", 1)[-1] for link in links[:1])
    archive = CACHE / f"{source}_{target}_{version}.argosmodel"
    last_error = None
    if not archive.is_file():
        for link in links:
            partial = archive.with_suffix(".partial")
            try:
                with remote(link, timeout=90) as response, partial.open("wb") as output:
                    length = int(response.headers.get("Content-Length", 0))
                    received = 0; last_percent = -1
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk); received += len(chunk)
                        if received > 1_500_000_000: raise ValueError("Model archive is too large")
                        percent = int(received / length * 100) if length else None
                        if percent is not None and percent // 10 != last_percent // 10:
                            progress(source, target, "downloading", percent); last_percent = percent
                partial.replace(archive)
                last_error = None
                break
            except Exception as error:
                partial.unlink(missing_ok=True); last_error = error
        if last_error or not archive.exists():
            raise TranslationError("model-download-failed", "Could not download this language model. Check the host's connection and retry.") from last_error
    progress(source, target, "installing")
    temporary = pathlib.Path(tempfile.mkdtemp(prefix="install-", dir=destination.parent))
    try:
        with zipfile.ZipFile(archive) as package:
            total = 0
            for item in package.infolist():
                resolved = (temporary / item.filename).resolve()
                if not resolved.is_relative_to(temporary.resolve()) or ((item.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError("Unsafe model archive")
                total += item.file_size
                if total > 2_000_000_000: raise ValueError("Extracted model is too large")
            package.extractall(temporary)
        roots = list(temporary.rglob("metadata.json"))
        model_root = next((p.parent for p in roots if (p.parent / "model" / "model.bin").is_file() and (p.parent / "sentencepiece.model").is_file()), None)
        if not model_root: raise ValueError("Unsupported model package")
        metadata = json.loads((model_root / "metadata.json").read_text())
        if metadata.get("from_code") != source or metadata.get("to_code") != target:
            raise ValueError("Model metadata does not match the requested language pair")
        if destination.exists(): shutil.rmtree(destination)
        shutil.move(str(model_root), destination)
        archive.unlink(missing_ok=True)
    except Exception as error:
        archive.unlink(missing_ok=True)
        raise TranslationError("invalid-model", "This language model could not be installed. Retry its download.") from error
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return destination


def load_model(source, target):
    key = (source, target)
    with MODELS_LOCK:
        lock = PAIR_LOCKS.setdefault(key, threading.Lock())
    with lock:
        with MODELS_LOCK:
            if key in MODELS:
                MODELS.move_to_end(key)
                return MODELS[key]
        path = install_model(source, target)
        progress(source, target, "loading")
        import ctranslate2
        import sentencepiece
        tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(path / "sentencepiece.model"))
        translator = ctranslate2.Translator(str(path / "model"), device="cpu", compute_type="int8", intra_threads=min(8, os.cpu_count() or 2), inter_threads=2)
        # Warm kernels before reporting this language as ready.
        translator.translate_batch([tokenizer.encode("Hello.", out_type=str)], beam_size=1)
        with MODELS_LOCK:
            MODELS[key] = (tokenizer, translator)
            while len(MODELS) > MAX_LOADED: MODELS.popitem(last=False)
        progress(source, target, "ready")
        return tokenizer, translator


def translate_batch(texts, source, target):
    if source == target: return texts
    if (source, target) not in REGISTRY:
        if source != "en" and target != "en" and (source, "en") in REGISTRY and ("en", target) in REGISTRY:
            return translate_batch(translate_batch(texts, source, "en"), "en", target)
        raise TranslationError("unsupported-language", "No local model is available for this language pair.")
    tokenizer, translator = load_model(source, target)
    encoded = [tokenizer.encode(text, out_type=str) for text in texts]
    # Long copy is split before inference, so the engine never silently truncates it.
    chunks = []; locations = []
    for tokens in encoded:
        start = len(chunks)
        chunks.extend([tokens[n:n+384] for n in range(0, len(tokens), 384)] or [[]])
        locations.append((start, len(chunks)))
    translated = translator.translate_batch(chunks, beam_size=2, max_batch_size=64, max_input_length=0, max_decoding_length=1200)
    # Some target vocabulary pieces are unknown to the shared tokenizer and retain
    # its visible space marker after decoding. Argos applies this same normalization.
    outputs = [tokenizer.decode(item.hypotheses[0]).replace("▁", " ").strip() for item in translated]
    separator = "" if target in {"ja", "zh", "zt"} else " "
    return [separator.join(outputs[start:end]) for start, end in locations]


def execute(request):
    request_id = request.get("id")
    try:
        if request_id in CANCELED: return
        source = model_code(request["sourceLocale"])
        target = model_code(request["targetLocale"])
        texts = request.get("texts", [])
        if not isinstance(texts, list) or len(texts) > 2048 or any(not isinstance(t, str) or len(t) > 20000 for t in texts):
            raise TranslationError("invalid-input", "Invalid translation input.")
        started = time.monotonic()
        outputs = translate_batch(texts, source, target)
        if request_id not in CANCELED:
            emit({"id": request_id, "texts": outputs, "elapsedMs": round((time.monotonic()-started)*1000)})
    except Exception as error:
        if "source" in locals() and "target" in locals(): progress(source, target, "failed")
        if request_id not in CANCELED:
            emit({"id": request_id, "error": {"code": getattr(error, "code", "translation-failed"), "message": str(error) if isinstance(error, TranslationError) else "The local translation engine failed. Retry the request."}})


def complete(request_id, future):
    if FUTURES.get(request_id) is future:
        FUTURES.pop(request_id, None)
    CANCELED.discard(request_id)


def main():
    if "--prepare" in sys.argv:
        source = model_code(sys.argv[sys.argv.index("--prepare")+1])
        targets = sys.argv[sys.argv.index("--prepare")+2:]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for future in [pool.submit(load_model, source, model_code(target)) for target in targets]: future.result()
        return
    revision = hashlib.sha256(json.dumps(get_index(), sort_keys=True).encode()).hexdigest()
    emit({"event": "ready", "languages": languages(), "revision": revision})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request.get("operation") == "cancel":
                    request_id = request.get("id")
                    if request_id in FUTURES:
                        CANCELED.add(request_id)
                        if FUTURES[request_id].cancel(): FUTURES.pop(request_id, None); CANCELED.discard(request_id)
                    continue
                request_id = request.get("id")
                if request_id is None: continue
                future = pool.submit(execute, request)
                FUTURES[request_id] = future
                future.add_done_callback(lambda done, key=request_id: complete(key, done))
            except (ValueError, TypeError):
                continue


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print("Local translator could not start: " + (str(error) if isinstance(error, TranslationError) else type(error).__name__), file=sys.stderr, flush=True)
        sys.exit(1)
