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
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = os.environ.get('MACHINES_TOKEN', '')
SHELLS_ROOT = os.environ.get('SHELLS_ROOT', '/state/shells')
# As for captures, Docker resolves a bind source on the host, not in this container.
SHELLS_ROOT_HOST = os.environ.get('SHELLS_ROOT_HOST', SHELLS_ROOT)
SHELLS_SEED = os.environ.get('SHELLS_SEED', '/seed/profiles/web')
SHELL_IMAGE = os.environ.get('SHELL_IMAGE', 'mndt-workbench:local')
BROWSER_AGENT_IMAGE = os.environ.get('BROWSER_AGENT_IMAGE', 'mndt-browser-agent:local')
BROWSER_AGENT_PORT = int(os.environ.get('BROWSER_AGENT_PORT', '9223'))
DESKTOP_IMAGE = os.environ.get('DESKTOP_IMAGE', 'mndt-desktop:local')
DESKTOP_PORT = int(os.environ.get('DESKTOP_PORT', '9224'))
# Two sessions at once at most on this host, and one per person: the server has
# four vCPU and the browser sessions are the heaviest thing it runs.
MAX_CONCURRENT = int(os.environ.get('MACHINES_MAX_CONCURRENT', '2'))
MAX_PER_IDENTITY = int(os.environ.get('MACHINES_PER_IDENTITY', '1'))

_ACTIVE_LOCK = threading.Lock()
_ACTIVE = {}
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


def claim(identity):
    """Reserve one browser session for this person.

    @returns None when the session may start, or the reason it may not.
    """
    with _ACTIVE_LOCK:
        if _ACTIVE.get(identity, 0) >= MAX_PER_IDENTITY:
            return 'this person already has a session running'
        if sum(_ACTIVE.values()) >= MAX_CONCURRENT:
            return 'the server is already running the maximum number of sessions'
        _ACTIVE[identity] = _ACTIVE.get(identity, 0) + 1
    return None


def release(identity):
    with _ACTIVE_LOCK:
        _ACTIVE[identity] = max(0, _ACTIVE.get(identity, 0) - 1)


def desktop_name(identity):
    return 'desktop-' + shell_slug(identity)


def ensure_desktop(identity):
    """Start the person's desktop if it is not already up.

    A screen, a window manager and Chromium, reachable only through the agent.
    """
    name = desktop_name(identity)
    running = docker('inspect', name, '--format', '{{.State.Running}}').stdout.strip()
    if running == 'true':
        return {'ok': True, 'identity': identity, 'host': name, 'port': DESKTOP_PORT, 'token': TOKEN}
    docker('rm', '-f', name)
    docker(
        'run', '-d', '--name', name,
        '--network', 'mndt-front_front',
        '--read-only',
        '--tmpfs', '/tmp:rw,size=1g',
        '--tmpfs', '/dev/shm:rw,size=256m',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '1000:1000',
        '--pids-limit', '256',
        '--memory', '1g',
        '--cpus', '1',
        '-e', 'DESKTOP_TOKEN=' + TOKEN,
        '-e', 'DESKTOP_PORT=' + str(DESKTOP_PORT),
        DESKTOP_IMAGE,
        timeout=60,
    )
    for _ in range(30):
        probe = ("fetch('http://127.0.0.1:" + str(DESKTOP_PORT) + "/health', { headers: { 'x-agent-token': process.env.DESKTOP_TOKEN } })"
                 + ".then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))")
        health = docker('exec', name, 'node', '-e', probe, timeout=20)
        if health.returncode == 0:
            return {'ok': True, 'identity': identity, 'host': name, 'port': DESKTOP_PORT, 'token': TOKEN}
        time.sleep(2)
    return {'ok': False, 'identity': identity, 'error': 'the desktop agent did not answer'}


def stop_desktop(identity):
    docker('rm', '-f', desktop_name(identity))
    return {'ok': True, 'identity': identity, 'stopped': True}


def browser_name(identity):
    return 'browser-' + shell_slug(identity)


