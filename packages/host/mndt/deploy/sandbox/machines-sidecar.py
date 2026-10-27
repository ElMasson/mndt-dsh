#!/usr/bin/env python3
"""One browser session per person, on demand.

The product never sees the Docker socket: this small service runs beside it, on
the same network, and exposes only three verbs. Every session is an ephemeral
container started with the isolation flags below, named after the person and the
run, and removed whatever happens.

Environment:
  MACHINES_TOKEN   shared secret the product sends in X-Machine-Token
  MACHINES_IMAGE   image to run (default mndt-browser:test)
  MACHINES_OUT     host directory for captures (default /state/machines)
  MACHINES_DIR     directory read by the product API for previews
"""
import base64
import json
import os
import re
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get('MACHINES_TOKEN', '')
IMAGE = os.environ.get('MACHINES_IMAGE', 'mndt-browser:test')
OUT = os.environ.get('MACHINES_OUT', '/state/machines')
# Docker resolves a bind source on the host, so the sidecar keeps the host path
# of the very directory it also sees mounted at OUT.
OUT_HOST = os.environ.get('MACHINES_OUT_HOST', OUT)
IDENTITY = re.compile(r'^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$')
URL = re.compile(r'^https?://[^\s]+$')


def docker(*args, timeout=120):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)


def session_name(identity):
    return 'mndt-browser-' + re.sub(r'[^a-z0-9]+', '-', identity.lower()) + '-' + uuid.uuid4().hex[:8]


def capture(identity, url):
    name = session_name(identity)
    target = os.path.join(OUT, name + '.png')
    os.makedirs(OUT, exist_ok=True)
    # The bind mount lives beside the capture so the container only writes the
    # file the product asked for; the rest of the root is read only.
    folder = OUT_HOST
    args = [
        'run', '--rm', '--name', name,
        '--network', 'bridge',
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,size=256m',
        '--tmpfs', '/home/browser:rw,nosuid,size=64m',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '10001:10001',
        '--pids-limit', '128',
        '--memory', '768m',
        '--cpus', '1',
        '--mount', 'type=bind,src=' + folder + ',dst=/out',
        IMAGE, '--screenshot=/out/' + os.path.basename(target), url,
    ]
    started = time.time()
    result = docker(*args, timeout=90)
    if not os.path.exists(target) or os.path.getsize(target) == 0:
        raise RuntimeError('no capture was produced: ' + (result.stderr or result.stdout)[-300:])
    with open(target, 'rb') as handle:
        payload = handle.read()
    return {
        'ok': True,
        'identity': identity,
        'file': target,
        'bytes': len(payload),
        'seconds': round(time.time() - started, 1),
        'png': base64.b64encode(payload).decode('ascii'),
    }


def sessions():
    result = docker('ps', '--filter', 'name=mndt-browser-', '--format', '{{.Names}}\t{{.Status}}')
    rows = []
    for line in (result.stdout or '').strip().splitlines():
        name, _, status = line.partition('\t')
        rows.append({'name': name, 'status': status})
    return rows


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def reply(self, status, body):
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorised(self):
        if TOKEN == '':
            return True
        return self.headers.get('x-machine-token') == TOKEN

    def do_GET(self):
        if not self.authorised():
            return self.reply(403, {'error': 'a machine token is required'})
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'image': IMAGE})
        if self.path == '/sessions':
            return self.reply(200, {'sessions': sessions()})
        return self.reply(404, {'error': 'unknown path'})

    def do_POST(self):
        if not self.authorised():
            return self.reply(403, {'error': 'a machine token is required'})
        try:
            length = int(self.headers.get('content-length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'a JSON body is required'})
        if self.path != '/capture':
            return self.reply(404, {'error': 'unknown path'})
        identity = str(body.get('identity', '')).strip().lower()
        url = str(body.get('url', '')).strip()
        if not IDENTITY.match(identity):
            return self.reply(400, {'error': 'identity must be an email address'})
        if not URL.match(url):
            return self.reply(400, {'error': 'url must start with http:// or https://'})
        try:
            return self.reply(200, capture(identity, url))
        except subprocess.TimeoutExpired:
            return self.reply(504, {'error': 'the session did not finish within 90 seconds'})
        except Exception as error:  # noqa: BLE001 - the reason goes back to the caller
            return self.reply(500, {'error': str(error)})

    def log_message(self, *_args):
        return


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8796), Handler).serve_forever()
