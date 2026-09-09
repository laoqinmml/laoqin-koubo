# 老秦口播剪辑（laoqin-koubo）

老秦个人定制的口播剪辑与发布工作流，聚合三个技能：

- `kbcut`：知识口播 AI 剪辑主流程（火山引擎转写、HyperFrames 包装、封面、发布物料），包含「5.2 字幕语义断行」必做步骤。
- `kbcut-style`：HyperFrames 风格预设（founder-interview 等）；横屏 IP 介绍整段常驻、竖屏仅 2–6 秒显示。
- `auto-kbcut-publish`：编排层，触发词「开始剪辑」，负责素材扫描、增量剪辑、活人感写作、gpt-image-2 生图封面、蚁小二定时发布与状态回写。

账号映射、字幕规则与默认参数见 `auto-kbcut-publish/references/config.md`。
