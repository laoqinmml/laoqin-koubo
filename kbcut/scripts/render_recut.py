#!/usr/bin/env python3
"""按保留片段计划渲染口播，同时延续原素材色彩元数据。"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shlex
import subprocess
import tempfile
from pathlib import Path


def create_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description, add_help=False)
    parser._positionals.title = "位置参数"
    parser._optionals.title = "可选参数"
    parser.add_argument("-h", "--help", action="help", help="显示本帮助并退出")
    return parser


def run(command: list[str], capture: bool = False) -> subprocess.CompletedProcess[str]:
    print(shlex.join(command), flush=True)
    return subprocess.run(
        command,
        check=True,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def probe(source: Path) -> tuple[dict, dict]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(source),
        ],
        capture=True,
    )
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    return stream, payload.get("format", {})


_ENCODERS: str | None = None


def available_encoders() -> str:
    global _ENCODERS
    if _ENCODERS is None:
        _ENCODERS = run(["ffmpeg", "-hide_banner", "-encoders"], capture=True).stdout
    return _ENCODERS


def headroom(bitrate: str, factor: float = 1.5) -> str | None:
    """把 "10.5M" 这类目标码率放大成峰值码率；解析不出来时返回 None。"""
    match = re.fullmatch(r"\s*([0-9.]+)\s*([kKmM]?)\s*", bitrate or "")
    if not match:
        return None
    value = float(match.group(1)) * factor
    unit = match.group(2) or ""
    return f"{value:.0f}{unit}"


def select_encoder(stream: dict, override: str | None) -> tuple[str, str, str]:
    if override:
        encoder = override
    else:
        source_codec = stream.get("codec_name")
        ten_bit = "10" in stream.get("pix_fmt", "")
        use_hevc = source_codec == "hevc" or ten_bit
        encoders = available_encoders()
        videotoolbox = "hevc_videotoolbox" if use_hevc else "h264_videotoolbox"
        nvenc = "hevc_nvenc" if use_hevc else "h264_nvenc"
        if platform.system() == "Darwin" and videotoolbox in encoders:
            encoder = videotoolbox
        elif platform.system() == "Windows" and nvenc in encoders:
            # 2026-09-12 实测（1080p30 10-bit 源，10 秒素材）：libx265 medium 耗
            # CPU 196.5s、墙钟 40.4s，hevc_nvenc 耗 CPU 17.4s、墙钟 3.8s；
            # H.264 侧 libx264 medium 105.6s、墙钟 17.5s → h264_nvenc 43.9s、墙钟 11.6s。
            # 画质对拍 SSIM 0.9502 → 0.9487、PSNR 33.33 → 33.33，肉眼无差异。
            encoder = nvenc
        else:
            encoder = "libx265" if use_hevc else "libx264"

    hevc = "265" in encoder or "hevc" in encoder
    ten_bit = "10" in stream.get("pix_fmt", "")
    hardware_10bit = "videotoolbox" in encoder or "nvenc" in encoder
    pixel_format = "p010le" if hevc and ten_bit and hardware_10bit else None
    if pixel_format is None:
        pixel_format = "yuv420p10le" if hevc and ten_bit else "yuv420p"
    return encoder, pixel_format, "hvc1" if hevc else "avc1"


def color_args(stream: dict) -> list[str]:
    mapping = {
        "color_primaries": "-color_primaries",
        "color_transfer": "-color_trc",
        "color_space": "-colorspace",
        "color_range": "-color_range",
    }
    result: list[str] = []
    for field, option in mapping.items():
        value = stream.get(field)
        if value and value not in {"unknown", "unspecified"}:
            result.extend([option, str(value)])
    return result


def codec_args(encoder: str, stream: dict, plan: dict) -> list[str]:
    bitrate = str(plan.get("video_bitrate") or stream.get("bit_rate") or "8M")
    if "videotoolbox" in encoder:
        options = ["-allow_sw", "1", "-b:v", bitrate]
        if "hevc" in encoder and "10" in stream.get("pix_fmt", ""):
            options.extend(["-profile:v", "main10"])
        return options
    if "nvenc" in encoder:
        hevc = "hevc" in encoder
        options = [
            "-preset",
            str(plan.get("nvenc_preset", "p5")),
            "-tune",
            str(plan.get("nvenc_tune", "hq")),
            "-rc",
            "vbr",
            "-cq",
            str(plan.get("cq", 26)),
        ]
        if plan.get("video_bitrate"):
            options.extend(["-b:v", str(plan["video_bitrate"])])
            peak = str(plan.get("maxrate") or "") or headroom(str(plan["video_bitrate"]))
            if peak:
                options.extend(["-maxrate", peak, "-bufsize", "12M"])
        else:
            # 纯 CQ，让编码器按画面复杂度分配码率。2026-09-12 实测（720p 素材，
            # 17 秒）：cq26 出 2.46 Mbps / SSIM 0.9829，旧默认 libx264 crf20 是
            # 2.41 Mbps / SSIM 0.9818——码率持平、画质略优。cq 尺度比 x264 的 crf
            # 松，用 cq19 会膨胀到 12.9 Mbps，不要照搬 crf 数值。
            options.extend(["-b:v", "0"])
        if hevc and "10" in stream.get("pix_fmt", ""):
            options.extend(["-profile:v", "main10"])
        return options
    if encoder == "libx265":
        return ["-preset", str(plan.get("preset", "medium")), "-crf", str(plan.get("crf", 20))]
    return ["-preset", str(plan.get("preset", "medium")), "-crf", str(plan.get("crf", 18))]


def apply_output_drops(segments: list[dict], drop_ranges: list[dict]) -> list[dict]:
    drops = sorted((float(item["start"]), float(item["end"])) for item in drop_ranges)
    for index, (start, end) in enumerate(drops):
        if start < 0 or end <= start or (index and start < drops[index - 1][1]):
            raise ValueError(f"删除区间无效或互相重叠：{start} -> {end}")

    result: list[dict] = []
    output_cursor = 0.0
    for segment in segments:
        source_start = float(segment["start"])
        source_end = float(segment["end"])
        output_start = output_cursor
        output_end = output_start + source_end - source_start
        output_cursor = output_end
        intersections = [
            (max(start, output_start), min(end, output_end))
            for start, end in drops
            if end > output_start and start < output_end
        ]
        keep_cursor = output_start
        for start, end in intersections:
            if start - keep_cursor > 0.04:
                result.append(
                    {
                        **segment,
                        "start": source_start + keep_cursor - output_start,
                        "end": source_start + start - output_start,
                    }
                )
            keep_cursor = max(keep_cursor, end)
        if output_end - keep_cursor > 0.04:
            result.append(
                {
                    **segment,
                    "start": source_start + keep_cursor - output_start,
                    "end": source_end,
                }
            )
    return result


def main() -> None:
    parser = create_parser("根据 edit_plan.json 渲染口播优化版。")
    parser.add_argument("plan", type=Path, help="剪辑计划 JSON 路径")
    args = parser.parse_args()

    plan_path = args.plan.expanduser().resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    source = Path(plan["source"]).expanduser().resolve()
    output = Path(plan["output"]).expanduser().resolve()
    if source == output:
        raise ValueError("输出文件不能覆盖原始素材")
    if not source.is_file():
        raise FileNotFoundError(f"原始素材不存在：{source}")

    stream, source_format = probe(source)
    source_duration = float(source_format.get("duration") or 0)
    encoder, pixel_format, codec_tag = select_encoder(stream, plan.get("video_encoder"))
    colors = color_args(stream)
    video_options = codec_args(encoder, stream, plan)
    source_frame_rate = stream.get("r_frame_rate") or stream.get("avg_frame_rate") or "30"
    frame_rate = str(
        plan.get("output_frame_rate")
        or (
            "30"
            if "videotoolbox" in encoder and "10" in stream.get("pix_fmt", "")
            else source_frame_rate
        )
    )
    segments = apply_output_drops(plan["segments"], plan.get("drop_ranges", []))
    if not segments:
        raise ValueError("剪辑计划中没有保留片段")

    for index, segment in enumerate(segments):
        start = float(segment["start"])
        end = float(segment["end"])
        if start < 0 or end - start <= 0.04 or (source_duration and end > source_duration + 0.05):
            raise ValueError(f"第 {index} 个片段无效：{start} -> {end}")

    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(f"{output.stem}_rendering{output.suffix}")

    with tempfile.TemporaryDirectory(prefix=f"{source.stem}_recut_", dir=plan_path.parent) as temp_name:
        temp_dir = Path(temp_name)
        concat_lines = ["ffconcat version 1.0"]
        for index, segment in enumerate(segments):
            start = float(segment["start"])
            duration = float(segment["end"]) - start
            fade = min(0.008, duration / 4)
            segment_path = temp_dir / f"segment_{index:04d}.mov"
            command = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                f"{duration:.3f}",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-map_metadata",
                "0",
                "-af",
                f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={duration - fade:.3f}:d={fade:.3f}",
                "-c:v",
                encoder,
                "-vf",
                f"fps={frame_rate},format={pixel_format}",
                *video_options,
                "-tag:v",
                codec_tag,
                *colors,
                "-c:a",
                "pcm_s16le",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-shortest",
                str(segment_path),
            ]
            run(command)
            escaped = str(segment_path).replace("'", "'\\''")
            concat_lines.append(f"file '{escaped}'")

        concat_path = temp_dir / "segments.ffconcat"
        concat_path.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_path),
                "-map_metadata",
                "0",
                "-c:v",
                "copy",
                "-tag:v",
                codec_tag,
                *colors,
                "-c:a",
                "aac",
                "-b:a",
                str(plan.get("audio_bitrate", "192k")),
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                str(pending),
            ]
        )
        pending.replace(output)

    output_stream, output_format = probe(output)
    print(
        json.dumps(
            {
                "output": str(output),
                "duration": output_format.get("duration"),
                "encoder": encoder,
                "pixel_format": output_stream.get("pix_fmt"),
                "color_primaries": output_stream.get("color_primaries"),
                "color_transfer": output_stream.get("color_transfer"),
                "color_space": output_stream.get("color_space"),
                "color_range": output_stream.get("color_range"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
