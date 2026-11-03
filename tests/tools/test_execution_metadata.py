"""Execution capabilities remain ephemeral across homes, threads and nested turns."""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools.execution_metadata import active_for, current_metadata, execution_scope


def test_execution_capabilities_follow_the_owning_home_and_are_retired_after_turn(tmp_path):
    a, b = tmp_path / 'a', tmp_path / 'b'
    a.mkdir(); b.mkdir()
    token = set_hermes_home_override(a)
    try:
        with execution_scope({'cloud_drive': 'grant-a'}, 'runtime-a'):
            assert current_metadata() == {'cloud_drive': 'grant-a'}
            assert active_for('grant-a', 'runtime-a') and not active_for('grant-a', 'runtime-b')
            other = set_hermes_home_override(b)
            try:
                assert current_metadata() == {}
                with execution_scope({'cloud_drive': 'grant-b'}, 'runtime-b'):
                    assert current_metadata() == {'cloud_drive': 'grant-b'}
            finally:
                reset_hermes_home_override(other)
            assert current_metadata() == {'cloud_drive': 'grant-a'}
            with execution_scope(None, 'synthetic'):
                assert current_metadata() == {}
        assert not active_for('grant-a', 'runtime-a') and current_metadata() == {}
    finally:
        reset_hermes_home_override(token)


def test_concurrent_turns_do_not_adopt_another_turns_capability(tmp_path):
    def read(value):
        with execution_scope({'cloud_drive': value}, value):
            with ThreadPoolExecutor(max_workers=1) as child:
                return child.submit(copy_context().run, current_metadata).result()
    with ThreadPoolExecutor(max_workers=2) as threads:
        a, b = list(threads.map(read, ['a', 'b']))
    assert a == {'cloud_drive': 'a'} and b == {'cloud_drive': 'b'}
    assert not active_for('a', 'a') and not active_for('b', 'b')
