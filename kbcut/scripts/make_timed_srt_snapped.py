#!/usr/bin/env python3
"""把 AI 语义断行结果吸附到逐词稿字符流上，生成 SRT（上游 make_timed_srt_words 的替代）。

用法:
  python make_timed_srt_snapped.py <words.tsv> <lines.txt> <out.srt>

为什么需要它：上游 `make_timed_srt_words.py` 拿「AI 写好的字幕文本」去逐字符匹配
逐词稿。只要 AI 文本不是逐词稿的**字符子序列**（改了错别字、删了语气词、换了同义
词），游标就会越跑越靠前，最后十几行字幕会被静默丢弃（实测 57 行只剩 44 条）。

本脚本改为：AI 只提供**分段点（hint）**，每行字幕的显示文本**取自逐词稿本身**——
先在窗口内贪婪匹配定位该行的起止字符，再把这段逐词稿字符原样作为字幕文本
（只去掉纯语气词 呃/嗯/唔）。因此：
  * 文本必然是逐词稿的子序列，不会漂移、不会丢行；
  * 字幕用字与口播完全一致，不会出现 AI 改写的错别字。
"""
import io
import sys

WINDOW = 12          # 单字向前搜索窗口
START_PAD = 0.06
END_PAD = 0.10
MIN_GAP = 0.02
FILLERS = set('呃嗯唔')
NUM_MAP = {'0': '零', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五',
           '6': '六', '7': '七', '8': '八', '9': '九'}


def norm_char(ch):
    return NUM_MAP.get(ch, ch.lower())


def load_words(path):
    words = []
    for i, raw in enumerate(io.open(path, encoding='utf-8')):
        line = raw.rstrip('\n')
        if not line.strip() or (i == 0 and line.startswith('start')):
            continue
        parts = line.split('\t')
        if len(parts) < 4:
            continue
        try:
            s, e = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        words.append((s, e, parts[3]))
    return words


def build_stream(words):
    """(norm, orig, start, end) 逐字符流；orig 保留原字用于显示。"""
    stream = []
    for start, end, token in words:
        chars = [c for c in token if not c.isspace()]
        n = len(chars)
        if not n:
            continue
        span = max(0.0, end - start)
        for idx, ch in enumerate(chars):
            stream.append((norm_char(ch), ch, start + span * idx / n, start + span * (idx + 1) / n))
    return stream


def load_lines(path):
    return [l.strip() for l in io.open(path, encoding='utf-8') if l.strip()]


def snap(stream, text, cursor):
    i = min(cursor, len(stream))
    a = b = None
    for ch in text:
        if ch.isspace():
            continue
        t = norm_char(ch)
        limit = min(len(stream), i + WINDOW)
        j = i
        while j < limit and stream[j][0] != t:
            j += 1
        if j >= limit:
            continue          # 这一字逐词稿里没有：跳过，不推进游标
        if a is None:
            a = j
        b = j
        i = j + 1
    return None if a is None else (a, b, i)


def fmt(seconds):
    ms = int(round(max(0.0, seconds) * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def main():
    words_path, lines_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    stream = build_stream(load_words(words_path))
    cues = []
    cursor = 0
    skipped = []
    for idx, text in enumerate(load_lines(lines_path), 1):
        got = snap(stream, text, cursor)
        if got is None:
            skipped.append((idx, text))
            continue
        a, b, cursor = got
        shown = ''.join(c for c in (stream[k][1] for k in range(a, b + 1)) if c not in FILLERS)
        if not shown:
            skipped.append((idx, text))
            continue
        cues.append([max(0.0, stream[a][2] - START_PAD), stream[b][3] + END_PAD, shown])

    for i in range(1, len(cues)):
        if cues[i][0] < cues[i - 1][1] + MIN_GAP:
            cues[i][0] = cues[i - 1][1] + MIN_GAP
        if cues[i][1] <= cues[i][0]:
            cues[i][1] = cues[i][0] + 0.35

    with io.open(out_path, 'w', encoding='utf-8') as fh:
        for i, (s, e, text) in enumerate(cues, 1):
            fh.write(f'{i}\n{fmt(s)} --> {fmt(e)}\n{text}\n\n')

    longest = max((len(c[2]) for c in cues), default=0)
    print(f'{len(cues)} cues -> {out_path}  最长行 {longest} 字  跳过 {len(skipped)} 行')
    for idx, t in skipped[:10]:
        print(f'  SKIP {idx}: {t}')


if __name__ == '__main__':
    main()
