# 服务器侧的隧道服务：给每台电脑开一个公网端口，把流量倒进去。
#
# 和 lib/tunnel.js 配对。设计目标只有三个：
#   1. 零外部依赖——纯 Python 标准库，不装 frp、不需要额外运行时。
#   2. 端口归服务器发，电脑只拿 token——token 里绑死了端口号。
#   3. 一条控制连接 + 每条入站连接一条数据连接——职责清晰，绝不串流。
#
# 为什么不用 frp：frp 需要客户端侧有 frpc.exe（15 MB 的 Go 二进制）。
# 插件从 GitHub 装下来时那个 exe 常常不在，于是「端口申请到了、服务器上没人监听」，
# 手机只看到「网页拒绝了您的访问」。客户端换成纯 Node 后，整条链路没有任何
# 需要随包分发的可执行文件。
#
# ---------------------------------------------------------------------------
# 协议
# ---------------------------------------------------------------------------
# 控制连接（GET /tunnel，header x-dsh-token: <token>）
#   客户端 → 服务器  {"t":"hello","token":"...","port":9000}
#   服务器 → 客户端  {"t":"ready","port":9000}
#                    {"t":"error","msg":"..."}
#                    {"t":"open","id":7}        手机来了第 7 条连接，请开数据通道
#                    {"t":"close","id":7}       第 7 条连接结束
#
# 数据连接（GET /tunnel-data，header x-dsh-token / x-dsh-conn）
#   双向二进制帧，一帧就是一段原始字节。帧边界不等于 HTTP 报文边界，
#   两端都把它当纯字节流，靠 HTTP 自己的 Content-Length / chunked 分帧。
#
# 每台电脑的连接数很少：一条控制 + 每条手机 TCP 一条数据。
# 手机浏览器在同 host 下复用连接，所以实际通常只有 2-4 条。

import base64
import hashlib
import json
import socket
import struct
import threading
import time
from urllib.parse import urlsplit

WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONTROL_PATH = "/tunnel"
DATA_PATH = "/tunnel-data"


def _accept_key(key):
    return base64.b64encode(hashlib.sha1(key.encode("ascii") + WS_GUID).digest()).decode("ascii")


