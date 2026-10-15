"""用户显式执行此脚本才下载所选 Whisper 模型，服务启动和转写不自动下载。"""
import argparse
from pathlib import Path
from faster_whisper.utils import download_model

parser = argparse.ArgumentParser(description="下载指定本地 Whisper 模型")
parser.add_argument("--download-model", required=True, choices=["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v3"])
args = parser.parse_args()
download_model(args.download_model, cache_dir=str(Path(__file__).parent / ".models"))
print("所选 Whisper 模型已准备好。")
