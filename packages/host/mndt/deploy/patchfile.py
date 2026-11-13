#!/usr/bin/env python3
"""The one guarded writer of a dsh patch file (cordis.patch.yml).

Several writers share these files: dsh creates them (three comment lines, then
`[]`), the interface edits rows in place (`- id: <plugin>` with `config` or
`disabled`), and the deployment scripts each own one block between two marker
comments. A writer that appends text blindly leaves `[]` followed by a block
sequence: invalid YAML, and a workbench that no longer starts.

Every deployment writer goes through `update()`:

    patchfile.py <file> --begin '<marker>' --end '<marker>' \
        [--ids a,b*] [--insert-name <module>] [--block-file <f>]   # block on stdin otherwise
    patchfile.py <file> --check

It reads the file in whatever state it is (absent, comments only, `[]`, a flow
or block array, an earlier block between the markers, the `[]`-then-block
breakage), removes the caller's own rows only, puts the caller's block back
between its markers, and leaves one valid top-level array. Every other row is
kept as the text it was: comments, key order and `!!js` expressions are never
re-serialised. The result is parsed again and compared row by row with what was
meant to be kept before an atomic write (temporary file, then rename). When the
file or the result does not parse, or the rewrite cannot be proven safe, nothing
is written and the reason is given.

A row is the caller's own when it sits between the caller's markers and carries
one of the caller's ids (the ids of the new block, plus `--ids` patterns for
retired ones), or, anywhere in the file, when it is an `insert` list whose rows
all name the `--insert-name` module. A row the interface added between the
markers is therefore kept.
"""
import fnmatch
import os
import re
import sys
import tempfile

try:
    import yaml
except ImportError:  # reported as a refusal by update(), never as a traceback
    yaml = None

EMPTY_FLOW_LINE = re.compile(r'^\[\s*\]\s*(#.*)?$')


class PatchFileError(Exception):
    """A refusal: the file is left as it was, the message says why."""


def _compose(text, what):
    """@returns the root node of a YAML text, or None when it holds no document."""
    try:
        return yaml.compose(text)
    except yaml.YAMLError as error:
        raise PatchFileError(f'{what} ne se parse pas: {" ".join(str(error).split())}') from error


def _canonical(node, what, depth=0):
    """@returns a comparable form of a node: tags and values, no positions.

    Refuses what the dsh loader refuses and PyYAML lets through: a mapping with
    the same key twice.
    """
    if depth > 200:
        raise PatchFileError(f'{what}: structure trop profonde ou cyclique')
    if isinstance(node, yaml.ScalarNode):
        return ('scalar', node.tag, node.value)
    if isinstance(node, yaml.SequenceNode):
        return ('seq', node.tag, tuple(_canonical(item, what, depth + 1) for item in node.value))
    pairs = tuple((_canonical(key, what, depth + 1), _canonical(value, what, depth + 1)) for key, value in node.value)
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise PatchFileError(f'{what}: une cle est repetee dans un meme mapping')
    return ('map', node.tag, pairs)


def _field(node, name):
    """@returns the value node of a mapping key, or None."""
    for key, value in node.value:
        if isinstance(key, yaml.ScalarNode) and key.value == name:
            return value
    return None


def _scalar(node, name):
    value = _field(node, name)
    return value.value if isinstance(value, yaml.ScalarNode) else None


def _insert_rows(node):
    """@returns the mapping rows of an entry's `insert` list, or None without a usable one."""
    insert = _field(node, 'insert')
    if not isinstance(insert, yaml.SequenceNode) or not insert.value:
        return None
    if not all(isinstance(row, yaml.MappingNode) for row in insert.value):
        return None
    return insert.value


def _entries(text, what):
    """Parse a patch text into its top-level entries.

    @returns (root, entries) where root is None for a text without a document.
    """
    root = _compose(text, what)
    if root is None:
        return None, []
    if not isinstance(root, yaml.SequenceNode):
        raise PatchFileError(f'{what} doit etre un tableau YAML de premier niveau')
    for index, item in enumerate(root.value):
        if not isinstance(item, yaml.MappingNode):
            raise PatchFileError(f'{what}: l entree {index + 1} n est pas un mapping')
        _canonical(item, what)
    return root, root.value


