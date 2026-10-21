"""附件引用不能抢占用户问题的会话标题，也不能改动原始提问。"""

import pytest

from agent.title_generator import (
    apply_instant_title,
    build_title_input,
    derive_title,
    is_titleable_user_message,
)
from hermes_state import SessionDB


@pytest.mark.parametrize('references', [
    '@file:/unavailable/attachments/report.pdf',
    '@file:`/unavailable/attachments/季度 报告.pdf`',
    '@file:"C:\\Users\\tester\\季度 报告.pdf":1-3',
    '@folder:/unavailable/data\n@file:/unavailable/second.pdf',
])
def test_title_uses_question_after_attachment_prefix(references):
    """即时标题和模型命名输入均跳过引用及展开内容，无需读取附件。"""
    question = '翻译这个文档'
    original = references + '\n\n' + question
    expanded = original + '\n\n--- Attached Context ---\nprivate document content'
    assert is_titleable_user_message(expanded)
    assert build_title_input(expanded) == question
    assert derive_title(expanded) == derive_title(question)
    assert build_title_input(expanded, 'pasted topic').startswith(question)
    assert 'private document content' not in build_title_input(expanded, 'pasted topic')


def test_title_persistence_preserves_attachment_only_and_manual_names(tmp_path):
    """真实数据库保留仅附件不命名及手动标题优先级，问题标题重开后仍正确。"""
    path = tmp_path / 'state.db'
    reference = '@file:/unavailable/attachments/report.pdf'
    question = '翻译这个文档'
    with SessionDB(path) as database:
        for sid in ('question', 'file-only', 'manual'):
            database.create_session(session_id=sid, source='desktop')
        database.set_session_title('manual', '手动名称')
        assert apply_instant_title(database, 'file-only', reference) is None
        assert not database.get_session_title('file-only')
        assert not is_titleable_user_message(reference)
        assert derive_title(reference) is None
        assert apply_instant_title(database, 'question', reference + '\n\n' + question) == question
        apply_instant_title(database, 'manual', reference + '\n\n' + question)
        assert database.get_session_title('manual') == '手动名称'
    with SessionDB(path) as reopened:
        assert reopened.get_session_title('question') == question
        assert reopened.get_session_title('manual') == '手动名称'
