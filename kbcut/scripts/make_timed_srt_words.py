#!/usr/bin/env python3
"""Word-aligned caption timing.

Usage:
  python make_timed_srt_words.py <words.tsv> <caption_lines.txt> <out.srt>

The caption file is a flat list of caption lines (blank lines ignored). Each
line is aligned to the ASR word stream from words.tsv: the cue starts at the
first matched word and ends at the last matched word, so caption start times
follow the speaker instead of a character-proportional estimate.
"""

from __future__ import annotations

import sys

NUM_MAP = {
    "0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
    "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
    "０": "零", "１": "一", "２": "二", "３": "三", "４": "四",
    "５": "五", "６": "六", "７": "七", "８": "八", "９": "九",
}

WINDOW = 6
START_PAD = 0.06
END_PAD = 0.10
MIN_GAP = 0.02


def norm_char(ch: str) -> str:
    if ch in NUM_MAP:
        return NUM_MAP[ch]
    return ch.lower()


def norm_token(token: str) -> str:
    return "".join(norm_char(c) for c in token if not c.isspace())


def load_words(path: str):
    words = []
    with open(path, encoding="utf-8") as fh:
        first = True
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            if first:
                first = False
                if line.startswith("start"):
                    continue
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            try:
                start = float(parts[0])
                end = float(parts[1])
            except ValueError:
                continue
            words.append((start, end, "\t".join(parts[3:])))
    return words


def load_lines(path: str):
    lines = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            text = raw.strip()
            if text:
                lines.append(text)
    return lines


def align_line(words, text, cursor):
    chars = [c for c in text if not c.isspace()]
    cursor = min(cursor, len(words))
    first_time = None
    last_time = None
    i = cursor

    def find_match(start, target):
        limit = min(len(words), start + WINDOW)
        j = start
        while j < limit:
            token = norm_token(words[j][2])
            if token and (token == target or target in token):
                return j
            j += 1
        return None

    for ch in chars:
        target = norm_char(ch)
        found = find_match(i, target)
        if found is None:
            # ASR used an extra filler token; skip up to 2 tokens and retry
            skipped = 0
            probe = i
            while found is None and skipped < 2 and probe < len(words):
                probe += 1
                skipped += 1
                found = find_match(probe, target)
            if found is None:
                # substitution (e.g. 老秦 vs ASR 老辛): anchor on current word
                if i >= len(words):
                    break
                found = i
        if first_time is None:
            first_time = words[found][0]
        last_time = words[found][1]
        i = found + 1
    if first_time is None:
        return None
    return first_time, last_time, i


def fmt(seconds: float) -> str:
    seconds = max(0.0, seconds)
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    words = load_words(sys.argv[1])
    lines = load_lines(sys.argv[2])
    out_path = sys.argv[3]

    cues = []
    cursor = 0
    for text in lines:
        aligned = align_line(words, text, cursor)
        if aligned is None:
            continue
        start, end, cursor = aligned
        cues.append([max(0.0, start - START_PAD), end + END_PAD, text])

    for idx in range(1, len(cues)):
        prev, cur = cues[idx - 1], cues[idx]
        if cur[0] < prev[1] + MIN_GAP:
            cur[0] = prev[1] + MIN_GAP
        if cur[1] <= cur[0]:
            cur[1] = cur[0] + 0.35

    with open(out_path, "w", encoding="utf-8") as fh:
        for idx, (start, end, text) in enumerate(cues, 1):
            fh.write(f"{idx}\n{fmt(start)} --> {fmt(end)}\n{text}\n\n")
    print(f"{len(cues)} cues written to {out_path} (word-aligned)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