def _unflow(text, root):
    """Rewrite a top-level flow array as block rows, each row's own text kept."""
    rows = ['- ' + text[item.start_mark.index:item.end_mark.index] for item in root.value]
    head, tail = text[:root.start_mark.index], text[root.end_mark.index:]
    if rows:
        return head + '\n'.join(rows) + tail
    # An empty `[]`: drop it, and its line when nothing else stands on it.
    line_start = head.rfind('\n') + 1
    line_end = tail.find('\n')
    rest = tail if line_end == -1 else tail[:line_end]
    if head[line_start:].strip() == '' and rest.strip() == '':
        return head[:line_start] + ('' if line_end == -1 else tail[line_end + 1:])
    return head + tail


def _normalise(text, what, notes):
    """Bring any readable state of the file to a block array at column 0 (or no document).

    @returns (text, root, entries).
    """
    if text.startswith('﻿'):
        text = text[1:]
    if '\x00' in text:
        raise PatchFileError(f'{what} contient un octet nul')
    if text and not text.endswith('\n'):
        text += '\n'
    try:
        root, entries = _entries(text, what)
    except PatchFileError as error:
        # The known breakage: the `[]` dsh wrote at first start, with block rows
        # appended after it. Dropping that empty array is the whole repair.
        lines = text.splitlines(keepends=True)
        kept = [line for line in lines if not EMPTY_FLOW_LINE.match(line.rstrip('\n'))]
        if len(kept) == len(lines):
            raise
        try:
            root, entries = _entries(''.join(kept), what)
        except PatchFileError:
            raise error from None
        text = ''.join(kept)
        notes.append('tableau vide `[]` suivi de lignes en bloc: repare')
    if root is not None and root.flow_style:
        before = [_canonical(item, what) for item in entries]
        text = _unflow(text, root)
        try:
            root, entries = _entries(text, what)
        except PatchFileError as error:
            raise PatchFileError(f'{what}: tableau en flux impossible a reecrire surement ({error})') from error
        if [_canonical(item, what) for item in entries] != before:
            raise PatchFileError(f'{what}: tableau en flux impossible a reecrire surement')
    if root is not None and root.start_mark.column != 0:
        raise PatchFileError(f'{what}: le tableau de premier niveau est indente, reecriture refusee')
    return text, root, entries


def _spans(text, count, what):
    """@returns the (first line, last line) of each top-level row, from the token stream."""
    dashes = []
    last = []
    depth = 0
    for token in yaml.scan(text):
        if isinstance(token, (yaml.FlowSequenceStartToken, yaml.FlowMappingStartToken)):
            depth += 1
        elif isinstance(token, (yaml.FlowSequenceEndToken, yaml.FlowMappingEndToken)):
            depth -= 1
        if isinstance(token, yaml.BlockEntryToken) and depth == 0 and token.start_mark.column == 0:
            dashes.append(token.start_mark.line)
            last.append(token.end_mark.index)
        elif dashes and isinstance(token, (
            yaml.ScalarToken, yaml.AliasToken, yaml.AnchorToken, yaml.TagToken,
            yaml.FlowSequenceEndToken, yaml.FlowMappingEndToken,
        )):
            last[-1] = max(last[-1], token.end_mark.index)
    if len(dashes) != count:
        raise PatchFileError(f'{what}: lignes de premier niveau introuvables, reecriture refusee')
    # A block scalar ends after its newline: the last content character is one before.
    return [(first, text.count('\n', 0, max(end - 1, 0))) for first, end in zip(dashes, last)]


def _marker_ranges(lines, begin, end):
    """@returns (marker line numbers, [(first, last)] line ranges the markers enclose).

    Tolerant on purpose: an opening marker without its closing one runs to the
    next opening marker or to the end. Ownership still needs one of the caller's
    ids, so a wide range never removes somebody else's row.
    """
    markers = set()
    ranges = []
    opened = None
    for number, line in enumerate(lines):
        stripped = line.strip()
        if stripped == begin:
            if opened is not None:
                ranges.append((opened, number))
            opened = number
            markers.add(number)
        elif stripped == end:
            if opened is not None:
                ranges.append((opened, number))
                opened = None
            markers.add(number)
    if opened is not None:
        ranges.append((opened, len(lines)))
    return markers, ranges


