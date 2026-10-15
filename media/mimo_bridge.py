"""复用固定版本的 MiMo 驱动生成请求正文；凭据与网络请求留在 Node 进程。"""
import importlib.util
import json
from pathlib import Path
import sys

driver_path = Path(__file__).parent / "vendor" / "mimo" / "driver" / "mimo_driver.py"
spec = importlib.util.spec_from_file_location("vendored_mimo_driver", driver_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
print(json.dumps(module.build_body(request), ensure_ascii=False))
