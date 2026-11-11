"""Select Office/PDF deliverables by explicit handoff, never directory discovery."""

import re

from .paths import DOCUMENTS, MEDIA, resolve_path, shown_paths

_DRAFT = re.compile(r"(?:草稿|待核对稿?|初稿|中间稿|未完成|备份)$|(?:^|[-_. ()])(?:draft|preview|working|backup)(?:$|[-_. ()0-9])", re.I)
_WORK_DIRS = {"draft", "drafts", "preview", "previews", "recovery", "intermediate", "草稿", "待核对"}


def is_office(path):
    return path.suffix.lower().lstrip('.') in DOCUMENTS


def blocked(turn, paths, text, cwd, returned=(), candidates=()):
    """A model's prose mention of an old file is not a handoff declaration."""
    handed = shown_paths(text, cwd) | set(turn.native_finals.values()) | set(returned)
    handed |= {path for m in MEDIA.finditer(text)
               if (path := resolve_path(m.group('path'), cwd)) is not None}
    # A requested output path is evidence only after existing freshness/ownership checks.
    handed |= turn.declared - turn.uploads
    rejected = set()
    for path in paths:
        if not is_office(path):
            continue
        parts = path.relative_to(turn.cwd).parts if path.is_relative_to(turn.cwd) else (path.name,)
        draft = bool(_DRAFT.search(path.stem)) or any(p.lower() in _WORK_DIRS for p in parts[:-1]
            if not (turn.wants_pdf and path.suffix.lower() == '.pdf' and p.lower() in {'preview', 'previews'}))
        if draft:
            rejected.add(path)
    # Keep the existing single-file handoff when there is no version ambiguity.
    # Multiple discoveries need explicit selection; never pick by mtime or filename version.
    available = {p for p in candidates if is_office(p) and p not in rejected}
    if not any(is_office(p) for p in handed) and len(available) == 1:
        handed.update(available)
    rejected.update(p for p in paths if is_office(p) and p not in handed)
    return rejected


def suppress_cards(text, cwd, rejected):
    """Keep explanatory prose while removing rejected download/preview directives."""
    from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE

    def plain(match):
        return match.group(1) if shown_paths(match.group(), cwd) & rejected else match.group()

    text = re.sub(r"(?<!!)\[([^\]\n]*)\]\([^\n)]*\)", plain, text)
    text = re.sub(r"::preview\{[^}\n]*\}", lambda m: '' if shown_paths(m.group(), cwd) & rejected else m.group(), text)
    return MEDIA_TAG_CLEANUP_RE.sub(lambda m: '' if shown_paths(m.group(), cwd) & rejected else m.group(), text)
