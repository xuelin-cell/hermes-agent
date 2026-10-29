"""Build heartbeats and real shell pipeline failure propagation, without Docker or network."""
import importlib.util
from pathlib import Path
import shlex
import subprocess
import sys

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / 'deploy/hermes-mt'


def test_heartbeat_reports_elapsed_latest_output_and_redacts_credentials():
    spec = importlib.util.spec_from_file_location('build_progress', DEPLOY / 'scripts/build_progress.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now, output = [0], []
    progress = module.BuildProgress('基础镜像', clock=lambda: now[0], emit=output.append)
    progress.accept('#8 [runtime 2/3] RUN apt-get update')
    progress.accept('#8 1.0 Get:1 https://user:private@example.com/a?token=hidden package')
    now[0] = 29
    progress.tick()
    assert len(output) == 1
    now[0] = 31
    progress.tick()
    assert '0分31秒' in output[-1] and 'Get:1' in output[-1]
    assert 'private' not in output[-1] and 'hidden' not in output[-1]
    now[0] = 61
    progress.tick()
    assert '1分01秒' in output[-1]


@pytest.mark.parametrize('target', ['build_base', 'cmd_image'])
@pytest.mark.platforms('posix')
def test_a_failed_build_stops_deployment_and_keeps_the_complete_log(tmp_path, target):
    here = tmp_path / 'deploy'
    (here / 'scripts').mkdir(parents=True)
    (here / 'scripts/build_progress.py').write_bytes((DEPLOY / 'scripts/build_progress.py').read_bytes())
    source = (DEPLOY / 'deploy.sh').read_text()
    start = source.index('\n' + target + '() {\n')
    function = source[start:source.index('\n}\n', start) + 3]
    command = '''
set -Eeuo pipefail
HERE=HERE_VALUE
REPO="$HERE"
IMAGE_NAME=hermes-test
BASE_IMAGE=hermes-test-base
need() { :; }
say() { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*"; }
ok() { printf '%s\\n' "$*"; }
die() { printf '[停止] %s\\n' "$*"; exit 1; }
base_tag() { printf hermes-test-base; }
head_short() { printf test; }
cfg() { printf '%s' "$HERE"; }
df() { printf 'Avail\\n100G\\n'; }
ensure_frontend() { :; }
fingerprint() { printf test; }
check_overlay() { :; }
stage_overlay() { :; }
python3() {
  if [ "$1" = "$HERE/scripts/base_seed.py" ]; then return 0; fi
  PYTHON_VALUE "$@"
}
docker() {
  if [ "$1" = image ]; then test -f "$HERE/image-exists"; return; fi
  if [ "$1" = build ]; then
    touch "$HERE/image-exists"
    printf '#8 [runtime 2/3] RUN install\\n#8 1.2 download details\\n#8 ERROR: failed\\n'
    return 7
  fi
  printf 'unexpected docker operation\\n'
  return 99
}
'''.replace('HERE_VALUE', shlex.quote(str(here))).replace('PYTHON_VALUE', shlex.quote(sys.executable))
    result = subprocess.run(['bash', '-c', command + function + '\n' + target], text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=15)
    assert result.returncode != 0
    assert '[停止]' in result.stdout and '构建失败' in result.stdout, result.stdout + '\n' + result.stderr
    log = here / ('.base-build.log' if target == 'build_base' else '.image-build.log')
    assert 'download details' in log.read_text() and 'ERROR: failed' in log.read_text()
