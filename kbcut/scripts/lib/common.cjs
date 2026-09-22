"use strict";

/**
 * Shared plumbing for the KB Cut template generators.
 *
 * Both make-package.cjs (in-video three-layer packaging) and make-cover.cjs
 * (cover) fill a style-owned template from a style-owned frame.md. Everything
 * that is the same between them lives here; everything that differs is the
 * style's business, not this file's.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { collectPlaceholders } = require("./frame_md.cjs");

/**
 * Placeholders the scripts supply themselves. A style never declares these in
 * frame.md's `templates` block, but a template may use them freely.
 */
const RESERVED_PLACEHOLDERS = new Set([
  "COMPOSITION_ID",
  "COMPOSITION_WIDTH",
  "COMPOSITION_HEIGHT",
  "DURATION_SECONDS",
  "LAYOUT_VARS",
  "VIDEO_SRC",
  "COVER_BACKGROUND_SRC",
  "FONT_BODY_NORMAL",
  "FONT_BODY_BOLD",
  "FONT_COVER_TITLE",
  "FONT_CAPTION_NORMAL",
  "FONT_TITLE_SANS",
]);

function fail(message, hint) {
  const lines = [`${path.basename(process.argv[1] || "kbcut")}: ${message}`];
  if (hint) lines.push(`  → ${hint}`);
  console.error(lines.join("\n"));
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read JSON from ${file}`, error.message);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse "60cqh" / "4.8cqw" / 1.0 into a number, dropping the unit. */
function toNumber(value) {
  if (typeof value === "number") return value;
  if (value === undefined || value === null) return null;
  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function ffprobeJson(video, extra) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", ...extra, "-of", "json", video],
      { encoding: "utf8" },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function probeDimensions(video) {
  const data = ffprobeJson(video, [
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
  ]);
  const stream = data && data.streams && data.streams[0];
  if (!stream || !stream.width || !stream.height) return null;
  return { width: stream.width, height: stream.height };
}

function hasAudioStream(media) {
  const data = ffprobeJson(media, ["-select_streams", "a", "-show_entries", "stream=index"]);
  return Boolean(data && Array.isArray(data.streams) && data.streams.length > 0);
}

function probeDuration(video) {
  const data = ffprobeJson(video, ["-show_entries", "format=duration"]);
  const value = data && data.format && Number(data.format.duration);
  return Number.isFinite(value) ? value : null;
}

/**
 * Warn when the reframe throws away most of the picture. Not fatal: the user
 * may have confirmed exactly this crop at the 0.4.1 gate.
 */
function warnOnHeavyCrop(source, width, height) {
  if (!source) return null;
  const sourceRatio = source.width / source.height;
  const targetRatio = width / height;
  const loss = 1 - Math.min(sourceRatio, targetRatio) / Math.max(sourceRatio, targetRatio);
  if (loss > 0.35) {
    console.warn(
      `⚠ 把 ${source.width}×${source.height} 裁进 ${width}×${height} 会丢掉约 ` +
        `${Math.round(loss * 100)}% 的画面，人物可能装不下。渲染前请确认裁切方案。`,
    );
  }
  return loss;
}

/**
 * Validate a template against the style's declared contract.
 *
 * `kind` selects the entry in frame.md's `templates` block. Errors when the
 * template uses a placeholder the style never declared; warns when the style
 * declares one the template ignores. Reserved placeholders are exempt.
 */
function validateContract(frame, templateText, kind) {
  const entry = ((frame.templates || {})[kind] || {});
  const declared = new Set(entry.placeholders || []);
  if (declared.size === 0) {
    console.warn(
      `frame.md declares no templates.${kind}.placeholders; skipping the contract check. ` +
        `Add the block so a mistyped placeholder fails loudly instead of rendering blank.`,
    );
    return;
  }

  const used = collectPlaceholders(templateText);
  const undeclared = used.filter(
    (name) => !declared.has(name) && !RESERVED_PLACEHOLDERS.has(name),
  );
  const unused = [...declared].filter((name) => !used.includes(name));

  if (undeclared.length > 0) {
    fail(
      `${kind} template uses placeholders frame.md does not declare: ${undeclared.join(", ")}`,
      `Add them to templates.${kind}.placeholders in frame.md, or remove them from the template.`,
    );
  }
  if (unused.length > 0) {
    console.warn(
      `frame.md declares ${kind} placeholders the template never uses: ${unused.join(", ")}`,
    );
  }
}

/**
 * Resolve the CSS custom properties a template reads.
 *
 * Layers are applied lowest precedence first. Each is a plain object of
 * unprefixed keys ("title-top") or already-prefixed ones ("--title-top");
 * both forms are accepted so callers can pass frame.md blocks directly.
 */
function resolveLayoutVars(layers) {
  const vars = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || value === null) continue;
      vars[key.startsWith("--") ? key : `--${key}`] = value;
    }
  }
  return vars;
}

function buildLayoutCss(vars, indent = "        ") {
  return Object.entries(vars)
    .map(([key, value]) => `${key}: ${value};`)
    .join(`\n${indent}`);
}

/** Map a confirmed crop anchor onto an object-position value. */
function anchorToPosition(anchor, offset) {
  if (anchor === "custom" && offset) return String(offset);
  return { top: "0%", center: "50%", bottom: "100%" }[anchor] ?? "50%";
}

/** Copy when absent or changed; skip identical files so re-runs stay cheap. */
function syncFile(source, target) {
  if (!fs.existsSync(source)) fail(`missing file: ${source}`);
  if (fs.existsSync(target)) {
    const a = fs.statSync(source);
    const b = fs.statSync(target);
    if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

/**
 * 把字体目录挂到生成目录旁边（Windows 用目录 Junction，其它平台逐文件同步）。
 *
 * 为什么必须放在 HTML 旁边：实测 Chrome 在 `file://` 页面下**拒绝加载跨目录的
 * 字体**——@font-face 写绝对路径 `file:///E:/…/fonts/优设标题黑.ttf`（编码与不编码
 * 都试过）都会静默回退成默认字体（实测标题墨迹从 69.5% 变成 74.7%，字形也不对）。
 * 所以字体必须在 index.html 同级。用 Junction 指回预设：目录能解析、**磁盘上不复制**。
 */
function syncFontLink(fontDir, outputDir) {
  const target = path.join(outputDir, "fonts");
  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink() && path.resolve(fs.readlinkSync(target)) === path.resolve(fontDir)) return;
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  if (process.platform === "win32") {
    fs.symlinkSync(fontDir, target, "junction");
    return;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(fontDir)) {
    syncFile(path.join(fontDir, entry), path.join(target, entry));
  }
}

