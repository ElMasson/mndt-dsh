#!/usr/bin/env python3
"""Write the sign-on proxy's list of who may sign in, from the tenant's roles.

oauth2-proxy admits an address that is in `authenticated_emails_file` OR whose
domain is in `email_domains`: a domain list alone lets every account of the
directory in. The tenant's oauth2.cfg therefore names only this file, and this
script writes it from grants.json: every subject, lowercase, plain ASCII, and
within the allowed domains (the domains stay a second lock, never a way in).

    render-authenticated-emails.py <grants.json> <output file> <domain[,domain...]>

The output is replaced atomically (mode 644: addresses, no secret). A role
table that cannot be read, or that would leave nobody, changes nothing and
exits 1: the last good list stays.
"""
import json
import os
import re
import sys
import tempfile

ADDRESS = re.compile(r'^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$')


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print('usage: render-authenticated-emails.py <grants.json> <output file> <domain[,domain...]>', file=sys.stderr)
        return 2
    grants_path, output, domains_arg = argv[1], argv[2], argv[3]
    domains = {domain.strip().lower() for domain in domains_arg.split(',') if domain.strip()}
    try:
        with open(grants_path, encoding='utf-8') as handle:
            table = json.load(handle)
    except (OSError, ValueError) as error:
        print(f'refused: cannot read {grants_path}: {error}; the sign-in list is unchanged', file=sys.stderr)
        return 1
    rows = table.get('grants') if isinstance(table, dict) else None
    if not isinstance(rows, list):
        print(f'refused: {grants_path} has no "grants" list; the sign-in list is unchanged', file=sys.stderr)
        return 1
    admitted: list[str] = []
    for row in rows:
        subject = row.get('subject') if isinstance(row, dict) else None
        if not isinstance(subject, str):
            continue
        address = subject.strip()
        # Plain ASCII only, before lower-casing: lower() folds a few Unicode
        # characters onto ASCII ones (the Kelvin sign onto k), as #64 refuses.
        if not address.isascii():
            print(f'skipped: {subject!r} is not a plain ASCII address', file=sys.stderr)
            continue
        address = address.lower()
        if not ADDRESS.match(address):
            print(f'skipped: {subject!r} is not an address', file=sys.stderr)
            continue
        if address.rsplit('@', 1)[1] not in domains:
            print(f'skipped: {address} is outside {",".join(sorted(domains))}', file=sys.stderr)
            continue
        if address not in admitted:
            admitted.append(address)
    if not admitted:
        print('refused: nobody would be allowed to sign in; the sign-in list is unchanged', file=sys.stderr)
        return 1
    folder = os.path.dirname(os.path.abspath(output))
    fd, temporary = tempfile.mkstemp(dir=folder, prefix='.authenticated_emails.')
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(''.join(f'{address}\n' for address in admitted))
    os.chmod(temporary, 0o644)
    os.replace(temporary, output)
    print(f'sign-in list: {len(admitted)} address(es) in {output}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
