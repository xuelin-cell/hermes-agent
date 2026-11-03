"""Conversation folders on the tenant volume; cleanup never recursively deletes."""
from __future__ import annotations

import os
import threading
from datetime import datetime
from pathlib import Path


def identity(value):
    return value.st_dev, value.st_ino


class ConversationFolders:
    def __init__(self, workspace: Path, now=datetime.now):
        self.workspace = Path(workspace)
        self.now = now
        self.created = {}
        self.lock = threading.Lock()

    def create(self, default_cwd):
        if not isinstance(default_cwd, str) or not default_cwd.startswith('/') or len(default_cwd) > 4096 or '\0' in default_cwd:
            return None
        # The platform deliberately links /opt/data/workspace to the mounted volume.
        root = self.workspace.resolve()
        if Path(default_cwd).resolve() != root:
            return None
        with self.lock:
            try:
                with_root = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError:
                return None
            try:
                base = self.now().strftime('%Y%m%d-%H%M%S')
                for index in range(1, 100):
                    name = base if index == 1 else f'{base}-{index}'
                    try:
                        os.mkdir(name, dir_fd=with_root)
                    except FileExistsError:
                        continue
                    except OSError:
                        return None
                    folder = str(self.workspace / name)
                    try:
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=with_root)
                    except OSError:
                        return None
                    self.created[folder] = (identity(os.fstat(with_root)), identity(os.fstat(child)))
                    while len(self.created) > 4096:
                        # Losing an old cleanup receipt only leaves an empty folder behind.
                        self.created.pop(next(iter(self.created)))
                    try:
                        os.mkdir('.tmp', dir_fd=child)
                    except OSError:
                        pass  # The scratch folder is optional, as on desktop.
                    finally:
                        os.close(child)
                    return folder
                return None
            finally:
                os.close(with_root)

    def discard(self, folder):
        if not isinstance(folder, str):
            return
        with self.lock:
            expected = self.created.pop(folder, None)
            if expected is None:
                return
            root_fd = child = None
            try:
                root_fd = os.open(self.workspace.resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                name = Path(folder).name
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                if (identity(os.fstat(root_fd)), identity(os.fstat(child))) != expected:
                    return
                if os.listdir(child) == ['.tmp']:
                    os.rmdir('.tmp', dir_fd=child)
                os.rmdir(name, dir_fd=root_fd)
            except OSError:
                # Nonempty, replaced, missing or inaccessible directories are retained.
                pass
            finally:
                if child is not None:
                    os.close(child)
                if root_fd is not None:
                    os.close(root_fd)
