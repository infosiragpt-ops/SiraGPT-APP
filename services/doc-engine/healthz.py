#!/usr/bin/env python3
"""Healthz interno — solo 127.0.0.1, sin puerto público."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8080
BIND = "127.0.0.1"


class HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        return

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/healthz", "/health", "/"):
            body = json.dumps({"ok": True, "service": "doc-engine"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


def main():
    httpd = ThreadingHTTPServer((BIND, PORT), HealthHandler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
