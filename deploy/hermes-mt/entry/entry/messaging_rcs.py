"""RCS format policy stays at the channel edge; relay envelopes remain platform neutral."""
import asyncio
from pathlib import Path
import tempfile

from plugins.cloud_messaging.media import unpack, pack, MAX_MEDIA_BYTES

NATIVE = {
    '.jpg':('image','image/jpeg'), '.jpeg':('image','image/jpeg'), '.png':('image','image/png'),
    '.amr':('audio','audio/amr'), '.mp3':('audio','audio/mpeg'), '.m4a':('audio','audio/mp4'),
    '.mp4':('video','video/mp4'), '.webm':('video','video/webm'),
}


class RcsPreparationFailed(RuntimeError):
    pass


async def prepare(item):
    suffix = Path(item['name']).suffix.lower()
    if suffix == '.wav':
        import imageio_ffmpeg
        with tempfile.TemporaryDirectory(prefix='hermes-rcs-') as directory:
            source, target = Path(directory)/'input.wav', Path(directory)/'output.mp3'
            source.write_bytes(unpack(item))
            process = await asyncio.create_subprocess_exec(imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y',
                '-i', str(source), '-codec:a', 'libmp3lame', '-qscale:a', '4', str(target),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                await asyncio.wait_for(process.wait(), 60)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            if process.returncode or not target.is_file(): raise RcsPreparationFailed('Audio conversion failed')
            with target.open('rb') as stream:
                raw = stream.read(MAX_MEDIA_BYTES+1)
            item = pack(raw, str(Path(item['name']).with_suffix('.mp3')), 'audio', 'audio/mpeg')
        suffix = '.mp3'
    native = NATIVE.get(suffix)
    if native:
        # A file/document sender may have supplied the envelope; extension decides the RCS format.
        raw = unpack(item)
        item = pack(raw, item['name'], *native)
    return item, native is not None
