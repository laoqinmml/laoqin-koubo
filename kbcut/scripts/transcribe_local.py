#!/usr/bin/env python3
"""使用火山引擎大模型语音识别（Seed ASR 标准版）生成词级时间戳转写。"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import uuid
import urllib.request
from pathlib import Path


SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
RESOURCE_ID = "volc.seedasr.auc"


def create_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description, add_help=False)
    parser._positionals.title = "位置参数"
    parser._optionals.title = "可选参数"
    parser.add_argument("-h", "--help", action="help", help="显示本帮助并退出")
    return parser


def timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def load_api_key() -> str:
    key = os.environ.get("VOLCENGINE_API_KEY", "").strip()
    if key:
        return key

    candidates: list[Path] = []
    env_file = os.environ.get("VOLCENGINE_ENV_FILE")
    if env_file:
        candidates.append(Path(env_file).expanduser())
    candidates.append(Path(__file__).resolve().parent.parent / ".env")
    candidates.append(Path.home() / ".codex" / "skills" / "AI剪口播" / ".env")
    candidates.append(Path.home() / ".codex" / "skills" / ".env")

    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            for line in candidate.read_text(encoding="utf-8").splitlines():
                name, _, value = line.partition("=")
                if name.strip() == "VOLCENGINE_API_KEY":
                    value = value.strip().strip('"').strip("'")
                    if value:
                        return value
        except OSError:
            continue

    raise SystemExit("未找到 VOLCENGINE_API_KEY")


def post(url: str, body: dict, api_key: str, request_id: str, logid: str | None = None):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("X-Api-Key", api_key)
    req.add_header("X-Api-Resource-Id", RESOURCE_ID)
    req.add_header("X-Api-Request-Id", request_id)
    req.add_header("X-Api-Sequence", "-1")
    req.add_header("Content-Type", "application/json")
    if logid:
        req.add_header("X-Tt-Logid", logid)

    with urllib.request.urlopen(req, timeout=120) as response:
        status = response.headers.get("X-Api-Status-Code", "")
        out_logid = response.headers.get("X-Tt-Logid", "")
        text = response.read().decode("utf-8")

    parsed = json.loads(text) if text else {}
    return status, out_logid, parsed


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = create_parser("使用火山引擎转录口播素材。")
    parser.add_argument("input", type=Path, help="输入视频或音频路径")
    parser.add_argument("--model", default="medium", help="保留兼容参数，当前固定使用标准版 Seed ASR")
    parser.add_argument("--language", default="zh", help="转写语言代码")
    parser.add_argument("--output-dir", type=Path, required=True, help="转写文件输出目录")
    parser.add_argument("--initial-prompt", default="", help="保留兼容参数")
    parser.add_argument("--device", default="cpu", help="保留兼容参数")
    parser.add_argument("--download-root", type=Path, help="保留兼容参数")
    args = parser.parse_args()

    source = args.input.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"输入媒体不存在：{source}")

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = output_dir / source.stem
    mp3 = prefix.with_name(f"{prefix.name}_volc.mp3")

    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "32k",
            str(mp3),
        ],
        check=True,
    )

    api_key = load_api_key()
    request_id = str(uuid.uuid4()).lower()
    request_body = {
        "user": {"uid": "kbcut"},
        "audio": {
            "data": base64.b64encode(mp3.read_bytes()).decode(),
            "format": "mp3",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": False,
            "enable_ddc": False,
            "show_utterances": True,
            "enable_speaker_info": False,
        },
    }

    status, logid, _ = post(SUBMIT_URL, request_body, api_key, request_id)
    if status != "20000000":
        raise SystemExit(f"提交任务失败（状态码 {status or '未返回'}）")

    result = None
    for _ in range(120):
        time.sleep(5)
        status, logid, body = post(QUERY_URL, {}, api_key, request_id, logid)
        if status == "20000000":
            result = body
            break
        if status not in ("20000001", "20000002", ""):
            raise SystemExit(f"转录失败（状态码 {status}）")

    if result is None:
        raise SystemExit("转录超时，任务未在 10 分钟内完成")

    utterances = (result.get("result") or {}).get("utterances") or []
    segments = []
    for utterance in utterances:
        words = [
            {
                "start": word.get("start_time", 0) / 1000.0,
                "end": word.get("end_time", 0) / 1000.0,
                "word": (word.get("text") or "").strip(),
                "probability": 1.0,
            }
            for word in (utterance.get("words") or [])
            if (word.get("start_time") or -1) >= 0
            and (word.get("end_time") or -1) >= 0
            and (word.get("text") or "").strip()
        ]
        segments.append(
            {
                "start": (utterance.get("start_time") or 0) / 1000.0,
                "end": (utterance.get("end_time") or 0) / 1000.0,
                "text": (utterance.get("text") or "").strip(),
                "words": words,
            }
        )

    result_obj = {
        "text": "".join(seg["text"] for seg in segments).strip(),
        "language": args.language,
        "engine": "volcengine-seedasr",
        "segments": segments,
    }

    with prefix.with_suffix(".json").open("w", encoding="utf-8") as handle:
        json.dump(result_obj, handle, ensure_ascii=False, indent=2)

    with prefix.with_suffix(".txt").open("w", encoding="utf-8") as handle:
        for segment in segments:
            handle.write(f"[{segment['start']:8.2f} --> {segment['end']:8.2f}] {segment['text']}\n")

    with prefix.with_suffix(".words.tsv").open("w", encoding="utf-8") as handle:
        handle.write("start\tend\tprobability\tword\n")
        for segment in segments:
            for word in segment["words"]:
                handle.write(
                    f"{word['start']:.3f}\t{word['end']:.3f}\t"
                    f"{word['probability']:.4f}\t{word['word']}\n"
                )

    with prefix.with_suffix(".srt").open("w", encoding="utf-8") as handle:
        for index, segment in enumerate(segments, start=1):
            handle.write(f"{index}\n")
            handle.write(f"{timestamp(segment['start'])} --> {timestamp(segment['end'])}\n")
            handle.write(f"{segment['text']}\n\n")

    print(
        json.dumps(
            {
                "engine": "volcengine-seedasr",
                "model": args.model,
                "audio": str(mp3),
                "json": str(prefix.with_suffix(".json")),
                "txt": str(prefix.with_suffix(".txt")),
                "words": str(prefix.with_suffix(".words.tsv")),
                "srt": str(prefix.with_suffix(".srt")),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
