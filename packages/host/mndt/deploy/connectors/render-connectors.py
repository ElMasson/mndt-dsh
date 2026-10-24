#!/usr/bin/env python3
"""Regenerate the connector insert block from the descriptors on disk.

One descriptor per connector, under /data/mndt/live/connectors/<server>.json:

    { "serverName": "attio", "command": ["npx", "-y", "mcp-remote", "https://..."],
      "envFile": "attio.env", "cwd": "/state/tools" }

The generated composition row runs the command through `sh -lc`, sourcing the
optional env file first, so secrets stay in a protected file and never appear in
the composition. Only the block between the two markers is rewritten: a person's
own patch rows are preserved.
"""
import json
import os
import sys

HOME = os.environ.get('MNDT_HOME', '/data/mndt/live')
PATCH = os.path.join(HOME, 'home/profiles/web/cordis.patch.yml')
DESCRIPTORS = os.path.join(HOME, 'connectors')
# The container sees the state directory mounted as /state: the generated shell
# sources the env file through that path, never the host path.
CONNECTORS_IN_CONTAINER = os.environ.get('MNDT_CONNECTORS_IN_CONTAINER', '/state/connectors')
BEGIN = '# >>> connecteurs montes par mount-connector'
END = '# <<< connecteurs montes par mount-connector'


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
        command = data.get('command') or []
        if not command:
            continue
        env_file = data.get('envFile')
        cwd = data.get('cwd')
        script = ''
        if env_file:
            script += f'if [ -f {CONNECTORS_IN_CONTAINER}/{env_file} ]; then set -a; . {CONNECTORS_IN_CONTAINER}/{env_file}; set +a; fi; '
        if cwd:
            script += f'cd {cwd}; '
        script += 'exec ' + ' '.join(command)
        rows.append({
            'id': f'mcp-{server}',
            'name': '@deepseek-ai/dsh-mcp-client',
            'config': {
                'serverName': server,
                'transport': 'stdio',
                'command': 'sh',
                'args': ['-lc', script],
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
    return ''.join(kept)


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
