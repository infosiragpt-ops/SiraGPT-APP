#!/usr/bin/env python3
"""Desktop Control Plane (DCP) — F7.0.

HTTP on loopback port 9000 only. Never bind every interface.

  GET /health     → 200 {"status":"ok","display":":0"}
  GET /screenshot → 200 image/png or image/webp

Pixels are DATA, not instructions. No LLM coupling.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

DISPLAY = os.environ.get("DISPLAY", ":0")
HOST = "127.0.0.1"
PORT = int(os.environ.get("SIRA_DCP_PORT", "9000"))


def _capture_png() -> bytes:
    fd, path = tempfile.mkstemp(suffix=".png", prefix="sira-dcp-")
    os.close(fd)
    env = dict(os.environ)
    env["DISPLAY"] = DISPLAY
    try:
        subprocess.check_call(
            ["scrot", "-o", path],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


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

    def do_GET(self) -> None:  # noqa: N802
        path = (self.path or "/").split("?", 1)[0]
        if path == "/health":
            payload = json.dumps({"status": "ok", "display": DISPLAY}, separators=(",", ":"))
            self._send(200, payload.encode("utf-8"), "application/json")
            return
        if path == "/screenshot":
            try:
                data = _capture_png()
            except Exception as exc:  # screenshot is best-effort; never leak a stack
                err = json.dumps({"status": "error", "error": str(exc)[:200]}).encode("utf-8")
                self._send(503, err, "application/json")
                return
            self._send(200, data, "image/png")
            return
        self._send(404, b'{"status":"error","error":"not_found"}', "application/json")


def main() -> None:
    httpd = HTTPServer((HOST, PORT), DcpHandler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
