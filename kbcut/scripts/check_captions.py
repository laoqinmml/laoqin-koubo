#!/usr/bin/env python3
"""KB Cut caption text self-check.

Usage:
  python check_captions.py <口播优化版.srt> --output <字幕自检记录.md>
                                       [--max-chars 30] [--min-duration 0.4]

Runs a deterministic text checklist over the packaged caption SRT before it
reaches make-package:
  1. duplicate/叠字 runs (e.g. 慢慢慢、我我、很很)
  2. same caption text repeated elsewhere (possible accidental repeats)
  3. suspicious ASR tokens that common term fixes should have removed
  4. caption duration too short to read
  5. caption longer than the readability budget
Writes a markdown audit; it does not edit the SRT. Fixes are applied back in
the transcript/SRT workflow by the editor.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


CJK = r"\u4e00-\u9fff"
SUSPICIOUS = [
    (r"\bw\s?[wa]\b", "疑似 WA 字母碎片，应统一为 WA"),
    (r"\bwba\b", "疑似 WhatsApp 误写 WBA"),
    (r"\bpi\b", "疑似 API 掉了首字母"),
    (r"\bpp\b", "疑似 App/APP 误写 PP"),
    (r"\bctrl ?c\b", "保留 Ctrl C 属口播，仅提示检查"),
]


def ts_to_seconds(ts: str) -> float:
    parts = re.split(r"[:,]", ts.replace(",", ":"))
    nums = [float(x) for x in parts]
    return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / 1000


def parse_srt(text: str) -> list[dict]:
    blocks = re.split(r"\n\s*\n", text.strip())
    caps = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        m = re.search(
            r"(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)", lines[1]
        )
        if not m:
            continue
        caps.append(
            {
                "start": ts_to_seconds(m.group(1)),
                "end": ts_to_seconds(m.group(2)),
                "text": "".join(lines[2:]).strip(),
            }
        )
    return caps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("srt", type=Path)
    parser.add_argument("--output", type=Path, default=Path("字幕自检记录.md"))
    parser.add_argument("--max-chars", type=int, default=30)
    parser.add_argument("--min-duration", type=float, default=0.4)
    args = parser.parse_args()

    caps = parse_srt(args.srt.read_text(encoding="utf-8"))
    findings: list[dict] = []

    seen: dict[str, list[float]] = {}
    for cap in caps:
        text = cap["text"]
        duration = cap["end"] - cap["start"]
        at = f"{cap['start']:.2f}s"

        # 1. repeated CJK runs (叠字/口吃残留)
        for m in re.finditer(rf"([{CJK}])\1{{1,}}", text):
            run = m.group(0)
            if len(run) >= 3 or (len(run) == 2 and text.count(run) > 1):
                findings.append(
                    {"time": at, "kind": "叠字/重复", "text": text, "detail": run}
                )
                break

        # 2. exact caption repeated elsewhere
        if text in seen and duration >= args.min_duration:
            findings.append(
                {
                    "time": at,
                    "kind": "整条重复",
                    "text": text,
                    "detail": f"与 {seen[text][0]:.2f}s 处相同",
                }
            )
        seen.setdefault(text, []).append(cap["start"])

        # 3. suspicious tokens
        for pattern, hint in SUSPICIOUS:
            if re.search(pattern, text, re.IGNORECASE):
                findings.append(
                    {"time": at, "kind": "疑似听写错误", "text": text, "detail": hint}
                )
                break

        # 4. too short to read
        if duration < args.min_duration:
            findings.append(
                {
                    "time": at,
                    "kind": "字幕过短",
                    "text": text,
                    "detail": f"{duration:.2f}s < {args.min_duration}s",
                }
            )

        # 5. over the readability budget
        chars = len(re.sub(r"\s", "", text))
        if chars > args.max_chars:
            findings.append(
                {
                    "time": at,
                    "kind": "超长字幕",
                    "text": text,
                    "detail": f"{chars} 字 > {args.max_chars} 字",
                }
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# 字幕文本自检记录",
        "",
        f"- SRT：{args.srt}",
        f"- 字幕条数：{len(caps)}",
        f"- 命中问题：{len(findings)}",
        "",
    ]
    if findings:
        lines.append("| 时间 | 类型 | 问题 | 字幕文本 |")
        lines.append("| --- | --- | --- | --- |")
        for f in findings:
            safe = f["text"].replace("|", "｜").replace("\n", " ")
            lines.append(
                f"| {f['time']} | {f['kind']} | {f['detail']} | {safe} |"
            )
    else:
        lines.append("未发现命中项。")
    lines.append("")
    lines.append("（本记录只做提示，不自动改稿；命中项需在字幕/复核转写流程中确认处理。）")
    args.output.write_text("\n".join(lines), encoding="utf-8")
    print(json_summary(caps, findings))
    return 0


def json_summary(caps: list[dict], findings: list[dict]) -> str:
    import json

    return json.dumps(
        {"captions": len(caps), "findings": len(findings)},
        ensure_ascii=False,
    )


if __name__ == "__main__":
    raise SystemExit(main())
