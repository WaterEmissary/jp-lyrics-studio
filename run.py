"""启动入口：python run.py [--host 0.0.0.0] [--port 8765]

环境变量：
  JLS_DATA_DIR    数据目录（默认 ./data）
  JLS_PROXY_BASE  网易云/Marumaru 代理 Worker 地址（默认沿用原项目部署的 Worker）
"""
import argparse
import webbrowser
import threading

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="JP Lyrics Studio")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址；局域网/手机访问用 0.0.0.0")
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    ap.add_argument("--reload", action="store_true", help="开发模式：代码变更自动重载")
    args = ap.parse_args()
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"JP Lyrics Studio → {url}")
    uvicorn.run("server.app:app", host=args.host, port=args.port, reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
