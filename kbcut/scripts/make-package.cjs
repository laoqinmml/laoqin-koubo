#!/usr/bin/env node
"use strict";

/**
 * Generate a renderable HyperFrames packaging project from a KB Cut work directory.
 *
 * This script is style-agnostic. It does not know what a "topic lockup" is; it
 * fills whatever placeholders the active style's template.html declares, using
 * the layout numbers that style's frame.md defines. All founder-interview (or
 * any other preset's) visual knowledge lives in $kbcut-style, never here.
 *
 * The cover half of the same contract is make-cover.cjs.
 *
 * Usage:
 *   node make-package.cjs \
 *     --input-choices <work>/input_choices.json \
 *     --srt <work>/复核转写/xxx_口播优化版.srt \
 *     --video <work>/xxx_口播优化版.mp4 \
 *     --output <work>/hyperframes/package
 */

const fs = require("fs");
const path = require("path");

const { parseFrameMd } = require("./lib/frame_md.cjs");
const { parseSrt, buildCaptions } = require("./lib/captions.cjs");
const {
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
} = require("./lib/common.cjs");

const COMPOSITION_ID = "kbcut";

/* --------------------------------------------------------- content rendering */

/**
 * Render a topic line into mixed-weight spans.
 *
 * Accepts a plain string (rendered as one strong span) or an array of
 * {text, weight} where weight is strong | light | accent. Structured input is
 * preferred: it lets the caller compose emphasis without writing raw HTML.
 */
function renderTopicLine(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return `<span class="t-strong">${escapeHtml(value)}</span>`;
  }
  if (!Array.isArray(value)) return "";
  return value
    .map((span) => {
      const weight = span.weight === "light" || span.weight === "accent" ? span.weight : "strong";
      return `<span class="t-${weight}">${escapeHtml(span.text ?? "")}</span>`;
    })
    .join("");
}

function renderCredentials(list) {
  if (!Array.isArray(list)) return "";
  return list
    .filter((line) => String(line ?? "").trim() !== "")
    .map((line) => `<div class="credential">${escapeHtml(line)}</div>`)
    .join("\n            ");
}

/**
 * Render the hook topic title used by cognition-style frames.
 *
 * Accepts a plain string (split on newlines into .topic-line divs), an array of
 * strings, or an array of {text} / {text, weight} spans collapsed per line.
 * Styles that still use topic_line_1 / topic_line_2 ignore this helper.
 */
function renderTopicTitle(value) {
  if (!value) return "";
  // data-layout-allow-overlap: the oversized hook title is meant to sit over
  // the countdown for ~3s; hyperframes layout check must not fail that.
  const line = (text) =>
    `<div class="topic-line" data-layout-allow-overlap>${escapeHtml(text)}</div>`;
  if (typeof value === "string") {
    return value
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(line)
      .join("\n          ");
  }
  if (!Array.isArray(value)) return "";
  // Array of strings → one line each. Array of span objects → single line.
  if (value.every((item) => typeof item === "string")) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .map(line)
      .join("\n          ");
  }
  const text = value.map((span) => (typeof span === "string" ? span : span.text ?? "")).join("");
  return text ? line(text) : "";
}

/**
 * Normalize annotation segments for the packaging template.
 * Each item: {start, end, text} or {start, end, lines: string[]}.
 */
function renderAnnotationSegments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (Array.isArray(item.lines)) {
        const lines = item.lines.map((line) => String(line ?? "").trim()).filter(Boolean);
        if (lines.length === 0) return null;
        return { start, end, lines };
      }
      const text = String(item.text ?? "").trim();
      if (!text) return null;
      return { start, end, text };
    })
    .filter(Boolean);
}

/**
 * Render a multi-line side-column title (persistent thesis lockup).
 * Accepts a string (split on newlines), an array of strings, or span arrays.
 */
