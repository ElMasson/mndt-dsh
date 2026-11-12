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
word of the command is shell-quoted. Only the block between the two markers is
rewritten: a person's own patch rows are preserved.
"""
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
            'name': '@deepseek-ai/dsh-mcp-client',
            'config': {
                'serverName': server,
                'transport': 'stdio',
                'command': 'sh',
                'args': ['-lc', script_for(data, server)],
            },
        })
    return rows


def render(rows):
    if not rows:
        return ''
    lines = [BEGIN]
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
    lines.append(END)
    return '\n'.join(lines) + '\n'


def strip_managed(text):
    """Drop every insert block that mounts an MCP client, marked or legacy.

    The renderer is the only writer of these blocks. A hand-added block from an
    earlier attempt must not survive next to a generated one, otherwise the same
    server is mounted twice.
    """
    blocks = []
    current = []
    for line in text.splitlines(keepends=True):
        if line.startswith('- ') and current:
            blocks.append(''.join(current))
            current = []
        current.append(line)
    if current:
        blocks.append(''.join(current))
    kept = [block for block in blocks if '@deepseek-ai/dsh-mcp-client' not in block]
    # The markers ride on whichever block precedes them; drop them so they never
    # pile up between renders.
    text = ''.join(kept)
    return ''.join(line for line in text.splitlines(keepends=True) if line.rstrip('\n') not in (BEGIN, END))


def main():
    rows = load_descriptors()
    block = render(rows)
    text = open(PATCH, encoding='utf-8').read() if os.path.exists(PATCH) else ''
    text = strip_managed(text)
    text = text.rstrip() + '\n'
    if block:
        text += block
    with open(PATCH, 'w', encoding='utf-8') as handle:
        handle.write(text)
    print(f'connecteurs actifs: {len(rows)}')
    for row in rows:
        print(' -', row['config']['serverName'])
    if not rows:
        print('aucun descripteur dans', DESCRIPTORS)


if __name__ == '__main__':
    sys.exit(main())