/**
 * Resolve the font files a template needs out of the style preset.
 * `roles` maps a frame.md fonts key to the reserved placeholder that carries
 * its relative path, e.g. { "cover-title": "FONT_COVER_TITLE" }.
 *
 * 占位符填的是 `fonts/xxx.otf`（相对 index.html 的路径），所以模板统一写
 * `url("{{FONT_X}}")`；字体目录以 Junction 形式落在生成目录里，项目其它地方
 * （尤其 `工作文件/fonts`）不再出现字体包。
 */
function copyFonts(frame, fontDir, outputDir, roles) {
  const fonts = frame.fonts || {};
  const result = {};

  for (const [role, placeholder] of Object.entries(roles)) {
    const declared = fonts[role];
    if (!declared) fail(`frame.md must declare fonts.${role}`);
    const file = path.basename(declared);
    const source = path.join(fontDir, file);
    if (!fs.existsSync(source)) {
      fail(
        `font file missing: ${source}`,
        "Copy the style preset with kbcut-style --copy-to so fonts/ travels with frame.md.",
      );
    }
    result[placeholder] = `fonts/${file}`;
  }
  syncFontLink(fontDir, outputDir);
  return result;
}

/** Substitute every {{NAME}} and fail loudly if any survive. */
function fillTemplate(template, replacements) {
  let output = template.replace(/<!--@template-doc[\s\S]*?-->\n?/, "");
  for (const [name, value] of Object.entries(replacements)) {
    output = output.split(`{{${name}}}`).join(value);
  }
  const leftover = collectPlaceholders(output);
  if (leftover.length > 0) {
    fail(`unfilled placeholders remain: ${leftover.join(", ")}`);
  }
  return output;
}

/** Locate frame.md and one of the style's templates from input_choices.json. */
function resolveStyleFiles(choices, args, kind, defaultFile) {
  const framePath = path.resolve(
    args.frame || choices.frame_copy || choices.frame_source || fail("no frame.md in input_choices"),
  );
  if (!fs.existsSync(framePath)) fail(`frame.md not found: ${framePath}`);

  const key = kind === "cover" ? "cover_template_source" : "template_source";
  const templatePath = path.resolve(
    args.template || choices[key] || (kind === "cover" ? choices.cover_source : null) || path.join(path.dirname(framePath), defaultFile),
  );
  if (!fs.existsSync(templatePath)) {
    fail(
      `style "${choices.style_id}" ships no ${defaultFile}`,
      `expected at ${templatePath}. A style owns both its packaging template and its ` +
        `cover template; add the missing one to the preset rather than hand-building this video's.`,
    );
  }

  // 字体解析目录（本地定制 2026-09-18）：项目里**没有真实字体目录**时回落到风格预设的
  // fonts/，于是项目内不必存字体副本，模板通过相对路径 fonts/xxx 加载（生成目录里会建
  // 一个指向预设的 Junction）。只有用户自己往项目里放了**真实**字体目录时才优先用它。
  // 注意不能把「指向预设的 Junction」当成源：一旦那个 Junction 被删就会悬空（踩过）。
  const copyFontDir = path.join(path.dirname(framePath), "fonts");
  let copyIsRealDir = false;
  try {
    const st = fs.lstatSync(copyFontDir);
    copyIsRealDir = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    copyIsRealDir = false;
  }
  const sourceFrame = args.frame || choices.frame_source || "";
  const presetFontDir = sourceFrame ? path.join(path.dirname(path.resolve(sourceFrame)), "fonts") : "";
  const fontDir = copyIsRealDir
    ? copyFontDir
    : presetFontDir && fs.existsSync(presetFontDir)
      ? presetFontDir
      : copyFontDir;

  return { framePath, templatePath, fontDir };
}

module.exports = {
  RESERVED_PLACEHOLDERS,
  anchorToPosition,
  buildLayoutCss,
  copyFonts,
  escapeHtml,
  fail,
  fillTemplate,
  hasAudioStream,
  parseArgs,
  probeDimensions,
  probeDuration,
  readJson,
  resolveLayoutVars,
  resolveStyleFiles,
  syncFile,
  toNumber,
  validateContract,
  warnOnHeavyCrop,
};
