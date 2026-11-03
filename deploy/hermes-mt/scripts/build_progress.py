"""Summarize BuildKit output with a periodic heartbeat; tee retains the full log.

Uses Python 3.6 standard library for deployment hosts. This formatter reports
output progress only; the shell pipeline owns the actual build exit status.
"""
import argparse
import codecs
import os
import re
import select
import sys
import time


class BuildProgress:
    def __init__(self, label, interval=30, clock=time.monotonic, emit=None):
        self.label, self.interval, self.clock = label, interval, clock
        self.emit = emit or (lambda line: print(line, flush=True))
        self.started = self.last_tick = clock()
        self.latest = '等待构建器输出'

    def accept(self, line):
        line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line).strip()
        if not line:
            return
        line = re.sub(r'(https?://)[^/\s@]+@', r'\1***@', line)
        line = re.sub(r'(?i)((?:token|password|secret|api[_-]?key)=)[^\s&]+', r'\1***', line)
        self.latest = line[:180]
        if re.match(r'^#\d+\s+(?:\[|DONE|CACHED|ERROR|exporting|naming)', line) or line.startswith('ERROR:'):
            self.emit('  ' + self.latest)

    def tick(self, force=False):
        now = self.clock()
        if force or now - self.last_tick >= self.interval:
            elapsed = int(now - self.started)
            self.emit('  [{0} 已耗时 {1}分{2:02d}秒] 最新：{3}'.format(self.label, elapsed // 60, elapsed % 60, self.latest))
            self.last_tick = now


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    progress = BuildProgress(args.label)
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    pending = ''
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 1)
        if ready:
            data = os.read(sys.stdin.fileno(), 65536)
            pending += decoder.decode(data, final=not data)
            lines = pending.replace('\r', '\n').split('\n')
            pending = lines.pop()
            for line in lines:
                progress.accept(line)
            if not data:
                progress.accept(pending)
                progress.tick(force=True)
                return
        progress.tick()


if __name__ == '__main__':
    main()
