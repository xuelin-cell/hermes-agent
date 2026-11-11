"""Non-blocking cross-process lock for one Office input or output path."""
from contextlib import contextmanager
import os


@contextmanager
def file_lock(path):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.with_name('.' + path.name + '.uniwork-edit.lock').open('a+b')
    try:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError('Another edit is in progress for this Office file; no changes were published') from error
        yield
    finally:
        stream.close()
