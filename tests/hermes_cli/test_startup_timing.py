"""Startup stage marks: buffered until logging exists, then replayed once."""

import importlib
import logging

from hermes_cli import startup_timing


def _fresh():
    """A module instance with empty buffer/state (the module is a singleton otherwise)."""
    return importlib.reload(startup_timing)


def _messages(caplog, stage):
    return [record.getMessage() for record in caplog.records if stage in record.getMessage()]


def test_mark_taken_before_flush_is_replayed_once(caplog):
    module = _fresh()

    with caplog.at_level(logging.INFO, logger="hermes_cli.startup"):
        module.mark("stage before flush")
        assert not _messages(caplog, "stage before flush")
        module.flush()

    assert len(_messages(caplog, "stage before flush")) == 1


def test_mark_after_flush_is_logged_immediately(caplog):
    module = _fresh()
    module.flush()

    with caplog.at_level(logging.INFO, logger="hermes_cli.startup"):
        module.mark("stage after flush")

    assert len(_messages(caplog, "stage after flush")) == 1


def test_mark_once_records_only_the_first_occurrence(caplog):
    module = _fresh()

    with caplog.at_level(logging.INFO, logger="hermes_cli.startup"):
        module.mark_once("single stage")
        module.mark_once("single stage")
        module.flush()

    assert len(_messages(caplog, "single stage")) == 1