def _ids(entries):
    """@returns (top-level ids, inserted ids) of a list of entries."""
    top = set()
    inserted = set()
    for item in entries:
        rows = _insert_rows(item)
        if rows is None:
            if _scalar(item, 'id') is not None:
                top.add(_scalar(item, 'id'))
        else:
            inserted.update(_scalar(row, 'id') for row in rows if _scalar(row, 'id') is not None)
    return top, inserted


def rewrite(text, begin, end, block, ids=(), insert_name=None):
    """Compute the new text of a patch file. Pure: nothing is read or written.

    @param text - the current text ('' for an absent file).
    @param begin - the caller's opening marker, a whole comment line.
    @param end - the caller's closing marker.
    @param block - the caller's rows, a block array at column 0 without the markers; '' removes the block.
    @param ids - id patterns (fnmatch) the caller also owns between its markers, for rows it no longer writes.
    @param insert_name - a module name: an insert list whose rows all name it is the caller's, anywhere.
    @returns (new text, notes).
    @throws PatchFileError when the text or the result does not parse, or the rewrite is not provably safe.
    """
    if yaml is None:
        raise PatchFileError('PyYAML est requis (paquet python3-yaml)')
    for marker in (begin, end):
        if not marker.startswith('#') or '\n' in marker or marker != marker.strip():
            raise PatchFileError('un marqueur doit etre une ligne de commentaire entiere')
    if begin == end:
        raise PatchFileError('les deux marqueurs doivent differer')
    notes = []
    text, _, entries = _normalise(text, 'le fichier de patch', notes)

    block = '\n'.join(line for line in block.splitlines() if line.strip() != '')
    block = block + '\n' if block else ''
    block_root, block_entries = _entries(block, 'le bloc a ecrire')
    if block_root is not None and (block_root.flow_style or block_root.start_mark.column != 0):
        raise PatchFileError('le bloc a ecrire doit etre un tableau en bloc, a la colonne 0')
    if any(line.strip() in (begin, end) for line in block.splitlines()):
        raise PatchFileError('le bloc a ecrire ne doit pas contenir les marqueurs')
    block_top, block_inserted = _ids(block_entries)
    patterns = [*block_top, *block_inserted, *ids]

    def owned_id(value):
        return value is not None and any(fnmatch.fnmatchcase(value, pattern) for pattern in patterns)

    lines = text.splitlines(keepends=True)
    spans = _spans(text, len(entries), 'le fichier de patch')
    markers, ranges = _marker_ranges(lines, begin, end)

    def own(item, first):
        rows = _insert_rows(item)
        if insert_name is not None and rows is not None and all(_scalar(row, 'name') == insert_name for row in rows):
            return True
        if not any(low < first < high for low, high in ranges):
            return False
        if rows is not None:
            return all(owned_id(_scalar(row, 'id')) for row in rows)
        return owned_id(_scalar(item, 'id'))

    dropped = set(markers)
    kept = []
    owner = {}  # line number -> whether the row covering it is the caller's
    for item, (first, last) in zip(entries, spans):
        mine = own(item, first)
        owner.update((number, mine) for number in range(first, last + 1))
        if mine:
            dropped.update(range(first, last + 1))
        else:
            kept.append((first, item))
    # The comments of the caller's block go with it, or they would pile up on
    # each run: between the markers, a run of comment lines belongs to the row
    # below it, and to the row above it when it closes the block.
    for low, high in ranges:
        run = []
        above = None
        for number in range(low + 1, min(high, len(lines)) + 1):
            if number < min(high, len(lines)) and number not in owner:
                run.append(number)
                continue
            below = owner.get(number) if number < min(high, len(lines)) else None
            if below is True or (below is None and above is not False):
                dropped.update(run)
            run = []
            above = below
    _, kept_inserted = _ids([item for _, item in kept])
    clash = sorted(block_inserted & kept_inserted)
    if clash:
        raise PatchFileError(
            'une ligne insert etrangere porte deja ' + ', '.join(clash) + ': la retirer a la main avant de relancer')

    position = min(markers) if markers else len(lines)
    out = [line for number, line in enumerate(lines[:position]) if number not in dropped]
    if out and not out[-1].endswith('\n'):
        out[-1] += '\n'
    if block:
        out += [begin + '\n', block, end + '\n']
    out += [line for number, line in enumerate(lines[position:], start=position) if number not in dropped]
    if not kept and not block_entries:
        # dsh refuses a patch file that is not an array: comments alone are not one.
        out.append('[]\n')
    result = ''.join(out)

    expected = [_canonical(item, 'le fichier de patch') for first, item in kept if first < position]
    expected += [_canonical(item, 'le bloc a ecrire') for item in block_entries]
    expected += [_canonical(item, 'le fichier de patch') for first, item in kept if first > position]
    root, written = _entries(result, 'le resultat')
    if root is None:
        raise PatchFileError('le resultat ne serait pas un tableau YAML')
    if [_canonical(item, 'le resultat') for item in written] != expected:
        raise PatchFileError('le resultat ne conserve pas exactement les autres lignes, reecriture refusee')
    return result, notes


