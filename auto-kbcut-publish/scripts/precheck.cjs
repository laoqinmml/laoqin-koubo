#!/usr/bin/env node
/**
 * 发布前自查（第一道门）——把 references/config.md「交付前全量核对」变成可执行检查。
 *
 * 用法:
 *   node precheck.cjs <项目目录> [<项目目录> ...]
 *   node precheck.cjs --root "E:\自动剪辑" --match "0918_小号1*"
 *   node precheck.cjs <项目目录> --lint        # 额外跑 hyperframes lint（慢）
 *
 * 退出码: 0 = 全绿（可以进入第二道门 yxer validate / dry-run）；1 = 有 FAIL。
 *
 * 覆盖：画面与包装 / 文案 / 成片与文件 三类；发布类只做前置提醒，
 * 真正的机器校验仍在蚁小二侧：同一份 payload + 同一套通道参数
 * `yxer validate` → `yxer publish --dry-run` → 正式 `yxer publish`。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const wantLint = args.includes('--lint');
const rootIdx = args.indexOf('--root');
const matchIdx = args.indexOf('--match');
const root = rootIdx >= 0 ? args[rootIdx + 1] : null;
const match = matchIdx >= 0 ? args[matchIdx + 1] : null;
let projects = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root' && args[i - 1] !== '--match');

if (root) {
  const re = new RegExp('^' + String(match || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  projects = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && re.test(e.name))
    .map((e) => path.join(root, e.name));
}
if (!projects.length) {
  console.error('用法: node precheck.cjs <项目目录> [...] | --root <批目录> --match <通配>');
  process.exit(2);
}

const FORBIDDEN = ['WhatsApp', 'whatsapp', 'Facebook', 'facebook', 'Instagram', 'instagram', 'YouTube', 'youtube', 'Google', 'google', '谷歌', '翻墙', '必火', '稳赚', '百分百'];
const rows = [];
const add = (scope, item, ok, detail, level = 'FAIL') => rows.push({ scope, item, ok: !!ok, detail: String(detail), level });
const warn = (scope, item, ok, detail) => add(scope, item, ok, detail, 'WARN');

const ffprobe = (a) => execFileSync('ffprobe', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
/**
 * 同时拿 stdout + stderr：ffmpeg 的 loudnorm JSON 写在 stderr 上，而
 * execFileSync 只回 stdout，所以这里必须用 spawnSync。
 * raw=true 时回 Buffer（用于 -f rawvideo 取像素）。
 */
const run = (cmd, a, raw = false) => {
  const r = spawnSync(cmd, a, { maxBuffer: 1 << 28, encoding: raw ? null : 'utf8' });
  if (raw) return r.stdout || Buffer.alloc(0);
  return String(r.stdout || '') + String(r.stderr || '');
};

function shot(raw, w, y) {
  const xs = [];
  for (let x = 0; x < w; x += 1) if (raw[y * w + x] >= 215) xs.push(x);
  return xs.length ? [xs[0], xs[xs.length - 1]] : null;
}

function portraitGeometry(png) {
  const W = 1080, H = 1440;
  const raw = run('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-'], true);
  if (raw.length < W * H) return null;
  const bands = [];
  let cur = null;
  for (let y = 0; y < H; y += 1) {
    const ext = shot(raw, W, y);
    if (ext) cur = cur ? [cur[0], y, Math.min(cur[2], ext[0]), Math.max(cur[3], ext[1])] : [y, y, ext[0], ext[1]];
    else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  if (!bands.length) return null;
  const widths = bands.map((b) => b[3] - b[2] + 1);
  const top = bands[0][0], bottom = bands[bands.length - 1][1];
  return { lines: bands.length, widths, pct: widths.map((x) => (x / W) * 100), center: (top + bottom) / 2, frameCenter: H / 2 };
}

/** 横屏封面：整幅亮字的外接框（整体跨度要保持 ≤70% 画面宽）。 */
function landscapeGeometry(png) {
  const W = 1920, H = 1080;
  const raw = run('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-'], true);
  if (raw.length < W * H) return null;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (raw[y * W + x] >= 215) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, x1, y0, y1, pct: ((x1 - x0 + 1) / W) * 100, center: (y0 + y1) / 2, frameCenter: H / 2 };
}

