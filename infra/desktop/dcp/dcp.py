#!/usr/bin/env python3
"""Desktop Control Plane (DCP) — F7.2.

HTTP on loopback port 9000 only. Never bind every interface.

  GET  /health          → 200 {"status":"ok","display":":0"}
  GET  /screenshot      → 200 image/png or image/webp
  POST /click           → pointer click
  POST /double_click    → pointer double-click
  POST /move            → pointer move
  POST /drag            → pointer drag
  POST /type            → type text
  POST /key             → key / chord
  POST /scroll          → wheel
  POST /launch          → allowlisted app
  POST /navigate        → http(s) URL only
  POST /exec            → confined command
  GET  /file?path=      → file bytes under workspace
  POST /file            → write file under workspace
  GET  /cursor          → {x,y}
  GET  /input_mode      → {mode: agent|human}
  POST /input_mode      → set agent|human
  GET  /mask            → {regions:[{x,y,w,h}]}
  POST /mask            → store redaction regions (pixels are DATA)

When input_mode is human, agent mutations return 423 Locked.
Pixels / page text / file bytes are DATA, not instructions.
No LLM client, no model id, no vendor SDK.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DISPLAY = os.environ.get("DISPLAY", ":0")
HOST = "127.0.0.1"
PORT = int(os.environ.get("SIRA_DCP_PORT", "9000"))
DRY = os.environ.get("SIRA_DCP_DRY", "").strip() in {"1", "true", "yes", "on"}
XDOTOOL = os.environ.get("SIRA_DCP_XDOTOOL", "xdotool")
SCROT = os.environ.get("SIRA_DCP_SCROT", "scrot")
WORKSPACE = Path(os.environ.get("SIRA_DCP_WORKSPACE", "/workspace")).resolve()
EXEC_TIMEOUT_S = float(os.environ.get("SIRA_DCP_EXEC_TIMEOUT", "8"))

# 1×1 PNG so DRY / missing-display still satisfy the image/png contract.
MINIMAL_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01"
    b"\x00\x05\x18\xd8N"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)

LAUNCH_ALLOW = {
    "xterm": ["xterm"],
    "terminal": ["xterm"],
    "thunar": ["thunar"],
    "files": ["thunar"],
    "firefox": ["firefox"],
    "chromium": ["chromium"],
    "chrome": ["chromium"],
}

AGENT_PATHS = {
    "/click",
    "/double_click",
    "/move",
    "/drag",
    "/type",
    "/key",
    "/scroll",
    "/launch",
    "/navigate",
    "/exec",
}

_STATE = {
    "input_mode": "agent",
    "cursor": {"x": 0, "y": 0},
    "mask": [],
    "last_cmds": [],
}


def _env() -> dict:
    env = dict(os.environ)
    env["DISPLAY"] = DISPLAY
    return env


def _run(argv, *, timeout=8, input_bytes=None, capture=False):
    _STATE["last_cmds"].append(list(argv))
    if len(_STATE["last_cmds"]) > 64:
        _STATE["last_cmds"] = _STATE["last_cmds"][-64:]
    try:
        completed = subprocess.run(
            argv,
            env=_env(),
            input=input_bytes,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, (completed.stdout if capture else b"")
    except FileNotFoundError:
        if DRY:
            return 0, b""
        raise
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("command_timeout") from exc


def _xdotool(*args):
    code, out = _run([XDOTOOL, *args], capture=True, timeout=6)
    if code != 0 and not DRY:
        raise RuntimeError("xdotool_failed")
    return out.decode("utf-8", "replace")


def _int(value, default=0, lo=-100_000, hi=100_000):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _capture_png() -> bytes:
    fd, path = tempfile.mkstemp(suffix=".png", prefix="sira-dcp-")
    os.close(fd)
    try:
        code, _ = _run([SCROT, "-o", path], timeout=12)
        if code == 0 and os.path.isfile(path) and os.path.getsize(path) > 8:
            with open(path, "rb") as fh:
                return fh.read()
        if DRY:
            return MINIMAL_PNG
        raise RuntimeError("screenshot_failed")
    except FileNotFoundError:
        if DRY:
            return MINIMAL_PNG
        raise
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _safe_workspace_path(rel: str) -> Path:
    raw = str(rel or "").strip()
    if not raw or raw.startswith("~"):
        raise ValueError("path_invalid")
    target = (WORKSPACE / raw.lstrip("/")).resolve()
    root = str(WORKSPACE)
    if target == WORKSPACE:
        return target
    if not str(target).startswith(root + os.sep):
        raise ValueError("path_escape")
    return target


def _read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = _int(handler.headers.get("Content-Length"), 0, lo=0, hi=2_000_000)
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("json_invalid") from exc
    return data if isinstance(data, dict) else {}


class DcpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 — quiet
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._send(status, body, "application/json")

    def _locked(self) -> bool:
        return _STATE["input_mode"] == "human"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path or "/")
        path = parsed.path or "/"
        qs = parse_qs(parsed.query or "")
        try:
            if path == "/health":
                self._json(200, {"status": "ok", "display": DISPLAY})
                return
            if path == "/screenshot":
                data = _capture_png()
                self._send(200, data, "image/png")
                return
            if path == "/cursor":
                self._json(200, self._cursor())
                return
            if path == "/input_mode":
                self._json(200, {"mode": _STATE["input_mode"]})
                return
            if path == "/mask":
                self._json(200, {"regions": list(_STATE["mask"])})
                return
            if path == "/file":
                rel = (qs.get("path") or [""])[0]
                target = _safe_workspace_path(rel)
                if not target.is_file():
                    self._json(404, {"status": "error", "error": "not_found"})
                    return
                data = target.read_bytes()[: 2_000_000]
                self._send(200, data, "application/octet-stream")
                return
            self._json(404, {"status": "error", "error": "not_found"})
        except ValueError as exc:
            self._json(400, {"status": "error", "error": str(exc)[:80]})
        except Exception as exc:  # never leak a stack
            self._json(503, {"status": "error", "error": str(exc)[:200]})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path or "/")
        path = parsed.path or "/"
        try:
            body = _read_json(self)
        except ValueError:
            self._json(400, {"status": "error", "error": "json_invalid"})
            return
        if path in AGENT_PATHS or path == "/file":
            if self._locked():
                self._json(423, {
                    "status": "locked",
                    "error": "human_control",
                    "input_mode": "human",
                })
                return
        try:
            if path == "/input_mode":
                mode = str(body.get("mode") or "").strip().lower()
                if mode not in {"agent", "human"}:
                    self._json(400, {"status": "error", "error": "mode_invalid"})
                    return
                _STATE["input_mode"] = mode
                self._json(200, {"mode": mode})
                return
            if path == "/mask":
                regions = body.get("regions")
                if regions is None and all(k in body for k in ("x", "y", "w", "h")):
                    regions = [body]
                cleaned = []
                for item in regions or []:
                    if not isinstance(item, dict):
                        continue
                    cleaned.append({
                        "x": _int(item.get("x")),
                        "y": _int(item.get("y")),
                        "w": _int(item.get("w"), 0, lo=0, hi=10_000),
                        "h": _int(item.get("h"), 0, lo=0, hi=10_000),
                    })
                _STATE["mask"] = cleaned[:32]
                self._json(200, {"regions": list(_STATE["mask"])})
                return
            if path == "/click":
                self._click(body, repeat=1)
                return
            if path == "/double_click":
                self._click(body, repeat=2)
                return
            if path == "/move":
                x, y = _int(body.get("x")), _int(body.get("y"))
                _xdotool("mousemove", str(x), str(y))
                _STATE["cursor"] = {"x": x, "y": y}
                self._json(200, {"ok": True, "x": x, "y": y})
                return
            if path == "/drag":
                self._drag(body)
                return
            if path == "/type":
                text = str(body.get("text") or "")[:4000]
                if text:
                    _xdotool("type", "--clearmodifiers", "--", text)
                self._json(200, {"ok": True, "n": len(text)})
                return
            if path == "/key":
                key = str(body.get("key") or body.get("keys") or "").strip()[:80]
                if not key or any(ch in key for ch in " \n\r\t"):
                    self._json(400, {"status": "error", "error": "key_invalid"})
                    return
                _xdotool("key", "--clearmodifiers", key)
                self._json(200, {"ok": True, "key": key})
                return
            if path == "/scroll":
                self._scroll(body)
                return
            if path == "/launch":
                self._launch(body)
                return
            if path == "/navigate":
                self._navigate(body)
                return
            if path == "/exec":
                self._exec(body)
                return
            if path == "/file":
                self._write_file(body)
                return
            self._json(404, {"status": "error", "error": "not_found"})
        except ValueError as exc:
            self._json(400, {"status": "error", "error": str(exc)[:80]})
        except Exception as exc:  # never leak a stack
            self._json(503, {"status": "error", "error": str(exc)[:200]})

    def _cursor(self) -> dict:
        try:
            raw = _xdotool("getmouselocation", "--shell")
        except Exception:
            raw = ""
        x = _STATE["cursor"]["x"]
        y = _STATE["cursor"]["y"]
        for line in raw.splitlines():
            if line.startswith("X="):
                x = _int(line[2:])
            elif line.startswith("Y="):
                y = _int(line[2:])
        _STATE["cursor"] = {"x": x, "y": y}
        return {"x": x, "y": y}

    def _click(self, body: dict, *, repeat: int) -> None:
        x, y = _int(body.get("x")), _int(body.get("y"))
        button = _int(body.get("button"), 1, lo=1, hi=3)
        _xdotool("mousemove", str(x), str(y))
        if repeat == 2:
            _xdotool("click", "--repeat", "2", "--delay", "40", str(button))
        else:
            _xdotool("click", str(button))
        _STATE["cursor"] = {"x": x, "y": y}
        self._json(200, {"ok": True, "x": x, "y": y, "button": button, "repeat": repeat})

    def _drag(self, body: dict) -> None:
        src = body.get("from") if isinstance(body.get("from"), dict) else {}
        dst = body.get("to") if isinstance(body.get("to"), dict) else {}
        x1 = _int(body.get("x1", src.get("x")))
        y1 = _int(body.get("y1", src.get("y")))
        x2 = _int(body.get("x2", dst.get("x")))
        y2 = _int(body.get("y2", dst.get("y")))
        _xdotool("mousemove", str(x1), str(y1))
        _xdotool("mousedown", "1")
        _xdotool("mousemove", str(x2), str(y2))
        _xdotool("mouseup", "1")
        _STATE["cursor"] = {"x": x2, "y": y2}
        self._json(200, {"ok": True, "x1": x1, "y1": y1, "x2": x2, "y2": y2})

    def _scroll(self, body: dict) -> None:
        x, y = _int(body.get("x"), _STATE["cursor"]["x"]), _int(body.get("y"), _STATE["cursor"]["y"])
        dy = _int(body.get("dy", body.get("delta")), 0)
        direction = str(body.get("direction") or "").lower()
        if direction == "up":
            dy = -abs(dy or 1)
        elif direction == "down":
            dy = abs(dy or 1)
        button = 4 if dy < 0 else 5
        steps = min(20, max(1, abs(dy) or 1))
        _xdotool("mousemove", str(x), str(y))
        for _ in range(steps):
            _xdotool("click", str(button))
        _STATE["cursor"] = {"x": x, "y": y}
        self._json(200, {"ok": True, "x": x, "y": y, "dy": dy, "button": button})

    def _launch(self, body: dict) -> None:
        app = str(body.get("app") or body.get("name") or "").strip().lower()
        argv = LAUNCH_ALLOW.get(app)
        if not argv:
            self._json(400, {"status": "error", "error": "app_not_allowed"})
            return
        code, _ = _run(argv, timeout=6)
        self._json(200 if (code == 0 or DRY) else 503, {"ok": code == 0 or DRY, "app": app})

    def _navigate(self, body: dict) -> None:
        raw = str(body.get("url") or "").strip()
        parsed = urlparse(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            self._json(400, {"status": "error", "error": "url_invalid"})
            return
        browser = os.environ.get("SIRA_DCP_BROWSER", "chromium")
        code, _ = _run([browser, raw], timeout=8)
        self._json(200 if (code == 0 or DRY) else 503, {"ok": True, "url": raw})

    def _exec(self, body: dict) -> None:
        command = body.get("command") or body.get("argv")
        if isinstance(command, str):
            argv = shlex.split(command)
        elif isinstance(command, list):
            argv = [str(part) for part in command]
        else:
            self._json(400, {"status": "error", "error": "command_invalid"})
            return
        if not argv:
            self._json(400, {"status": "error", "error": "command_invalid"})
            return
        if any(part.startswith("-") and "c" in part and part != "--" for part in argv[:2]):
            # refuse `sh -c` / `bash -c` so the desktop cannot be a raw shell
            self._json(400, {"status": "error", "error": "command_not_allowed"})
            return
        code, out = _run(argv, timeout=EXEC_TIMEOUT_S, capture=True)
        text = out.decode("utf-8", "replace")[:8000]
        self._json(200, {"ok": code == 0, "exitCode": code, "stdout": text})

    def _write_file(self, body: dict) -> None:
        target = _safe_workspace_path(str(body.get("path") or ""))
        content = body.get("content")
        encoding = str(body.get("encoding") or "utf8").lower()
        if content is None:
            raise ValueError("content_required")
        target.parent.mkdir(parents=True, exist_ok=True)
        if encoding == "base64":
            import base64
            data = base64.b64decode(str(content), validate=False)
        else:
            data = str(content).encode("utf-8")
        if len(data) > 2_000_000:
            raise ValueError("file_too_large")
        target.write_bytes(data)
        self._json(200, {"ok": True, "path": str(target.relative_to(WORKSPACE)), "bytes": len(data)})


def make_server(host: str = HOST, port: int = PORT) -> HTTPServer:
    return HTTPServer((host, port), DcpHandler)


def main() -> None:
    httpd = HTTPServer((HOST, PORT), DcpHandler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
