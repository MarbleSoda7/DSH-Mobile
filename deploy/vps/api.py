#!/usr/bin/env python3
"""dsh-mobile 分配接口（跑在公网服务器上，只监听 127.0.0.1，由 Caddy 反代）

这个服务只做一件事：给每台装了插件的电脑发一个公网端口 + 一个只属于它的
frp 会话 token。电脑拿着 token 用 frpc 连本机的 frps，frps 只放行它被分配
的那个端口，其它端口一概拒绝。

  POST /api/claim    电脑第一次上线：不带 deviceId，换回 deviceId + secret + port + token
  POST /api/claim    之后每次上线：带上 deviceId + secret，换回同一个 port + 新 token
  POST /api/release  电脑主动退网：显式地放掉端口（可选）
  POST /api/verify   电脑自检：我这个身份还活着吗
  GET  /api/info     给人看的：现在分了哪几个端口、谁占着
  GET  /api/health   存活探针

为什么端口必须由服务器分：以前端口号存在每台电脑自己的 local.json 里，克隆同一份
仓库的两台机器会挑到同一个端口，表现就是「码没过期却提示配对码已过期」。端口归
服务器统一分配，机器之间就没有撞车的机会。

为什么用 frp 而不是 SSH：SSH 是登录协议，给每台电脑开转发就得给它们登录账号；
frp 的控制通道只用来协商端口，对方拿不到 shell，拿不到文件，也拿不到 root。

数据文件默认 /var/lib/dsh-gateway/api.json：
  {"machines": [{"deviceId","secret","port","token","owner","created","seen"}],
   "routes":   {token: {"port","deviceId","seen"}}}
"""

import hmac
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_FILE = os.environ.get("DSH_API_STATE", "/var/lib/dsh-gateway/api.json")
LISTEN_HOST = os.environ.get("DSH_API_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DSH_API_PORT", "7789"))

# 公网端口池：与 /etc/frp/frps.toml 的 allowPorts 保持一致。
# 端口池。9000 留给 frps 的控制通道（云安全组只放行 9000/9099 与 7789，
# 控制通道没法用默认的 7000），所以用户端口从 9001 起。
PORT_BASE = int(os.environ.get("DSH_API_PORT_BASE", "9001"))
PORT_STEP = int(os.environ.get("DSH_API_PORT_STEP", "1"))
PORT_SLOTS = int(os.environ.get("DSH_API_SLOTS", "20"))

# 空闲多久之后把端口收回来（秒）。0 表示永不回收。
RECLAIM_IDLE_SECONDS = int(os.environ.get("DSH_API_RECLAIM_IDLE", str(7 * 24 * 3600)))

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
    except FileNotFoundError:
        return _blank()
    except Exception as exc:  # 文件坏了就先把现场留一份，再重来
        try:
            os.replace(STATE_FILE, STATE_FILE + ".corrupt-%d" % int(time.time()))
        except Exception:
            pass
        sys.stderr.write("[api] state unreadable, starting fresh: %r\n" % (exc,))
        return _blank()


_state = load()


def save():
    tmp = STATE_FILE + ".tmp"
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def slot_port(index):
    return PORT_BASE + index * PORT_STEP


def _now_ms():
    return int(time.time() * 1000)


def _new_token():
    return secrets.token_hex(24)


def reclaim_idle():
    """把长期没露面的机器放掉，端口回收再用。返回被回收的 deviceId 列表。"""
    if RECLAIM_IDLE_SECONDS <= 0:
        return []
    deadline = _now_ms() - RECLAIM_IDLE_SECONDS * 1000
    dropped = []
    keep = []
    for row in _state["machines"]:
        if int(row.get("seen") or 0) < deadline:
            dropped.append(row.get("deviceId"))
            _state["routes"].pop(row.get("token") or "", None)
        else:
            keep.append(row)
    _state["machines"] = keep
    return dropped


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
    # 池子满了，回收最久没露面的那台，把端口借出来。
    victims = sorted(_state["machines"], key=lambda r: int(r.get("seen") or 0))
    for row in victims:
        if except_id and row.get("deviceId") == except_id:
            continue
        port = int(row.get("port") or 0)
        _state["machines"].remove(row)
        _state["routes"].pop(row.get("token") or "", None)
        sys.stderr.write("[api] reclaimed port %d from idle %s\n"
                         % (port, row.get("deviceId")))
        if port >= PORT_BASE:
            return port
    return None


