"""Run the local PDF OCR fallback in a process with an adapter timeout."""

from __future__ import annotations

import json
from pathlib import Path
import sys


def recognize(source: Path, selected: list[int]) -> list[dict]:
    """Return text, confidence and page-relative positions for requested pages."""
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    with pymupdf.open(source) as document:
        numbers = list(dict.fromkeys(selected)) if selected else range(1, len(document) + 1)
        if not numbers or any(not 1 <= number <= len(document) for number in numbers):
            raise ValueError(f"Select a page between 1 and {len(document)}.")
        ocr = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        pages = []
        for number in numbers:
            page = document[number - 1]
            scale = min(240 / 72, 3600 / max(page.rect.width, page.rect.height))
            image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            result, _elapsed = ocr(image.tobytes("png"))
            blocks = []
            for corners, text, confidence in result or []:
                xs, ys = zip(*corners)
                blocks.append({
                    "text": text,
                    "confidence": round(float(confidence), 3),
                    "bbox": [round(float(value), 1) for value in (min(xs), min(ys), max(xs), max(ys))],
                })
            pages.append({"page": number, "width": image.width, "height": image.height, "blocks": blocks})
    return pages


if __name__ == "__main__":
    source, output, *pages = sys.argv[1:]
    try:
        data = recognize(Path(source), [int(page) for page in pages])
        Path(output).write_text(json.dumps({"pages": data}, ensure_ascii=False, indent=2), encoding="utf-8")
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
