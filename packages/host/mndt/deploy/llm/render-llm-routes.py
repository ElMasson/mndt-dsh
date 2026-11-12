#!/usr/bin/env python3
"""Write the workbench LLM routes into the home patch of the Harness.

    render-llm-routes.py [--env-file /data/mndt/live/model.env] [--print]

The template (routes.patch.yml.template) declares the pi-ai routes
`scaleway-genapi` and `vllm-qwen`. Its ${VAR} placeholders are non-secret
values (project id, vLLM address, served model id); they come from the
environment, or from the named env file, where only those names are read.
Keys never pass through here: the routes name them by apiKeyEnv.

The block lands between two markers in <MNDT_HOME>/home/cordis.patch.yml (the
home patch layer, applied after the profile patch), so a rerun replaces it and
every other row of the file is kept. --print writes the block to stdout only.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, 'routes.patch.yml.template')
HOME = os.environ.get('MNDT_HOME', '/data/mndt/live')
PATCH = os.environ.get('MNDT_HOME_PATCH', os.path.join(HOME, 'home', 'cordis.patch.yml'))
BEGIN = '# >>> routes LLM rendues par render-llm-routes'
END = '# <<< routes LLM rendues par render-llm-routes'

# Each placeholder and the shape its value must have: a value that would change
# the YAML structure or point somewhere unexpected is refused.
CHECKS = {
    'SCW_PROJECT_ID': re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    'VLLM_QWEN_BASE_URL': re.compile(r'^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$'),
    'VLLM_QWEN_MODEL': re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$'),
}
DEFAULTS = {'VLLM_QWEN_BASE_URL': 'http://51.159.151.86:8000/v1'}


def read_env_file(path):
    """@returns the placeholder values found in an env file, and nothing else."""
    values = {}
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip().removeprefix('export ').strip()
            if key in CHECKS:
                values[key] = value.strip().strip('"').strip("'")
    return values


def substitute(template, values):
    """@returns the template with every placeholder replaced, or raises naming the missing ones."""
    problems = []
    for key, pattern in CHECKS.items():
        value = values.get(key, '')
        if value == '':
            problems.append(f'{key} manquant')
        elif not pattern.match(value):
            problems.append(f'{key} invalide')
    if problems:
        raise ValueError(', '.join(problems))
    text = template
    for key in CHECKS:
        text = text.replace('${' + key + '}', values[key])
    rows = [line for line in text.splitlines() if not line.lstrip().startswith('#')]
    left = re.findall(r'\$\{[A-Z_]+\}', '\n'.join(rows))
    if left:
        raise ValueError('placeholders sans valeur: ' + ', '.join(sorted(set(left))))
    return text


def block(text):
    """@returns the rendered rows wrapped in the markers, comments dropped."""
    rows = [line for line in text.splitlines() if line.strip() != '' and not line.lstrip().startswith('#')]
    return '\n'.join([BEGIN, *rows, END]) + '\n'


def strip_block(text):
    """@returns the patch text without a previous rendered block."""
    if BEGIN not in text:
        return text
    head, _, rest = text.partition(BEGIN)
    _, _, tail = rest.partition(END)
    return head.rstrip() + '\n' + tail.lstrip('\n')


def main(argv):
    values = dict(DEFAULTS)
    if '--env-file' in argv:
        values.update(read_env_file(argv[argv.index('--env-file') + 1]))
    for key in CHECKS:
        if os.environ.get(key):
            values[key] = os.environ[key]
    with open(TEMPLATE, encoding='utf-8') as handle:
        rendered = block(substitute(handle.read(), values))
    if '--print' in argv:
        sys.stdout.write(rendered)
        return 0
    current = open(PATCH, encoding='utf-8').read() if os.path.exists(PATCH) else ''
    text = strip_block(current).strip()
    text = (text + '\n' if text else '') + rendered
    os.makedirs(os.path.dirname(PATCH), exist_ok=True)
    with open(PATCH, 'w', encoding='utf-8') as handle:
        handle.write(text)
    print('routes LLM ecrites dans', PATCH)
    print(' - scaleway-genapi: deepseek-v4.1-flash, glm-5.3')
    print(' - vllm-qwen:', values['VLLM_QWEN_MODEL'])
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as error:
        sys.stderr.write(f'render-llm-routes: {error}\n')
        sys.exit(1)
