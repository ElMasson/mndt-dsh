#!/usr/bin/env python3
"""The Docker guard of a team space: the machine service's only way to Docker.

It listens on an internal network that the machine service alone joins, and
relays to the Docker socket only what one space's computers need. Every
request is read, checked, then relayed; anything else answers 403.

- Create a container (POST /containers/create): the computer's image, its
  runtime (runsc; runc only when MNDT_GUARD_ALLOW_RUNC=1, a rehearsal), the
  space's label, a name with the space's prefix, one network of the space, one
  bind under the members' folders onto /home/user, a read-only root, every
  capability dropped, no-new-privileges; any other field of the request must be
  empty (no privilege, no device, no host namespace, no port, no extra bind).
- Act on a container (start, stop, kill, wait, delete, inspect, exec): only on
  one that carries the space's label, read from Docker itself; an exec never
  privileged; an exec's start, inspection and resize only for an exec this
  guard saw created on such a container. The egress proxy may be inspected,
  by its exact name (the computers reach it by its address).
- Networks: inspect, create (internal, labelled), connect and disconnect (the
  egress proxy only) and delete, only those named with the space's prefix.
- The containers' list only filtered on the space's label; _ping and version.

A refusal answers 403 with one line, and says why on stderr (the operator's
log). The exec start hijacks its connection (docker exec -i): once authorised,
both directions are relayed as raw bytes until either side closes.

Environment: MNDT_GUARD_SPACE (the space, required), MNDT_GUARD_PC_IMAGE,
MNDT_GUARD_PC_PREFIX, MNDT_GUARD_NET_PREFIX, MNDT_GUARD_USERS_ROOT (the host
path of the members' folders), MNDT_GUARD_EGRESS (the egress proxy's name),
MNDT_GUARD_SOCKET (/var/run/docker.sock), MNDT_GUARD_HOST, MNDT_GUARD_PORT.
"""
import json
import os
import re
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

SPACE = os.environ.get('MNDT_GUARD_SPACE', '')
PC_IMAGE = os.environ.get('MNDT_GUARD_PC_IMAGE', 'mndt-pc:local')
PC_PREFIX = os.environ.get('MNDT_GUARD_PC_PREFIX', 'mndt-' + SPACE + '-pc-')
NET_PREFIX = os.environ.get('MNDT_GUARD_NET_PREFIX', 'mndt-' + SPACE + '-pcnet-')
USERS_ROOT = os.environ.get('MNDT_GUARD_USERS_ROOT', '').rstrip('/')
EGRESS = os.environ.get('MNDT_GUARD_EGRESS', 'mndt-' + SPACE + '-egress')
SOCKET = os.environ.get('MNDT_GUARD_SOCKET', '/var/run/docker.sock')
ALLOW_RUNC = os.environ.get('MNDT_GUARD_ALLOW_RUNC', '') == '1'
TENANT_LABEL = 'mndt.tenant'
NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$')
VERSIONED = re.compile(r'^/v[0-9.]+(/.*)$')
# The fields of a computer's creation that may carry a value, and what each may be.
TMPFS = {'/tmp', '/dev/shm'}
_EXECS_LOCK = threading.Lock()
_EXECS = set()


# What the Docker client sends by itself for a field left unset (-1: « the default »).
CLIENT_DEFAULTS = {'MemorySwappiness': (-1,), 'OomScoreAdj': (0,), 'CpuShares': (0,)}


def empty(value, key=''):
    """@returns whether a request field is unset: None, false, zero, '' or an empty
    list or object, or the value the Docker client sends for an unset field."""
    return value in (None, False, 0, '', [], {}) or value in CLIENT_DEFAULTS.get(key, ())


class Refused(Exception):
    """A request the guard does not relay; its message goes to the log only."""


