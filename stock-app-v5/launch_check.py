"""Reuse only a service running exactly this package's four backend modules."""
import hashlib
import json
from pathlib import Path
import urllib.request

def current_code_sha256(directory):
    files=[directory/name for name in ('bridge.py','market_bridge.py','agents_runtime.py','sec_fundamentals.py')]
    return hashlib.sha256(b''.join(p.name.encode()+b'\0'+p.read_bytes() for p in files)).hexdigest()

def main():
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:8775/api/health',timeout=2) as response:
            health=json.loads(response.read(200000))
    except Exception:
        return 1
    if not health.get('ok') or health.get('app')!='regime-stock-research' or not str(health.get('version','')).startswith('5'):
        print('8775端口已有其他服务。本启动器未停止它；请先释放此端口。')
        return 2
    if health.get('loadedCodeSha256')!=current_code_sha256(Path(__file__).resolve().parent):
        print('正在运行的是另一版选股服务。请在原服务终端按 Control+C，再重新双击本启动器。')
        return 2
    return 0

if __name__=='__main__':
    raise SystemExit(main())
