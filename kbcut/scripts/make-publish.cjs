#!/usr/bin/env node
"use strict";

/**
 * Generate platform publish materials for a finished KB Cut clip.
 *
 * Inputs:
 *   --input-choices   work/input_choices.json
 *   --srt             work/复核转写/*_口播优化版.srt  (or any final SRT)
 *   --output          path to the publish markdown (required)
 *   --dbs-brief       optional path for the dbs scoring brief (default: sibling)
 *   --dbs-score       optional JSON/Markdown file produced after a local dbs pass
 *   --stem            optional title stem override
 *   --duration        optional finished duration in seconds
 *
 * The script is style-agnostic. It never embeds a private brand template.
 * Title / intro / tag drafts are derived from package_content + the SRT text.
 * Emitting the dbs brief file is always fine; *calling* a local $dbs-* skill is
 * an Agent decision gated by input_choices.dbs_scoring + local install — this
 * script never invokes dbs itself. Re-run with --dbs-score to merge results.
 */

const fs = require("fs");
const path = require("path");

const { parseSrt } = require("./lib/captions.cjs");
const { fail, parseArgs, readJson, probeDuration } = require("./lib/common.cjs");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function srtToPlainText(segments) {
  return segments
    .map((seg) => String(seg.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function srtToTimedText(segments) {
  return segments
    .map((seg) => {
      const start = Number(seg.start).toFixed(1);
      const end = Number(seg.end).toFixed(1);
      const text = String(seg.text || "").replace(/\s+/g, " ").trim();
      return `[${start}-${end}] ${text}`;
    })
    .join("\n");
}

function firstLines(text, n = 3) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, n);
}

function asLines(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && item.text) return String(item.text).trim();
        return "";
      })
      .filter(Boolean);
  }
  return String(value)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function deriveTags(content, plain) {
  const seeds = new Set();
  for (const line of [
    ...asLines(content.cover_title),
    ...asLines(content.side_title),
    ...asLines(content.topic_title),
  ]) {
    const compact = line.replace(/\s+/g, "");
    if (compact.length >= 2 && compact.length <= 12) seeds.add(compact);
  }
  // lightweight keyword harvest from plain transcript
  const candidates = plain.match(/[一-鿿A-Za-z0-9]{2,12}/g) || [];
  const stop = new Set([
    "我们",
    "你们",
    "他们",
    "一个",
    "这个",
    "那个",
    "什么",
    "怎么",
    "因为",
    "所以",
    "但是",
    "如果",
    "其实",
    "就是",
    "可以",
    "没有",
    "不是",
    "自己",
    "大家",
    "东西",
    "时候",
    "现在",
    "这种",
    "那样",
    "以及",
    "然后",
    "非常",
    "已经",
    "还是",
    "可能",
    "需要",
    "问题",
    "内容",
    "事情",
  ]);
  const freq = new Map();
  for (const word of candidates) {
    if (stop.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([word]) => seeds.add(word));

  // always useful defaults for knowledge talking-head
  ["个人IP", "自媒体", "知识付费", "内容创业"].forEach((tag) => seeds.add(tag));
  return [...seeds].slice(0, 14);
}

function draftTitles(content, plain) {
  const cover = asLines(content.cover_title);
  const side = asLines(content.side_title);
  const topic = asLines(content.topic_title);
  const core = (cover.length ? cover : side.length ? side : topic).join(" · ") || "核心观点待提炼";
  const first = firstLines(plain, 1)[0] || "";
  const titles = [];
  if (cover.length) titles.push(cover.join(""));
  if (side.length && side.join("") !== cover.join("")) titles.push(side.join(" · "));
  if (topic.length) {
    const t = topic.join("");
    if (!titles.includes(t)) titles.push(t);
  }
  if (first && first.length <= 28) titles.push(first.replace(/[，。！？、]/g, ""));
  titles.push(`${core}：你真正该想清楚的一件事`);
  // unique, keep 4
  const seen = new Set();
  const out = [];
  for (const title of titles) {
    const key = title.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 4) break;
  }
  while (out.length < 4) out.push(`${core}（方案 ${out.length + 1}）`);
  return out;
}