class WsConn:
    """最小的 WebSocket 服务端封装：握手 + 收发帧。"""

    def __init__(self, sock):
        self.sock = sock
        self._buf = b""
        self._lock = threading.Lock()
        self.closed = False

    @classmethod
    def handshake(cls, sock, request_head):
        lines = request_head.split("\r\n")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        key = headers.get("sec-websocket-key")
        if not key or headers.get("upgrade", "").lower() != "websocket":
            raise ValueError("不是 WebSocket 请求")
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {_accept_key(key)}\r\n\r\n"
        )
        sock.sendall(resp.encode("ascii"))
        return cls(sock), headers

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("对端关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def read_frame(self):
        b0, b1 = self._recv_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(length) if length else b""
        if mask:
            payload = bytes(payload[i] ^ mask[i & 3] for i in range(len(payload)))
        return opcode, payload, fin

    def send(self, payload, opcode=0x2):
        if self.closed:
            return
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x80 | opcode, length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 126, length)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 127, length)
        try:
            with self._lock:
                self.sock.sendall(header + payload)
        except OSError:
            self.closed = True

    def send_json(self, obj):
        self.send(json.dumps(obj, ensure_ascii=False).encode("utf-8"), 0x1)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class Slot:
    """一个「电脑 × 端口」的隧道会话。"""

    def __init__(self, port, control, log, token):
        self.port = port
        self.control = control
        self.log = log
        self.token = token
        self.listener = None
        self.next_id = 1
        self.data = {}  # id -> {"conn": WsConn, "client": socket, "pending": [bytes]}
        self._lock = threading.Lock()

    def bind(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("0.0.0.0", self.port))
        listener.listen(64)
        self.listener = listener
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        listener = self.listener
        while True:
            try:
                client, peer = listener.accept()
            except (OSError, AttributeError):
                return
            conn_id = self._next_id()
            self.log(f"[{self.port}] 接入 {peer[0]}:{peer[1]} → conn#{conn_id}")
            with self._lock:
                entry = {"conn": None, "client": client, "pending": [], "eof": False}
                self.data[conn_id] = entry
            self.control.send_json({"t": "open", "id": conn_id})
            threading.Thread(
                target=self._pump_client, args=(conn_id, client, entry), daemon=True
            ).start()

    def _next_id(self):
        with self._lock:
            cid = self.next_id
            self.next_id += 1
            return cid

    def _pump_client(self, conn_id, client, entry):
        """手机 → 服务器 → 电脑。数据通道还没建好时先存着，建好再冲。

        关键：这里必须能在数据通道到位之前读字节。手机一连上就发请求头，
        如果我们等数据通道建好才 recv，浏览器的首包会卡在内核缓冲区里；
        更糟的是「数据通道建好 → 才启动本线程」就会漏掉首包，手机侧表现为
        连接直接被重置。

        另一个关键：recv 返回空只代表手机把「发」的方向关了（HTTP 客户端
        常常请求一发完就 half-close），**不代表这条连接结束了**。这时候必须
        把 EOF 传给电脑（让本机服务知道请求体结束了、可以回响应），然后继续
        等电脑回完数据。以前在这里直接 close 手机 socket，手机收到的是
        半个响应或者干脆是 400/ECONNRESET。
        """
        peer_closed = False
        try:
            while True:
                data = client.recv(65536)
                if not data:
                    peer_closed = True
                    break
                with self._lock:
                    conn = entry["conn"]
                    if conn is None:
                        # 攒着等数据通道；攒到 512 个 chunk 还没人接就放弃这条连接，
                        # 免得一个没人要的连接把内存吃干净。
                        if len(entry["pending"]) >= 512:
                            self.log(f"[{self.port}] conn#{conn_id} 数据通道迟迟不来，丢弃")
                            return
                        entry["pending"].append(data)
                        continue
                    # 在锁里写：attach_data 也在同一把锁里回填 backlog，
                    # 两个线程往同一条 WebSocket 写帧必须串行，否则帧会交错，
                    # 电脑侧收到的是「前半截是别人的帧尾巴、后半截才是 HTTP」。
                    conn.send(data, 0x2)
        except OSError:
            peer_closed = True

        # 手机不再发东西了：通知电脑「upstream 结束」，但连接留着等回程。
        # 只有手机是异常断开（不是正常 half-close）时才整条拆掉。
        with self._lock:
            conn = entry.get("conn")
            if conn is None:
                entry["eof"] = True
        if conn is not None and not conn.closed:
            try:
                conn.send_json({"t": "eof", "id": conn_id})
            except OSError:
                pass
            return
        # 数据通道都没建起来就断了，没什么可等的。
        self._teardown(conn_id, client)

    def _teardown(self, conn_id, client):
        """整条连接收尾。只有 _pump_ws（电脑侧结束）或异常路径才会走到这里。"""
        self.control.send_json({"t": "close", "id": conn_id})
        with self._lock:
            entry = self.data.pop(conn_id, None)
        try:
            client.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        time.sleep(0.05)
        try:
            client.close()
        except OSError:
            pass

    def attach_data(self, conn_id, ws):
        """电脑为 conn#id 建好了数据通道：把之前攒下的字节冲过去。

        整个回填过程必须在槽的锁里做——`_pump_client` 也在这把锁里写同一个
        WebSocket。以前锁只圈住了「取 backlog」，回填放到锁外，于是两边的帧
        互相穿插，电脑侧收到的请求前面会粘上 `{"t":"open"...}` 的尾巴。
        """
        with self._lock:
            entry = self.data.get(conn_id)
            if entry is None:
                return None
            entry["conn"] = ws
            backlog = entry["pending"]
            entry["pending"] = []
            already_eof = entry.get("eof", False)
            for chunk in backlog:
                ws.send(chunk, 0x2)
            if already_eof:
                ws.send_json({"t": "eof", "id": conn_id})
        threading.Thread(target=self._pump_ws, args=(conn_id, ws), daemon=True).start()
        return True

    def _pump_ws(self, conn_id, ws):
        """电脑 → 服务器 → 手机。"""
        try:
            while not ws.closed:
                opcode, payload, fin = ws.read_frame()
                if opcode == 0x8:
                    break
                if opcode == 0x1:
                    continue
                with self._lock:
                    entry = self.data.get(conn_id)
                if entry is None:
                    continue
                try:
                    entry["client"].sendall(payload)
                except OSError:
                    break
        except (ConnectionError, OSError):
            pass
        finally:
            # 电脑那边把响应写完了（local 的 close）→ 整条连接真的结束了。
            with self._lock:
                entry = self.data.get(conn_id)
            client = entry.get("client") if entry else None
            if client is not None:
                self._teardown(conn_id, client)

    def close(self, reason=""):
        try:
            if self.listener:
                # 先 shutdown 再 close：accept() 阻塞在 listener 上时，单纯 close
                # 不会把那个 fd 真正还回去，端口会一直显示 LISTEN 却没人能连，
                # 下一次隧道重连就报 Errno 98 Address already in use。
                try:
                    self.listener.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.listener.close()
        except OSError:
            pass
        self.listener = None
        with self._lock:
            entries = list(self.data.values())
            self.data.clear()
        for entry in entries:
            try:
                entry["client"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                entry["client"].close()
            except OSError:
                pass
        try:
            self.control.close()
        except OSError:
            pass
        self.log(f"[{self.port}] 隧道关闭（{reason}）")


class TunnelServer:
    """接收电脑来的隧道连接，为每个端口开一条公网监听。

    verify(token, port) -> bool  由 api.py 提供，判断 token 是否允许占这个端口
    """

    def __init__(self, listen_host, listen_port, verify, log=print):
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.verify = verify
        self.log = log
        self.slots = {}  # port -> Slot
        self._lock = threading.Lock()
        self._srv = None
        self._pending_data = {}  # (token, conn_id) -> ws，等待控制通道声明的数据连接

    def start(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.listen_host, self.listen_port))
        srv.listen(128)
        self._srv = srv
        self.log(f"隧道服务已监听 {self.listen_host}:{self.listen_port}")
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def status(self):
        with self._lock:
            return {port: {"online": True} for port in self.slots}

    def _accept_loop(self):
        while True:
            try:
                sock, addr = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(sock, addr), daemon=True).start()

    def _read_head(self, sock):
        data = b""
        sock.settimeout(10)
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("握手前关闭")
            data += chunk
            if len(data) > 65536:
                raise ValueError("请求头过大")
        head, rest = data.split(b"\r\n\r\n", 1)
        return head.decode("latin-1"), rest

    def _serve(self, sock, addr):
        try:
            head, rest = self._read_head(sock)
            parts = head.split("\r\n")[0].split(" ")
            path = urlsplit(parts[1]).path if len(parts) >= 2 else ""
            if path not in (CONTROL_PATH, DATA_PATH):
                sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                sock.close()
                return
            ws, headers = WsConn.handshake(sock, head)
            # 握手包里跟着的字节不能丢：那是客户端紧随其后发来的帧，
            # 丢掉就等于吃掉请求头前半截，本机服务收到的是「残句」→ 400。
            if rest:
                ws._buf = rest
            sock.settimeout(None)
            if path == CONTROL_PATH:
                self._serve_control(ws, headers, addr)
            else:
                self._serve_data(ws, headers)
        except Exception as error:
            self.log(f"隧道连接处理失败 {addr}：{error}")
            try:
                sock.close()
            except OSError:
                pass

    def _serve_control(self, ws, headers, addr):
        opcode, payload, _ = ws.read_frame()
        if opcode != 0x1:
            ws.close()
            return
        hello = json.loads(payload.decode("utf-8"))
        if hello.get("t") != "hello":
            ws.send_json({"t": "error", "msg": "首帧必须是 hello"})
            ws.close()
            return
        token = str(hello.get("token") or "")
        try:
            port = int(hello.get("port") or 0)
        except (TypeError, ValueError):
            ws.send_json({"t": "error", "msg": "port 不合法"})
            ws.close()
            return
        if not self.verify(token, port):
            ws.send_json({"t": "error", "msg": f"token 无权占用端口 {port}"})
            ws.close()
            return
        # 同一端口重复连入：踢掉旧的，让新的接管
        self._drop(port, "被新连接顶替")
        slot = Slot(port, ws, self.log, token)
        try:
            slot.bind()
        except OSError as error:
            ws.send_json({"t": "error", "msg": f"端口 {port} 绑定失败：{error}"})
            ws.close()
            return
        with self._lock:
            self.slots[port] = slot
        ws.send_json({"t": "ready", "port": port})
        self.log(f"[{port}] 隧道就绪（来自 {addr[0]}）")
        # 控制通道只收心跳和 close；真正断线靠 read 抛错感知
        try:
            while True:
                opcode, payload, _ = ws.read_frame()
                if opcode == 0x8:
                    break
                if opcode == 0x1:
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                    except Exception:
                        continue
                    if msg.get("t") == "ping":
                        ws.send_json({"t": "pong"})
        except (ConnectionError, OSError):
            pass
        finally:
            self._drop(port, "控制通道断开")

    def _serve_data(self, ws, headers):
        token = headers.get("x-dsh-token", "")
        try:
            conn_id = int(headers.get("x-dsh-conn", "0"))
        except ValueError:
            ws.close()
            return
        with self._lock:
            slot = None
            for candidate in self.slots.values():
                if candidate.token == token:
                    slot = candidate
                    break
        if slot is None:
            self.log(f"数据通道带了不认识的 token（conn#{conn_id}），丢弃")
            ws.close()
            return
        if not slot.attach_data(conn_id, ws):
            # 这条连接已经没了（手机自己断的），直接把数据通道关掉
            ws.close()

    def _drop(self, port, reason):
        with self._lock:
            slot = self.slots.pop(port, None)
        if slot:
            slot.close(reason)