function checkProject(project) {
  const scope = path.basename(project);
  const deliv = path.join(project, '交付文件');
  const work = path.join(project, '工作文件');
  const choicesPath = path.join(work, 'input_choices.json');

  if (!fs.existsSync(choicesPath)) { add(scope, 'input_choices.json 存在', false, choicesPath); return; }
  const ch = JSON.parse(fs.readFileSync(choicesPath, 'utf8'));
  // stem 解析（2026-09-18 加固）：优先用交付物料，其次用成片/SRT 文件名，
  // 最后从项目目录名推断。旧版只认 `交付文件\*_发布物料.md`，导致剪辑阶段
  // （发布物料还没写）stem 为空、成片/SRT/封面三项被静默误报为「缺失」。
  const listDir = (d, suffix) => {
    try { return (fs.readdirSync(d).find((f) => f.endsWith(suffix)) || '').replace(suffix, ''); } catch (e) { return ''; }
  };
  const stem =
    listDir(deliv, '_发布物料.md') ||
    listDir(work, '_口播优化版.mp4') ||
    listDir(path.join(work, '复核转写'), '_口播优化版.srt') ||
    path.basename(project).replace(/^\d{4}_[^_]+_/, '').replace(/_KBcut.*$/, '');
  // 2026-09-18 修复：大号（9:16）交付名是 `{stem}_9-16_包装版.mp4`，旧版只认
  // `_16-9_包装版.mp4`，导致 9:16 项目永远报「成片存在 / 交付文件 6 件齐全」FAIL。
  const pickFinal = () => {
    const a = `${stem}_9-16_包装版.mp4`;
    const b = `${stem}_16-9_包装版.mp4`;
    if (fs.existsSync(path.join(deliv, a))) return a;
    if (fs.existsSync(path.join(deliv, b))) return b;
    return ch.width > ch.height ? b : a;
  };
  const finalName = pickFinal();
  const final = path.join(deliv, finalName);
  const srtPath = path.join(work, '复核转写', `${stem}_口播优化版.srt`);
  const materialPath = path.join(deliv, `${stem}_发布物料.md`);
  const landscape = ch.width > ch.height;
  const capBudget = landscape ? 24 : 13;

  // ---- 一、画面与包装 ----
  add(scope, '成片存在', fs.existsSync(final), stem ? path.basename(final) : '未找到 *_发布物料.md');
  if (fs.existsSync(final)) {
    const wh = ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', final]).replace(/[,\r\n]+$/, '');
    add(scope, `成片画幅 ${ch.width}x${ch.height}`, wh === `${ch.width},${ch.height}`, wh);
    const streams = ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', final]).split(/\r?\n/).map((s) => s.replace(/[+,]/g, '').trim()).filter(Boolean);
    add(scope, '成片含 video + audio', streams.includes('video') && streams.includes('audio'), streams.join('+'));
    let ln = '';
    try { ln = run('ffmpeg', ['-hide_banner', '-nostats', '-i', final, '-af', 'loudnorm=I=-23:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']); } catch (e) { ln = String((e.stderr && e.stderr.toString()) || e.stdout || e.message); }
    const m = ln.match(/\{[^{}]*"input_i"[^{}]*\}/s);
    if (m) {
      const i = parseFloat(JSON.parse(m[0]).input_i);
      add(scope, '成片响度 ≈ −23 LUFS', Math.abs(i + 23) <= 1.5, `${i} LUFS`);
    } else add(scope, '成片响度 ≈ −23 LUFS', false, 'loudnorm 解析失败');
  }

  const lo = ch.layout_overrides || {};
  // 2026-09-18 用户反馈：横屏左上角话题锁 + IP 介绍太大、有的挡脸 → 整体缩 25%；
  // 再追加「太长要换行」：话题锁最宽收到 32cqw，模板里按语义段换行（span 保持 nowrap，
  // 不切半句），所以每个语义段本身必须放得下：线 1 ≤10 字（3.15cqw×10=31.5）、线 2 ≤15 字。
  // 现口径：话题锁 --title-size 2.1cqw（首行由 CSS ×1.5 = 3.15cqw）、最宽 32cqw、
  // 字幕 2.8cqw、介绍名 1.75cqw、介绍详情 1.35cqw、介绍间距 1.4cqh。竖屏不显示话题锁，不受影响。
  if (landscape) add(scope, '横屏字号覆盖（话题锁 2.1/32cqw、字幕 2.8、介绍 1.75+1.35cqw）',
    lo['--title-size'] === '2.1cqw' && lo['--caption-size'] === '2.8cqw'
    && lo['--speaker-name-size'] === '1.75cqw' && lo['--speaker-detail-size'] === '1.35cqw'
    && lo['--title-max-width'] === '32cqw',
    JSON.stringify(lo));
  {
    const pc = ch.package_content || {};
    const spans = (v, lim, label) => (v || []).map((x) => (x && x.text) || '')
      .filter((t) => t.length > lim).map((t) => `${label}「${t}」${t.length}字`);
    const over = [...spans(pc.topic_line_1, 10, '线1'), ...spans(pc.topic_line_2, 15, '线2')];
    add(scope, '话题锁每个语义段放得下（线1 ≤10 字 / 线2 ≤15 字）', over.length === 0,
      over.length ? over.join(' ') : '超长会在语义段之间换行，不会顶到人脸');
  }
  add(scope, '关闭关键词高亮 ["__none__"]', JSON.stringify((ch.package_content || {}).caption_emphasis) === '["__none__"]', JSON.stringify((ch.package_content || {}).caption_emphasis));

  // 2026-09-21 用户规范（最高优先）：字幕一律「白色填充 + 半透明投影」，禁止任何黑色描边。
  // 只看**生效的 CSS**：先剥掉 HTML 注释与内嵌的 frame.md 文档块，
  // 否则 frame.md 里描述规范的示例文本（含 "-webkit-text-stroke: ..." 字样）会误报。
  {
    // frame.md 是对外规范文档（会引用历史条款，含 `-webkit-text-stroke` 字样），
    // 因此**只检查真正参与渲染的两个文件**：样式模板与其渲染副本；
    // frame.md 只查「是否还留着 caption-stroke-width 参数」。
    const renderFiles = [
      path.join(work, 'template.html'),
      path.join(work, 'hyperframes', 'package', 'index.html'),
    ].filter((f) => fs.existsSync(f));
    const frameFile = path.join(work, 'frame.md');
    const strip = (t) => t
      .replace(/<!--[\s\S]*?-->/g, '')                 // HTML 注释
      .replace(/\/\*[\s\S]*?\*\//g, '')                // JS/CSS 块注释
      .replace(/```[\s\S]*?```/g, '')                  // markdown 代码块
      .replace(/`[^`\n]*`/g, '');                      // 行内代码
    const hits = [];
    for (const f of renderFiles) {
      const t = strip(fs.readFileSync(f, 'utf8'));
      const strokeRe = /-webkit-text-stroke\s*:\s*([^;{}\n]*)/g;
      let m;
      while ((m = strokeRe.exec(t)) !== null) {
        const v = m[1].trim();
        if (v && !/^0(\s|$|[;}])/.test(v)) hits.push(`${path.basename(f)}: text-stroke(${v.slice(0, 18)})`);
      }
      if (/paint-order\s*:\s*stroke/.test(t)) hits.push(`${path.basename(f)}: paint-order stroke`);
    }
    if (fs.existsSync(frameFile) && /caption-stroke-width\s*:\s*"?\s*[1-9]/.test(
      fs.readFileSync(frameFile, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, ''))) {
      hits.push('frame.md: caption-stroke-width');
    }
    add(scope, '字幕无黑色描边（只用半透明投影）', hits.length === 0,
      hits.length ? hits.join(' / ') : '白色填充 + text-shadow 投影，无描边');
  }

  if (fs.existsSync(srtPath)) {
    const lines = fs.readFileSync(srtPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes(' --> '));
    const maxLen = Math.max(...lines.map((l) => l.length));
    add(scope, `字幕每行 ≤ ${capBudget} 字`, maxLen <= capBudget, `最长 ${maxLen} 字 / ${lines.length} 段`);

    // 2026-09-21 事故门（字幕与声音对不上）：SRT 时间轴必须是「成片时间轴」。
    // 判据：末条结束时间应≈成片时长（差 >1.5s = 用了源素材时间轴，字幕会提前）。
    const stamps = [...fs.readFileSync(srtPath, 'utf8')
      .matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->/g)]
      .map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
    const srtEnd = stamps.length ? Math.max(...stamps) : -1;
    const finalDur = (() => {
      const p = path.join(deliv, finalName);
      if (!fs.existsSync(p)) return -1;
      const o = ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]);
      return parseFloat(o) || -1;
    })();
    if (srtEnd > 0 && finalDur > 0) {
      const diff = Math.abs(finalDur - srtEnd);
      add(scope, '字幕时间轴 = 成片时间轴（防字声不同步）', diff <= 1.5,
        `SRT 末条 ${srtEnd.toFixed(2)}s / 成片 ${finalDur.toFixed(2)}s（差 ${diff.toFixed(2)}s）`);
    } else {
      warn(scope, '字幕时间轴可校验', false, 'SRT 或成片缺失');
    }
  } else add(scope, '成片 SRT 存在', false, srtPath);

  // 回归门（2026-09-18）：edit_plan.json 里手写的 drop_ranges 是「成片输出时间轴」坐标，
  // 写错坐标会在成片里删掉好内容（MVI_4418 因此白丢 8.2 秒）。出现即 WARN，须用
  // scripts/check_cut_integrity.py 做字级核对确认。
  const planFileForDrops = path.join(work, 'edit_plan.json');
  if (fs.existsSync(planFileForDrops)) {
    try {
      const pl = JSON.parse(fs.readFileSync(planFileForDrops, 'utf8').replace(/^\uFEFF/, ''));
      const dr = pl.drop_ranges || [];
      if (dr.length) {
        warn(scope, 'edit_plan 无手写 drop_ranges（或用字级核对确认过）', false,
          `${dr.length} 个：${JSON.stringify(dr)}（render_recut 按成片时间轴处理，务必跑 check_cut_integrity.py）`);
      } else {
        add(scope, 'edit_plan 无手写 drop_ranges', true, '删除全部由 --drop 体现在 segments 空档');
      }
    } catch (e) { warn(scope, 'edit_plan 可读', false, String(e.message)); }
  }

  const c16 = path.join(deliv, `${stem}_16-9_封面.png`);
  const c34 = path.join(deliv, `${stem}_3-4_封面.png`);
  const dim = (p) => (fs.existsSync(p) ? ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]).replace(/[,\r\n]+$/, '') : '缺失');
  // 2026-09-21 用户规范：成片保持源视频原始画幅/尺寸，封面也必须与成片同比例。
  // 封面尺寸门从「固定 1920x1080 / 1080x1440」放宽为「与 input_choices 的 width×height 一致」。
  const nativeTag = `${ch.width}x${ch.height}`;
  const portrait = ch.height > ch.width;
  const nativeCover = path.join(deliv, `${stem}_${portrait ? '9-16' : '16-9'}_封面.png`);
  const nativeCoverAlt = path.join(deliv, `${stem}_${portrait ? '16-9' : '9-16'}_封面.png`);
  const useNative = fs.existsSync(nativeCover) ? nativeCover : nativeCoverAlt;
  add(scope, `原生比例封面 = 成片尺寸 ${nativeTag}`,
    dim(useNative) === `${ch.width},${ch.height}`,
    `${path.basename(useNative)}=${dim(useNative)}`);
  add(scope, `投流竖版封面尺寸 1080x1440`, dim(c34) === '1080,1440', dim(c34));

  // 2026-09-20：新增第二个风格（knowledge-sharing）。封面门从「必须是 founder-interview-dark」
  // 改成「必须是当前 style_id 预设自带的 cover.html」；founder 家族仍强制 dark 版。
  const coverSrc = String(ch.cover_source || '');
  const styleId = String(ch.style_id || '');
  const founderCover = !styleId || styleId === 'founder-interview' || styleId === 'founder-interview-dark';
  if (styleId && styleId !== 'founder-interview' && styleId !== 'founder-interview-dark') {
    add(scope, `封面模板 = ${styleId} 预设自带 cover.html`,
      coverSrc.includes('frame-presets') && coverSrc.includes(styleId) && /cover\.html$/.test(coverSrc),
      path.basename(path.dirname(coverSrc)));
  } else {
    add(scope, '封面模板 = founder-interview-dark', coverSrc.includes('founder-interview-dark'), path.basename(path.dirname(coverSrc)));
  }

  if (fs.existsSync(c34)) {
    // 2026-09-18：3:4 封面有两条路线 —— ①模板版（founder-interview-dark 排字）适用下面三条几何门；
    // ②生图版（gpt-image-2 图生图，大号有单独人像照片时按 config.md 走这条）标题由模型画进画面，
    // 位置/宽度不受 cover.html 控制，那三条模板几何门对它天然不成立（还会把明亮背景误判成亮字）。
    // 因此按 input_choices.cover_3x4_mode 分流：生图只校验尺寸，并提示人工核验标题文字与身份。
    const imagegen = String(ch.cover_3x4_mode || '').toLowerCase() === 'imagegen';
    if (imagegen) {
      add(scope, '3:4 封面走生图（几何门跳过，需人工核验标题文字/身份）', true,
        `cover_3x4_mode=imagegen；` + (() => { const g = portraitGeometry(c34); return g ? `亮带启发式实测 ${g.pct.map((p) => p.toFixed(1) + '%').join('/')}（仅供参考）` : '未识别到亮字'; })());
    } else if (founderCover) {
      const g = portraitGeometry(c34);
      if (!g) add(scope, '3:4 封面标题几何', false, '未识别到亮字');
      else {
        const w = g.pct, spread = Math.max(...g.widths) - Math.min(...g.widths);
        const off = Math.abs(g.center - g.frameCenter);
        add(scope, '3:4 两行撑满 ≈80% 宽', w.every((p) => p >= 78 && p <= 82), w.map((p) => p.toFixed(1) + '%').join(' / '));
        add(scope, '3:4 两行宽度一致（差 ≤15px）', spread <= 15, `${spread}px`);
        add(scope, '3:4 标题块垂直居中（偏差 ≤15px）', off <= 15, `中心 ${g.center.toFixed(0)} vs ${g.frameCenter}`);
      }
    } else {
      // 2026-09-20：knowledge-sharing 的 3:4 封面是「上贴顶 / 下贴底」两行，
      // 第二行压在中灰 T 恤上，亮字启发式只认得出第一行 → 上面三条 founder 几何门不成立。
      // 该风格改为：硬门只要求「识别到足够醒目的标题墨迹」，三条几何门降级为 WARN 供人工看。
      const g = portraitGeometry(c34);
      const ink = g ? g.pct.filter((p) => p >= 25).length : 0;
      add(scope, '3:4 封面标题墨迹存在（新风格走自定义几何）', ink >= 1,
        g ? `亮带 ${g.pct.map((p) => p.toFixed(1) + '%').join('/')}` : '未识别到亮字');
      if (g) {
        const w = g.pct, spread = Math.max(...g.widths) - Math.min(...g.widths);
        warn(scope, '3:4 两行撑满 ≈80% 宽（该风格上顶下底，仅参考）', w.filter((p) => p >= 25).every((p) => p >= 78 && p <= 82), w.map((p) => p.toFixed(1) + '%').join(' / '));
        warn(scope, '3:4 两行宽度一致（差 ≤15px）', spread <= 15, `${spread}px`);
        warn(scope, '3:4 标题块垂直居中（偏差 ≤15px）', Math.abs(g.center - g.frameCenter) <= 15, `中心 ${g.center.toFixed(0)} vs ${g.frameCenter}`);
      }
    }
  }

  if (fs.existsSync(c16)) {
    const g = landscapeGeometry(c16);
    if (!g) add(scope, '16:9 封面标题几何', false, '未识别到亮字');
    else if (founderCover) {
      add(scope, '16:9 整体宽度 ≤70% 画面宽', g.pct <= 70, `整体 ${g.pct.toFixed(1)}%（x ${g.x0}..${g.x1}）`);
      add(scope, '16:9 标题没有偏小（≥60%）', g.pct >= 60, `${g.pct.toFixed(1)}%`, 'WARN');
      add(scope, '16:9 标题块垂直居中（偏差 ≤20px）', Math.abs(g.center - g.frameCenter) <= 20, `中心 ${g.center.toFixed(0)} vs ${g.frameCenter}`);
    } else {
      // 2026-09-20：knowledge-sharing 的 16:9 封面是「左半 + 右半」两行，
      // 亮字包围盒天然横跨 ~85% 画面宽、且每行会折成两行 —— 旧三条门（居中块 / ≤70%）对它不成立。
      // 该风格三条全部降级为 WARN，硬门只要求「识别到标题墨迹」。
      warn(scope, '16:9 标题块垂直居中（该风格左右分栏，仅参考）', Math.abs(g.center - g.frameCenter) <= 20, `中心 ${g.center.toFixed(0)} vs ${g.frameCenter}`);
      warn(scope, '16:9 整体宽度 ≤70% 画面宽（该风格为左右分栏，仅参考）', g.pct <= 70, `整体 ${g.pct.toFixed(1)}%（x ${g.x0}..${g.x1}）`);
      warn(scope, '16:9 标题没有偏小（≥60%）', g.pct >= 60, `${g.pct.toFixed(1)}%`);
    }
  }

  const prev = fs.existsSync(path.join(work, '预览截图')) ? fs.readdirSync(path.join(work, '预览截图')).filter((f) => f.startsWith(stem)) : [];
  add(scope, '批次级预览齐（2 封面 + 4 截图）', prev.length >= 6, `${prev.length} 张`);

  // ---- 剪辑计划：气口保留规则（≤1.2s 不许剪，2026-09-18 用户规则）----
  const planPath = path.join(work, 'edit_plan.json');
  if (fs.existsSync(planPath)) {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const segs = (plan.segments || []).slice().sort((a, b) => a.start - b.start);
    const tdir = path.join(work, 'transcript');
    const wt = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.words.tsv')) : [];
    if (wt.length && segs.length) {
      const words = fs.readFileSync(path.join(tdir, wt[0]), 'utf8').split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p.length >= 4 && !Number.isNaN(parseFloat(p[0])))
        .map((p) => [parseFloat(p[0]), parseFloat(p[1]), p[3]]);
      if (words.length) {
        const removed = [['片头静音', words[0][0], segs[0].start]];
        for (let i = 0; i < segs.length - 1; i += 1) removed.push(['段间', segs[i].end, segs[i + 1].start]);
        removed.push(['片尾静音', segs[segs.length - 1].end, words[words.length - 1][1]]);
        const info = removed.filter(([, a, b]) => b > a).map(([kind, a, b]) => {
          // 2026-09-21：ASR 逐词时间戳与剪辑计划之间存在 ±0.2s 级的边界漂移，
          // 会把「故意删掉的口误字（呃/啊/呢…）」误判成「被剪短的纯气口」。
          // 判定时给两侧各 0.25s 容差：容差内只要碰到词，就算「删的是字」，不是「剪气口」。
          const TOL = 0.25;
          const spoke = words.filter((w) => w[1] > a - TOL && w[0] < b + TOL);
          return { kind, a, b, dur: b - a, spoke: spoke.length, text: spoke.map((w) => w[2]).join('').slice(0, 20) };
        });
        const pure = info.filter((r) => r.kind === '段间' && r.spoke === 0);
        const tooShort = pure.filter((r) => r.dur <= 1.2);
        add(scope, '纯气口只剪 >1.2s（≤1.2s 必须保留）', tooShort.length === 0,
          tooShort.length ? tooShort.map((r) => `${r.a.toFixed(2)}-${r.b.toFixed(2)}=${r.dur.toFixed(2)}s`).join(', ')
            : `${pure.length} 处纯气口，最短 ${pure.length ? Math.min(...pure.map((r) => r.dur)).toFixed(2) : '-'}s`);
        const cuts = info.filter((r) => r.kind === '段间' && r.spoke > 0);
        const span = segs[segs.length - 1].end - segs[0].start;
        add(scope, '剪辑不碎片化（片段数）', segs.length <= Math.max(6, Math.ceil(span / 15)),
          `${segs.length} 段 / 跨度 ${span.toFixed(0)}s；删掉带语音的重复 ${cuts.length} 处${cuts.length ? '：' + cuts.map((c) => c.text).join(' | ') : ''}`, 'WARN');
      }
    }
  }

  // ---- 二、文案 ----
  // 2026-09-18：发布物料缺失时**不再提前 return**（旧版会连带跳过第 3 节的字体门禁等
  // 必须 PASS 项，造成「剪辑阶段永远只报 4 个 FAIL、其余门禁静默不执行」）。
  const coverTitle = ((ch.package_content || {}).cover_title || []).join('');
  const md = fs.existsSync(materialPath) ? fs.readFileSync(materialPath, 'utf8') : '';
  add(scope, '发布物料存在', !!md, materialPath);
  if (md) {
    const platforms = ['小红书', '抖音', '视频号', '哔哩哔哩', '快手'];
    const present = platforms.filter((p) => md.includes(`## ${p}文案`));
    for (const p of present) {
      const block = md.split(`## ${p}文案`)[1].split(/\n## /)[0];
      const titles = (block.match(/\*\*标题（最终[^*]*）\*\*\n\n?(.+)/) || [])[1];
      const body = (block.match(/\*\*正文（(\d+) 字）\*\*/) || [])[1];
      const tags = (block.match(/\*\*标签（(\d+) 个）\*\*/) || [])[1];
      add(scope, `${p}：只 1 个最终标题`, !!titles && !/^\d\.\s/m.test(block.split('**正文')[0]), titles ? titles.trim().slice(0, 24) : '缺失');
      add(scope, `${p}：正文 100–160 字`, body && Number(body) >= 100 && Number(body) <= 160, body ? body + ' 字' : '缺失');
      add(scope, `${p}：10 个标签`, tags === '10' || (block.match(/#[^\s#]+/g) || []).length === 10, tags ? tags + ' 个' : '缺失');
    }
    add(scope, '至少一个平台文案块', present.length > 0, present.join('/'));

    const bodyOnly = md.split('## 红线自查')[0];
    const hit = FORBIDDEN.filter((w) => bodyOnly.includes(w));
    add(scope, '标题/正文/标签无违禁原词', hit.length === 0, hit.length ? hit.join(',') : '无');

    const rec = md.match(/## 推荐标题（最终[^\n]*\n\n\*\*(.+?)\*\*/);
    add(scope, '推荐标题只有 1 个', !!rec && !/^\d\./m.test(rec[1]), rec ? rec[1].slice(0, 30) : '缺失');

    add(scope, '无 make-publish 机械草稿残留', !md.includes('本段为 SRT 提炼草稿') && !md.includes('标题 / 简介 / tag 为草稿'), md.includes('本段为 SRT 提炼草稿') ? '仍有视频简介草稿' : '无');
    add(scope, '不交付 发布文案.md', !fs.existsSync(path.join(deliv, `${stem}_发布文案.md`)), '');
    add(scope, '封面标题与 input_choices 一致', !!coverTitle && md.includes(coverTitle), coverTitle);
  }

  // ---- 三、成片与文件 ----
  const need = [finalName, `${stem}_16-9_封面.png`, `${stem}_3-4_封面.png`, `${stem}_发布物料.md`, `${stem}_发布物料.json`, `${stem}_dbs-文稿底稿.md`];
  const missing = need.filter((f) => !fs.existsSync(path.join(deliv, f)));
  add(scope, '交付文件 6 件齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : `6 件`);

  const renamed = /^\d{4}_[^_]+_.+_KBcut_.+/.test(path.basename(project));
  add(scope, '项目目录已改名（含封面标题）', renamed && coverTitle && path.basename(project).includes(coverTitle), path.basename(project));

  // 交付文件里出现的项目路径必须是「当前这个项目」，出现别的 _KBcut 项目名就是没同步旧路径
  const otherProjectPaths = [...md.matchAll(/[A-Z]:\\[^\s`）)]*?_KBcut[^\s`）)]*/g)]
    .map((m) => m[0])
    .filter((p) => !p.startsWith(project));
  add(scope, '交付文件内无旧项目名', otherProjectPaths.length === 0, otherProjectPaths.length ? otherProjectPaths[0] : '路径均指向本项目');

  // Windows 上 Junction 的 Dirent.isDirectory() 为 false，必须用 statSync 跟进链接。
  const fontDirs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; }
      }
      if (!isDir) continue;
      if (e.name === 'fonts') { fontDirs.push(p); continue; }
      if (e.name === 'node_modules' || e.name === 'snapshots') continue;
      if (!e.isSymbolicLink()) walk(p);
    }
  })(work);
  const realFonts = fontDirs.filter((p) => !fs.lstatSync(p).isSymbolicLink());
  const rootFonts = fontDirs.filter((p) => path.dirname(p) === work);
  add(scope, '无实体字体副本（生成目录里的 fonts 必须是 Junction）', realFonts.length === 0,
    `${fontDirs.length} 个 fonts 目录，实体 ${realFonts.length} 个` + (realFonts.length ? `：${realFonts.map((p) => path.relative(work, p)).join(', ')}` : ''));
  add(scope, '工作文件下不生成 fonts 目录', rootFonts.length === 0,
    rootFonts.length ? '工作文件\\fonts 又出现了' : '仅生成目录内各一个 Junction');

  const leftovers = [];
  (function walk2(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'fonts') walk2(p); continue; }
      if (/^_salvage|_source_copy|_口播优化版_ln\.mp4$|^footage\.mp4$/.test(e.name)) leftovers.push(path.relative(work, p));
    }
  })(work);
  add(scope, '中间产物已清理', leftovers.length === 0, leftovers.length ? leftovers.join(', ') : '无', 'WARN');

  if (wantLint) {
    const pkg = path.join(work, 'hyperframes', 'package');
    if (fs.existsSync(pkg)) {
      let out = '';
      try { out = execFileSync('npx', ['--yes', 'hyperframes', 'lint', pkg], { encoding: 'utf8', shell: true, maxBuffer: 1 << 28 }); } catch (e) { out = String(e.stdout || e.message); }
      const m = out.match(/(\d+)\s+errors?,\s*(\d+)\s+warnings?/);
      add(scope, 'hyperframes lint 0 error', m ? Number(m[1]) === 0 : /0 errors/.test(out), m ? `${m[1]} errors / ${m[2]} warnings` : '未解析');
    }
  }
}

