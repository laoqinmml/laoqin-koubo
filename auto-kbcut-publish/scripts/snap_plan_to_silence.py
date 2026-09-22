#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对 / 修正 edit_plan.json 的段边界，保证不切在说话中间。

背景：`make_edit_plan.py` 用的是**源素材 ASR 逐词稿的时间戳**，这份时间戳在个别素材上与真实
音频偏差 0.5–1.2 秒（文字/词序自洽，但时间对不上），段边界会落在有声区 → 成片截字/咔哒。

判定口径（简单且稳，不依赖「绝对静音」）：
  语音中位 med = 全片 20ms 窗 RMS 的 60 分位；「没在说话」= 窗电平 < med − 8 dB。
  内部段边界 b 合格 ⟺ b 前后 ±0.2s 内所有窗都低于该阈值（真的在两句话之间）。
  不合格时在 ±0.8s 内找一段 ≥0.35s 的低电平区间，把 b 移到它的中点；找不到就报 BAD。

用法:
  python snap_plan_to_silence.py <edit_plan.json> [--source 源视频] [--apply]
  --apply 才写回；不加只预览。退出码 0 = 全部合格（或已可自动吸附）；1 = 仍有边界落在有声区。
"""
import argparse
import array
import io
import json
import math
import os
import re
import subprocess
import sys

FFMPEG = r"C:\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe"
WIN = 0.02  # 20ms
SR = 8000


def windows_db(src):
    r = subprocess.run([FFMPEG, "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", str(SR),
                        "-f", "s16le", "-"], capture_output=True)
    pcm = array.array("h")
    pcm.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    n = int(WIN * SR)
    out = []
    for i in range(0, len(pcm) - n + 1, n):
        s = 0
        for v in pcm[i:i + n]:
            s += v * v
        rms = math.sqrt(s / n) / 32768.0
        out.append(20 * math.log10(rms) if rms > 1e-9 else -120.0)
    return out


def pct(xs, p):
    ys = sorted(xs)
    return ys[min(len(ys) - 1, max(0, int(len(ys) * p)))]


def idx(t, n):
    return max(0, min(n - 1, int(round(t / WIN))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--source", default=None)
    ap.add_argument("--rel", type=float, default=8.0, help="低电平阈值 = 语音中位 − rel dB")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    plan = json.load(io.open(a.plan, encoding="utf-8-sig"))
    src = a.source or plan.get("source")
    if (not src or not os.path.exists(src)) and a.source is None:
        # 计划里的 source 可能是已清理的中间产物；按素材名去 G:\0 视频未剪辑 里找原片
        base = os.path.basename(src or "")
        mm = re.match(r"(\d{6})", base)
        keys = [k for k in ([os.path.splitext(base)[0]] + ([mm.group(1)] if mm else [])) if k]
        m = re.search(r"[\\/](\d{4})[\\/]", str(src) or "")
        for root in ([os.path.join("G:\\0 视频未剪辑", m.group(1))] if m else []) + ["G:\\0 视频未剪辑"]:
            for dp, _dn, fn in os.walk(root):
                for f in fn:
                    st = os.path.splitext(f)[0]
                    if any(k and (k in st or st in k) for k in keys):
                        src = os.path.join(dp, f)
                        print(f"（计划的 source 不存在，自动改用原片 {src}）")
                        break
                if src and os.path.exists(src):
                    break
            if src and os.path.exists(src):
                break
    if not src or not os.path.exists(src):
        print(f"✗ 找不到源素材：{src}（用 --source 指原始素材）")
        return 1

    db = windows_db(src)
    n = len(db)
    med = pct(db, 0.60)
    thr = med - a.rel
    segs = [(float(s["start"]), float(s["end"])) for s in plan["segments"]]
    print(f"源素材 {os.path.basename(src)}（{n * WIN:.1f}s）：语音中位 {med:.1f} dBFS，"
          f"低电平参考 {thr:.1f} dBFS（中位−{a.rel}dB）")

    def local_min(b, half=1.0):
        """在 b ± half 内找最安静的 20ms 窗，返回 (该窗电平, 时间, b 处电平)"""
        i0, i1 = idx(b - half, n), idx(b + half, n)
        m, mi = 1e9, i0
        for i in range(i0, i1 + 1):
            if db[i] < m:
                m, mi = db[i], i
        return m, mi * WIN, db[idx(b, n)]

    def quiet(b, half=0.20):
        i0, i1 = idx(b - half, n), idx(b + half, n)
        return max(db[i0:i1 + 1]) < thr

    def nearest_pause(b, search=0.8, minlen=0.35):
        i0, i1 = idx(b - search, n), idx(b + search, n)
        best = None
        i = i0
        while i <= i1:
            if db[i] < thr:
                j = i
                while j <= i1 and db[j] < thr:
                    j += 1
                if (j - i) * WIN >= minlen:
                    mid = (i + j) / 2 * WIN
                    d = abs(mid - b)
                    if best is None or d < best[0]:
                        best = (d, mid, (j - i) * WIN)
                i = j
            else:
                i += 1
        return best

    new, bad = [], []
    for k, (s, e) in enumerate(segs):
        row = [s, e, "ok", "ok"]
        for pos, b in ((0, s), (1, e)):
            internal = (pos == 0 and k > 0) or (pos == 1 and k < len(segs) - 1)
            if not internal:
                m, mt, hb = local_min(b)
                if hb - m > 6:          # 首段起点/末段终点：落到语音起止的静音边缘即可
                    row[pos] = f"moved({mt:.2f})"
                    row[0 if pos == 0 else 1] = mt
                continue
            m, mt, hb = local_min(b)
            # 合格：边界处电平距附近最安静点 ≤3 dB（就是切在最安静的地方）
            if hb - m <= 3.0:
                continue
            # 2026-09-19 修正：只能朝**不会吃掉语音**的方向吸附 ——
            # 段起点只许往前（更早）、段终点只许往后（更晚）。反方向会把边界推进下一段静音，
            # 静默丢掉两段之间的整句话（MVI_4414 实测段5/段7 各丢一句，snap 退出码却仍是 0）。
            i_lo, i_hi = idx(b - 0.9, n), idx(b + 0.9, n)
            if pos == 0:
                cand = [i for i in range(i_lo, idx(b, n) + 1) if db[i] < thr]
            else:
                cand = [i for i in range(idx(b, n), i_hi + 1) if db[i] < thr]
            if cand:
                best = min(cand, key=lambda i: db[i])
                row[pos] = f"moved({best * WIN:.2f}, {db[best] - hb:+.1f}dB)"
                row[0 if pos == 0 else 1] = best * WIN
            else:
                row[pos] = "SPEECH"
                bad.append((k + 1, "start" if pos == 0 else "end", b, hb - m))
        new.append(row)

    for i in range(1, len(new)):
        if new[i][0] < new[i - 1][1]:
            mid = (new[i][0] + new[i - 1][1]) / 2
            new[i - 1][1] = new[i][0] = mid

    print("\n段边界核对：")
    for i, ((os_, oe), r) in enumerate(zip(segs, new), 1):
        tag = "" if (r[2] == "ok" and r[3] == "ok") else "   ← 已吸附/异常"
        print(f"  段{i:2d}  {os_:8.2f}–{oe:8.2f}  ->  {r[0]:8.2f}–{r[1]:8.2f}   "
              f"起点 {r[2]:26} 终点 {r[3]:26}{tag}")

    if a.apply:
        for s_, r in zip(plan["segments"], new):
            s_["start"], s_["end"] = round(r[0], 2), round(r[1], 2)
        io.open(a.plan, "w", encoding="utf-8", newline="").write(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
        print(f"\n已写回 {a.plan}")
    else:
        print("\n（预览模式，未写回；加 --apply 生效）")

    if bad:
        print(f"\n⚠ {len(bad)} 个内部边界附近 ±1s 内没有明显低电平点（电平仅比边界低 <1 dB 或仍在说话），"
              f"按「≤1.2s 气口一律保留」应把相邻两段合并：")
        for k, kind, b, d in bad:
            print(f"   段{k} {kind} @ {b:.2f}s（边界与附近最安静点差 {d:.1f} dB）")
        return 1
    print("\n✓ 所有内部段边界都切在附近最安静的位置（偏差 ≤3 dB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
