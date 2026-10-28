#!/usr/bin/env python3
"""DSH Mobile 公网网关（跑在公网服务器上，标准库实现，零依赖）

解决的问题
----------
每台电脑各跑一个 DSH Mobile 插件，靠 SSH 反向隧道把自己的 127.0.0.1:7788
借到服务器上的某个本地端口。如果每台电脑都要「服务器IP:不同端口」，用户就得
记端口，也谈不上开箱即用。

这里改成：对外永远只有一个地址 http://服务器IP（80 端口），按「这台手机的
身份」把请求转给对应的电脑。

路由依据
--------
1. 首次绑定：手机扫描二维码，码里是 `http://<服务器>/?t=<token>`。
   网关把 token 换成一台机器的隧道端口，并把 `mr_route` cookie 种到手机上。
2. 之后每次请求：网关看 `mr_route` cookie 里记的 token，查表找到端口转发。
3. 没 cookie 也没 token 的请求：返回一张说明页，告诉用户去电脑上扫码。

机器登记
--------
每台电脑的插件启动时 POST /__dsh_register 报到，带上自己的 token 和本地
隧道端口（默认 7788），网关把 token→端口记下来并持久化到 state 文件。
隧道断开时 POST /__dsh_unregister 注销。

为什么用 token 而不是 IP：同一个 WiFi 后面可能有多台电脑，同一台电脑也可能
换网络；token 是插件在本地生成并保存的，跟着仓库里的东西走，最稳。
"""

import json
import os
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_FILE = os.environ.get("DSH_GW_STATE", "/var/lib/dsh-gateway/state.json")
LISTEN_PORT = int(os.environ.get("DSH_GW_PORT", "80"))
LISTEN_HOST = os.environ.get("DSH_GW_HOST", "0.0.0.0")
COOKIE = "mr_route"
# 后端隧道的默认端口。插件报到时会带上自己真实的端口，这里只是兜底默认值。
DEFAULT_BACKEND_PORT = int(os.environ.get("DSH_GW_BACKEND_PORT", "7788"))
# 内部管理接口只允许这些路径前缀，避免和 DSH 自己的 /api/* 打架
REGISTER_PATH = "/__dsh_register"
UNREGISTER_PATH = "/__dsh_unregister"
HEALTH_PATH = "/__dsh_gateway_health"

_state_lock = threading.Lock()
_state = {
    # token -> {"port": 7788, "name": "xxx", "seen": 1234567890}
    "routes": {},
    "updated": 0,
}


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        routes = data.get("routes") if isinstance(data, dict) else None
        if isinstance(routes, dict):
            with _state_lock:
                _state["routes"] = {
                    str(k): {
                        "port": int(v.get("port") or DEFAULT_BACKEND_PORT),
                        "name": str(v.get("name") or ""),
                        "seen": float(v.get("seen") or 0),
                    }
                    for k, v in routes.items()
                    if isinstance(v, dict)
                }
                _state["updated"] = float(data.get("updated") or 0)
    except FileNotFoundError:
        pass
    except Exception as exc:  # 状态文件坏了也不能让网关起不来
        log(f"load_state failed: {exc}")


def save_state():
    with _state_lock:
        payload = {"routes": _state["routes"], "updated": _state["updated"]}
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception as exc:
        log(f"save_state failed: {exc}")


def log(msg):
    sys.stderr.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


COOKIE_RE = re.compile(r"(?:^|;\s*)" + COOKIE + r"=([A-Za-z0-9._~-]{8,256})")


def parse_cookie_token(header):
    if not header:
        return ""
    found = COOKIE_RE.search(header)
    return found.group(1) if found else ""


TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{8,256}$")


def token_valid(token):
    return bool(token) and bool(TOKEN_RE.match(token))


def route_for(token):
    if not token:
        return None
    with _state_lock:
        entry = _state["routes"].get(token)
    if not entry:
        return None
    return entry


def upsert_route(token, port, name):
    with _state_lock:
        _state["routes"][token] = {"port": port, "name": name, "seen": time.time()}
        _state["updated"] = time.time()
    save_state()


def drop_route(token):
    with _state_lock:
        existed = _state["routes"].pop(token, None)
        _state["updated"] = time.time()
    if existed:
        save_state()
    return bool(existed)


