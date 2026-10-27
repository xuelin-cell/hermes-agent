"""Capabilities belong to one queued envelope and the actual turn worker, never user text."""
import threading
from types import SimpleNamespace

from tui_gateway import server
from tools.execution_metadata import active_for, current_metadata, completed_for


def session(agent=None):
    return {'agent': agent or SimpleNamespace(), 'session_key': 'capability-test', 'history': [],
            'history_lock': threading.Lock(), 'history_version': 0, 'running': True,
            'attached_images': [], 'image_counter': 0, 'cols': 80, 'slash_worker': None,
            'show_reasoning': False, 'tool_progress_mode': 'all', 'inflight_turn': None}


def test_queue_does_not_merge_different_execution_capabilities_or_mutate_the_live_turn():
    value = session()
    a = server._enqueue_prompt(value, 'first', None, execution_metadata={'cloud_drive': 'grant-a'})
    b = server._enqueue_prompt(value, 'second', None, execution_metadata={'cloud_drive': 'grant-b'})
    assert value['queued_prompt'] is a and value['queued_prompts'] == [b]
    assert a['text'] == 'first' and b['text'] == 'second'
    assert a['execution_metadata'] != b['execution_metadata']
    assert current_metadata() == {} and 'execution_metadata' not in value


def test_actual_prompt_worker_binds_then_retires_private_metadata(monkeypatch, tmp_path):
    seen = []
    def converse(prompt, *args, **kwargs):
        seen.append((prompt, current_metadata(), active_for('grant-live', 'runtime')))
        return {'final_response': 'done'}
    for name in ['_emit', '_wire_callbacks', '_sync_agent_model_with_config', '_register_session_cwd', '_sync_session_key_after_compress']:
        monkeypatch.setattr(server, name, lambda *a, **k: None)
    monkeypatch.setattr(server, '_session_cwd', lambda value: str(tmp_path))
    monkeypatch.setattr(server, '_tts_stream_begin', lambda: None)
    monkeypatch.setattr(server, '_get_usage', lambda agent: {})
    agent = SimpleNamespace(session_id='stored-session', run_conversation=converse, clear_interrupt=lambda: None)
    value = session(agent)
    assert server._run_prompt_submit('request', 'runtime', value, 'read this file', execution_metadata={'cloud_drive': 'grant-live'})
    value['_run_thread'].join(10)
    assert seen == [('read this file', {'cloud_drive': 'grant-live'}, True)]
    assert not active_for('grant-live', 'runtime') and current_metadata() == {}
    assert completed_for('grant-live', 'runtime')
