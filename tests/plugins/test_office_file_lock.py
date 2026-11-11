"""Concurrent writers cannot publish over another owning Office operation."""
from pathlib import Path
import subprocess
import sys
import types

namespace = types.ModuleType('office_lock_test')
namespace.__path__ = [str(Path(__file__).parents[2] / 'plugins/uniwork-kits')]
sys.modules[namespace.__name__] = namespace
from office_lock_test.office.file_lock import file_lock


def attempt(path):
    plugin = Path(__file__).parents[2] / 'plugins/uniwork-kits'
    code = ('from pathlib import Path;import sys;sys.path.insert(0,sys.argv[1]);'
            'from office.file_lock import file_lock\n'
            'with file_lock(Path(sys.argv[2])):Path(sys.argv[2]).write_text("new")\n')
    return subprocess.run([sys.executable, '-c', code, str(plugin), str(path)], capture_output=True, timeout=10)


def test_other_process_cannot_write_until_owner_releases(tmp_path):
    path = tmp_path / 'report.docx'
    path.write_text('original')
    with file_lock(path):
        assert attempt(path).returncode != 0
        assert path.read_text() == 'original'
    assert attempt(path).returncode == 0
    assert path.read_text() == 'new'


def test_different_paths_remain_independent_and_exception_releases_lock(tmp_path):
    a, b = tmp_path / 'A.docx', tmp_path / 'B.docx'
    try:
        with file_lock(a):
            assert attempt(b).returncode == 0
            raise RuntimeError('failed operation')
    except RuntimeError:
        pass
    assert attempt(a).returncode == 0
