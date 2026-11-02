"""Contract tests for ``tools.silk_audio`` (SILK v3 → WAV).

The decoder binding is optional and swappable (silk-python preferred, pilk as
the fallback for environments provisioned before the swap), so these tests pin
the contracts callers depend on:

1. The WAV handed to the STT engine is 16-bit mono at the requested rate.
2. A truncated trailing packet keeps the audio decoded so far instead of
   discarding it.
3. Without silk-python, pilk still decodes.
"""

from __future__ import annotations

import sys
import wave
from types import ModuleType

import pytest

from tools import silk_audio


PCM = b"\x01\x02" * 480  # 480 samples of 16-bit mono PCM


def _install_pysilk(monkeypatch, decode):
    module = ModuleType("pysilk")
    module.decode = decode
    monkeypatch.setitem(sys.modules, "pysilk", module)
    monkeypatch.setattr(silk_audio, "_importable", lambda name: name in ("pysilk", "pilk"))
    return module


def test_wav_is_16bit_mono_at_the_requested_rate(tmp_path, monkeypatch):
    def decode(source, output, sample_rate):
        assert sample_rate == 16000
        output.write(PCM)

    _install_pysilk(monkeypatch, decode)
    target = tmp_path / "voice.wav"

    silk_audio.silk_to_wav(str(tmp_path / "voice.silk"), str(target), rate=16000)

    with wave.open(str(target), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16000
        assert wav.readframes(wav.getnframes()) == PCM


def test_truncated_tail_keeps_the_audio_decoded_so_far(tmp_path, monkeypatch):
    def decode(source, output, sample_rate):
        output.write(PCM)
        raise RuntimeError("truncated trailing packet")

    _install_pysilk(monkeypatch, decode)
    target = tmp_path / "voice.wav"

    silk_audio.silk_to_wav(str(tmp_path / "voice.silk"), str(target))

    with wave.open(str(target), "rb") as wav:
        assert wav.readframes(wav.getnframes()) == PCM


def test_undecodable_source_propagates(tmp_path, monkeypatch):
    def decode(source, output, sample_rate):
        raise RuntimeError("wrong header")

    _install_pysilk(monkeypatch, decode)

    with pytest.raises(RuntimeError, match="wrong header"):
        silk_audio.silk_to_wav(str(tmp_path / "voice.silk"), str(tmp_path / "voice.wav"))


def test_pilk_is_the_fallback_when_silk_python_is_absent(tmp_path, monkeypatch):
    calls = []

    pilk = ModuleType("pilk")
    pilk.silk_to_wav = lambda src, dst, rate=24000: calls.append((src, dst, rate))
    monkeypatch.setitem(sys.modules, "pilk", pilk)
    monkeypatch.setattr(silk_audio, "_importable", lambda name: name == "pilk")

    assert silk_audio.available() is True
    silk_audio.silk_to_wav("voice.silk", "voice.wav", rate=16000)

    assert calls == [("voice.silk", "voice.wav", 16000)]


def test_available_is_false_without_any_decoder(monkeypatch):
    monkeypatch.setattr(silk_audio, "_importable", lambda name: False)

    assert silk_audio.available() is False
