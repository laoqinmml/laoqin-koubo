---
version: alpha
id: knowledge-sharing
name: Knowledge Sharing — Noto Editorial Knowledge Frame
description: >
  A clean vertical short-form knowledge-sharing overlay for talking-head clips.
  The speaker stays dominant; the frame keeps a compact speaker credential
  card on the left and plain speech-synced sans-serif captions at the bottom,
  with no persistent topic lockup. Best for knowledge explainers, course
  clips, study notes, tool tutorials, and editorial commentary where clarity
  and authority matter more than decoration.
unit: the vertical frame — 1080x1920 primary; adapts to 1080x1440 3:4, 1260x2736 capture, and 1:1 crops
principle: speaker first · speaker card on the left · plain white captions carry the logic · knowledge reads clearly

colors:
  text-primary: "#FFFFFF"
  text-secondary: "rgba(255,255,255,0.72)"
  text-tertiary: "rgba(255,255,255,0.58)"
  caption-base: "rgba(255,255,255,0.80)"
  caption-emphasis: "#FFFFFF"
  accent-primary: "#8EC5FC"
  accent-soft: "rgba(142,197,252,0.88)"
  progress-track: "rgba(255,255,255,0.30)"
  progress-fill: "#8EC5FC"
  shadow-soft: "rgba(0,0,0,0.38)"
  rule: "rgba(142,197,252,0.92)"

fonts:
  cover-title: "fonts/SourceHanSerifSC-Heavy.ttf"
  body-normal: "fonts/NotoSansSC-Medium.otf"
  body-bold: "fonts/NotoSansSC-Bold.otf"

typography:
  display-strong: { fontFamily: "KnowledgeSerif, Source Han Serif SC, serif", cqw: 8.2, weight: 700, lineHeight: 0.98, tracking: "0" }
  display-light: { fontFamily: "KnowledgeSerif, Source Han Serif SC, serif", cqw: 6.6, weight: 700, lineHeight: 1.0, tracking: "0" }
  display-mid: { fontFamily: "KnowledgeSerif, Source Han Serif SC, serif", cqw: 6.8, weight: 700, lineHeight: 1.0, tracking: "0" }
  speaker-name: { fontFamily: "KnowledgeSans, Noto Sans SC, sans-serif", cqw: 3.4, weight: 700, lineHeight: 1.1, tracking: "0" }
  speaker-detail: { fontFamily: "KnowledgeSans, Noto Sans SC, sans-serif", cqw: 2.6, weight: 400, lineHeight: 1.18, tracking: "0" }
  caption-base: { fontFamily: "KnowledgeSans, Noto Sans SC, sans-serif", cqw: 3.5, weight: 400, lineHeight: 1.1, tracking: "0" }
  caption-emphasis: { fontFamily: "KnowledgeSans, Noto Sans SC, sans-serif", cqw: 3.95, weight: 700, lineHeight: 1.02, tracking: "0" }
  micro-ui: { fontFamily: "KnowledgeSans, Noto Sans SC, sans-serif", cqw: 2.2, weight: 400, lineHeight: 1.2, tracking: "0" }

spacing:
  safe-x: "4.8cqw"
  title-top: "4.8cqh"
  title-gap: "0.8cqh"
  title-rule-width: "17cqw"
  title-rule-height: "0.18cqw"
  credentials-gap: "2.2cqh"
  caption-zone-top: "60cqh"
  caption-zone-bottom: "76cqh"
  caption-max-width: "94cqw"
  subject-clearance: "4cqh"

