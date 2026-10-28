#!/usr/bin/env python3
"""dsh-mobile 分配接口（跑在公网服务器上，只监听 127.0.0.1）

网关 dsh-gateway.py 只做「按身份反代」。这个服务负责给每台电脑发身份：

  POST /register  电脑领一个设备码 deviceId + deviceSecret，
                  同时按顺序分一个公网端口（9000 起，最多 5 台）
  POST /verify    电脑每次连上来，用 deviceId + deviceSecret 换回自己的端口
  POST /lookup    网关按手机 cookie 里的 route 查该转给哪个端口
  GET  /info      给人看的：现在分了哪几个端口、谁占着

数据文件默认 /var/lib/dsh-gateway/api.json：
  {"machines": [{"deviceId","secret","port","owner","created","seen"}],
   "routes":   {token: {"port","deviceId","seen"}}}

为什么要放在服务器上分端口：以前槽位存在每台电脑自己的 local.json 里，克隆
同一份仓库的两台机器会选中同一个槽位，表现就是「码没过期却提示配对码已过期」。
端口由服务器统一分配，机器就没有撞车的机会。
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_FILE = os.environ.get("DSH_API_STATE", "/var/lib/dsh-gateway/api.json")
LISTEN_HOST = os.environ.get("DSH_API_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DSH_API_PORT", "7790"))

# 公网端口号：frps 的 allowPorts 放开了 9000-9099，这里默认给前 5 个。
PORT_BASE = int(os.environ.get("DSH_API_PORT_BASE", "9000"))
PORT_STEP = int(os.environ.get("DSH_API_PORT_STEP", "1"))
PORT_SLOTS = int(os.environ.get("DSH_API_SLOTS", "5"))

_lock = threading.Lock()


def _blank():
    return {"machines": [], "routes": {}}


def load():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("bad state")
        data.setdefault("machines", [])
        data.setdefault("routes", {})
        return data
    except Exception:
        return _blank()


_state = load()


def save():
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def slot_port(index):
    return PORT_BASE + index * PORT_STEP


def used_ports(except_id=None):
    out = set()
    for row in _state["machines"]:
        if except_id and row.get("deviceId") == except_id:
            continue
        try:
            out.add(int(row.get("port") or 0))
        except Exception:
            pass
    return out


def allocate_port(except_id=None):
    used = used_ports(except_id)
    for index in range(PORT_SLOTS):
        port = slot_port(index)
        if port not in used:
            return port
    return None


def find_machine(device_id):
    for row in _state["machines"]:
        if row.get("deviceId") == device_id:
            return row
    return None


def info_payload():
    machines = sorted(_state["machines"], key=lambda r: int(r.get("port") or 0))
    by_port = {int(m.get("port") or 0): m for m in machines}
    slots = []
    for index in range(PORT_SLOTS):
        port = slot_port(index)
        occupant = by_port.get(port)
        slots.append({
            "slot": index + 1,
            "port": port,
            "deviceId": occupant.get("deviceId") if occupant else None,
            "owner": occupant.get("owner", "") if occupant else "",
        })
    return {
        "ok": True,
        "portBase": PORT_BASE,
        "portStep": PORT_STEP,
        "slots": slots,
        "machines": [{
            "deviceId": m.get("deviceId"),
            "port": m.get("port"),
            "owner": m.get("owner", ""),
            "seen": m.get("seen", 0),
        } for m in machines],
        "routes": len(_state["routes"]),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-api/1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[api] %s %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            size = int(self.headers.get("content-length") or 0)
        except ValueError:
            size = 0
        if size <= 0 or size > 65536:
            return {}
        try:
            return json.loads(self.rfile.read(size).decode("utf-8"))
        except Exception:
            return {}

    # ---- 接口 -------------------------------------------------------------

    def _handle_register(self, body):
        with _lock:
            device_id = str(body.get("deviceId") or "").strip()
            secret = str(body.get("secret") or "").strip()
            owner = str(body.get("owner") or "").strip()[:40]
            now = int(time.time() * 1000)
            # 第一次上线（或者本地 state 被删过）没带 deviceId：直接发一个新的。
            # 以前这里直接 400，机器人永远拿不到身份，界面上一直显示「缺少 deviceId」。
            new_identity = not device_id
            if new_identity:
                device_id = "dev_" + os.urandom(9).hex()
                # 首次登记发一把密钥，插件存进 identity.json，之后每次带着它来。
                secret = os.urandom(18).hex()
            row = find_machine(device_id)
            if row is None:
                port = allocate_port()
                if port is None:
                    self._send(409, {
                        "ok": False,
                        "error": "服务器上的端口已经分完了（最多 %d 台电脑）" % PORT_SLOTS,
                    })
                    return
                row = {
                    "deviceId": device_id,
                    "secret": secret,
                    "port": port,
                    "owner": owner,
                    "created": now,
                    "seen": now,
                }
                _state["machines"].append(row)
            else:
                if row.get("secret") and secret and row["secret"] != secret:
                    self._send(403, {"ok": False, "error": "deviceSecret 不对"})
                    return
                row["secret"] = row.get("secret") or secret
                if owner:
                    row["owner"] = owner
                row["seen"] = now
            save()
            self._send(200, {
                "ok": True,
                "deviceId": row["deviceId"],
                # 首次登记或换了密钥时必须回传，否则电脑那边没法再次证明身份。
                "secret": row.get("secret", ""),
                "port": row["port"],
                "slot": (int(row["port"]) - PORT_BASE) // PORT_STEP + 1,
            })

    def _handle_verify(self, body):
        with _lock:
            device_id = str(body.get("deviceId") or "").strip()
            secret = str(body.get("secret") or "").strip()
            row = find_machine(device_id)
            if row is None:
                self._send(404, {"ok": False, "error": "这台电脑还没登记"})
                return
            if row.get("secret") and secret != row["secret"]:
                self._send(403, {"ok": False, "error": "deviceSecret 不对"})
                return
            row["seen"] = int(time.time() * 1000)
            save()
            self._send(200, {
                "ok": True,
                "deviceId": row["deviceId"],
                "port": row["port"],
                "slot": (int(row["port"]) - PORT_BASE) // PORT_STEP + 1,
            })

    def _handle_lookup(self, body):
        token = str(body.get("token") or "").strip()
        with _lock:
            entry = _state["routes"].get(token)
            if not entry:
                self._send(200, {"ok": False, "error": "route 不存在"})
                return
            self._send(200, {"ok": True, "port": entry.get("port"), "deviceId": entry.get("deviceId")})

    def _handle_route_set(self, body):
        token = str(body.get("token") or "").strip()
        port = body.get("port")
        if not token or not port:
            self._send(400, {"ok": False, "error": "缺少 token 或 port"})
            return
        with _lock:
            _state["routes"][token] = {
                "port": int(port),
                "deviceId": str(body.get("deviceId") or ""),
                "seen": int(time.time() * 1000),
            }
            save()
            self._send(200, {"ok": True})

    def _dispatch(self, method):
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/__dsh_api_health"):
            self._send(200, {"ok": True, "machines": len(_state["machines"])})
            return
        body = self._body() if method == "POST" else {}
        if method == "GET" and path == "/info":
            with _lock:
                self._send(200, info_payload())
            return
        if method != "POST":
            self._send(405, {"ok": False, "error": "只支持 GET /info"})
            return
        if path == "/register":
            self._handle_register(body)
        elif path == "/verify":
            self._handle_verify(body)
        elif path == "/lookup":
            self._handle_lookup(body)
        elif path == "/route":
            self._handle_route_set(body)
        else:
            self._send(404, {"ok": False, "error": "没有这个接口"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


def main():
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    httpd.daemon_threads = True
    sys.stderr.write("[api] listening on %s:%d, ports %d..%d\n"
                     % (LISTEN_HOST, LISTEN_PORT, PORT_BASE, slot_port(PORT_SLOTS - 1)))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
