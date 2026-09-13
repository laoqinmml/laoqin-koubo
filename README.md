# 老秦口播剪辑（laoqin-koubo）

老秦个人定制的口播剪辑与发布工作流，聚合四个技能：

- `kbcut`：知识口播 AI 剪辑主流程（火山引擎转写、HyperFrames 包装、封面、发布物料），包含「5.2 字幕语义断行」必做步骤。
- `kbcut-style`：HyperFrames 风格预设（founder-interview 等）；横屏 IP 介绍整段常驻、竖屏仅 2–6 秒显示。
- `auto-kbcut-publish`：编排层，触发词「开始剪辑」，负责素材扫描、增量剪辑、活人感写作、gpt-image-2 生图封面、蚁小二定时发布与状态回写。
- `ffmpeg-hdr-color`：HDR/HLG → BT.709 SDR 的色调映射与色彩空间转换（kbcut 处理 iPhone HLG 素材时依赖）。上游为公开仓库 `damionrashford/media-os` 的 `skills/ffmpeg-hdr-color`，本仓库保存本地定制版：`hdrcolor.py` 增加 `--gpu`（有 NVENC 则走 GPU、否则自动回退 `libx264`），色调映射链与上游保持一致。同步上游更新时，注意保留这一处本地改动。

四个技能默认走 GPU 编码（NVENC）：口播优化版用 `hevc_nvenc`/`h264_nvenc -rc vbr -cq 26 -b:v 0`，成片压缩用 `h264_nvenc -cq 19 -b:v 8M`，HyperFrames 渲染加 `--gpu`；无显卡或编码失败时自动回退 CPU。实测 60 秒 1080p 素材：`libx264` 压缩耗 CPU 105.6s，`h264_nvenc` 约 2s。

另外本仓库保存一份 `yixiaoer/SKILL.md`：蚁小二 skill 本体由 `yxer update` 安装与更新，但 `SKILL.md` 开头那段「用户既定偏好（本机覆盖）」是本机定制，**执行过 `yxer update` 之后要把本仓库这份覆盖回 `C:\Users\NBAMA\.agents\skills\yixiaoer\SKILL.md`**，否则「发布一律走本机通道」等长期默认值会丢失。

账号映射、字幕规则与默认参数见 `auto-kbcut-publish/references/config.md`。
