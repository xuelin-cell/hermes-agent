"""Transport health is observed by the adapter; only it publishes Hermes status."""

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class ChannelHealth:
    state: str = "stopped"
    last_error: str = ""
    on_change: Callable[[str], None] | None = field(default=None, repr=False)

    def _change(self, state: str, error: str = "") -> None:
        self.state, self.last_error = state, error
        if self.on_change:
            self.on_change(state)

    def mark_starting(self):
        self._change("starting")

    def mark_running(self):
        self._change("running")

    def mark_degraded(self, error):
        self._change("degraded", error)

    def mark_failed(self, error):
        self._change("failed", error)

    def mark_stopped(self):
        self._change("stopped")
