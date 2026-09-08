#!/usr/bin/env python3
"""Local Whisper STT via faster-whisper (preferred) or openai-whisper.

Used by backend/src/services/local-whisper-engine.js when whisper.cpp is
not installed. No API keys. Reads --audio and writes JSON to --output.
"""
from __future__ import annotations

import argparse
import json
import sys


def transcribe_faster(audio: str, model_name: str, language: str | None) -> dict:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        audio,
        language=language or None,
        beam_size=1,
        vad_filter=True,
    )
    segments = []
    parts = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if not text:
            continue
        parts.append(text)
        segments.append({"start": float(seg.start or 0), "end": float(seg.end or 0), "text": text})
    return {
        "text": " ".join(parts).strip(),
        "segments": segments,
        "language": getattr(info, "language", language),
        "model": model_name,
        "engine": "faster-whisper",
    }


def transcribe_openai_whisper(audio: str, model_name: str, language: str | None) -> dict:
    import whisper

    model = whisper.load_model(model_name)
    result = model.transcribe(audio, language=language or None)
    segments = []
    for seg in result.get("segments") or []:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "start": float(seg.get("start") or 0),
            "end": float(seg.get("end") or 0),
            "text": text,
        })
    return {
        "text": str(result.get("text") or "").strip(),
        "segments": segments,
        "language": result.get("language") or language,
        "model": model_name,
        "engine": "openai-whisper",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Whisper transcription")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="")
    args = parser.parse_args()
    language = (args.language or "").strip() or None

    last_error = None
    result = None
    try:
        result = transcribe_faster(args.audio, args.model, language)
    except Exception as exc:  # noqa: BLE001 — fallback engine
        last_error = exc
        try:
            result = transcribe_openai_whisper(args.audio, args.model, language)
        except Exception as exc2:  # noqa: BLE001
            last_error = exc2

    if result is None:
        sys.stderr.write(f"local-whisper unavailable: {last_error}\n")
        return 2

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
