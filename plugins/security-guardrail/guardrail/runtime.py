"""Explicit execution-side capabilities, scoped to one engine evaluation."""

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from types import MappingProxyType

from .types import OperatingSystem


class ContextUnavailableError(ValueError):
    """The host has not supplied information required for this inspection."""


@dataclass(frozen=True)
class ExecutionEnvironment:
    appdata_root: str | None = None
    local_appdata_root: str | None = None
    home: str | None = None
    operating_system: OperatingSystem | None = None
    variables: Mapping[str, str] = field(default_factory=dict)
    product_exemptions: bool = False
    script_reader: Callable[[str, int], bytes | None] | None = None
    exists: Callable[[str], bool | None] | None = None
    is_directory: Callable[[str], bool | None] | None = None

    def __post_init__(self):
        object.__setattr__(self, "variables", MappingProxyType(dict(self.variables)))


_ENVIRONMENT = ContextVar("guardrail_execution_environment", default=ExecutionEnvironment())


def execution_environment() -> ExecutionEnvironment:
    return _ENVIRONMENT.get()


@contextmanager
def use_execution_environment(environment: ExecutionEnvironment) -> Iterator[None]:
    token = _ENVIRONMENT.set(environment)
    try:
        yield
    finally:
        _ENVIRONMENT.reset(token)


def path_exists(path: str) -> bool:
    probe = execution_environment().exists
    # Unknown existence cannot grant an exemption for deleting a missing file.
    return probe is None or probe(str(path)) is not False


def path_is_directory(path: str) -> bool:
    probe = execution_environment().is_directory
    return probe is not None and probe(str(path)) is True