def upstream(method, path, body=b'', headers=None):
    """One request to Docker, read whole (for the guard's own checks). @returns (status, body bytes)."""
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(30)
    try:
        conn.connect(SOCKET)
        head = method + ' ' + path + ' HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n'
        for key, value in (headers or {}).items():
            head += key + ': ' + value + '\r\n'
        head += 'Content-Length: ' + str(len(body)) + '\r\n\r\n'
        conn.sendall(head.encode('latin-1') + body)
        data = b''
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
    finally:
        conn.close()
    header, _, payload = data.partition(b'\r\n\r\n')
    status = int(header.split(b' ', 2)[1]) if header else 502
    if b'transfer-encoding: chunked' in header.lower():
        payload = dechunk(payload)
    return status, payload


def dechunk(data):
    out = b''
    while data:
        size_line, _, rest = data.partition(b'\r\n')
        size = int(size_line.split(b';')[0] or b'0', 16)
        if size == 0:
            break
        out += rest[:size]
        data = rest[size + 2:]
    return out


def container_space(name):
    """@returns the space label of a container, '' when it has none, None when Docker does not know it."""
    status, body = upstream('GET', '/containers/' + name + '/json')
    if status == 404:
        return None
    if status != 200:
        raise Refused('the container ' + name + ' could not be inspected (' + str(status) + ')')
    labels = (json.loads(body or b'{}').get('Config') or {}).get('Labels') or {}
    return labels.get(TENANT_LABEL, '')


def ours(name):
    """Refuse unless the container carries this space's label. @returns whether Docker knows it."""
    if not NAME.match(name):
        raise Refused('not a container name: ' + name)
    space = container_space(name)
    if space is None:
        return False
    if space != SPACE:
        raise Refused('the container ' + name + ' is not of this space')
    return True


def check_create(query, body):
    name = (query.get('name') or [''])[0]
    if not name.startswith(PC_PREFIX) or not NAME.match(name):
        raise Refused('a computer is named ' + PC_PREFIX + '…, not ' + name)
    spec = json.loads(body or b'{}')
    host = spec.get('HostConfig') or {}
    labels = spec.get('Labels') or {}
    if spec.get('Image') != PC_IMAGE:
        raise Refused('a computer runs ' + PC_IMAGE + ', not ' + str(spec.get('Image')))
    if labels.get(TENANT_LABEL) != SPACE:
        raise Refused('a computer carries ' + TENANT_LABEL + '=' + SPACE)
    runtime = host.get('Runtime')
    if runtime != 'runsc' and not (runtime == 'runc' and ALLOW_RUNC):
        raise Refused('a computer runs under runsc, not ' + str(runtime))
    network = host.get('NetworkMode') or ''
    if not network.startswith(NET_PREFIX):
        raise Refused('a computer joins its own network ' + NET_PREFIX + '…, not ' + network)
    endpoints = list(((spec.get('NetworkingConfig') or {}).get('EndpointsConfig') or {}).keys())
    if any(not endpoint.startswith(NET_PREFIX) for endpoint in endpoints):
        raise Refused('a computer joins no other network: ' + ', '.join(endpoints))
    if host.get('ReadonlyRootfs') is not True:
        raise Refused('a computer has a read-only root')
    if 'ALL' not in [str(cap).upper() for cap in (host.get('CapDrop') or [])]:
        raise Refused('a computer drops every capability')
    if any(option != 'no-new-privileges' for option in (host.get('SecurityOpt') or [])):
        raise Refused('a computer takes no security option but no-new-privileges')
    mounts = host.get('Mounts') or []
    if len(mounts) != 1:
        raise Refused('a computer has one bind, its member\'s folder')
    mount = mounts[0]
    source = str(mount.get('Source') or '')
    folder = source[len(USERS_ROOT) + 1:] if USERS_ROOT and source.startswith(USERS_ROOT + '/') else ''
    if mount.get('Type') != 'bind' or mount.get('Target') != '/home/user' or not re.match(r'^[a-z0-9-]{1,80}$', folder):
        raise Refused('a computer binds one folder under the members\' folders onto /home/user, not ' + source)
    for path in (host.get('Tmpfs') or {}):
        if path not in TMPFS:
            raise Refused('a computer has no tmpfs at ' + path)
    allowed_host = {'Runtime', 'NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Mounts', 'Tmpfs',
                    'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'RestartPolicy', 'LogConfig', 'ConsoleSize',
                    'CgroupnsMode', 'Isolation', 'AutoRemove', 'MaskedPaths', 'ReadonlyPaths', 'ShmSize'}
    for key, value in host.items():
        if key not in allowed_host and not empty(value, key):
            raise Refused('a computer takes no ' + key + ' (' + json.dumps(value)[:60] + ')')
    if not empty((host.get('RestartPolicy') or {}).get('Name')) and host['RestartPolicy']['Name'] != 'no':
        raise Refused('a computer is never restarted by Docker')
    allowed = {'Image', 'Labels', 'HostConfig', 'NetworkingConfig', 'Env', 'User', 'Hostname', 'Domainname',
               'AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty', 'OpenStdin', 'StdinOnce', 'Cmd', 'Entrypoint',
               'WorkingDir', 'Volumes', 'ExposedPorts', 'StopSignal', 'Healthcheck', 'MacAddress', 'Platform'}
    for key, value in spec.items():
        if key not in allowed and not empty(value, key):
            raise Refused('a computer takes no ' + key + ' (' + json.dumps(value)[:60] + ')')
    for key in ('Cmd', 'Entrypoint', 'Volumes', 'ExposedPorts', 'Healthcheck'):
        if not empty(spec.get(key)):
            raise Refused('a computer takes no ' + key + ': its image says what it runs')
    if spec.get('User') not in ('1000:1000', '1000'):
        raise Refused('a computer runs as 1000')


