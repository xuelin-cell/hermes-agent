"""SILK v3 voice decoding (WeChat/QQ .silk) to 16-bit mono WAV.

Prefers silk-python: it ships prebuilt wheels for every supported CPython, so
installing it never needs a C compiler. Environments provisioned before the
swap still carry pilk, which is used as a fallback so offline installs keep
decoding.
"""
from __future__ import annotations

import importlib.util
import os
import tempfile
import wave

__all__ = ["available", "silk_to_wav"]


def _importable(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def available() -> bool:
    """Is a SILK decoder importable (silk-python preferred, pilk as fallback)?"""
    return _importable("pysilk") or _importable("pilk")


def silk_to_wav(src: str, dst: str, rate: int = 24000) -> None:
    """Decode a SILK v3 file into a WAV file."""
    if not _importable("pysilk"):
        import pilk

        pilk.silk_to_wav(src, dst, rate=rate)
        return

    import pysilk

    fd, pcm_path = tempfile.mkstemp(suffix=".pcm")
    os.close(fd)
    try:
        with open(src, "rb") as source, open(pcm_path, "wb") as pcm:
            try:
                pysilk.decode(source, pcm, sample_rate=rate)
            except Exception:
                # A truncated trailing packet must not discard the audio already
                # decoded; pilk stops silently on the same input.
                if os.path.getsize(pcm_path) == 0:
                    raise
        with open(pcm_path, "rb") as pcm:
            with wave.open(dst, "wb") as wav:
                wav.setparams((1, 2, rate, 0, "NONE", "NONE"))
                wav.writeframes(pcm.read())
    finally:
        if os.path.exists(pcm_path):
            os.remove(pcm_path)
