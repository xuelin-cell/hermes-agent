"""A read contact sheet approves only its unchanged member pages in the owning turn."""
from pathlib import Path
import hashlib
import sys
import types

import pytest
from PIL import Image

namespace = types.ModuleType('ppt_contact_test')
namespace.__path__ = [str(Path(__file__).parents[2] / 'plugins/uniwork-kits')]
sys.modules[namespace.__name__] = namespace
from ppt_contact_test import turns
from ppt_contact_test.native_ppt_events import context
from ppt_contact_test.ppt_contact_sheet import create
from ppt_contact_test.ppt_visual_evidence import require_reads


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_contact_requires_actual_read_in_owning_turn_and_binds_page_content(tmp_path):
    page = tmp_path / 'page.png'
    Image.new('RGB', (200, 100), 'white').save(page)
    contact = tmp_path / 'contact.png'
    create([('Page 1', page)], contact)
    receipt = {'require_read_evidence': True, 'review_images': {'0': str(page)},
               'review_contacts': {str(contact): {'sha256': sha(contact), 'pages': {'0': sha(page)}}}}
    owner = turns.current('contact-owner', 'current')
    other = turns.current('contact-other', 'current')
    owner.native_visual_reads.clear()
    other.native_visual_reads[str(contact)] = sha(contact)
    token = context.set({'session_id': 'contact-owner', 'turn_id': 'current'})
    try:
        with pytest.raises(ValueError, match='尚未实际读取'):
            require_reads(receipt, [0])
        owner.native_visual_reads[str(contact)] = sha(contact)
        require_reads(receipt, [0])
        Image.new('RGB', (200, 100), 'blue').save(page)
        with pytest.raises(ValueError, match='尚未实际读取'):
            require_reads(receipt, [0])
    finally:
        context.reset(token)
        owner.native_visual_reads.clear()
        other.native_visual_reads.clear()


def test_contact_modification_invalidates_previously_read_digest(tmp_path):
    page = tmp_path / 'page.png'
    Image.new('RGB', (200, 100), 'white').save(page)
    contact = tmp_path / 'contact.png'
    create([('Page 1', page)], contact)
    receipt = {'require_read_evidence': True, 'review_images': {'0': str(page)},
               'review_contacts': {str(contact): {'sha256': sha(contact), 'pages': {'0': sha(page)}}}}
    owner = turns.current('contact-mutation', 'current')
    owner.native_visual_reads[str(contact)] = sha(contact)
    token = context.set({'session_id': 'contact-mutation', 'turn_id': 'current'})
    try:
        require_reads(receipt, [0])
        Image.new('RGB', (50, 50), 'black').save(contact)
        with pytest.raises(ValueError, match='尚未实际读取'):
            require_reads(receipt, [0])
    finally:
        context.reset(token)
        owner.native_visual_reads.clear()