def ensure_browser(identity):
    """Start the person's interactive browser if needed.

    The session lives until it is stopped: a person can open a page, fill a form
    and read the result across several calls. It is read only, has no capability
    and holds a single Chromium.
    """
    name = browser_name(identity)
    running = docker('inspect', name, '--format', '{{.State.Running}}').stdout.strip()
    if running == 'true':
        return {'ok': True, 'identity': identity, 'host': name, 'port': BROWSER_AGENT_PORT, 'token': TOKEN}
    docker('rm', '-f', name)
    docker(
        'run', '-d', '--name', name,
        '--network', 'mndt-front_front',
        '--read-only',
        '--tmpfs', '/tmp:rw,size=512m',
        '--tmpfs', '/dev/shm:rw,size=256m',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '1000:1000',
        '--pids-limit', '256',
        '--memory', '1g',
        '--cpus', '1',
        '-e', 'AGENT_TOKEN=' + TOKEN,
        '-e', 'AGENT_PORT=' + str(BROWSER_AGENT_PORT),
        BROWSER_AGENT_IMAGE,
        timeout=60,
    )
    for _ in range(30):
        probe = ("fetch('http://127.0.0.1:" + str(BROWSER_AGENT_PORT) + "/health', { headers: { 'x-agent-token': process.env.AGENT_TOKEN } })"
                 + ".then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))")
        health = docker('exec', name, 'node', '-e', probe, timeout=20)
        if health.returncode == 0:
            return {'ok': True, 'identity': identity, 'host': name, 'port': BROWSER_AGENT_PORT, 'token': TOKEN}
        time.sleep(2)
    return {'ok': False, 'identity': identity, 'error': 'the browser agent did not answer'}


def stop_browser(identity):
    docker('rm', '-f', browser_name(identity))
    return {'ok': True, 'identity': identity, 'stopped': True}


def shell_slug(identity):
    return re.sub(r'[^a-z0-9]+', '-', identity.lower()).strip('-')


def shell_token(identity):
    path = os.path.join(SHELLS_ROOT, shell_slug(identity), 'web-token')
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read().strip()
    except OSError:
        return ''


def ensure_shell(identity):
    """Start the person's own shell if needed, and return where to reach it.

    Each shell gets its own /state volume, seeded from the shared web profile, so
    sessions, storages and the launch token belong to that person alone. The
    product API stays central: this instance carries no API port.
    """
    slug = shell_slug(identity)
    name = 'shell-' + slug
    home = os.path.join(SHELLS_ROOT, slug)
    profile = os.path.join(home, 'home', 'profiles', 'web')
    if not os.path.exists(os.path.join(profile, 'cordis.patch.yml')):
        os.makedirs(profile, exist_ok=True)
        if os.path.isdir(SHELLS_SEED):
            subprocess.run(['cp', '-r', SHELLS_SEED + '/.', profile + '/'], check=False)
    running = docker('inspect', name, '--format', '{{.State.Running}}').stdout.strip()
    if running != 'true':
        docker('rm', '-f', name)
        docker(
            'run', '-d', '--name', name,
            '--network', 'mndt-front_front',
            '--restart', 'unless-stopped',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--pids-limit', '256',
            '--memory', '768m',
            '--cpus', '1',
            '-e', 'DSH_HOME=/state/home',
            '-e', 'DSH_MNDT_IDENTITY=' + identity,
            '-e', 'DSH_MNDT_WEB_TOKEN_FILE=/state/web-token',
            '-e', 'HOME=/tmp',
            '-e', 'TMPDIR=/tmp',
            '-e', 'PUBLIC_URL=https://mndt.duke-analytics.com/',
            '-e', 'TRUSTED_HOST=mndt.duke-analytics.com',
            '-v', os.path.join(SHELLS_ROOT_HOST, slug) + ':/state',
            '--entrypoint', 'sh',
            SHELL_IMAGE, '/app/workbench-entrypoint.sh',
            timeout=60,
        )
    for _ in range(45):
        token = shell_token(identity)
        if token != '':
            return {'ok': True, 'identity': identity, 'host': name, 'token': token}
        time.sleep(2)
    return {'ok': False, 'identity': identity, 'error': 'the shell did not publish a launch token'}


# « Mon ordinateur » (option B, 26/11): one computer per member, under gVisor.
# Its runtime is a setting: runsc by default; a rehearsal without gVisor sets
# runc, and its checks say the gVisor proof is still to be made.
PC_RUNTIME = os.environ.get('MNDT_MACHINE_RUNTIME', 'runsc')
PC_IMAGE = os.environ.get('PC_IMAGE', DESKTOP_IMAGE)
PC_PORT = int(os.environ.get('PC_PORT', str(DESKTOP_PORT)))
# Each member's files, and nothing else: Docker resolves the bind on the host.
USERS_ROOT = os.environ.get('USERS_ROOT', '/state/users')
USERS_ROOT_HOST = os.environ.get('USERS_ROOT_HOST', USERS_ROOT)
# The only way out: the egress proxy (public web, HTTP and HTTPS only).
EGRESS_PROXY = os.environ.get('EGRESS_PROXY', 'mndt-egress')
EGRESS_PORT = int(os.environ.get('EGRESS_PORT', '3128'))
MAX_PCS = int(os.environ.get('MNDT_MACHINE_MAX', '4'))
IDLE_SECONDS = int(os.environ.get('MNDT_MACHINE_IDLE_SECONDS', '900'))
REAP_SECONDS = float(os.environ.get('MNDT_MACHINE_REAP_SECONDS', '30'))
PC_LABEL = 'mndt.member'