components:
  footage-grade:
    treatment: "Keep the footage natural and bright; do not add color filters, LUTs, exposure changes, or darkening overlays unless the user explicitly requests them."
    background: "The filmed person remains the primary visual; never cover the face with graphic blocks or caption bands."
  speaker-credentials:
    position: "Left side, vertically centered, on a translucent dark card."
    structure: "One bold name line, then 1-3 compact credential lines, inside a semi-transparent black rounded card."
    typography: "{typography.speaker-name} + {typography.speaker-detail}"
    color: "{colors.text-primary} for the name; {colors.text-secondary} for details"
    background: "rgba(0,0,0,0.45), rounded, padding around the text (explicitly requested by the user)."
    function: "Authority proof. It tells the viewer why this speaker's knowledge is worth their time."
  live-caption:
    position: "Aspect-dependent and subject-aware: 9:16 uses 60-76cqh; 3:4 uses the bottom band 74-88cqh. Keep above platform UI and never over the face, eyes, mouth, head, or primary subject area."
    structure: "One spoken phrase per line. Captions are plain and uniform: the whole phrase renders the same with no keyword highlighting."
    typography: "{typography.caption-base}"
    color: "{colors.caption-base}"
    shadow: "none"
    maxWidth: "{spacing.caption-max-width}"
    background: "rgba(0,0,0,0.45) — the same depth as the speaker card backing — keeps captions readable without turning them into a heavy plate."
    function: "Comprehension. Regular white captions carry the spoken logic without emphasis or decoration."
  cover-design:
    priority: "User's current explicit request > project .kbcut and cover/design principle files > this cover-design component > this frame's general layout rules > generic defaults."
    independence: "The cover is an independent HyperFrames composition, not a reused process frame, dynamic-caption frame, or debug frame."
    title: "Extract the video's core idea into a 6-8 Chinese-character title broken into two lines on meaning. Never stack raw subtitle sentences on the cover."
    layout: "Landscape: line 1 on the left half, line 2 on the right half, each horizontally centered within its half and vertically centered at 50% of the frame. Portrait: line 1 near the top edge, line 2 near the bottom edge, 80% width justified."
    typography: "Bundled Source Han Serif SC Heavy face in white. Font size is dynamic: make-cover derives the largest size that fits the longest line inside its side/band width and the title block height, capped by title-size-max. In both orientations longer or more text renders smaller automatically; short titles may render larger."
    size-adaptation: "Never hard-code a cover title size for a given video. Text amount drives the size: more characters or a longer line reduce font size; fewer characters allow a larger size, always bounded by the per-aspect title-max-width and title-size-max in cover-aspect-variants."
    word-integrity: "Pass cover_title as explicit whole lines and break on meaning. A complete word, term, number, or phrase must never be split across two lines; when a line is long the font shrinks instead of wrapping or cutting a word."
    subjectRelation: "The title leads the cover, but keep the face visible: choose a background frame and cover anchor so the title sits in its designated side or edge zone rather than over the eyes, mouth, or head. Overlap with the body or background is acceptable; covering the face is not preferred."
    copyLimit: "Do not add explanatory subtitles, labels, badges, or decorative copy unrelated to the core point."
    mask: "Keep the cover bright and open by default. A soft text shadow is allowed for readability, but do not add a vignette or dark scrim unless the user requests one."
    verification: "Before delivery, inspect a clean PNG snapshot with no debug marks: landscape shows one line on each side of the subject; portrait shows one line at the top and one at the bottom; every line is one complete word/term (no mid-word wrap); the title stays within 6-8 characters and does not cover the speaker's face."

templates:
  package:
    file: "template.html"
    placeholders: [SPEAKER_NAME, SPEAKER_CREDENTIALS, CAPTION_SEGMENTS_JSON]
  cover:
    file: "cover.html"
    placeholders: [COVER_TITLE_LINES]

cover-spacing:
  safe-x: "7cqw"
  title-max-width: "86cqw"
  title-block-max-height: "62cqh"
  title-size-max: "30cqw"
  title-line-height: 1.02
  title-line-gap: "1.1cqh"
  title-color: "#FFFFFF"
  cover-anchor-x: "50%"
  cover-anchor-y: "50%"
  cover-scale: 1

cover-aspect-variants:
  "9:16":
    title-block-max-height: "58cqh"
    title-max-width: "80cqw"
    title-size-max: "22cqw"
  "3:4":
    title-block-max-height: "62cqh"
    title-max-width: "80cqw"
    title-size-max: "22cqw"
  "4:5":
    title-block-max-height: "62cqh"
    title-max-width: "80cqw"
    title-size-max: "22cqw"
  "1:1":
    title-block-max-height: "60cqh"
    title-max-width: "80cqw"
    title-size-max: "20cqw"
  "4:3":
    title-block-max-height: "62cqh"
    title-max-width: "38cqw"
    title-size-max: "10cqw"
  "16:9":
    title-block-max-height: "62cqh"
    title-max-width: "42cqw"
    title-size-max: "10cqw"

