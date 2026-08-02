import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_HTML = (Path(__file__).parent / "static" / "index.html").read_bytes()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(_HTML)))
        self.end_headers()
        self.wfile.write(_HTML)

    def log_message(self, format, *args):
        pass  # keep polling logs free of HTTP access noise


def start_landing_server() -> ThreadingHTTPServer:
    """Serve the landing page on $PORT so Zeabur's custom domain has something to route to."""
    port = int(os.getenv("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
