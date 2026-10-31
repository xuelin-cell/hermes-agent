"""Stage desktop resources using the deployment host's Python 3.6 standard library."""

import hashlib
import os
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'scripts/bundles'))
from uniwork_bundled import DEFAULT_SOURCE, TARGET, stage_bundled_plugins


def main(output=None):
    out = output or REPO / 'deploy/hermes-mt/.kits-runtime'
    source = os.environ.get('UNIWORK_BUNDLED_PLUGINS') or DEFAULT_SOURCE
    ref = os.environ.get('UNIWORK_BUNDLED_PLUGINS_REF', '')
    count = stage_bundled_plugins(out, {**os.environ, 'UNIWORK_BUNDLED_PLUGINS': source,
                               'UNIWORK_BUNDLED_PLUGINS_REF': ref,
                               'UNIWORK_BUNDLED_PLUGINS_REQUIRED': '1'})
    if not count:
        raise RuntimeError('云端套件必须包含有效的内置资源。')
    directory = out / TARGET
    files = sorted(p for p in directory.rglob('*') if p.is_file())
    if not files or not list((directory / 'plugins').glob('*.zip')):
        raise RuntimeError('云端套件包缺失，停止构建。')
    digest = hashlib.sha256()
    for path in files:
        digest.update(str(path.relative_to(out)).encode())
        digest.update(path.read_bytes())
    (out / '.fingerprint').write_text(digest.hexdigest()[:12] + '\n')


if __name__ == '__main__':
    main(Path(sys.argv[1]) if len(sys.argv) == 2 else None)
