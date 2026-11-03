"""Prepare image-local mutable directories before Cube drops privileges."""

import os
from pathlib import Path
import stat


def prepare_home(home: Path, uid: int, gid: int) -> None:
    # Only these build-time local trees participate. Never follow links into
    # the immutable PM store or the separately mounted persistent user volume.
    for name in ("cache", "tools"):
        root = home / name
        if root.is_symlink():
            raise ValueError(f"mutable home directory must not be a symlink: {root}")
        root.mkdir(parents=True, exist_ok=True)
        if name == "cache":
            paths = [root]
        else:
            paths = [root, *root.rglob("*")]
        for path in paths:
            if path.is_symlink():
                continue
            mode = path.stat().st_mode
            os.chown(path, uid, gid)
            access = stat.S_IRUSR
            if stat.S_ISDIR(mode):
                access |= stat.S_IWUSR | stat.S_IXUSR
            path.chmod(stat.S_IMODE(mode) | access)


def check_home(home: Path) -> None:
    for name in ("cache", "tools"):
        root = home / name
        paths = [root, *root.rglob("*")] if name == "tools" else [root]
        for path in paths:
            if path.is_symlink():
                continue
            access = os.R_OK | os.W_OK | os.X_OK if path.is_dir() else os.R_OK
            if not os.access(path, access):
                raise PermissionError(f"Hermes cannot restore or archive this path: {path}")


if __name__ == "__main__":
    import pwd

    user = pwd.getpwnam("hermes")
    home = Path("/opt/data")
    prepare_home(home, user.pw_uid, user.pw_gid)
    os.setgroups([])
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    check_home(home)
    print("Mutable home directories are accessible to Hermes, including nested tools")
