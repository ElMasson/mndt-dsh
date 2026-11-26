#!/usr/bin/env python3
"""Regenerate the connector insert block from the descriptors on disk.

One descriptor per connector, under /data/mndt/live/connectors/<server>.json:

    { "serverName": "attio", "command": ["npx", "-y", "mcp-remote", "https://..."],
      "envFile": "attio.env", "cwd": "/state/tools",
      "env": {"MCP_REMOTE_CONFIG_DIR": "/state/mcp-auth"},
      "allow": ["search-records", "list-*"], "deny": ["delete-*"] }

The generated composition row runs the command through `sh -lc`, sourcing the
optional env file first, so secrets stay in a protected file and never appear in
the composition. `env` holds non-secret settings only and is written inline.

A descriptor with an `allow` list is wrapped in the read-only proxy
(`mcp-proxy.mjs`): its allow and deny lists are exported after the env file is
sourced, so a secret file can never widen what the descriptor permits. Every
word of the command is shell-quoted. The file is rewritten through the shared
guard (deploy/patchfile.py): only the connector rows are replaced, every other
row is kept, including those the interface writes, and a file or a result that
does not parse is refused without writing anything.
"""
import importlib.util
import json
import os
import re
import shlex
import sys

HOME = os.environ.get('MNDT_HOME', '/data/mndt/live')
PATCH = os.path.join(HOME, 'home/profiles/web/cordis.patch.yml')
DESCRIPTORS = os.path.join(HOME, 'connectors')
# The container sees the state directory mounted as /state: the generated shell
# sources the env file through that path, never the host path.
CONNECTORS_IN_CONTAINER = os.environ.get('MNDT_CONNECTORS_IN_CONTAINER', '/state/connectors')
PROXY_IN_CONTAINER = os.environ.get('MNDT_PROXY_IN_CONTAINER', '/opt/mndt-tools/mcp-proxy.mjs')
BEGIN = '# >>> connecteurs montes par mount-connector'
END = '# <<< connecteurs montes par mount-connector'


SERVER_NAME = re.compile(r'^[a-z][a-z0-9_-]{0,62}$')
ENV_NAME = re.compile(r'^[A-Z_][A-Z0-9_]*$')
FILE_NAME = re.compile(r'^[A-Za-z0-9._-]+$')
PATTERN = re.compile(r'^[A-Za-z0-9_.:-]+\*?$')
MODULE = '@deepseek-ai/dsh-mcp-client'
# Every connector runs under Landlock (the workbench image's landlock-run): it
# reads the system, the image and its tools, writes its temp and the MCP auth
# folder, and reads nothing else: not /state (state.json, the role table, the
# other connectors' secrets), not /proc (the workbench's environment), not
# /run (the machine service's token, the gateway's secret, the shell's launch
# token). What else a connector reads comes from the versioned catalog only
# (its readPaths; gatewaySecret: the gateway's secret, for approvals and
# machine), and only for a descriptor whose command is the catalog's: a
# descriptor that names itself `machine` with another command gets nothing.
# A workbench without the launcher starts no connector.
LANDLOCK_DEFAULT = '/app/native/system/packages/linux-$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/)/bin/landlock-run'
# The workbench image's node, by its path: the proxy that wraps each connector
# never depends on what PATH says when the connector starts.
NODE = '/usr/local/bin/node'
# What a descriptor's `env` may never set (a library to preload, node's or the
# loader's options, the PATH, or anything of mndt's own, Landlock's switch
# included), unless it is the very value the catalog sets for its own command.
FORBIDDEN_ENV = re.compile(r'^(MNDT_|LD_|DYLD_)|^(NODE_OPTIONS|NODE_PATH|PATH|BASH_ENV|ENV)$')
READ_ROOTS = ('/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/app', '/opt/mndt-tools',
              '/dev/null', '/dev/zero', '/dev/urandom', '/dev/random')
WRITE_ROOTS = ('/tmp', '/state/mcp-auth')
GATEWAY_SECRET = '/run/secrets/mndt-gateway'
STATE_PATH = re.compile(r'^/state/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$')


