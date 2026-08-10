#!/usr/bin/env python3
"""
clip_transcribe.py — Whisper transcription for Clip Scanning.

This is NOT the old voice-recording transcriber (that feature was removed on
2026-06-28 and stays removed — the hub does not listen to voice channels). This
is a standalone, stateless helper: give it a wav and optional time windows, it
prints JSON segments to stdout. No database, no sessions, nothing persistent.

Usage:
    python clip_transcribe.py <audio.wav> [--windows '[[12.0,26.5],[120.5,134.0]]']

Output (stdout, JSON):
    {"ok": true, "device": "cuda", "segments": [{"start": 12.4, "end": 15.1, "text": "..."}]}

Transcribing only the windows the audio pass flagged is dramatically faster
across a batch of long recordings than doing whole tracks; pass no --windows to
do the entire file.
"""

import sys
import json
import argparse


def load_model():
    """GPU medium if we can, CPU base if we can't. Returns (model, device)."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None, None
    try:
        return WhisperModel("medium", device="cuda", compute_type="float16"), "cuda"
    except Exception:
        try:
            return WhisperModel("base", device="cpu", compute_type="int8"), "cpu"
        except Exception:
            return None, None


def transcribe(model, audio, windows):
    out = []
    if not windows:
        segments, _ = model.transcribe(audio, language="en", vad_filter=True)
        for s in segments:
            text = (s.text or "").strip()
            if text:
                out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
        return out

    # Per-window: clip_offset puts the timestamps back on the recording's clock,
    # so a caller can map a line straight onto a candidate.
    for start, end in windows:
        try:
            segments, _ = model.transcribe(
                audio, language="en", vad_filter=True,
                clip_timestamps=[float(start), float(end)],
            )
            for s in segments:
                text = (s.text or "").strip()
                if text:
                    out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
        except TypeError:
            # Older faster-whisper without clip_timestamps: fall back to one
            # whole-file pass and filter, rather than failing outright.
            segments, _ = model.transcribe(audio, language="en", vad_filter=True)
            for s in segments:
                text = (s.text or "").strip()
                if text and s.end >= float(start) and s.start <= float(end):
                    out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--windows", default=None,
                    help="JSON array of [start,end] second pairs; omit to do the whole file")
    args = ap.parse_args()

    windows = []
    if args.windows:
        try:
            windows = json.loads(args.windows)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"bad --windows JSON: {e}"}), flush=True)
            return 2

    model, device = load_model()
    if model is None:
        print(json.dumps({
            "ok": False,
            "error": "faster-whisper not installed. Install with: pip install faster-whisper",
        }), flush=True)
        return 3

    try:
        segments = transcribe(model, args.audio, windows)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        return 4

    # Deduplicate: overlapping windows can transcribe the same line twice.
    seen = set()
    unique = []
    for s in sorted(segments, key=lambda x: x["start"]):
        key = (round(s["start"], 1), s["text"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(s)

    print(json.dumps({"ok": True, "device": device, "segments": unique}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