def check_exec(body):
    spec = json.loads(body or b'{}')
    if spec.get('Privileged'):
        raise Refused('an exec is never privileged')
    if str(spec.get('User') or '1000').split(':')[0] not in ('1000',):
        raise Refused('an exec runs as the member (1000)')


def authorise(method, path, query, body):
    """Refuse what this space's machine service has no use for. @returns what to remember after the reply, or None."""
    if path in ('/_ping', '/version') and method in ('GET', 'HEAD'):
        return None
    if method == 'GET' and path == '/containers/json':
        filters = json.loads((query.get('filters') or ['{}'])[0] or '{}')
        label = filters.get('label') or {}
        labels = list(label.keys()) if isinstance(label, dict) else list(label)
        if TENANT_LABEL + '=' + SPACE not in labels:
            raise Refused('the containers are listed with the filter ' + TENANT_LABEL + '=' + SPACE)
        return None
    if method == 'POST' and path == '/containers/create':
        check_create(query, body)
        return None
    match = re.match(r'^/containers/([^/]+)/(json|start|stop|kill|wait|exec)$', path) or re.match(r'^/containers/([^/]+)$', path)
    if match:
        name = unquote(match.group(1))
        action = match.group(2) if match.lastindex and match.lastindex >= 2 else ('delete' if method == 'DELETE' else '')
        if action == 'json' and method == 'GET' and name == EGRESS:
            return None
        if action == '' or (action == 'json' and method != 'GET') or (action != 'json' and action != 'delete' and method != 'POST'):
            raise Refused(method + ' ' + path)
        if not ours(name):
            if action in ('delete', 'json'):
                return 'absent'
            raise Refused('no container ' + name)
        if action == 'exec':
            check_exec(body)
            return 'exec'
        return None
    match = re.match(r'^/exec/([0-9a-f]{12,64})/(start|json|resize)$', path)
    if match:
        with _EXECS_LOCK:
            known = match.group(1) in _EXECS
        if not known:
            raise Refused('an exec this guard did not see created: ' + match.group(1))
        return None
    if method == 'POST' and path == '/networks/create':
        spec = json.loads(body or b'{}')
        if not str(spec.get('Name') or '').startswith(NET_PREFIX) or spec.get('Internal') is not True \
                or (spec.get('Labels') or {}).get(TENANT_LABEL) != SPACE or spec.get('Driver') not in (None, '', 'bridge') \
                or spec.get('Ingress') or spec.get('ConfigFrom') or spec.get('Options'):
            raise Refused('a computer\'s network is internal, labelled, named ' + NET_PREFIX + '…')
        return None
    match = re.match(r'^/networks/([^/]+)(?:/(connect|disconnect))?$', path)
    if match:
        network = unquote(match.group(1))
        if not network.startswith(NET_PREFIX) or not NAME.match(network):
            raise Refused('not a network of this space: ' + network)
        action = match.group(2)
        if action is None and method in ('GET', 'DELETE'):
            return None
        if action is not None and method == 'POST':
            if json.loads(body or b'{}').get('Container') != EGRESS:
                raise Refused('only the egress proxy joins a computer\'s network')
            return None
    raise Refused(method + ' ' + path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def refuse(self, why):
        sys.stderr.write('docker-guard: refused ' + self.command + ' ' + self.path.split('?')[0] + ': ' + why + '\n')
        payload = json.dumps({'message': 'refused by the space\'s Docker guard'}).encode('utf-8')
        self.send_response(403)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.send_header('connection', 'close')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def handle_any(self):
        url = urlparse(self.path)
        versioned = VERSIONED.match(url.path)
        path = versioned.group(1) if versioned else url.path
        query = parse_qs(url.query)
        length = int(self.headers.get('content-length') or 0)
        if self.headers.get('transfer-encoding', '').lower() == 'chunked':
            return self.refuse('a chunked body')
        body = self.rfile.read(length) if length > 0 else b''
        try:
            after = authorise(self.command, path, query, body)
        except (Refused, ValueError) as error:
            return self.refuse(str(error))
        if after == 'absent':
            payload = json.dumps({'message': 'No such container'}).encode('utf-8')
            self.send_response(404)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.relay(body, after)

    def relay(self, body, after):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(SOCKET)
        hijack = 'upgrade' in (self.headers.get('connection') or '').lower()
        head = self.command + ' ' + self.path + ' HTTP/1.1\r\n'
        for key, value in self.headers.items():
            if key.lower() in ('connection', 'content-length', 'keep-alive', 'proxy-connection'):
                continue
            head += key + ': ' + value + '\r\n'
        head += ('Connection: Upgrade\r\n' if hijack else 'Connection: close\r\n') + 'Content-Length: ' + str(len(body)) + '\r\n\r\n'
        conn.sendall(head.encode('latin-1') + body)
        client = self.connection
        if after == 'exec':
            # The exec's id: read from the whole answer, then the answer is relayed.
            data = b''
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            conn.close()
            _, _, payload = data.partition(b'\r\n\r\n')
            if b'transfer-encoding: chunked' in data.split(b'\r\n\r\n')[0].lower():
                payload = dechunk(payload)
            try:
                exec_id = json.loads(payload or b'{}').get('Id', '')
                if re.match(r'^[0-9a-f]{12,64}$', exec_id):
                    with _EXECS_LOCK:
                        _EXECS.add(exec_id)
            except ValueError:
                pass
            client.sendall(data)
            self.close_connection = True
            return
        if hijack:
            def pump(source, target):
                try:
                    while True:
                        chunk = source.recv(65536)
                        if not chunk:
                            break
                        target.sendall(chunk)
                except OSError:
                    pass
                finally:
                    try:
                        target.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
            inbound = threading.Thread(target=pump, args=(client, conn), daemon=True)
            inbound.start()
            pump(conn, client)
            inbound.join(timeout=5)
            conn.close()
            self.close_connection = True
            return
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                client.sendall(chunk)
        finally:
            conn.close()
        self.close_connection = True

    do_GET = do_POST = do_DELETE = do_HEAD = do_PUT = handle_any

    def log_message(self, *_args):
        return


def startup_refusal():
    if not re.match(r'^[a-z0-9][a-z0-9-]{1,40}$', SPACE):
        return 'MNDT_GUARD_SPACE must name the space (lower case, digits, dashes)'
    if not USERS_ROOT.startswith('/'):
        return 'MNDT_GUARD_USERS_ROOT must be the host path of the members\' folders'
    return None


if __name__ == '__main__':
    refusal = startup_refusal()
    if refusal is not None:
        sys.stderr.write('docker-guard: ' + refusal + '\n')
        sys.exit(2)
    host = os.environ.get('MNDT_GUARD_HOST', '0.0.0.0')
    ThreadingHTTPServer((host, int(os.environ.get('MNDT_GUARD_PORT', '2375'))), Handler).serve_forever()
