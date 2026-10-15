"""本机 Whisper CPU 转写入口，不读取服务凭据或用户其他文件。"""
import importlib.util
import json
from pathlib import Path
import sys

if "--probe" in sys.argv:
    selected = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "tiny"
    models_dir = Path(sys.argv[sys.argv.index("--models-dir") + 1]) if "--models-dir" in sys.argv else Path(__file__).parent / ".models"
    cache = models_dir / ("models--Systran--faster-whisper-" + selected) / "snapshots"
    cached = any((directory / "model.bin").is_file() and (directory / "tokenizer.json").is_file() for directory in cache.glob("*"))
    dependency = importlib.util.find_spec("faster_whisper") is not None
    print(json.dumps({"available": dependency and cached, "dependencyAvailable": dependency, "modelCached": cached}))
    raise SystemExit(0)

request = json.load(sys.stdin)
from faster_whisper import WhisperModel

cache = Path(request["modelsDir"]) if request.get("modelsDir") else Path(__file__).parent / ".models"
cache.mkdir(parents=True, exist_ok=True)
model = WhisperModel(request.get("model", "tiny"), device="cpu", compute_type="int8", download_root=str(cache), local_files_only=True)
language = request.get("language") or None
if language == "auto":
    language = None
segments, info = model.transcribe(request["path"], language=language, task="transcribe", beam_size=5, vad_filter=True)
result = [{"start": item.start, "end": item.end, "text": item.text.strip()} for item in segments]
print(json.dumps({"text": " ".join(item["text"] for item in result).strip(), "language": info.language,
                  "languageProbability": info.language_probability, "segments": result}, ensure_ascii=False))