aspect-variants:
  "9:16":
    type-scale: 1.0
    caption-zone-top: "60cqh"
    caption-zone-bottom: "76cqh"
    caption-max-width: "94cqw"
    title-max-width: "62cqw"
    credentials-max-width: "56cqw"
  "3:4":
    type-scale: 1.0
    caption-zone-top: "74cqh"
    caption-zone-bottom: "88cqh"
    caption-max-width: "94cqw"
    title-max-width: "62cqw"
    credentials-max-width: "56cqw"
  "4:5":
    type-scale: 1.0
    caption-zone-top: "72cqh"
    caption-zone-bottom: "87cqh"
    caption-max-width: "94cqw"
    title-max-width: "62cqw"
    credentials-max-width: "56cqw"
  "1:1":
    type-scale: 0.74
    caption-zone-top: "70cqh"
    caption-zone-bottom: "86cqh"
    caption-max-width: "88cqw"
    title-max-width: "52cqw"
    credentials-max-width: "48cqw"
  "4:3":
    type-scale: 0.62
    caption-zone-top: "68cqh"
    caption-zone-bottom: "85cqh"
    caption-max-width: "80cqw"
    title-max-width: "44cqw"
    credentials-max-width: "40cqw"
  "16:9":
    type-scale: 0.56
    caption-zone-top: "66cqh"
    caption-zone-bottom: "84cqh"
    caption-max-width: "72cqw"
    title-max-width: "40cqw"
    credentials-max-width: "36cqw"

shot-profiles:
  subject-centered:
    label: "人物居中，头顶留白正常"
    video-anchor-y: "50%"
  subject-headroom-tight:
    label: "近景顶天，头顶留白很少"
    video-anchor-y: "20%"
    title-top: "3.4cqh"
  subject-low:
    label: "人物偏下，上方背景空"
    video-anchor-y: "72%"
    title-top: "5.6cqh"
  subject-wide:
    label: "半身远景，人物小、下方空间大"
    video-anchor-y: "42%"
    caption-zone-top: "78cqh"
    caption-zone-bottom: "90cqh"

motion:
  title-enter: "On the first beat, fade 0->1 and translate y 8px->0 over 320-420ms. Then remain fixed."
  credentials-enter: "Follow the title by 120-160ms; fade 0->1 and translate y 6px->0 over 260-340ms. Then remain fixed."
  caption-reveal: "Static captions: each phrase is visible for its full segment with no enter or exit motion."
  emphasis-reveal: "Emphasized spans are bold white; they appear directly as part of the phrase without a separate sweep."
  caption-exit: "Replace at phrase boundaries with a hard cut on a breath."
  prohibited: "No bounce captions, sticker pop, colored word plates, karaoke highlight bars, neon glow, heavy type stroke, grain, particle noise, thick subtitle shadow, large black blocks, or unrequested decorative gradients. Emphasis is white weight change, not a color wash."
---

# Knowledge Sharing — Noto Editorial Knowledge Frame

## Overview

This preset is a clean, information-forward short-form overlay for knowledge-sharing
talking-head clips. It should read like a well-edited explainer or study clip: the speaker
stays visible, a compact speaker credential card sits on the left, and plain captions carry
the spoken logic in a highly readable sans face without shouting. There is no persistent topic
lockup.

Use it for knowledge explainers, course clips, tool tutorials, study notes, expert commentary,
and any talking-head video where the viewer needs to absorb information quickly and trust the
source.

## The Frame

Primary output is 9:16. Author frame-relative sizes in `cqw`/`cqh` against the composition
container. The preset assumes a filmed portrait background and overlays text only.

