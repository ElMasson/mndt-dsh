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
    for key, value in env.items():
        if not ENV_NAME.match(key) or key.startswith('MCP_PROXY_'):
            raise ValueError(f'{server}: env key {key} is not allowed')
        script += f'export {key}={shlex.quote(str(value))}; '
    if cwd:
        script += f'cd {shlex.quote(cwd)}; '
    words = [shlex.quote(word) for word in command]
    if allow:
        script += f'export MCP_PROXY_ALLOW={shlex.quote(",".join(allow))}; '
        script += f'export MCP_PROXY_DENY={shlex.quote(",".join(deny))}; '
        words = ['node', shlex.quote(PROXY_IN_CONTAINER)] + words
    return script + 'exec ' + ' '.join(words)


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
        if not SERVER_NAME.match(server):
            raise ValueError(f'{name}: serverName {server!r} is not a lowercase identifier')
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