def load_catalog():
    """@returns the versioned catalog beside this renderer (CONNECTOR_CATALOG), or {} when there is none."""
    path = os.environ.get('CONNECTOR_CATALOG') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'catalog.json')
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def catalog_entry(server, command):
    """@returns the catalog's entry for a server, only when the descriptor runs the catalog's own command; else {}."""
    entry = load_catalog().get(server)
    return entry if isinstance(entry, dict) and entry.get('command') == command else {}


def catalog_grants(server, command):
    """@returns (paths a connector may read beyond the roots, whether it reads the gateway's secret):
    the catalog's, only when the descriptor runs the catalog's own command."""
    entry = catalog_entry(server, command)
    if not entry:
        return [], False
    paths = [path for path in (entry.get('readPaths') or []) if isinstance(path, str) and STATE_PATH.match(path)]
    return paths, entry.get('gatewaySecret') is True


def load_patchfile():
    """@returns the shared patch-file guard (deploy/patchfile.py), from beside this script or one folder up."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.environ.get('MNDT_PATCHFILE'), os.path.join(here, 'patchfile.py'), os.path.join(here, '..', 'patchfile.py')):
        if candidate and os.path.isfile(candidate):
            spec = importlib.util.spec_from_file_location('mndt_patchfile', candidate)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise RuntimeError('patchfile.py introuvable: le copier a cote de ce script (deploy/patchfile.py), ou nommer son chemin dans MNDT_PATCHFILE')


def patterns(value, field, server):
    """@returns a validated pattern list, or raises naming the descriptor."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and PATTERN.match(item) for item in value):
        raise ValueError(f'{server}: {field} must be a list of tool names or prefixes ending with *')
    return value


def script_for(data, server):
    """Build the `sh -lc` script of one descriptor.

    @param data - the descriptor.
    @param server - its server name, for error messages.
    @returns the script text.
    """
    command = data.get('command') or []
    if not isinstance(command, list) or not all(isinstance(word, str) for word in command):
        raise ValueError(f'{server}: command must be a list of strings')
    env_file = data.get('envFile')
    cwd = data.get('cwd')
    env = data.get('env') or {}
    allow = patterns(data.get('allow'), 'allow', server)
    deny = patterns(data.get('deny'), 'deny', server)
    if 'deny' in data and not allow:
        raise ValueError(f'{server}: a deny list needs an allow list')
    script = ''
    if env_file:
        if not FILE_NAME.match(env_file):
            raise ValueError(f'{server}: envFile must be a bare file name')
        path = shlex.quote(f'{CONNECTORS_IN_CONTAINER}/{env_file}')
        script += f'if [ -f {path} ]; then set -a; . {path}; set +a; fi; '
    if not isinstance(env, dict):
        raise ValueError(f'{server}: env must be an object')
    catalog_env = catalog_entry(server, command).get('env') or {}
    for key, value in env.items():
        if not ENV_NAME.match(key) or key.startswith('MCP_PROXY_'):
            raise ValueError(f'{server}: env key {key} is not allowed')
        if FORBIDDEN_ENV.match(key) and (key in ('MNDT_CONNECTOR_LANDLOCK', 'MNDT_LANDLOCK_RUN') or catalog_env.get(key) != value):
            raise ValueError(f'{server}: env key {key} is not allowed in a descriptor (only the catalog sets it, for its own command)')
        script += f'export {key}={shlex.quote(str(value))}; '
    if cwd:
        script += f'cd {shlex.quote(cwd)}; '
    words = [shlex.quote(word) for word in command]
    if allow:
        script += f'export MCP_PROXY_ALLOW={shlex.quote(",".join(allow))}; '
        script += f'export MCP_PROXY_DENY={shlex.quote(",".join(deny))}; '
        words = [shlex.quote(NODE), shlex.quote(PROXY_IN_CONTAINER)] + words
    return script + confined(*catalog_grants(server, command)) + ' '.join(words)


