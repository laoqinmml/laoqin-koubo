#!/usr/bin/env python3
"""按「气口 ≤1.2s 保留」规则，从逐词稿生成 edit_plan.json（编排层工具）。

用法:
  python make_edit_plan.py <words.tsv> <源素材> <口播优化版输出> <edit_plan.json> \
      [--drop 起-止] [--drop 起-止] ... [--gap 1.2] [--note-prefix 前缀]

规则（2026-09-18 用户确认，写进 auto-kbcut-publish/references/config.md）：
  * 只在 >1.2s 的停顿处断句；≤1.2s 的气口一律保留，不做碎片化切割；
  * 重复/说错的句子用 --drop 把不要的那段删掉（保留最完整的一句）；
  * 片头/片尾静音自动去掉。

脚本只做机械切分；哪句是重复、哪句该留由人（或 agent）判断后传给 --drop。
"""
import argparse
import io
import json


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


def blocks(words, gap):
    out, cur = [], []
    prev_end = None
    for s, e, w in words:
        if cur and s - prev_end > gap:
            out.append(cur)
            cur = []
        cur.append((s, e, w))
        prev_end = e
    if cur:
        out.append(cur)
    return out


def fmt_segments(blocks_list):
    return [(b[0][0], b[-1][1], ''.join(x[2] for x in b)) for b in blocks_list]


def apply_drops(segs, drops):
    """在片段内按时间删掉区间（用于删重复/口误），返回新的片段列表。"""
    result = []
    for start, end, text in segs:
        pieces = [(start, end)]
        for ds, de in drops:
            nxt = []
            for ps, pe in pieces:
                if de <= ps or ds >= pe:
                    nxt.append((ps, pe))
                    continue
                if ds - ps > 0.04:
                    nxt.append((ps, ds))
                if pe - de > 0.04:
                    nxt.append((de, pe))
            pieces = nxt
        for ps, pe in pieces:
            result.append((ps, pe, text))
    return [r for r in result if r[1] - r[0] > 0.04]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('words')
    ap.add_argument('source')
    ap.add_argument('output')
    ap.add_argument('plan')
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--gap', type=float, default=1.2)
    ap.add_argument('--note-prefix', default='')
    a = ap.parse_args()

    words = load_words(a.words)
    bl = blocks(words, a.gap)
    segs = fmt_segments(bl)
    drops = []
    for d in a.drop:
        s, e = d.split('-')
        drops.append((float(s), float(e)))
    # 片头静音：从第一个词开始
    final = apply_drops(segs, drops)

    plan = {
        'source': a.source,
        'output': a.output,
        'edit_rule': '气口 ≤1.2s 一律保留（不剪），只在 >1.2s 的停顿处断；重复/说错的只保留最完整的那句（2026-09-18 用户规则）',
        'segments': [
            {'start': round(s, 2), 'end': round(e, 2), 'note': (a.note_prefix + t[:80])}
            for s, e, t in final
        ],
    }
    io.open(a.plan, 'w', encoding='utf-8').write(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')

    print(f'原始块 {len(bl)} 个（按 >{a.gap}s 停顿切）→ 删 {len(drops)} 处重复 → 最终 {len(final)} 段')
    for i, (s, e, t) in enumerate(final, 1):
        print(f'  [{i:2d}] {s:7.2f} -> {e:7.2f} ({e - s:5.2f}s)  {t[:56]}')
    print(f'写入 {a.plan}')


if __name__ == '__main__':
    main()
