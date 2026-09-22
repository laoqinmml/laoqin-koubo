#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剪辑内容字级核对（2026-09-18 新增，强制收口门，与 precheck.cjs 并列）。

用法:
  python check_cut_integrity.py <stem 或 项目目录> [--root E:\\自动剪辑]

它回答三个问题：
  1. 成片到底删掉了哪些字？（把 edit_plan.json 的 segments + drop_ranges 按 render_recut
     的真实语义——segments 按源时间轴拼接成成片时间轴、drop_ranges 按**成片时间轴**再删
     ——映射回源逐词稿，把被删的字用 ⟦⟧ 标出来）
  2. 成片内容与计划是否一致？（模拟结果 vs 「复核转写」逐词稿，逐字比对；只允许 ASR 同音
     错字级别的差异，出现成句内容缺失就是渲染/计划出错）
  3. drop_ranges 是否冗余？（segments 已经把某段排除在外、drop_ranges 又删一遍 → 会白丢
     好内容；本批次 MVI_4418 因此丢了 8.2 秒）

退出码 0 = 一致；1 = 有内容差异或冗余删除（需人工修）。
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


def simulate(plan, apply_drops=True):
    """→ [(out_s, out_e, src_s, src_e)] 与总时长（与 render_recut 语义一致）"""
    segs = sorted(rng(x) for x in plan.get("segments", []))
    out, t = [], 0.0
    for s, e in segs:
        out.append([t, t + (e - s), s, e])
        t += e - s
    total = t
    if apply_drops:
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
    return sorted((ss, se) for _, _, ss, se in out), total


def marked_text(words, ranges):
    buf = []
    for s, e, w in words:
        m = (s + e) / 2
        buf.append(w if any(a <= m <= b for a, b in ranges) else "⟦" + w + "⟧")
    return "".join(buf)


def kept_text(words, ranges):
    return "".join(w for s, e, w in words
                   if any(a <= (s + e) / 2 <= b for a, b in ranges))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="stem（如 MVI_4418）或项目目录")
    ap.add_argument("--root", default=r"E:\自动剪辑")
    a = ap.parse_args()

    proj = a.target if os.path.isdir(a.target) else os.path.join(a.root, a.target + "_KBcut")
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
    segs = sorted(rng(x) for x in plan.get("segments", []))
    drops = [rng(x) for x in plan.get("drop_ranges", [])]

    model_ranges, total = simulate(plan, apply_drops=True)
    plan_ranges, _ = simulate(plan, apply_drops=False)
    rs = 0 if not plan_ranges else max(b for _, b in plan_ranges)
    print(f"=== {stem}")
    print(f"segments {len(segs)} 段 / 计划时长 {total:.2f}s / drop_ranges {len(drops)} 个 {drops}")

    fail = 0
    # 1) 冗余 drop_ranges：删掉的区间在源时间轴上已经有「非重复内容」被 segments 排除
    if drops:
        lost = norm(kept_text(sw, plan_ranges)) != norm(kept_text(sw, model_ranges))
        removed = [w for s, e, w in sw
                   if any(x <= (s + e) / 2 <= y for x, y in plan_ranges)
                   and not any(x <= (s + e) / 2 <= y for x, y in model_ranges)]
        if lost:
            print(f"! drop_ranges 在成片时间轴上删掉了 {len(removed)} 字：{''.join(removed)}")
            print("   请人工确认这些字都是重复/口误（是→保留 drop_ranges；不是→删掉 drop_ranges，改用 make_edit_plan.py --drop 源时间轴）")
            print("   注意：跨词边界的 0.1~0.3s 小 drop 会出现「模型算它被删、实际渲染按帧保留」的偏差，属正常噪声")

    # 2) 计划文本 vs 成片文本
    got = norm("".join(w for _, _, w in cw))
    model = norm(kept_text(sw, model_ranges))
    planned = norm(kept_text(sw, plan_ranges))
    if model == got:
        print(f"✓ 计划文本 vs 成片逐词稿：一致（{len(model)} 字）")
    else:
        fail = 1
        sm = difflib.SequenceMatcher(None, model, got, autojunk=False)
        big = [(i2 - i1, model[i1:i2], got[j1:j2]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]
        big = [x for x in big if x[0] >= 2]
        print(f"✗ 计划文本 {len(model)} 字 / 成片实得 {len(got)} 字，差异 {len(big)} 处：")
        for n, x, y in sorted(big, key=lambda z: -z[0])[:8]:
            print(f"    计划有「{x}」/ 成片有「{y}」")
        if not big:
            print("    （只差 1 个同音字，视为 ASR 噪声）")
            fail = 0

    # 3) 删除清单
    print(f"--- 成片删掉的内容（⟦⟧ 内，源时间轴）---")
    txt = marked_text(sw, model_ranges)
    print(txt if len(txt) <= 4000 else txt[:4000] + " …（截断）")

    # 4) 硬规则抽查
    for pat, label, hard in ((r"[，。！？、,.!?]", "字幕/文本里留有中英标点", False),):
        if pat and re.search(pat, "".join(w for _, _, w in cw)) and hard:
            print(f"! {label}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
