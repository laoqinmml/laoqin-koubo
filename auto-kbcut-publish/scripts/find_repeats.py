#!/usr/bin/env python3
"""在逐词稿里找「同一句说两遍 / 说错重来」的候选片段（供人工决定删哪一段）。

用法: python find_repeats.py <words.tsv> [--window 12] [--min-len 2] [--max-len 6]

原理：把逐词稿展开成带时间的字符流，找出在 `--window` 秒内重复出现的 n-gram
（n 从 min-len 到 max-len）。自修复型口误（「还有一个几 / 还有两个吧」、「注册FB广告
的时候 / 注册FB账号的时候」、「到现在 / 应该是6月份到现在」）都会在这里露面。
只报候选，删哪一段由人判断（保留最完整的那句）。
"""
import argparse
import io


def load_words(path):
    words = []
    for i, raw in enumerate(io.open(path, encoding='utf-8')):
        parts = raw.rstrip('\n').split('\t')
        if len(parts) < 4 or (i == 0 and parts[0] == 'start'):
            continue
        try:
            s, e = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        words.append((s, e, parts[3]))
    return words


def build_chars(words):
    chars = []
    for s, e, tok in words:
        cs = [c for c in tok if not c.isspace()]
        n = len(cs)
        if not n:
            continue
        span = max(0.0, e - s)
        for idx, ch in enumerate(cs):
            chars.append((ch, s + span * idx / n, s + span * (idx + 1) / n))
    return chars


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('words')
    ap.add_argument('--window', type=float, default=12.0)
    ap.add_argument('--min-len', type=int, default=2)
    ap.add_argument('--max-len', type=int, default=6)
    a = ap.parse_args()

    chars = build_chars(load_words(a.words))
    text = ''.join(c[0] for c in chars)
    seen = []
    for n in range(a.min_len, a.max_len + 1):
        for i in range(len(text) - n + 1):
            gram = text[i:i + n]
            if not gram.strip():
                continue
            # 往后找同一 gram 的下一处
            nxt = text.find(gram, i + n)
            while nxt != -1:
                t1, t2 = chars[i][1], chars[nxt][1]
                if t2 - t1 <= a.window:
                    ctx1 = text[max(0, i - 6):i + n + 6]
                    ctx2 = text[max(0, nxt - 6):nxt + n + 6]
                    seen.append((round(t1, 2), round(t2, 2), gram, ctx1, ctx2))
                    break
                nxt = text.find(gram, nxt + 1)

    # 去掉被更长候选包含的短候选
    seen.sort(key=lambda x: (x[0], -(x[1] - x[0])))
    kept = []
    for s in seen:
        if any(k[0] <= s[0] and s[1] <= k[1] and len(k[2]) > len(s[2]) for k in kept):
            continue
        kept.append(s)
    print(f'# {a.words}  候选 {len(kept)} 处（window {a.window}s, n={a.min_len}..{a.max_len}）')
    for t1, t2, gram, c1, c2 in kept:
        print(f'  {t1:7.2f} ~ {t2:7.2f}  「{gram}」')
        print(f'        前: …{c1}…')
        print(f'        后: …{c2}…')


if __name__ == '__main__':
    main()