def check(path):
    """@returns the number of entries of a patch file dsh would accept, or raises PatchFileError."""
    if yaml is None:
        raise PatchFileError('PyYAML est requis (paquet python3-yaml)')
    with open(path, encoding='utf-8') as handle:
        text = handle.read()
    root, entries = _entries(text, path)
    if root is None:
        raise PatchFileError(f'{path} doit etre un tableau YAML de premier niveau')
    return len(entries)


def update(path, begin, end, block, ids=(), insert_name=None):
    """Rewrite a patch file through the guard, atomically.

    @param path - the patch file; created (with its folder) when absent.
    @returns the notes of the rewrite (repairs made).
    @throws PatchFileError on any refusal; the file is then exactly as it was.
    """
    try:
        with open(path, encoding='utf-8') as handle:
            current = handle.read()
        stat = os.stat(path)
    except FileNotFoundError:
        current, stat = None, None
    except (OSError, UnicodeDecodeError) as error:
        raise PatchFileError(f'{path} est illisible: {error}') from error
    try:
        result, notes = rewrite(current or '', begin, end, block, ids, insert_name)
    except PatchFileError as error:
        raise PatchFileError(f'{error}; {path} n a pas ete modifie') from error
    if result == current:
        return notes
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.cordis.patch.', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            stream.write(result)
            stream.flush()
            os.fsync(stream.fileno())
        if stat is None:
            # A new file takes the mode a plain `open(path, 'w')` would have given it.
            umask = os.umask(0)
            os.umask(umask)
            os.chmod(temporary, 0o666 & ~umask)
        else:
            os.chmod(temporary, stat.st_mode & 0o7777)
            try:
                os.chown(temporary, stat.st_uid, stat.st_gid)
            except OSError:
                pass
        # The interface writes this file too: give up when it changed meanwhile.
        try:
            with open(path, encoding='utf-8') as again:
                latest = again.read()
        except FileNotFoundError:
            latest = None
        if latest != current:
            raise PatchFileError(f'{path} a change pendant la reecriture, relancer; rien n a ete ecrit')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return notes


def main(argv):
    options = {'--begin': None, '--end': None, '--ids': '', '--insert-name': None, '--block-file': None}
    paths = []
    only_check = False
    index = 0
    while index < len(argv):
        word = argv[index]
        if word == '--check':
            only_check = True
        elif word in options:
            if index + 1 >= len(argv):
                raise PatchFileError(f'{word} attend une valeur')
            options[word] = argv[index + 1]
            index += 1
        else:
            paths.append(word)
        index += 1
    if len(paths) != 1:
        sys.stderr.write(
            "usage: patchfile.py <file> --begin '<marker>' --end '<marker>' [--ids a,b*] "
            '[--insert-name <module>] [--block-file <f>]\n       patchfile.py <file> --check\n')
        return 2
    path = paths[0]
    if only_check:
        print(f'{path}: tableau valide, {check(path)} entree(s)')
        return 0
    if options['--begin'] is None or options['--end'] is None:
        raise PatchFileError('--begin et --end sont requis')
    if options['--block-file'] is not None:
        with open(options['--block-file'], encoding='utf-8') as handle:
            block = handle.read()
    else:
        block = sys.stdin.read()
    ids = [item.strip() for item in options['--ids'].split(',') if item.strip()]
    for note in update(path, options['--begin'], options['--end'], block, ids, options['--insert-name']):
        print(f'patchfile: {note}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except PatchFileError as error:
        sys.stderr.write(f'patchfile: refus: {error}\n')
        sys.exit(1)
    except OSError as error:
        sys.stderr.write(f'patchfile: refus: {error}\n')
        sys.exit(1)