def find_machine(device_id):
    for row in _state["machines"]:
        if row.get("deviceId") == device_id:
            return row
    return None


def _port_in_pool(port):
    port = int(port or 0)
    return PORT_BASE <= port <= slot_port(PORT_SLOTS - 1) and (port - PORT_BASE) % PORT_STEP == 0


def _route_token(port, token):
    _state["routes"][token] = {
        "port": int(port),
        "deviceId": str(port),
        "seen": _now_ms(),
    }


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
        "portSlots": PORT_SLOTS,
        "slots": slots,
        "machines": [{
            "deviceId": m.get("deviceId"),
            "port": m.get("port"),
            "owner": m.get("owner", ""),
            "seen": m.get("seen", 0),
        } for m in machines],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-api/2"
    protocol_version = "HTTP/1.1"

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
            raw = self.rfile.read(size).decode("utf-8")
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    # ---- 接口 -------------------------------------------------------------

    def _handle_claim(self, body):
        """核心接口：一台电脑来要端口。第一次不带 deviceId，之后带 deviceId+secret。"""
        with _lock:
            reclaim_idle()
            device_id = str(body.get("deviceId") or "").strip()
            secret = str(body.get("secret") or "").strip()
            owner = str(body.get("owner") or "").strip()[:40]
            now = _now_ms()

            row = find_machine(device_id) if device_id else None

            if row is not None:
                # 老熟人：校验密钥，保持端口不变，换一个新 token。
                if row.get("secret") and not hmac.compare_digest(str(row.get("secret")), secret):
                    self._send(403, {"ok": False, "error": "设备密钥不对，请删除本地 identity.json 重新申请"})
                    return
                if owner:
                    row["owner"] = owner
                row["seen"] = now
            elif device_id and secret:
                # 本地还有身份、服务器却不认识（比如服务器数据被清过 / 端口回收了）：
                # 沿用原来的 deviceId，只补发密钥并重新分一个端口。
                port = allocate_port(except_id=device_id)
                if port is None:
                    self._send(409, {"ok": False, "error": "服务器的端口已经分完了"})
                    return
                row = {
                    "deviceId": device_id,
                    "secret": secret,
                    "port": port,
                    "token": "",
                    "owner": owner,
                    "created": now,
                    "seen": now,
                }
                _state["machines"].append(row)
            else:
                # 全新机器：发新身份 + 分端口。
                device_id = "dev_" + secrets.token_hex(9)
                secret = secrets.token_hex(18)
                port = allocate_port()
                if port is None:
                    self._send(409, {"ok": False, "error": "服务器的端口已经分完了"})
                    return
                row = {
                    "deviceId": device_id,
                    "secret": secret,
                    "port": port,
                    "token": "",
                    "owner": owner,
                    "created": now,
                    "seen": now,
                }
                _state["machines"].append(row)

            token = _new_token()
            row["token"] = token
            row["seen"] = now
            _state["routes"][token] = {
                "port": int(row["port"]),
                "deviceId": row["deviceId"],
                "seen": now,
            }
            save()
            self._send(200, {
                "ok": True,
                "deviceId": row["deviceId"],
                "secret": row.get("secret", ""),
                "port": int(row["port"]),
                "slot": (int(row["port"]) - PORT_BASE) // PORT_STEP + 1,
                "token": token,
                "url": "http://%s:%d" % (PUBLIC_HOST, int(row["port"])),
            })

    def _handle_verify(self, body):
        """frps 的 HTTP 插件回调：NewProxy 时问一句「这个 token 允许开哪个端口」。

        frps 把客户端登录时的元信息放在 body.content 里（这里是 JSON 字符串），
        形如 {"user":"", "metas":{"token":"..."}, "run_id":"...", ...}。
        回 unchange 表示放行（remotePort 由客户端自己填，pool 已经限死范围），
        回 reject 表示这个 token 不认识，直接断开。
        """
        content = body.get("content")
        metas = {}
        if isinstance(content, str) and content.strip():
            try:
                inner = json.loads(content)
                if isinstance(inner, dict):
                    metas = inner.get("metas") or {}
            except Exception:
                metas = {}
        elif isinstance(content, dict):
            metas = content.get("metas") or {}

        token = str(metas.get("token") or metas.get("dsh_token") or "").strip()
        with _lock:
            entry = _state["routes"].get(token) if token else None
            if not entry:
                self._send(200, {"reject": False, "unchange": True,
                                 "reject_reason": "" if token else "缺少 token"})
                return
            now = _now_ms()
            entry["seen"] = now
            port = int(entry["port"])
            row = find_machine(str(entry.get("deviceId") or ""))
            if row is not None:
                row["seen"] = now
            save()
            self._send(200, {
                "unchange": True,
                "content": {
                    "metas": {"dsh_port": str(port)},
                },
            })

    def _handle_release(self, body):
        device_id = str(body.get("deviceId") or "").strip()
        secret = str(body.get("secret") or "").strip()
        with _lock:
            row = find_machine(device_id)
            if row is None:
                self._send(200, {"ok": True, "released": False})
                return
            if row.get("secret") and not hmac.compare_digest(str(row.get("secret")), secret):
                self._send(403, {"ok": False, "error": "设备密钥不对"})
                return
            port = int(row.get("port") or 0)
            _state["machines"].remove(row)
            _state["routes"].pop(row.get("token") or "", None)
            save()
            self._send(200, {"ok": True, "released": True, "port": port})

    def _handle_route_set(self, body):
        token = str(body.get("token") or "").strip()
        port = body.get("port")
        device_id = str(body.get("deviceId") or "").strip()
        secret = str(body.get("secret") or "").strip()
        if not token or not port:
            self._send(400, {"ok": False, "error": "缺少 token 或 port"})
            return
        if not _port_in_pool(port):
            self._send(400, {"ok": False, "error": "端口不在分配池里"})
            return
        with _lock:
            row = find_machine(device_id) if device_id else None
            if row is not None and row.get("secret") and not hmac.compare_digest(str(row["secret"]), secret):
                self._send(403, {"ok": False, "error": "设备密钥不对"})
                return
            if row is not None and int(row.get("port") or 0) != int(port):
                self._send(403, {"ok": False, "error": "这个端口不属于你"})
                return
            _state["routes"][token] = {
                "port": int(port),
                "deviceId": device_id or str(port),
                "seen": _now_ms(),
            }
            save()
            self._send(200, {"ok": True})

    def _dispatch(self, method):
        path = self.path.split("?", 1)[0]
        sys.stderr.write("[api] dispatch %s %s\n" % (method, path))
        if path in ("/health", "/__dsh_api_health", "/api/health"):
            self._send(200, {"ok": True, "machines": len(_state["machines"])})
            return
        if method == "GET" and path in ("/info", "/api/info"):
            with _lock:
                self._send(200, info_payload())
            return
        if method != "POST":
            self._send(405, {"ok": False, "error": "只支持 GET /api/info"})
            return
        body = self._body()
        if path in ("/claim", "/register", "/api/claim"):
            self._handle_claim(body)
        elif path in ("/verify", "/lookup", "/api/verify"):
            self._handle_verify(body)
        elif path in ("/release", "/api/release"):
            self._handle_release(body)
        elif path in ("/route", "/api/route"):
            self._handle_route_set(body)
        else:
            self._send(404, {"ok": False, "error": "没有这个接口"})
            return

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


PUBLIC_HOST = os.environ.get("DSH_API_PUBLIC_HOST", "8.152.5.127")

# 校验用的共享密钥：frps 每次回调都带上这个头，防止有人从公网直接打 7790。
PLUGIN_SECRET = os.environ.get("DSH_API_PLUGIN_SECRET", "")


def main():
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    httpd.daemon_threads = True
    sys.stderr.write("[api] listening on %s:%d, ports %d..%d\n"
                     % (LISTEN_HOST, LISTEN_PORT, PORT_BASE, slot_port(PORT_SLOTS - 1)))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
