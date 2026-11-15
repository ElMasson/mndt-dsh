#!/usr/bin/env python3
"""Write the sign-on proxy's list of who may sign in, from the tenant's roles.

oauth2-proxy admits an address that is in `authenticated_emails_file` OR whose
domain is in `email_domains`: a domain list alone lets every account of the
directory in. The tenant's oauth2.cfg therefore names only this file, and this
script writes it from grants.json.

    render-authenticated-emails.py <grants.json> <output file> <domain[,domain...]> --owner <email>

The role table is validated as the product API reads it (src/grants.ts): a
subject is a plain ASCII e-mail, a role is owner, admin, operator or viewer, a
name is one line of 80 characters at most. One invalid row refuses the whole
table, as the API does. Strict on top of that:
- every subject must be an address within the allowed domains (the domains are
  a second lock, never a way in): one outside refuses the list rather than
  dropping that person in silence;
- the owner must be in it: a list without the owner would lock them out.

Any refusal changes nothing and exits 1: the last good list stays. The output
is replaced atomically (a rename: oauth2-proxy v7.15.5 watches the file and
applies the new list without a restart, to existing cookies too), mode 640,
owned by the proxy (65532).

Root is required, checked before anything is written: a list the proxy (65532)
cannot read stops it at its next start, and with `restart: unless-stopped` it
restarts in a loop and nobody signs in, the owner included (measured with the
real binary, sso-test/emails-list.sh). Tests only: MNDT_EMAILS_UNPRIVILEGED=1
writes without the owner change.
"""

import json
import os
import re
import sys
import tempfile

ADDRESS = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")
PRINTABLE = re.compile(r"^[\x21-\x7e]+$")
ROLES = {"owner", "admin", "operator", "viewer"}
PROXY_UID = 65532


def refuse(reason: str) -> int:
    """@param reason - why. @returns the exit code of a refusal, the list unchanged."""
    print(f"refused: {reason}; the sign-in list is unchanged", file=sys.stderr)
    return 1


# What JavaScript's String.prototype.trim removes (WhiteSpace and LineTerminator):
# Python's str.strip differs on U+FEFF (JS removes it) and U+0085 (JS keeps it).
JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def js_trim(value: str) -> str:
    """@param value - a text. @returns it trimmed as the API trims it (JavaScript trim)."""
    return value.strip(JS_TRIM)


def has_lone_surrogate(value: str) -> bool:
    """@param value - a text from JSON. @returns whether it holds a lone surrogate, which no file can encode."""
    return any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def shown_name(value: object) -> bool:
    """As the API's isShownName (src/grants.ts): trimmed, 1 to 80 UTF-16 units,
    no control character nor line/paragraph separator (U+2028, U+2029).
    @param value - a row's name. @returns whether it can be shown as it is."""
    if not isinstance(value, str):
        return False
    if has_lone_surrogate(value):
        return False
    shown = js_trim(value)
    return (
        shown != ""
        and len(shown.encode("utf-16-le")) // 2 <= 80
        and not any(ord(c) < 32 or ord(c) == 127 or c in "\u2028\u2029" for c in value)
    )


def main(argv: list[str]) -> int:
    args = argv[1:]
    owner = ""
    if "--owner" in args:
        at = args.index("--owner")
        owner = js_trim(args[at + 1]) if at + 1 < len(args) else ""
        del args[at : at + 2]
    if len(args) != 3 or owner == "":
        print(
            "usage: render-authenticated-emails.py <grants.json> <output file> <domain[,domain...]> --owner <email>",
            file=sys.stderr,
        )
        return 2
    grants_path, output, domains_arg = args
    # The test switch never applies to root: a forgotten MNDT_EMAILS_UNPRIVILEGED
    # in a root shell would leave the list root:root, unreadable by the proxy.
    unprivileged = os.geteuid() != 0 and os.environ.get("MNDT_EMAILS_UNPRIVILEGED") == "1"
    if os.geteuid() != 0 and not unprivileged:
        return refuse(
            "run as root: the list must belong to the proxy (65532), or the proxy cannot read it and stops at its next start"
        )
    domains = {domain.strip().lower() for domain in domains_arg.split(",") if domain.strip()}
    if not PRINTABLE.match(owner):
        return refuse("the owner is not a plain ASCII e-mail")
    owner = owner.lower()
    try:
        with open(grants_path, encoding="utf-8") as handle:
            table = json.load(handle)
    except (OSError, ValueError) as error:
        return refuse(f"cannot read {grants_path}: {error}")
    rows = table.get("grants") if isinstance(table, dict) else None
    if not isinstance(rows, list):
        return refuse(f'{grants_path} has no "grants" list')
    admitted: list[str] = []
    for index, row in enumerate(rows, start=1):
        subject = row.get("subject") if isinstance(row, dict) else None
        role = row.get("role") if isinstance(row, dict) else None
        if isinstance(subject, str) and has_lone_surrogate(subject):
            return refuse(f"{grants_path}, row {index}: the subject is not valid text")
        if not isinstance(subject, str) or js_trim(subject) == "" or role not in ROLES:
            return refuse(
                f"{grants_path}, row {index}: a subject (e-mail) and a role among owner, admin, operator, viewer are required"
            )
        # Plain ASCII before lower-casing: lower() folds a few Unicode characters
        # onto ASCII ones (the Kelvin sign onto k), as the API refuses (#75).
        if not PRINTABLE.match(js_trim(subject)):
            return refuse(f"{grants_path}, row {index}: the subject is not a plain ASCII e-mail")
        if "name" in row and not shown_name(row["name"]):
            return refuse(
                f"{grants_path}, row {index}: a name is one line of 80 characters at most, without control characters"
            )
        address = js_trim(subject).lower()
        if not ADDRESS.match(address):
            return refuse(f"{grants_path}, row {index}: {address} is not an e-mail address")
        if address.rsplit("@", 1)[1] not in domains:
            return refuse(
                f"{grants_path}, row {index}: {address} is outside {','.join(sorted(domains))}; "
                f"pass --email-domains with EVERY domain of the team, {','.join(sorted(domains))} included, "
                f"and {address.rsplit('@', 1)[1]} if it belongs to the team. Until a run succeeds the proxy "
                "keeps its previous configuration: if that one still names email_domains, the whole "
                "domain can still sign in"
            )
        if address not in admitted:
            admitted.append(address)
    if owner not in admitted:
        return refuse(f"the owner {owner} is not in {grants_path}: the list would lock them out")
    folder = os.path.dirname(os.path.abspath(output))
    fd, temporary = tempfile.mkstemp(dir=folder, prefix=".authenticated_emails.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            # oauth2-proxy reads one address per line; this line matches no address.
            handle.write("# generated from grants.json by render-authenticated-emails.py: never edit by hand\n")
            handle.write("".join(f"{address}\n" for address in admitted))
        os.chmod(temporary, 0o640)
        if not unprivileged:
            os.chown(temporary, PROXY_UID, PROXY_UID)
        os.replace(temporary, output)
        if not unprivileged:
            # Proved, not assumed: a file system that ignores chown would leave a list
            # the proxy cannot read at its next start.
            st = os.stat(output)
            if st.st_uid != PROXY_UID or st.st_gid != PROXY_UID or (st.st_mode & 0o777) != 0o640:
                print(
                    f"refused: {output} is {st.st_uid}:{st.st_gid} {oct(st.st_mode & 0o777)}, not {PROXY_UID}:{PROXY_UID} 0o640; "
                    "the proxy could not read it at its next start: fix it before any restart",
                    file=sys.stderr,
                )
                return 1
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"sign-in list: {len(admitted)} address(es) in {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