INTRO_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Mobile</title>
<style>
  body{margin:0;padding:32px 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",
       "PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e7e9ee}
  .card{max-width:520px;margin:0 auto;background:#161a21;border:1px solid #242a34;
        border-radius:14px;padding:24px}
  h1{font-size:20px;margin:0 0 12px}
  p{margin:0 0 12px;color:#a7b0bf}
  code{background:#1f2530;padding:2px 6px;border-radius:5px;color:#8fd0ff}
  ol{margin:0;padding-left:20px;color:#a7b0bf}
  li{margin-bottom:8px}
</style></head><body><div class="card">
  <h1>还没有绑定设备</h1>
  <p>这个地址是 DSH Mobile 的公网入口。每台电脑用各自的二维码绑定，
     绑定后手机访问同一个地址，看到的都是<b>你自己电脑</b>上的 DSH。</p>
  <ol>
    <li>在电脑上打开 <code>http://127.0.0.1:7788/admin</code></li>
    <li>用手机扫描页面上的二维码</li>
    <li>之后直接访问 <code>http://<服务器地址></code> 即可</li>
  </ol>
</div></body></html>
"""


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dsh-gateway"
    sys_version = ""

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    # ---- 小工具 ----
    def _json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or []):
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _html(self, status, html):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _query_token(self):
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        for key in ("t", "token"):
            values = params.get(key)
            if values and token_valid(values[0]):
                return values[0]
        return ""

    # ---- 内部接口 ----
    def _handle_register(self):
        payload = self._read_json_body()
        token = str(payload.get("token") or "").strip()
        if not token_valid(token):
            self._json(400, {"ok": False, "error": "token 无效"})
            return
        try:
            port = int(payload.get("port") or DEFAULT_BACKEND_PORT)
        except (TypeError, ValueError):
            port = DEFAULT_BACKEND_PORT
        if port <= 0 or port > 65535:
            self._json(400, {"ok": False, "error": "port 无效"})
            return
        name = str(payload.get("name") or "")[:80]
        upsert_route(token, port, name)
        log(f"register token={token[:8]}… port={port} name={name}")
        self._json(200, {"ok": True, "token": token, "port": port})

    def _handle_unregister(self):
        payload = self._read_json_body()
        token = str(payload.get("token") or "").strip()
        removed = drop_route(token) if token_valid(token) else False
        log(f"unregister token={token[:8] if token else '-'}… removed={removed}")
        self._json(200, {"ok": True, "removed": removed})

    def _handle_health(self):
        with _state_lock:
            routes = len(_state["routes"])
        self._json(200, {"ok": True, "routes": routes, "uptime": int(time.time() - STARTED_AT)})

    # ---- 转发 ----
    def _pick_backend(self, token):
        entry = route_for(token)
        if not entry:
            return None
        return entry["port"]

    def _proxy(self, backend_port, set_cookie_token=None):
        """把当前请求整体转发到 127.0.0.1:<backend_port>。

        只做最朴素的反向代理：头原样带过去，只是改 Host 并补上 X-Forwarded-*，
        并且重要的一点——**必须是流式**。DSH 的 /api/events 是 SSE 长连接，
        如果这里整包读完再写，手机就会一直转圈。
        """
        from http.client import HTTPConnection

        conn = HTTPConnection("127.0.0.1", backend_port, timeout=300)
        # 把 Host 改回后端期望的地址：插件是按 127.0.0.1 监听并校验 loopback 的，
        # 但不能让它以为是外网直连；用 127.0.0.1 最稳妥。
        headers = {}
        for key, value in self.headers.items():
            lower = key.lower()
            if lower in ("host", "connection", "keep-alive", "transfer-encoding",
                         "proxy-connection", "upgrade"):
                continue
            headers[key] = value
        headers["Host"] = f"127.0.0.1:{backend_port}"
        client_ip = self.client_address[0]
        headers["X-Forwarded-For"] = client_ip
        headers["X-Forwarded-Host"] = self.headers.get("Host", "")
        headers["X-Forwarded-Proto"] = "http"

        length = self.headers.get("Content-Length")
        body = None
        if length:
            try:
                size = int(length)
            except ValueError:
                size = 0
            if size:
                body = self.rfile.read(size)

        try:
            conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for key, value in headers.items():
                conn.putheader(key, value)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders()
            if body is not None:
                conn.send(body)
            resp = conn.getresponse()
        except Exception as exc:
            conn.close()
            self._html(502, f"<h1>后端电脑没有连上来</h1><p>隧道可能断了：{exc}</p>")
            return

        self.send_response_only(resp.status, resp.reason)
        raw_headers = resp.getheaders()
        for key, value in raw_headers:
            lower = key.lower()
            if lower in ("connection", "keep-alive", "transfer-encoding", "content-length"):
                continue
            self.send_header(key, value)
        if set_cookie_token:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE}={set_cookie_token}; Path=/; Max-Age=31536000; SameSite=Lax",
            )
        chunked = resp.chunked
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        else:
            clen = resp.getheader("Content-Length")
            if clen is not None:
                self.send_header("Content-Length", clen)
            else:
                self.send_header("Transfer-Encoding", "chunked")
                chunked = True
        self.end_headers()

        if self.command == "HEAD":
            conn.close()
            return

        # 流式转发：SSE / 大文件 / 普通响应都走这一条路
        try:
            while True:
                chunk = resp.read(16384)
                if not chunk:
                    break
                if chunked:
                    self.wfile.write(("%x\r\n" % len(chunk)).encode("ascii"))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()

    # ---- 入口 ----
    def _dispatch(self):
        from urllib.parse import urlparse

        path = urlparse(self.path).path
        if path == REGISTER_PATH:
            self._handle_register()
            return
        if path == UNREGISTER_PATH:
            self._handle_unregister()
            return
        if path == HEALTH_PATH:
            self._handle_health()
            return

        query_token = self._query_token()
        cookie_token = parse_cookie_token(self.headers.get("Cookie"))
        token = cookie_token or query_token
        port = self._pick_backend(token)
        if port is None and query_token:
            # 带了 token 但没登记：说明电脑那边的插件还没启动或隧道没通
            self._html(503, "<h1>这台电脑还没上线</h1>"
                            "<p>请确认电脑上的 DSH 正在运行，稍等几秒再刷新。</p>")
            return
        if port is None:
            self._html(200, INTRO_HTML)
            return
        # 用 token 进来时顺手种 cookie，之后就靠 cookie 路由
        self._proxy(port, set_cookie_token=query_token if query_token else None)

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_OPTIONS(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()


STARTED_AT = time.time()


def main():
    load_state()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), GatewayHandler)
    server.daemon_threads = True
    log(f"dsh-gateway listening on {LISTEN_HOST}:{LISTEN_PORT}, state={STATE_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