function renderSideTitle(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<div class="side-title-line">${escapeHtml(line)}</div>`)
      .join("\n            ");
  }
  if (!Array.isArray(value)) return "";
  if (value.every((item) => typeof item === "string")) {
    return value
      .map((line) => String(line ?? "").trim())
      .filter(Boolean)
      .map((line) => `<div class="side-title-line">${escapeHtml(line)}</div>`)
      .join("\n            ");
  }
  const text = value.map((span) => (typeof span === "string" ? span : span.text ?? "")).join("");
  return text ? `<div class="side-title-line">${escapeHtml(text)}</div>` : "";
}

/** Render speaker intro lines for the left column. */
function renderSpeakerIntro(list) {
  if (!list) return "";
  const lines = Array.isArray(list) ? list : String(list).split(/\n+/);
  return lines
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .map((line) => `<div class="speaker-line">${escapeHtml(line)}</div>`)
    .join("\n            ");
}

/* ------------------------------------------------------------ layout cascade */

/**
 * Resolve the CSS custom properties the packaging template reads.
 *
 * Cascade, lowest precedence first:
 *   1. frame.md `spacing` + `typography`      — the style baseline
 *   2. frame.md `aspect-variants[<ratio>]`    — per aspect ratio
 *   3. frame.md `shot-profiles[<name>]`       — per framing archetype
 *   4. input_choices `crop_plan`              — the user's confirmed crop
 *   5. input_choices `layout_overrides`       — final manual nudges
 */
function resolveLayout(frame, choices, shotProfileName) {
  const spacing = frame.spacing || {};
  const typography = frame.typography || {};
  const variants = frame["aspect-variants"] || {};
  const profiles = frame["shot-profiles"] || {};

  const ratio = choices.aspect_ratio;
  const variant = variants[ratio] || {};
  if (!variants[ratio]) {
    console.warn(
      `make-package: frame.md declares no aspect-variant for ${ratio}; ` +
        `using the style baseline. Add one to the preset for a tuned layout.`,
    );
  }

  const baseline = {
    "safe-x": spacing["safe-x"],
    "title-top": spacing["title-top"],
    "title-gap": spacing["title-gap"],
    "title-rule-width": spacing["title-rule-width"],
    "title-rule-height": spacing["title-rule-height"],
    // The credentials block flows under the topic block, so its position is a
    // gap rather than an absolute top. spacing.credentials-top documents where
    // that lands for a normal two-line topic; it is not consumed directly.
    "credentials-gap": spacing["credentials-gap"] ?? "2.2cqh",
    "caption-zone-top": spacing["caption-zone-top"],
    "caption-zone-bottom": spacing["caption-zone-bottom"],
    "caption-max-width": spacing["caption-max-width"],
    "progress-gap": spacing["progress-gap"] ?? "2.2cqh",
    "progress-height": spacing["progress-height"] ?? "0.34cqh",
    "progress-width": spacing["progress-width"] ?? spacing["caption-max-width"],
    "progress-track-color": (frame.colors || {})["progress-track"] ?? "rgba(255,255,255,0.30)",
    "progress-fill-color": (frame.colors || {})["progress-fill"] ?? "#FFD21F",
    "title-max-width": spacing["title-max-width"] ?? spacing["topic-max-width"] ?? "62cqw",
    "credentials-max-width": "56cqw",
    "video-anchor-x": "50%",
    "video-anchor-y": "50%",
    "video-scale": "1",
    // Optional cognition-frame layout tokens. Styles that never reference
    // them (e.g. founder-interview) ignore the unused CSS variables.
    "topic-top": spacing["topic-top"] ?? spacing["title-top"] ?? "10cqh",
    "topic-gap": spacing["topic-gap"] ?? spacing["title-gap"] ?? "0.6cqh",
    "topic-max-width": spacing["topic-max-width"] ?? "88cqw",
    "side-column-left": spacing["side-column-left"] ?? spacing["safe-x"] ?? "4.6cqw",
    "side-column-top": spacing["side-column-top"] ?? "12cqh",
    "side-column-width": spacing["side-column-width"] ?? "40cqw",
    "side-title-gap": spacing["side-title-gap"] ?? "0.45cqh",
    "speaker-gap": spacing["speaker-gap"] ?? "1.4cqh",
    "speaker-line-gap": spacing["speaker-line-gap"] ?? "0.35cqh",
    "speaker-max-width": spacing["speaker-max-width"] ?? "38cqw",
    "countdown-top": spacing["countdown-top"] ?? "16cqh",
    "countdown-right": spacing["countdown-right"] ?? spacing["safe-x"] ?? "5.2cqw",
    "countdown-gap": spacing["countdown-gap"] ?? "0.25cqh",
    "countdown-body-opacity": spacing["countdown-body-opacity"] ?? "0.72",
    "annotation-zone-top": spacing["annotation-zone-top"] ?? "44cqh",
    "annotation-zone-bottom": spacing["annotation-zone-bottom"] ?? "58cqh",
    "annotation-max-width": spacing["annotation-max-width"] ?? "82cqw",
    "annotation-bar-width": spacing["annotation-bar-width"] ?? "0.9cqw",
    "annotation-bar-gap": spacing["annotation-bar-gap"] ?? "1.6cqw",
    "annotation-bar-height": spacing["annotation-bar-height"] ?? "1.15em",
    "caption-stroke-width": spacing["caption-stroke-width"] ?? "0.22cqw",
    "subject-anchor-x": spacing["subject-anchor-x"] ?? "50%",
    "subject-anchor-y": spacing["subject-anchor-y"] ?? "42%",
    "vignette-radius": spacing["vignette-radius"] ?? "48%",
    "vignette-softness": spacing["vignette-softness"] ?? "42%",
    "hook-hold": spacing["hook-vignette-hold-seconds"] ?? spacing["topic-hold-seconds"] ?? "2.2",
    "hook-fade": spacing["hook-vignette-fade-seconds"] ?? spacing["topic-fade-seconds"] ?? "0.8",
  };

  const typeScale = toNumber(variant["type-scale"]) ?? 1;
  const size = (role, fallback) => {
    const cqw = toNumber((typography[role] || {}).cqw) ?? fallback;
    return `${(cqw * typeScale).toFixed(2)}cqw`;
  };
  baseline["title-size"] = size("display-strong", 8.8);
  baseline["speaker-name-size"] = size("speaker-name", 3.6);
  baseline["speaker-detail-size"] = size("speaker-detail", 2.75);
  baseline["caption-size"] = size("caption-base", 6.3);
  baseline["caption-emphasis-size"] = size("caption-emphasis", 7.1);
  // Optional typography roles for cognition-style frames.
  baseline["topic-size"] = size("topic-title", toNumber((typography["display-strong"] || {}).cqw) ?? 6.4);
  baseline["side-title-size"] = size("side-title", 5.6);
  baseline["annotation-size"] = size("annotation", 5.0);
  baseline["meta-label-size"] = size("meta-label", 2.2);
  baseline["meta-value-size"] = size("meta-value", 3.4);
  // Re-apply speaker sizes when the style declares them explicitly.
  if (typography["speaker-name"]) baseline["speaker-name-size"] = size("speaker-name", 4.4);
  if (typography["speaker-detail"]) baseline["speaker-detail-size"] = size("speaker-detail", 2.8);

  const variantLayer = { ...variant };
  delete variantLayer["type-scale"];

  let profile = null;
  if (shotProfileName) {
    profile = profiles[shotProfileName];
    if (!profile) {
      fail(
        `frame.md declares no shot profile named "${shotProfileName}"`,
        `available: ${Object.keys(profiles).join(", ") || "(none)"}`,
      );
    }
  }
  const profileLayer = { ...(profile || {}) };
  delete profileLayer.label;

  // The user's explicit framing decision outranks the profile's suggestion.
  const crop = choices.crop_plan || {};
  const cropLayer = {};
  if (crop.anchor) {
    cropLayer["video-anchor-y"] = anchorToPosition(crop.anchor, crop.offset_y);
  }
  if (crop.offset_x) cropLayer["video-anchor-x"] = crop.offset_x;
  if (crop.scale) cropLayer["video-scale"] = String(crop.scale);

  const vars = resolveLayoutVars([
    baseline,
    variantLayer,
    profileLayer,
    cropLayer,
    choices.layout_overrides,
  ]);

  return { vars, spacing, profileLabel: profile ? profile.label : null };
}

/**
 * Enforce frame.md's hard rule: a caption over the speaker's face is a layout
 * failure, not a readability problem. Only checkable when keyframe analysis
 * recorded where the face actually sits.
 */
function checkSubjectClearance(vars, spacing, choices) {
  const faceBottom = toNumber((choices.shot_profile || {}).face_bottom_pct);
  if (faceBottom === null) return null;

  const clearance = toNumber(spacing["subject-clearance"]) ?? 0;
  const captionTop = toNumber(vars["--caption-zone-top"]);
  if (captionTop === null) return null;

  const required = faceBottom + clearance;
  return captionTop < required ? { captionTop, faceBottom, clearance, required } : null;
}

/* --------------------------------------------------------------------- main */

function main() {
  const args = parseArgs(process.argv);

  if (!args["input-choices"]) fail("--input-choices is required");
  if (!args.srt) fail("--srt is required");
  if (!args.video) fail("--video is required");
  if (!args.output) fail("--output is required");

  const choicesPath = path.resolve(args["input-choices"]);
  const choices = readJson(choicesPath);

  const { framePath, templatePath, fontDir } = resolveStyleFiles(choices, args, "package", "template.html");
  const frame = parseFrameMd(fs.readFileSync(framePath, "utf8"));
  const template = fs.readFileSync(templatePath, "utf8");

  validateContract(frame, template, "package");

  const width = choices.width;
  const height = choices.height;
  if (!width || !height) fail("input_choices.json is missing width/height");

  const videoPath = path.resolve(args.video);
  const source = probeDimensions(videoPath);
  warnOnHeavyCrop(source, width, height);

  const srtSegments = parseSrt(fs.readFileSync(path.resolve(args.srt), "utf8"));
  if (srtSegments.length === 0) fail(`no caption segments parsed from ${args.srt}`);

  const duration = probeDuration(videoPath);
  const durationSeconds = duration ?? srtSegments[srtSegments.length - 1].end + 0.5;

  /* --- layout --- */
  const shotProfileName = args["shot-profile"] || (choices.shot_profile || {}).profile || null;
  const { vars, spacing } = resolveLayout(frame, choices, shotProfileName);

  const clearance = checkSubjectClearance(vars, spacing, choices);
  if (clearance && !args["allow-subject-overlap"]) {
    fail(
      `caption band starts at ${clearance.captionTop}cqh but the face reaches ` +
        `${clearance.faceBottom}cqh and frame.md requires ${clearance.clearance}cqh clearance`,
      `Move --caption-zone-top to at least ${clearance.required}cqh, pick a different ` +
        `shot profile, or re-crop. Pass --allow-subject-overlap only to inspect the failure.`,
    );
  }

  /* --- captions --- */
  const captionMaxWidth = toNumber(vars["--caption-max-width"]) ?? 94;
  const captionSize = toNumber(vars["--caption-size"]) ?? 6.3;
  // Both are cqw, so their ratio is the usable character count directly —
  // which is why this adapts to any aspect ratio without a lookup table.
  const maxChars = Math.max(6, Math.floor((captionMaxWidth / captionSize) * 0.97));

  const content = choices.package_content || {};
  const captions = buildCaptions(srtSegments, {
    maxChars,
    maxLines: 2,
    keywords: content.caption_emphasis,
  });

  /* --- output tree --- */
  const outputDir = path.resolve(args.output);
  fs.mkdirSync(outputDir, { recursive: true });

  const fontRoles = {
    "body-normal": "FONT_BODY_NORMAL",
    "body-bold": "FONT_BODY_BOLD",
  };
  // Some styles also load a display face for the persistent side title.
  if ((frame.fonts || {})["cover-title"]) {
    fontRoles["cover-title"] = "FONT_COVER_TITLE";
  }
  if ((frame.fonts || {})["caption-normal"]) {
    fontRoles["caption-normal"] = "FONT_CAPTION_NORMAL";
  }
  if ((frame.fonts || {})["title-sans"]) {
    fontRoles["title-sans"] = "FONT_TITLE_SANS";
  }
  const fontFiles = copyFonts(frame, fontDir, outputDir, fontRoles);

  // Bundle a local GSAP copy beside the template so rendering works offline.
  const templateDir = path.dirname(templatePath);
  const gsapSource = path.join(templateDir, "gsap.min.js");
  if (fs.existsSync(gsapSource)) {
    syncFile(gsapSource, path.join(outputDir, "gsap.min.js"));
  }

  const videoName = "footage" + path.extname(videoPath);
  syncFile(videoPath, path.join(outputDir, videoName));

  // topic_title is the hook title for cognition-style frames. Fall back to
  // joining founder-style topic_line_* fields when needed.
  const topicTitleSource =
    content.topic_title ??
    content.topic_title_lines ??
    [content.topic_line_1, content.topic_line_2].filter(Boolean);

  const html = fillTemplate(template, {
    COMPOSITION_ID,
    COMPOSITION_WIDTH: String(width),
    COMPOSITION_HEIGHT: String(height),
    DURATION_SECONDS: durationSeconds.toFixed(3),
    VIDEO_SRC: videoName,
    LAYOUT_VARS: buildLayoutCss(vars),
    TOPIC_LINE_1: renderTopicLine(content.topic_line_1),
    TOPIC_LINE_2: renderTopicLine(content.topic_line_2),
    TOPIC_TITLE: renderTopicTitle(topicTitleSource),
    SIDE_TITLE: renderSideTitle(
      content.side_title || content.side_title_lines || content.inspirational_title || "",
    ),
    SPEAKER_NAME: escapeHtml(content.speaker_name || (choices.ip_profile || {}).name || ""),
    SPEAKER_CREDENTIALS: renderCredentials(
      content.speaker_credentials || (choices.ip_profile || {}).credentials || [],
    ),
    SPEAKER_INTRO: renderSpeakerIntro(
      content.speaker_intro ||
        content.speaker_intro_lines ||
        (choices.ip_profile || {}).intro_lines ||
        (choices.ip_profile || {}).credentials ||
        [],
    ),
    // JSON.stringify is the escaping boundary: newlines, quotes and non-ASCII
    // all become valid JS source here, so the data can never break the script.
    CAPTION_SEGMENTS_JSON: JSON.stringify(captions.segments),
    ANNOTATION_SEGMENTS_JSON: JSON.stringify(
      renderAnnotationSegments(content.annotation_segments || content.annotations || []),
    ),
    ...fontFiles,
  });

  /*
    A talking-head clip whose packaged version is silent is worthless, and
    `hyperframes check` has no rule for it — the composition is structurally
    valid either way. HyperFrames needs a SEPARATE <audio> element because the
    <video> must be muted, so a template that omits one renders picture only.
  */
  const sourceHasAudio = hasAudioStream(videoPath);
  if (sourceHasAudio && !/<audio[\s>]/i.test(html)) {
    fail(
      "the source video has an audio track but the template declares no <audio> element",
      "HyperFrames renders <video> muted, so sound must come from a separate <audio> " +
        "element pointing at the same file. Add one to the style's template.html, " +
        "outside any element that carries data-start.",
    );
  }
  if (!sourceHasAudio) {
    console.warn("⚠ 源视频没有音轨，包装版将是无声的。确认这是预期结果。");
  }

  fs.writeFileSync(path.join(outputDir, "index.html"), html, "utf8");
  syncFile(framePath, path.join(outputDir, "frame.md"));

  const report = {
    generated_from: {
      input_choices: choicesPath,
      frame: framePath,
      template: templatePath,
      srt: path.resolve(args.srt),
      video: videoPath,
    },
    composition: { width, height, duration_seconds: Number(durationSeconds.toFixed(3)) },
    source_media: source,
    aspect_ratio: choices.aspect_ratio,
    shot_profile: shotProfileName,
    layout_vars: vars,
    captions: {
      segments: captions.segments.length,
      max_chars_per_line: maxChars,
      keyword_source: captions.keywordSource,
      keywords: captions.keywords,
      overflow_warnings: captions.warnings,
    },
  };
  fs.writeFileSync(
    path.join(outputDir, "build-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log(`✓ ${path.join(outputDir, "index.html")}`);
  console.log(`  画幅      ${width}×${height} (${choices.aspect_ratio})`);
  console.log(`  时长      ${durationSeconds.toFixed(2)}s`);
  console.log(`  字幕      ${captions.segments.length} 段，每行上限 ${maxChars} 字`);
  console.log(
    `  关键词    ${captions.keywordSource === "explicit" ? "指定" : "自动提取"}：` +
      `${captions.keywords.slice(0, 8).join("、") || "(无)"}`,
  );
  console.log(`  机位      ${shotProfileName || "(未指定，使用画幅基线)"}`);
  console.log(`  裁切锚点  ${vars["--video-anchor-x"]} ${vars["--video-anchor-y"]}`);

  if (captions.warnings.length > 0) {
    console.warn(`\n⚠ ${captions.warnings.length} 段字幕超过 2 行，需要在剪辑计划里拆句：`);
    for (const warning of captions.warnings.slice(0, 5)) {
      console.warn(`  ${warning.start.toFixed(1)}s  ${warning.text}  (${warning.lines} 行)`);
    }
    if (captions.warnings.length > 5) {
      console.warn(`  …另有 ${captions.warnings.length - 5} 段，完整列表见 build-report.json`);
    }
  }

  console.log(`\n下一步：npx hyperframes check ${outputDir}`);
}

main();
