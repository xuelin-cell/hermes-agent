"""Word review uses original scoped requests and applies only unique text corrections."""
import importlib
import json
from pathlib import Path
import sys
import types

import pytest

namespace = types.ModuleType('office_word_quality_test')
namespace.__path__ = [str(Path(__file__).parents[2] / 'plugins/uniwork-kits')]
sys.modules[namespace.__name__] = namespace
quality = importlib.import_module(namespace.__name__ + '.office.word_quality')
store = importlib.import_module(namespace.__name__ + '.store')


def test_review_targets_unique_content_without_mutating_the_draft():
    draft = {'title': '方案', 'sections': [{'paragraphs': ['可以释放。'], 'table': {'rows': [['管理员', '必须释放。']]}}]}
    fixed = quality.apply_review(draft, [{'old': '必须释放。', 'new': '可酌情释放。'}])
    assert draft['sections'][0]['table']['rows'][0][1] == '必须释放。'
    assert fixed['sections'][0]['paragraphs'] == draft['sections'][0]['paragraphs']
    assert fixed['sections'][0]['table']['rows'][0][1] == '可酌情释放。'
    with pytest.raises(ValueError, match='ambiguous'):
        quality.apply_review({'a': '重复', 'b': '重复'}, [{'old': '重复', 'new': '另文'}])


def test_review_request_scope_and_cleanup_follow_a_b_a(tmp_path):
    homes = [tmp_path / 'A', tmp_path / 'B']
    for number, home in enumerate(homes):
        home.mkdir()
        with store.scoped_home(home):
            quality.remember(task_id='same-task', session_id='same-session', user_message=f'原始用户规则{number}')
    content = tmp_path / 'content.json'
    content.write_text(json.dumps({'title': '草稿', 'sections': []}), encoding='utf-8')
    seen = []

    def complete_structured(**kwargs):
        seen.append(json.loads(kwargs['input'][0]['text'])['original_user_request'])
        return types.SimpleNamespace(parsed={'edits': []}, model='test')

    client = types.SimpleNamespace(complete_structured=complete_structured)
    try:
        for home in [homes[0], homes[1], homes[0]]:
            with store.scoped_home(home):
                quality.review(client, 'same-task', content, home / 'output.docx')
        assert seen == ['原始用户规则0', '原始用户规则1', '原始用户规则0']
        with store.scoped_home(homes[0]):
            quality.forget(session_id='same-session')
            with pytest.raises(ValueError, match='original user request'):
                quality.review(client, 'same-task', content, homes[0] / 'output.docx')
        with store.scoped_home(homes[1]):
            quality.review(client, 'same-task', content, homes[1] / 'output.docx')
    finally:
        for home in homes:
            with store.scoped_home(home):
                quality.forget(session_id='same-session')
