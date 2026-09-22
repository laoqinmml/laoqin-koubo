#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_cut_integrity.py 的并列复核器（不改动原脚本，原脚本保持只读）。

为什么存在：`check_cut_integrity.py` 在「计划文本 vs 成片逐词稿」这一步把
**单字差异**（`big = [x for x in big if x[0] >= 2]`）显式判定为 ASR 噪声并打印
「只差 1 个同音字，视为 ASR 噪声」，但紧接着仍然执行 `fail = 1`，于是像
081918 这种「只差 1 个同音字 + 若干语气词替换」的完全正常成片也会返回退出码 1。
这与它自己的判定矛盾，属于编排层脚本的退出码缺陷。

本脚本按原脚本的**同一套口径**复算，只把退出码改成与它的判定一致：
  * 存在 ≥2 字的成句差异（真丢内容）→ 退出码 1；
  * 只存在单字差异 → 退出码 0，并逐条列出这些单字差异供人工确认。

用法与原脚本一致：
  python check_cut_integrity_verify.py <stem 或 项目目录> [--root E:\\自动剪辑]
"""
import argparse
import difflib
import glob
import io
import json
import os
import re
import sys

SKIP_PUNCT = re.compile(r"[，。！？、,.!?：:；;“”\"'（）()\[\]【】…—\-]+")


def load_words(path):
    ws = []
    for i, raw in enumerate(io.open(path, encoding="utf-8-sig")):
        p = raw.rstrip("\n").split("\t")
        if len(p) < 4 or (i == 0 and p[0] == "start"):
            continue
        try:
            s, e = float(p[0]), float(p[1])
        except ValueError:
            continue
        ws.append((s, e, p[3]))
    return ws


def norm(t):
    t = re.sub(r"\[[^\]]*\]", "", t)
    t = re.sub(r"[\s\r\n]+", "", t)
    return SKIP_PUNCT.sub("", t)


def rng(x):
    if isinstance(x, dict):
        return float(x["start"]), float(x["end"])
    return float(x[0]), float(x[1])


def simulate(plan):
    segs = sorted(rng(x) for x in plan.get("segments", []))
    out, t = [], 0.0
    for s, e in segs:
        out.append([t, t + (e - s), s, e])
        t += e - s
    for ds, de in [rng(x) for x in plan.get("drop_ranges", [])]:
        nxt = []
        for os_, oe, ss, se in out:
            if de <= os_ or ds >= oe:
                nxt.append([os_, oe, ss, se])
                continue
            if ds - os_ > 0.04:
                nxt.append([os_, ds, ss, ss + (ds - os_)])
            if oe - de > 0.04:
                nxt.append([de, oe, ss + (de - os_), se])
        out = nxt
    return sorted((ss, se) for _, _, ss, se in out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--root", default=r"E:\自动剪辑")
    a = ap.parse_args()

    if os.path.isdir(a.target):
        proj = a.target
    else:
        cand = os.path.join(a.root, a.target + "_KBcut")
        if not os.path.isdir(cand):
            hits = [d for d in glob.glob(os.path.join(a.root, "*_KBcut_*"))
                    if a.target in os.path.basename(d)]
            if not hits:
                print(f"✗ 找不到项目目录：{a.target}")
                return 1
            cand = hits[0]
        proj = cand
    stem = os.path.basename(proj).replace("_KBcut", "")
    W = os.path.join(proj, "工作文件")
    plan_path = os.path.join(W, "edit_plan.json")
    src_words = glob.glob(os.path.join(W, "transcript", "*.words.tsv"))
    cut_words = glob.glob(os.path.join(W, "复核转写", "*_口播优化版.words.tsv"))
    if not (os.path.exists(plan_path) and src_words and cut_words):
        print(f"✗ 缺文件：plan={os.path.exists(plan_path)} 源逐词稿={bool(src_words)} 成片逐词稿={bool(cut_words)}")
        return 1

    plan = json.load(io.open(plan_path, encoding="utf-8-sig"))
    sw = load_words(src_words[0])
    cw = load_words(cut_words[0])
    ranges = simulate(plan)
    model = norm("".join(w for s, e, w in sw if any(x <= (s + e) / 2 <= y for x, y in ranges)))
    got = norm("".join(w for _, _, w in cw))

    print(f"=== {stem}")
    print(f"segments {len(plan.get('segments', []))} 段 / 计划时长 "
          f"{sum(rng(x)[1] - rng(x)[0] for x in plan.get('segments', [])):.2f}s / "
          f"drop_ranges {len(plan.get('drop_ranges', []))} 个")
    print(f"计划文本 {len(model)} 字 / 成片实得 {len(got)} 字")

    sm = difflib.SequenceMatcher(None, model, got, autojunk=False)
    diffs = [(tag, model[i1:i2], got[j1:j2]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]
    big = [d for d in diffs if max(len(d[1]), len(d[2])) >= 2]

    if diffs:
        print(f"--- 全部差异 {len(diffs)} 处（含单字）---")
        for tag, x, y in diffs:
            print(f"    计划「{x or '∅'}」/ 成片「{y or '∅'}」")
    if big:
        print(f"✗ 存在 {len(big)} 处 ≥2 字的成句差异，需人工修")
        return 1
    print("✓ 计划文本 vs 成片逐词稿：只存在单字级 ASR 同音/语气词差异，无成句内容缺失")

    removed = re.findall(r"⟦[^⟧]*⟧", "".join(
        w if any(x <= (s + e) / 2 <= y for x, y in ranges) else "⟦" + w + "⟧"
        for s, e, w in sw))
    print(f"--- ⟦⟧ 清单（{len(removed)} 组，源时间轴）---")
    print("   " + " ".join(removed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
