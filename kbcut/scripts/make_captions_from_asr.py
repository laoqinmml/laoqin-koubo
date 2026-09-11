#!/usr/bin/env python3
"""Build full-coverage captions directly from the ASR word stream.

Usage:
  python make_captions_from_asr.py <words.tsv> <asr_segments.txt> <out_lines.txt> <out.srt> [replacements.json] [--max-chars N] [--pause-break S]

--max-chars must match the current style/aspect caption budget (the
"每行上限 N 字" printed by make-package.cjs), e.g. founder-interview 9:16 ~13,
founder-interview 16:9 ~24.

Rules:
  * keep every spoken character except pure fillers (呃 嗯 啊 哦 唔 诶 唉 哟)
    and immediate duplicate stutters;
  * break lines at pauses >= 0.42s, or when a line reaches MAX_CHARS;
  * cue start = first char start - 0.06, cue end = last char end + 0.10,
    clamped so cues never overlap.
"""

from __future__ import annotations

import json
import re
import sys

FILLERS = {"呃", "嗯", "啊", "哦", "唔", "诶", "唉", "哟"}
MAX_CHARS = 17
MIN_CHARS = 8
HARD_CHARS = 24
PAUSE_BREAK = 0.40
PAUSE_SOFT = 0.24
START_PAD = 0.06
END_PAD = 0.10
MIN_GAP = 0.02

BREAK_BEFORE = set("就也还但而所因如其另这那它我你他她们有会能要把从对在跟与")
BREAK_AFTER = set("的了话时后前中里上下一事人")
BAD_AFTER = set("不没很太更最所")
BAD_BEFORE = set("的地得吗呢吧")
# characters that usually cannot start / end a word, used to avoid mid-word cuts
SUFFIX_HINT = set("们个儿化性者员品力度量处间"); 
PREFIX_HINT = set("另比如什怎为因虽但而就也还才刚已正将把被让给对向从在和跟与或及太很更最不没")


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
            token = "".join(parts[3:]).strip()
            if token:
                words.append((start, end, token))
    return words


def filter_fillers(words):
    out = []
    for start, end, token in words:
        if token in FILLERS:
            continue
        # drop immediate duplicate stutter ("就是就是")
        if out and out[-1][2] == token and token in {"就是", "然后", "这个", "那个"}:
            continue
        out.append((start, end, token))
    return out


def load_segments(path: str):
    segs = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            m = re.match(r"\s*\[\s*([\d.]+)\s*-->\s*([\d.]+)\s*\]", raw)
            if m:
                segs.append((float(m.group(1)), float(m.group(2))))
    return segs


def split_words(words, segments):
    """Group words into ASR sentence segments (fallback: pause grouping)."""
    groups = []
    if not segments:
        return [words]
    for start, end in segments:
        chunk = [w for w in words if w[0] >= start - 0.08 and w[0] <= end + 0.08]
        if chunk:
            groups.append(chunk)
    return groups


def build_cues(words, segments=None, max_chars=None, pause_break=None):
    max_chars = max_chars or MAX_CHARS
    pause_break = pause_break or PAUSE_BREAK
    chars = []
    for start, end, token in words:
        pieces = list(token)
        count = len(pieces)
        span = max(0.0, end - start)
        for idx, ch in enumerate(pieces):
            cs = start + span * idx / count
            ce = start + span * (idx + 1) / count
            chars.append((ch, cs, ce))
    text = "".join(c[0] for c in chars)
    if not text:
        return []

    try:
        import jieba  # type: ignore
    except ImportError:  # pragma: no cover
        jieba = None
    tokens = list(jieba.cut(text, HMM=False)) if jieba else list(text)

    def segment_index(t: float) -> int:
        for i, (s, e) in enumerate(segments or []):
            if s - 0.12 <= t <= e + 0.12:
                return i
        return -1

    cues = []
    buf_text = ""
    buf_start = None
    buf_end = None
    last_seg = None
    pos = 0
    for tok in tokens:
        if not tok:
            continue
        span = chars[pos:pos + len(tok)]
        pos += len(tok)
        if not span:
            continue
        tok_start = span[0][1]
        tok_end = span[-1][2]
        seg = segment_index(tok_start)
        force_break = False
        if buf_text:
            if last_seg is not None and seg != last_seg:
                force_break = True
            elif len(buf_text) + len(tok) > max_chars:
                force_break = True
            elif (tok_start - buf_end) >= pause_break and len(buf_text) >= 6:
                force_break = True
        if force_break:
            cues.append((buf_start, buf_end, buf_text))
            buf_text, buf_start, buf_end = "", None, None
        if not buf_text:
            buf_start = tok_start
        buf_text += tok
        buf_end = tok_end
        last_seg = seg
    if buf_text:
        cues.append((buf_start, buf_end, buf_text))
    return cues


def fmt(seconds: float) -> str:
    seconds = max(0.0, seconds)
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_flags(argv):
    rest, max_chars, pause_break = [], None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--max-chars" and i + 1 < len(argv):
            max_chars = int(argv[i + 1])
            i += 2
        elif argv[i] == "--pause-break" and i + 1 < len(argv):
            pause_break = float(argv[i + 1])
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    return rest, max_chars, pause_break


def main() -> int:
    argv, max_chars, pause_break = parse_flags(sys.argv[1:])
    if len(argv) < 4:
        print(__doc__)
        return 2
    words = filter_fillers(load_words(argv[0]))
    segments = load_segments(argv[1])
    out_lines = argv[2]
    out_srt = argv[3]
    replacements = {}
    if len(argv) > 4:
        with open(argv[4], encoding="utf-8") as fh:
            replacements = json.load(fh)

    cues = build_cues(words, segments, max_chars=max_chars, pause_break=pause_break)
    fixed = []
    for start, end, text in cues:
        for src, dst in replacements.items():
            text = text.replace(src, dst)
        fixed.append([start, end, text])

    for idx in range(1, len(fixed)):
        prev, cur = fixed[idx - 1], fixed[idx]
        if cur[0] - START_PAD < prev[1] + END_PAD + MIN_GAP:
            cur[0] = prev[1] + END_PAD + MIN_GAP + START_PAD
        if cur[1] <= cur[0]:
            cur[1] = cur[0] + 0.4

    with open(out_lines, "w", encoding="utf-8") as fh:
        for start, end, text in fixed:
            fh.write(text + "\n")
    with open(out_srt, "w", encoding="utf-8") as fh:
        for idx, (start, end, text) in enumerate(fixed, 1):
            fh.write(f"{idx}\n{fmt(max(0.0, start - START_PAD))} --> {fmt(end + END_PAD)}\n{text}\n\n")
    print(f"{len(fixed)} cues written (full coverage)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
