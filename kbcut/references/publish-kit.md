# KB Cut 发布物料与本地 dbs 打分

成片交付不只是 mp4 + 封面。KB Cut 在导出阶段还必须产出一份**可直接用于平台发布**的 markdown 物料，并把成片 SRT 转成文稿底稿文件。

**调用本机 dbs 打分不是默认步骤。** 只有用户在入口明确同意、且本机已经装好 dbs skill 时，才把底稿交给 dbs 并把结果合并进发布物料。KB Cut 不安装、不配置、不引导安装 dbs——那是用户自己的事。

## 交付物

对每条成片，至少生成：

| 文件 | 说明 |
| --- | --- |
| `{stem}_发布物料.md` | 标题候选、视频简介、Tags、元信息、可选 dbs 诊断 |
| `{stem}_发布物料.json` | 给 Agent 读的侧车（路径、标题数组、tags） |
| `{stem}_dbs-文稿底稿.md` | 从成片 SRT 导出的纯文稿 + 时间轴文稿，仅本机使用 |

以上文件写入**交付目录**（与包装成片同级），不要只留在临时目录。

生成底稿文件 ≠ 调用 dbs。底稿始终可以生成；dbs 调用另见下方双条件门。

## 生成命令

```bash
node $KBCUT/scripts/make-publish.cjs \
  --input-choices <工作目录>/input_choices.json \
  --srt <工作目录>/复核转写/<stem>_口播优化版.srt \
  --output <交付目录>/<stem>_发布物料.md \
  --dbs-brief <交付目录>/<stem>_dbs-文稿底稿.md
```

可选：

```bash
  --duration 193.7 \
  --stem 高内容是高认知对外的显化 \
  --dbs-score <工作目录或交付目录>/dbs-score.md
```

`input_choices.package_content` 中的 `cover_title` / `side_title` / `topic_title` / `speaker_name` 会优先进入标题与元信息；SRT 用于简介草稿与 tag 词频。

## 入口授权字段

在 `input_choices.json` 中记录：

```json
{
  "dbs_scoring": false
}
```

| 值 | 含义 |
| --- | --- |
| `false` 或缺失 | **默认**。禁止调用任何 `$dbs-*`。发布物料与底稿仍交付。 |
| `true` | 用户在本次任务入口同意使用本机 dbs 打分。成片后还须探测本机是否真有 dbs。 |

历史配置里的 `dbs_scoring` 只能预填，不能跳过本次确认。

## 与本地 dbs skill 的协作（双条件门）

KB Cut **不内置** dbs，**不安装** dbs，**不把「去装 dbs」写成流程步骤**。

### 何时可以调用 dbs

必须**同时**满足：

1. `input_choices.dbs_scoring === true`（用户事先同意）
2. 本机 Agent skills 根目录存在可用 skill，例如 `dbs-resonate/SKILL.md`（只查 skills 根，不扫全盘，不联网）

任一不满足 → 不调用 dbs，发布物料照常完成。

### 授权且本机可用时

推荐 skill（按需，均非硬依赖）：

| 目的 | 本地 skill | 输入 |
| --- | --- | --- |
| 共鸣 / 能不能发 | `$dbs-resonate` | `*_dbs-文稿底稿.md` 中的「纯文稿」 |
| 开头与标题 | `$dbs-hook` | 纯文稿 + 推荐标题草稿 |
| 划走点 / 逻辑 | `$dbs-script-flow` | 底稿中的「带时间轴文稿」 |
| 小红书标题公式 | `$dbs-xhs-title` | 核心观点 + 标题草稿 |

Agent 步骤：

1. 成片与封面验收通过后，运行 `make-publish.cjs`（无 `--dbs-score`）。
2. 若 `dbs_scoring !== true`：停止 dbs 分支，交付发布物料即可。
3. 若已授权：探测本机 dbs；**没有则跳过**，在「dbs 诊断」写「用户授权但本机未检测到 dbs」，**不要**给出安装/bridge 教程作为 KB Cut 步骤。
4. 有 dbs 时：把底稿交给 `$dbs-resonate`（默认），必要时再跑 `$dbs-hook`。结果写入本地 `dbs-score.md` 或 `dbs-score.json`。
5. 用 `--dbs-score` 重跑 `make-publish.cjs` 合并进发布物料。

### dbs-score.json 建议结构

```json
{
  "score": 78,
  "verdict": "改后发",
  "summary": "核心机制清楚，开头偏说明文",
  "strengths": ["刺点单一", "立场明确"],
  "risks": ["前 5 秒给答案过早"],
  "fixes": ["开头改悬念句", "删第二段重复定义"],
  "title_suggestions": ["标题A", "标题B"],
  "raw_markdown": "可选：完整诊断正文"
}
```

## 发布物料正文最小结构

1. 成片路径表（包装版 / 封面 / 口播优化版 / SRT / dbs 底稿）
2. 元信息（风格、画幅、时长、讲者、封面文案）
3. 推荐标题 4 条（标 1 条推荐草稿；有 dbs 标题则优先）
4. 视频简介代码块（可粘贴）
5. Tags
6. dbs 诊断（已合并 / 未授权 / 授权但本机无 dbs）
7. 使用说明

## 硬规则

- 标题与结论必须来自真实口播/SRT，不得编造素材中不存在的事实或成绩。
- 文稿与分数只存本地项目目录；禁止上传转写、SRT、成片到云端 dbs 或第三方。
- **默认不调用 dbs**；禁止因「本机有 dbs」就自动打分。
- **禁止**把安装 dbs、bridge、下载 skill 写成 KB Cut 必经或推荐安装流程；用户自行解决安装。
- 未授权或本机无 dbs 时，不得阻塞成片与发布物料交付，不得伪造分数。
- `make-publish.cjs` 是机械合并器：不替代 Agent 的编导判断，也不替代 dbs 的诊断推理。