_PCS_LOCK = threading.Lock()
# One start at a time: counting the running computers and starting one is one step.
_START_LOCK = threading.Lock()
# identity -> {'startedAt': iso, 'lastUsed': epoch seconds}
_PCS = {}


def pc_name(identity):
    return 'mndt-pc-' + shell_slug(identity)


def pc_network(identity):
    return 'mndt-pc-net-' + shell_slug(identity)


def iso(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(epoch))


def running_pcs():
    """@returns the members whose computer runs, from Docker itself (it survives a restart of this service)."""
    result = docker('ps', '--filter', 'label=' + PC_LABEL, '--format', '{{.Label "' + PC_LABEL + '"}}')
    return [line.strip() for line in (result.stdout or '').splitlines() if line.strip() != '']


def pc_state(identity):
    with _PCS_LOCK:
        known = _PCS.get(identity)
    up = identity in running_pcs()
    if not up:
        return {'state': 'stopped'}
    last = known['lastUsed'] if known else time.time()
    return {
        'state': 'running',
        **({'startedAt': known['startedAt']} if known else {}),
        'lastUsedAt': iso(last),
        'stopsAt': iso(last + IDLE_SECONDS),
    }


def capacity():
    return {'used': len(running_pcs()), 'max': MAX_PCS}


def touch_pc(identity):
    with _PCS_LOCK:
        if identity in _PCS:
            _PCS[identity]['lastUsed'] = time.time()


def start_pc(identity):
    """Start the member's computer if it is not up. Busy when MAX_PCS run already.

    No /state, no model key, no Docker socket: its own files, its own internal
    network whose only way out is the egress proxy, its runtime gVisor.
    """
    with _START_LOCK:
        return _start_pc(identity)


def _start_pc(identity):
    name = pc_name(identity)
    if identity in running_pcs():
        touch_pc(identity)
        return {'ok': True}
    if len(running_pcs()) >= MAX_PCS:
        return {'ok': False, 'busy': True}
    network = pc_network(identity)
    # An internal network: no route out but the proxy, attached to it below.
    if docker('network', 'inspect', network).returncode != 0:
        docker('network', 'create', '--internal', '--label', PC_LABEL + '=' + identity, network)
    docker('network', 'connect', network, EGRESS_PROXY)
    home = os.path.join(USERS_ROOT, shell_slug(identity))
    os.makedirs(home, exist_ok=True)
    docker('rm', '-f', name)
    proxy = 'http://' + EGRESS_PROXY + ':' + str(EGRESS_PORT)
    result = docker(
        'run', '-d', '--name', name,
        '--runtime', PC_RUNTIME,
        '--label', PC_LABEL + '=' + identity,
        '--network', network,
        '--read-only',
        '--tmpfs', '/tmp:rw,size=1g',
        '--tmpfs', '/dev/shm:rw,size=256m',
        '--mount', 'type=bind,src=' + os.path.join(USERS_ROOT_HOST, shell_slug(identity)) + ',dst=/home/user',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '1000:1000',
        '--pids-limit', '256',
        '--memory', '1g',
        '--cpus', '1',
        '-e', 'HOME=/home/user',
        '-e', 'HTTP_PROXY=' + proxy, '-e', 'HTTPS_PROXY=' + proxy,
        '-e', 'http_proxy=' + proxy, '-e', 'https_proxy=' + proxy,
        '-e', 'NO_PROXY=localhost,127.0.0.1',
        '-e', 'DESKTOP_TOKEN=' + TOKEN,
        '-e', 'DESKTOP_PORT=' + str(PC_PORT),
        PC_IMAGE,
        timeout=60,
    )
    if result.returncode != 0:
        return {'ok': False, 'error': 'the computer did not start'}
    now = time.time()
    with _PCS_LOCK:
        _PCS[identity] = {'startedAt': iso(now), 'lastUsed': now}
    return {'ok': True}


def stop_pc(identity):
    docker('rm', '-f', pc_name(identity))
    network = pc_network(identity)
    docker('network', 'disconnect', '-f', network, EGRESS_PROXY)
    docker('network', 'rm', network)
    with _PCS_LOCK:
        _PCS.pop(identity, None)
    return {'ok': True}


