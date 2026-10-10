"""Static dev server that never lets the browser cache, so edits always show on reload."""
import http.server, os, socket, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

class Server(http.server.ThreadingHTTPServer):
    # Listen on IPv4 and IPv6, because browsers may resolve localhost to either.
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
print(f'Viaggi on http://localhost:{port}', flush=True)
Server(('::', port), Handler).serve_forever()
