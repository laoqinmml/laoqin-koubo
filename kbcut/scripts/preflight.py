#!/usr/bin/env python3
"""检查知识口播剪辑所需的本地依赖、火山引擎凭证与媒体信息。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def create_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description, add_help=False)
    parser._positionals.title = "位置参数"
    parser._optionals.title = "可选参数"
    parser.add_argument("-h", "--help", action="help", help="显示本帮助并退出")
    return parser


def probe(path: Path) -> dict:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return json.loads(result.stdout)


def songti_available() -> bool:
    known_files = [
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
        Path("/Library/Fonts/Songti.ttc"),
    ]
    if any(path.is_file() for path in known_files):
        return True
    matcher = shutil.which("fc-match")
    if not matcher:
        return False
    result = subprocess.run(
        [matcher, "-f", "%{family}", "Songti SC"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and "songti" in result.stdout.lower()


def resolve_hyperframes() -> str | None:
    direct = shutil.which("hyperframes")
    if direct:
        return direct
    cache_root = Path.home() / ".npm" / "_npx"
    candidates = list(cache_root.glob("*/node_modules/.bin/hyperframes"))
    candidates = [path for path in candidates if path.is_file()]
    if not candidates:
        return None
    return str(max(candidates, key=lambda path: path.stat().st_mtime).resolve())


def volcengine_key() -> tuple[bool, str]:
    key = os.environ.get("VOLCENGINE_API_KEY", "").strip()
    if key:
        return True, "环境变量"

    candidates: list[Path] = []
    env_file = os.environ.get("VOLCENGINE_ENV_FILE")
    if env_file:
        candidates.append(Path(env_file).expanduser())
    candidates.append(Path.home() / ".codex" / "skills" / "AI剪口播" / ".env")
    candidates.append(Path.home() / ".codex" / "skills" / ".env")
    candidates.append(SKILL_ROOT / ".env")

    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            for line in candidate.read_text(encoding="utf-8").splitlines():
                name, _, value = line.partition("=")
                value = value.strip().strip('"').strip("'")
                if name.strip() == "VOLCENGINE_API_KEY" and value:
                    return True, str(candidate)
        except OSError:
            continue
    return False, ""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = create_parser("检查口播素材、本地依赖、火山引擎凭证和渲染工具。")
    parser.add_argument("input", type=Path, help="输入视频路径")
    parser.add_argument("--frame", type=Path, help="自定义 frame.md 路径；省略时使用内置版本")
    args = parser.parse_args()

    source = args.input.expanduser().resolve()
    frame = (
        args.frame.expanduser().resolve()
        if args.frame
        else SKILL_ROOT / "assets" / "frame.md"
    )
    tools = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe")}
    tools["hyperframes"] = resolve_hyperframes()

    volc_ok, volc_source = volcengine_key()

    report: dict = {
        "input": str(source),
        "input_exists": source.is_file(),
        "tools": tools,
        "frame": str(frame),
        "frame_exists": frame.is_file(),
        "transcription": {
            "engine": "volcengine-seedasr",
            "api_key_available": volc_ok,
            "api_key_source": volc_source or None,
        },
        "font": {"family": "Songti SC", "available": songti_available()},
        "media": None,
        "errors": [],
        "warnings": [],
    }

    if not source.is_file():
        report["errors"].append("输入视频不存在")
    if not tools["ffmpeg"]:
        report["errors"].append("PATH 中未找到 ffmpeg")
    if not tools["ffprobe"]:
        report["errors"].append("PATH 中未找到 ffprobe")
    if not frame.is_file():
        report["errors"].append("未找到 frame.md")
    if not volc_ok:
        report["errors"].append(
            "未找到火山引擎 VOLCENGINE_API_KEY；请配置到 AI剪口播/.env 或环境变量"
        )

    if source.is_file() and tools["ffprobe"]:
        try:
            metadata = probe(source)
            streams = metadata.get("streams", [])
            video = next((item for item in streams if item.get("codec_type") == "video"), None)
            audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
            side_data = [item.get("side_data_type") for item in (video or {}).get("side_data_list", [])]
            report["media"] = {
                "format": metadata.get("format", {}).get("format_name"),
                "duration": metadata.get("format", {}).get("duration"),
                "video": {
                    key: video.get(key)
                    for key in (
                        "codec_name",
                        "profile",
                        "width",
                        "height",
                        "pix_fmt",
                        "r_frame_rate",
                        "color_range",
                        "color_space",
                        "color_transfer",
                        "color_primaries",
                    )
                }
                if video
                else None,
                "audio": {
                    key: audio.get(key)
                    for key in ("codec_name", "sample_rate", "channels", "channel_layout")
                }
                if audio
                else None,
                "video_side_data": side_data,
            }
            if not video:
                report["errors"].append("素材中没有视频流")
            if not audio:
                report["errors"].append("素材中没有音频流")
            if "DOVI configuration record" in side_data:
                report["warnings"].append(
                    "检测到 Dolby Vision 元数据；请保留 HDR 兼容层，并对比渲染前后的同一帧"
                )
        except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
            report["errors"].append(f"ffprobe 检查失败：{error}")

    if not tools["hyperframes"]:
        report["warnings"].append(
            "未找到 HyperFrames CLI；包装前请使用已安装或缓存的版本，必要时再安装"
        )
    if not report["font"]["available"]:
        report["warnings"].append(
            "系统中没有 Songti SC；默认 Broadside 风格如需宋体，请确认字体配置"
        )

    report["ready"] = not report["errors"]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