function draftIntro(content, plain, durationLabel) {
  const cover = asLines(content.cover_title).join(" / ") || asLines(content.side_title).join(" / ");
  const body = firstLines(plain, 8).join("\n");
  return [
    cover ? `${cover}。` : "",
    "",
    body,
    "",
    durationLabel ? `成片约 ${durationLabel}。` : "",
    "",
    "（本段为 SRT 提炼草稿，可按平台语气改写；若已跑本地 dbs 打分，以「dbs 诊断」一节为准。）",
  ]
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""))
    .join("\n")
    .trim();
}

function loadDbsScore(filePath) {
  if (!filePath) return null;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) fail(`--dbs-score not found: ${abs}`);
  const raw = readText(abs);
  if (abs.endsWith(".json")) {
    try {
      return { kind: "json", data: JSON.parse(raw), raw };
    } catch (error) {
      fail(`--dbs-score JSON parse failed: ${error.message}`);
    }
  }
  return { kind: "markdown", raw };
}

function renderDbsSection(score) {
  if (!score) {
    return [
      "## dbs 诊断",
      "",
      "> 尚未合并 dbs 打分（默认不调用 dbs）。",
      ">",
      "> 仅当本次任务 `dbs_scoring: true` 且本机已安装 dbs 时，才把 `*_dbs-文稿底稿.md` 交给本地 `$dbs-resonate` / `$dbs-hook`。",
      "> 将诊断保存为 `dbs-score.md` 或 `dbs-score.json` 后，用 `--dbs-score` 重跑本脚本合并。",
      "> KB Cut 不安装 dbs；未授权或本机无 dbs 时忽略本节即可。",
      "",
    ].join("\n");
  }

  if (score.kind === "markdown") {
    return ["## dbs 诊断", "", score.raw.trim(), ""].join("\n");
  }

  const data = score.data || {};
  const lines = ["## dbs 诊断", ""];
  if (data.score != null) lines.push(`- **综合分**：${data.score}`);
  if (data.verdict) lines.push(`- **结论**：${data.verdict}`);
  if (data.summary) lines.push(`- **摘要**：${data.summary}`);
  if (Array.isArray(data.strengths) && data.strengths.length) {
    lines.push("", "### 优点");
    data.strengths.forEach((item) => lines.push(`- ${item}`));
  }
  if (Array.isArray(data.risks) && data.risks.length) {
    lines.push("", "### 风险");
    data.risks.forEach((item) => lines.push(`- ${item}`));
  }
  if (Array.isArray(data.fixes) && data.fixes.length) {
    lines.push("", "### 改法");
    data.fixes.forEach((item) => lines.push(`- ${item}`));
  }
  if (data.raw_markdown) {
    lines.push("", "### 原始诊断", "", String(data.raw_markdown).trim());
  }
  if (lines.length === 2) {
    lines.push("```json");
    lines.push(JSON.stringify(data, null, 2));
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

function buildDbsBrief({ stem, plain, timed, durationLabel, choices }) {
  const speaker = (choices.package_content || {}).speaker_name || (choices.ip_profile || {}).name || "";
  return `# dbs 文稿底稿 · ${stem}

> 由 KB Cut 从成片 SRT 导出。仅当用户授权 \`dbs_scoring: true\` 且本机已安装 dbs 时，
> 才交给本地 \`/dbs-resonate\` / \`/dbs-hook\`。**不要上传云端**；KB Cut 不负责安装 dbs。

## 元信息

| 项 | 值 |
| --- | --- |
| 选题 | ${stem} |
| 讲者 | ${speaker || "—"} |
| 成片时长 | ${durationLabel || "—"} |
| 风格 | ${(choices.style_id || "—")} |
| 画幅 | ${(choices.aspect_ratio || "—")} |

## 纯文稿（给 dbs 打分用）

${plain}

## 带时间轴文稿（可选，逻辑/划走点诊断用）

${timed}

## 请 dbs 输出（建议结构）

请本地 dbs skill 至少返回：

1. **综合判断**：能不能发 / 主要风险一句话
2. **共鸣结构**：核心机制是否单一、刺点在哪
3. **开头 3 秒**：是否独立建立吸引力（可走 \`$dbs-hook\`）
4. **标题候选**：3–5 条，并说明机制
5. **可执行改法**：删 / 留 / 强化 各 1–3 条

把结果保存为同目录 \`dbs-score.md\`（自然语言）或 \`dbs-score.json\`：

\`\`\`json
{
  "score": 0-100,
  "verdict": "可发 / 改后发 / 不建议发",
  "summary": "一句话",
  "strengths": ["..."],
  "risks": ["..."],
  "fixes": ["..."],
  "title_suggestions": ["..."],
  "raw_markdown": "完整诊断正文（可选）"
}
\`\`\`

然后运行：

\`\`\`bash
node $KBCUT/scripts/make-publish.cjs \\
  --input-choices <work>/input_choices.json \\
  --srt <work>/复核转写/<stem>_口播优化版.srt \\
  --dbs-score <work>/dbs-score.md \\
  --output <交付目录>/<stem>_发布物料.md
\`\`\`
`;
}

function buildPublishMarkdown(ctx) {
  const {
    stem,
    durationLabel,
    choices,
    titles,
    intro,
    tags,
    content,
    dbsSection,
    srtPath,
    videoHint,
    coverHint,
    optimizedHint,
    dbsBriefPath,
  } = ctx;

  const speaker = content.speaker_name || (choices.ip_profile || {}).name || "—";
  const aspect = choices.aspect_ratio || "—";
  const style = choices.style_id || "—";
  const coverLines = asLines(content.cover_title).join(" / ") || "—";
  const sideLines = asLines(content.side_title).join(" / ") || "—";
  const annotations = Array.isArray(content.annotation_segments)
    ? content.annotation_segments.length
    : 0;

  return `# ${stem} · 发布物料

> 由 KB Cut \`make-publish.cjs\` 生成。标题 / 简介 / tag 为草稿，可经本地 dbs 打分后重跑合并。

## 成片路径

| 类型 | 路径 |
| --- | --- |
| 包装成片 | ${videoHint || "（填写包装成片绝对路径）"} |
| 封面 | ${coverHint || "（填写封面 PNG 绝对路径）"} |
| 口播优化版 | ${optimizedHint || "（填写口播优化版绝对路径）"} |
| 成片 SRT | \`${srtPath}\` |
| dbs 底稿 | \`${dbsBriefPath}\` |

## 元信息

| 项 | 值 |
| --- | --- |
| 风格 | ${style} |
| 画幅 | ${aspect} |
| 时长 | ${durationLabel || "—"} |
| 讲者 | ${speaker} |
| 封面文案 | ${coverLines} |
| 侧栏/启发标题 | ${sideLines} |
| 概念注解条数 | ${annotations} |

## 推荐标题（选 1）

${titles.map((title, i) => `${i + 1}. **${title}**${i === 0 ? "（推荐草稿）" : ""}`).join("\n")}

## 视频简介（可直接粘贴后改）

\`\`\`
${intro}
\`\`\`

## Tags / 话题

${tags.map((tag) => `\`${tag}\``).join(" ")}

${dbsSection}

## 使用说明

1. 先用包装成片 + 封面发平台；简介与 tag 可按平台字数裁剪。
2. dbs 打分**非默认**：仅当本次 \`dbs_scoring: true\` 且本机已有 dbs 时，才把底稿交给本地 dbs，结果写入 \`dbs-score.md\` 后重跑本脚本。
3. 未授权或本机无 dbs 时，本文件仍可完整交付；KB Cut 不安装 dbs。
4. 所有路径均为本地绝对路径，**不要上传转写或成片到云端**。
`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args["input-choices"]) fail("--input-choices is required");
  if (!args.srt) fail("--srt is required");
  if (!args.output) fail("--output is required");

  const choicesPath = path.resolve(args["input-choices"]);
  const srtPath = path.resolve(args.srt);
  const outputPath = path.resolve(args.output);
  if (!fs.existsSync(choicesPath)) fail(`input_choices not found: ${choicesPath}`);
  if (!fs.existsSync(srtPath)) fail(`srt not found: ${srtPath}`);

  const choices = readJson(choicesPath);
  const content = choices.package_content || {};
  const segments = parseSrt(readText(srtPath));
  if (!segments.length) fail(`SRT has no segments: ${srtPath}`);

  const plain = srtToPlainText(segments);
  const timed = srtToTimedText(segments);

  let durationSec = args.duration != null ? Number(args.duration) : null;
  if (!Number.isFinite(durationSec)) {
    const optimized = choices.optimized_video;
    if (optimized && fs.existsSync(optimized)) {
      try {
        durationSec = probeDuration(optimized);
      } catch {
        durationSec = segments[segments.length - 1].end;
      }
    } else {
      durationSec = segments[segments.length - 1].end;
    }
  }
  const durationLabel = formatClock(durationSec);

  const stem =
    args.stem ||
    path.basename(outputPath).replace(/_发布物料\.md$/i, "") ||
    path.basename(path.dirname(choicesPath));

  const dbsBriefPath = path.resolve(
    args["dbs-brief"] || path.join(path.dirname(outputPath), `${stem}_dbs-文稿底稿.md`),
  );
  const dbsScore = args["dbs-score"] ? loadDbsScore(args["dbs-score"]) : null;

  // Prefer dbs title suggestions when provided as JSON
  let titles = draftTitles(content, plain);
  if (dbsScore && dbsScore.kind === "json" && Array.isArray(dbsScore.data.title_suggestions)) {
    const fromDbs = dbsScore.data.title_suggestions.map(String).filter(Boolean);
    if (fromDbs.length) titles = [...fromDbs, ...titles].slice(0, 4);
  }

  const tags = deriveTags(content, plain);
  const intro = draftIntro(content, plain, durationLabel);
  const dbsSection = renderDbsSection(dbsScore);

  const videoHint = choices.delivery_video || choices.package_video || "";
  const coverHint = choices.delivery_cover || "";
  const optimizedHint = choices.optimized_video || "";

  const publishMd = buildPublishMarkdown({
    stem,
    durationLabel,
    choices,
    titles,
    intro,
    tags,
    content,
    dbsSection,
    srtPath,
    videoHint,
    coverHint,
    optimizedHint,
    dbsBriefPath,
  });

  const briefMd = buildDbsBrief({
    stem,
    plain,
    timed,
    durationLabel,
    choices,
  });

  writeText(outputPath, publishMd);
  writeText(dbsBriefPath, briefMd);

  // machine-readable sidecar for agents
  const sidecar = {
    stem,
    duration_seconds: durationSec,
    duration_label: durationLabel,
    srt: srtPath,
    publish_md: outputPath,
    dbs_brief: dbsBriefPath,
    dbs_score: args["dbs-score"] ? path.resolve(args["dbs-score"]) : null,
    titles,
    tags,
    speaker: content.speaker_name || (choices.ip_profile || {}).name || null,
    style_id: choices.style_id || null,
    aspect_ratio: choices.aspect_ratio || null,
  };
  const sidecarPath = outputPath.replace(/\.md$/i, ".json");
  writeText(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");

  console.log(`✓ 发布物料  ${outputPath}`);
  console.log(`✓ dbs 底稿  ${dbsBriefPath}`);
  console.log(`✓ 侧车 JSON ${sidecarPath}`);
  console.log(`  时长      ${durationLabel}`);
  console.log(`  标题草稿  ${titles[0]}`);
  console.log(`  Tags      ${tags.slice(0, 6).join(" · ")}`);
  console.log(
    dbsScore
      ? "  dbs       已合并 --dbs-score"
      : "  dbs       未合并分数（需 dbs_scoring:true 且本机有 dbs）",
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = { srtToPlainText, draftTitles, deriveTags };
