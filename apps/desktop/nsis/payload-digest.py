"""Digest installed payload components the way the build stamped them.

update-plan.ps1 runs this with the payload's own interpreter: ``pm.store``
ships inside the payload, so the installer verifies against the same
``tree_digest`` the build used instead of re-implementing it in PowerShell.
A path that cannot be read reports an empty digest (that component is
replaced), never an error, because one damaged directory must not abandon the
whole plan.

Output is one ``<path>\\t<digest>`` line per path. A tab cannot appear in a
Windows path, so the installer splits each line once and needs no JSON parser
(PowerShell 5.1 hands a top-level JSON array back as a single object).
"""
import hashlib
import os
import sys


def digest(path):
    from pm.store import tree_digest

    try:
        if os.path.isdir(path):
            return tree_digest(path)
        state = hashlib.sha256()
        with open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                state.update(block)
        return state.hexdigest()
    except (OSError, ValueError):
        return ""


def main():
    sys.path.insert(0, sys.argv[1])
    for path in sys.argv[2:]:
        sys.stdout.write(f"{path}\t{digest(path)}\n")


if __name__ == "__main__":
    main()