for (const p of projects) checkProject(p);

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
let scope = '';
for (const r of rows) {
  if (r.scope !== scope) { scope = r.scope; console.log(`\n=== ${scope} ===`); }
  const mark = r.ok ? 'PASS' : r.level;
  console.log(`${mark === 'PASS' ? '  ✓' : r.level === 'WARN' ? '  !' : '  ✗'} ${pad(r.item, 46)} ${r.detail}`);
}

const fails = rows.filter((r) => !r.ok && r.level === 'FAIL');
const warns = rows.filter((r) => !r.ok && r.level === 'WARN');
console.log(`\n合计 ${rows.length} 项：FAIL ${fails.length}，WARN ${warns.length}`);
if (fails.length) {
  console.log('\n必须先修掉：');
  for (const f of fails) console.log(`  ✗ [${f.scope}] ${f.item} — ${f.detail}`);
}
console.log('\n第二道门（发布时必过，本脚本不代替）：同一份 payload + 同一套通道参数跑');
console.log('  yxer validate <平台> video <payload> --publish-channel local --client-id <id>');
console.log('  yxer publish  <平台> video <payload> --publish-channel local --client-id <id> --dry-run');
console.log('  两步都通过、且提交那一刻蚁小二客户端在线，才允许正式 publish；提交后回查 publishId。');

process.exit(fails.length ? 1 : 0);