The speaker's face must remain the first read. Place the subject center or center-right when
possible, leaving the upper-left and lower-middle text zones clean. If the footage is busy,
solve it with crop, spacing, or line breaks rather than heavy overlays.

## Captions

- Captions use the bundled `KnowledgeSans` family (`NotoSansSC-Medium`). All words render the
  same — no keyword emphasis, no highlighting.
- Base words are translucent white (`{colors.caption-base}`) on a soft dark backing.
- Captions are aspect-dependent: 9:16 uses `60cqh` to `76cqh`; 3:4 uses the bottom band
  `74cqh` to `88cqh`. Keep the full caption box above platform UI and away from the face.
- Size baseline is `3.5cqw`, matching a readable small caption rather than an oversized
  default. Captions support the speaker; they do not compete.

Captions are static: each phrase is visible for its whole segment with no enter or exit motion,
keeping the knowledge read calm and editorial.

## Speaker Card

There is no persistent topic lockup in this style. The speaker credential card sits on the left
side, vertically centered: a bold name followed by 1-3 compact credential lines (domain, role,
years, notable result), on a semi-transparent black rounded card (`rgba(0,0,0,0.45)`) with
padding. Keep the copy factual and compact.

## Cover Design

The cover belongs to this style. KB Cut should read this section from the selected `frame.md`;
it should not hard-code knowledge cover aesthetics in the main `$kbcut` entry skill.

The cover is an independent HyperFrames composition, sharing fonts and brand constraints with
`template.html` but none of its layout. Write the cover title after reading the whole clip and
extracting its core idea: a 6-8 Chinese-character title broken into two whole lines on meaning.
Do not pile raw subtitle sentences onto the cover, and do not create a claim the source does not
support.

Use the bundled `Source Han Serif SC Heavy` face in white. The title is the cover's loudest
element, but its size is **dynamic**: `make-cover.cjs` derives the largest size that fits the
longest line inside its designated width and the title block height, capped per aspect. Both
orientations follow the same rule — more or longer text shrinks the font automatically; short
titles may go larger. Never hard-code a per-video title size.

Layout is fixed, not centered:

- Landscape (16:9 / 4:3): line 1 sits on the left half, line 2 on the right half, each
  horizontally centered within its half and vertically centered at `50%` of the frame.
- Portrait (3:4 / 4:5 / 9:16): line 1 sits near the top edge, line 2 near the bottom edge,
  filling 80% width, justified to both ends.

Pass `cover_title` as explicit whole lines and break on meaning. A complete word, term, number,
or phrase must never be split across two lines — if a line is long, the derived size shrinks so
the whole term stays intact on one line.

Keep the speaker's face visible: choose the background frame and `cover.anchor` so the title
stays in its side or edge zone instead of over the eyes, mouth, or head. Overlap with the body
or background is acceptable; covering the face is not preferred. Do not add a vignette or dark
scrim by default; a soft text shadow is allowed for readability.

Before delivery, inspect a clean PNG snapshot: landscape shows one line on each side of the
subject, portrait shows one line at the top and one at the bottom; every line is one complete
word/term with no mid-word wrap; the title reads as white serif within 6-8 characters and does
not cover the speaker's face.

## Composition Rules

### Do

- Keep the filmed person dominant; overlays explain, not compete.
- Keep a compact speaker card on the left, vertically centered, once per video.
- Keep captions uniform translucent white; no keyword highlighting.
- Keep the caption box below the face/head region.

### Don't

- Do not put subtitles in a heavy card or colored rectangle (the speaker card is the only
  translucent plate, by explicit user request).
- Do not cover the speaker's face with the speaker card or captions.
- Do not animate every word with bounce, scale punches, or sticker effects.
- Do not use negative letter spacing; Chinese text should keep `tracking: 0`.
- Do not use a colored wash for emphasis; reserve it for a thin rule or accent span at most.

## Content Inputs

This preset ships two templates, and the style owns both: `template.html` is what the video
looks like from the inside, `cover.html` is what it looks like from the outside. A style is not
complete with only one of them.

The machine-readable contract lives in the `templates` block of the frontmatter. Reserved
technical placeholders are supplied by the scripts and never declared here.