def confined(paths, gateway):
    """@param paths - what the connector reads beyond the roots (its catalog readPaths).
    @param gateway - whether it reads the gateway's secret (its catalog says so).
    @returns the shell that ends a connector's script: its Landlock grants (the
    paths that exist), then `exec` of the launcher, which runs the command after
    `--`. Decided here, when the block is rendered, never by the connector's own
    environment (its env file is sourced before, and could say anything):
    MNDT_CONNECTOR_LANDLOCK=off at render time (a workstation without the image)
    renders the command as it is; MNDT_LANDLOCK_RUN at render time names another
    launcher (tests). A missing launcher refuses the connector, said on stderr."""
    if os.environ.get('MNDT_CONNECTOR_LANDLOCK') == 'off':
        return 'exec '
    launcher = os.environ.get('MNDT_LANDLOCK_RUN')
    reads = list(READ_ROOTS) + list(paths) + ([GATEWAY_SECRET] if gateway else [])
    grants = ' '.join(shlex.quote(path) for path in reads)
    writes = ' '.join(shlex.quote(path) for path in WRITE_ROOTS)
    return (
        'L=' + (shlex.quote(launcher) if launcher else LANDLOCK_DEFAULT) + '; '
        '[ -x "$L" ] || { echo "connector refused: no landlock-run at $L" >&2; exit 126; }; '
        f'set --; for p in {grants}; do [ -e "$p" ] && set -- "$@" --ro "$p"; done; '
        f'for p in {writes}; do [ -e "$p" ] && set -- "$@" --rw "$p"; done; '
        'exec "$L" "$@" -- '
    )


def load_descriptors():
    if not os.path.isdir(DESCRIPTORS):
        return []
    rows = []
    for name in sorted(os.listdir(DESCRIPTORS)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(DESCRIPTORS, name), encoding='utf-8') as handle:
            data = json.load(handle)
        server = data.get('serverName') or os.path.splitext(name)[0]
        # Tool names read mcp__<server>__<tool>: a server named with `__`, or ending
        # with `_`, would make the split ambiguous, so the allow-list could read a
        # tool of `approvals__x` as one of `approvals`.
        if not SERVER_NAME.match(server) or '__' in server or server.endswith('_'):
            raise ValueError(f'{name}: serverName {server!r} is not a lowercase identifier without `__` nor a final `_`')
        if not data.get('command'):
            continue
        rows.append({
            'id': f'mcp-{server}',
            'name': MODULE,
            'config': {
                'serverName': server,
                'transport': 'stdio',
                'command': 'sh',
                'args': ['-lc', script_for(data, server)],
            },
        })
    return rows


def render(rows):
    """@returns the connector rows as a block array, without the markers."""
    lines = []
    for row in rows:
        lines.append('- insert:')
        lines.append(f"    - id: {row['id']}")
        lines.append(f"      name: '{row['name']}'")
        lines.append('      config:')
        for key, value in row['config'].items():
            if key == 'args':
                lines.append('        args:')
                for arg in value:
                    lines.append(f"          - {json.dumps(arg)}")
            else:
                lines.append(f'        {key}: {json.dumps(value)}')
    return '\n'.join(lines) + '\n' if lines else ''


def main():
    rows = load_descriptors()
    try:
        guard = load_patchfile()
    except RuntimeError as error:
        sys.stderr.write(f'render-connectors: refus: {error}\n')
        return 1
    try:
        # Every insert list of MCP clients is this renderer's, marked or not: a
        # hand-added one from an earlier attempt would mount the same server twice.
        notes = guard.update(PATCH, BEGIN, END, render(rows), insert_name=MODULE)
    except guard.PatchFileError as error:
        sys.stderr.write(f'render-connectors: refus: {error}\n')
        return 1
    for note in notes:
        print('patch:', note)
    print(f'connecteurs actifs: {len(rows)}')
    for row in rows:
        print(' -', row['config']['serverName'])
    if not rows:
        print('aucun descripteur dans', DESCRIPTORS)


if __name__ == '__main__':
    sys.exit(main())