def reap_idle():
    """Stop every computer idle for IDLE_SECONDS. One found running unknown (this service restarted) starts its clock now."""
    now = time.time()
    for identity in running_pcs():
        with _PCS_LOCK:
            known = _PCS.setdefault(identity, {'startedAt': iso(now), 'lastUsed': now})
            idle = now - known['lastUsed'] >= IDLE_SECONDS
        if idle:
            stop_pc(identity)


def reaper():
    while True:
        time.sleep(REAP_SECONDS)
        try:
            reap_idle()
        except Exception:  # noqa: BLE001 - one failed pass must not stop the next ones
            pass


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
        if self.path.startswith('/shells/ensure'):
            query = parse_qs(urlparse(self.path).query)
            identity = str((query.get('identity') or [''])[0]).strip().lower()
            if not IDENTITY.match(identity):
                return self.reply(400, {'error': 'identity must be an email address'})
            try:
                result = ensure_shell(identity)
            except Exception as error:  # noqa: BLE001 - the reason goes back to the caller
                return self.reply(500, {'error': str(error)})
            return self.reply(200 if result.get('ok') is True else 502, result)
        if self.path == '/sessions':
            return self.reply(200, {'sessions': sessions()})
        if self.path == '/pcs':
            return self.reply(200, {'machines': [{'member': who, **pc_state(who)} for who in running_pcs()], 'capacity': capacity()})
        if self.path.startswith('/pcs/state'):
            query = parse_qs(urlparse(self.path).query)
            identity = str((query.get('identity') or [''])[0]).strip().lower()
            if not IDENTITY.match(identity):
                return self.reply(400, {'error': 'identity must be an email address'})
            return self.reply(200, {**pc_state(identity), 'capacity': capacity()})
        return self.reply(404, {'error': 'unknown path'})

    def do_POST(self):
        if not self.authorised():
            return self.reply(403, {'error': 'a machine token is required'})
        try:
            length = int(self.headers.get('content-length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'a JSON body is required'})
        identity = str(body.get('identity', '')).strip().lower()
        if not IDENTITY.match(identity):
            return self.reply(400, {'error': 'identity must be an email address'})
        if self.path == '/browsers/start':
            try:
                result = ensure_browser(identity)
            except subprocess.TimeoutExpired:
                return self.reply(504, {'error': 'the browser agent did not start in time'})
            except Exception as error:  # noqa: BLE001 - the reason goes back to the caller
                return self.reply(500, {'error': str(error)})
            return self.reply(200 if result.get('ok') is True else 502, result)
        if self.path == '/browsers/stop':
            return self.reply(200, stop_browser(identity))
        if self.path == '/desktops/start':
            try:
                result = ensure_desktop(identity)
            except subprocess.TimeoutExpired:
                return self.reply(504, {'error': 'the desktop agent did not start in time'})
            except Exception as error:  # noqa: BLE001 - the reason goes back to the caller
                return self.reply(500, {'error': str(error)})
            return self.reply(200 if result.get('ok') is True else 502, result)
        if self.path == '/desktops/stop':
            return self.reply(200, stop_desktop(identity))
        if self.path == '/pcs/start':
            try:
                result = start_pc(identity)
            except subprocess.TimeoutExpired:
                return self.reply(504, {'error': 'the computer did not start in time'})
            if result.get('busy') is True:
                return self.reply(409, {'busy': True, 'capacity': capacity()})
            if result.get('ok') is not True:
                return self.reply(502, {'error': 'the computer did not start'})
            return self.reply(200, {**pc_state(identity), 'capacity': capacity()})
        if self.path == '/pcs/stop':
            stop_pc(identity)
            return self.reply(200, {**pc_state(identity), 'capacity': capacity()})
        if self.path == '/pcs/touch':
            touch_pc(identity)
            return self.reply(200, {**pc_state(identity), 'capacity': capacity()})
        if self.path != '/capture':
            return self.reply(404, {'error': 'unknown path'})
        url = str(body.get('url', '')).strip()
        if not URL.match(url):
            return self.reply(400, {'error': 'url must start with http:// or https://'})
        blocked = claim(identity)
        if blocked is not None:
            return self.reply(429, {'error': blocked})
        try:
            return self.reply(200, capture(identity, url))
        except subprocess.TimeoutExpired:
            return self.reply(504, {'error': 'the session did not finish within 90 seconds'})
        except Exception as error:  # noqa: BLE001 - the reason goes back to the caller
            return self.reply(500, {'error': str(error)})
        finally:
            release(identity)

    def log_message(self, *_args):
        return


if __name__ == '__main__':
    threading.Thread(target=reaper, daemon=True).start()
    ThreadingHTTPServer((os.environ.get('MACHINES_HOST', '0.0.0.0'), int(os.environ.get('MACHINES_PORT', '8796'))), Handler).serve_forever()
