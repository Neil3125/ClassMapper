#!/usr/bin/env python3
"""Local dev server for ClassMapper.

Plain `python -m http.server` sends no Cache-Control header, so browsers cache
files heuristically and you end up staring at a stale page after every edit.
This adds no-cache headers (and the right MIME types) so what you see is always
what's on disk.

Usage:  python serve.py [port]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(SimpleHTTPRequestHandler):
    # Windows registry sometimes maps .js to text/plain, which breaks ES modules.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # `no-cache` means "always revalidate", which is what we want during
        # development. Deliberately NOT `no-store`: Chrome refuses to install a
        # service worker whose script is served with no-store.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    handler = partial(Handler, directory=str(__file__).rsplit("serve.py", 1)[0] or ".")
    with ThreadingHTTPServer(("", PORT), handler) as httpd:
        print(f"ClassMapper serving on http://localhost:{PORT}  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
