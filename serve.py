"""開発用ローカルサーバー(キャッシュ無効)。本番はGitHub Pagesで配信するため不要。
使い方: python serve.py [port]
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    print(f'serving http://127.0.0.1:{port} (no-cache)')
    HTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
