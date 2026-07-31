---
description: Motion 模式：根据口播稿生成可在线预览的 16:9 AI 信息页面，并由 SRT 主时钟同步播放。
---

# Motion 模式（信息动画）

Motion 把一集已经合成音频的播客变成一套 **16:9 在线信息页面**：AI 读取口播稿和节目大纲，生成视觉层级、短标题、要点与页面布局；SRT / `script-timing` 仍然是唯一主时钟，保证画面跟随真实口播。

页面会直接嵌入播放器预览，不需要先下载 HTML。下载单文件 HTML 仍保留为录屏和离线分发的次要出口。

设计参考 [jacky-motion](https://github.com/jackywxsz/jacky-motion)（MIT），保留「SRT 主时钟 + 确认门」核心思想，并按 BokeBox 的产品形态重构。

## 在播放器中生成

1. 打开某集节目，确认已有合成音频和口播稿。
2. 切换到 **Motion（动效）** 面板。
3. 在视觉要求输入框里写方向，例如“像 Apple 发布会一样克制，突出三个结论”。
4. 点击 **生成页面**。AI 会读取本集口播稿、节目大纲和固定时间轴。
5. 页面生成后，直接播放下方音频；预览画面、进度条和分镜列表会同步切换。
6. 点击分镜卡片可以跳转音频；需要录屏或离线分发时，再下载 HTML。

没有配置 LLM Key 时，Motion 会生成一套确定性的基础页面，保证仍可预览；配置 LLM 后才会使用 AI 页面内容。

## 工作流

| 阶段 | 说明 |
| --- | --- |
| **S1 优化 SRT** | 读取 `podcast.srt`（缺失时用 `script-timing.json` 兜底），合并碎句、切分超长句、修复重叠、统计覆盖率 |
| **S2 主时钟** | 总时长 = 优化后最后一条 cue 的 `endMs`，全时间轴以毫秒为唯一基准 |
| **S3 分镜** | 大纲 segment → beat（边界钉在 anchor cue 的 `startMs`），无大纲时按字重均分；末 beat 为收束页；屏幕文字做提炼（去开场白、截断、短于口播） |
| **S3.5 P3.5 确认门** | 全覆盖检查：首 beat 从 0ms 开始、空档 ≤1500ms、beat 不重叠、step 毫秒点严格递增且在区间内、收束页贴合主时钟（±300ms） |
| **S4 AI 页面** | AI 只生成视觉内容层，和已经通过门禁的 beat 合并 |
| **S5 在线预览 / 导出** | React 播放器跟随音频实时显示页面；需要时装配单文件 `motion.html` |

## 在播放器中生成

时间轴一经确认即锁定（`motion-timeline.json`），AI 页面可以反复生成，不会改动原始口播稿、音频或 SRT。

## 分镜与 B-roll

- **motion beat**：信息章节页，标题为提炼后的屏幕短文字（去开场白 / 语气词，短于口播），步骤按口播节奏 2-5 步逐条揭示，步骤毫秒点钉在语义触发 cue 的 `startMs`
- **broll beat**：无口播的大空档（**≥1.5s** 静音，常见于段落停顿 / 音乐）会先作为强制切分点把前后 beat 切开，再填充为正式 broll 过渡页（大号序号 + 预告短标题），画面不会在口播停止时空等；门禁视 broll 为正式 beat 参与覆盖检查。1.5s 以内的句间停顿属正常口播节奏，留在 beat 内（自动分镜不细分）
- **closing beat**：末段收束页，`endMs` 贴合主时钟总时长（±300ms），SRT 播完定格终帧

## HTML 播放器

- **主时钟**：`performance.now()` + `requestAnimationFrame`，无 setTimeout 链；切后台回来按绝对时间追帧
- **门 overlay**：准备播放 → 3-2-1 倒计时（录屏前预留）
- **HUD**：分镜圆点 + 当前毫秒时钟
- **键盘**：`空格` 暂停 / 继续 · `←` `→` 跳 5 秒 · `R` 重播 · `F` 全屏
- **样式**：deep navy 背景 + indigo/cyan 品牌渐变（按 jobId 派生），收束页金色 accent；纯 CSS 过渡 + class 切换，零外部依赖

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/jobs/:id/motion/timeline` | 已确认时间轴与覆盖表（无则空） |
| POST | `/api/jobs/:id/motion/generate` | 根据口播稿调用 AI 生成页面并保存 |
| POST | `/api/jobs/:id/motion/draft` | S1→S3.5 预检，返回覆盖表与违规（不落盘） |
| POST | `/api/jobs/:id/motion/confirm` | 确认时间轴（门禁不通过返回 422）并装配 HTML |
| POST | `/api/jobs/:id/motion/build` | 用已确认时间轴重新装配 |
| GET | `/api/jobs/:id/motion.html` | 下载 `motion.html`（`?download=1`） |
| GET | `/api/jobs/:id/motion.srt` | 下载优化后的 SRT |

写操作需要登录；已确认产物支持公开站点访客下载（与音频一致）。

> **失败响应**：`draft` / `confirm` / `build` 门禁未通过时返回 `422` 统一信封
> `{ code, message, data, errorCode: 'GATE_FAILED' }`，其中 `data` 携带
> `gate`（含 `violations` 违规明细）、`rows`（覆盖表）、`notes`（分镜说明），
> 前端直接渲染违规列表，不会只给一句误导性文案。

## 产物文件

任务目录下新增：

- `motion-timeline.json`：时间轴和 AI 页面 spec（门禁通过才写入）
- `motion.html`：单文件信息动画

## 与 jacky-motion 的关系

BokeBox 的 Motion 模式改编自 [jacky-motion](https://github.com/jackywxsz/jacky-motion)（MIT License），生成文件的文件头保留原作者署名。改编点：

- 保留 SRT 主时钟和确认门，将页面内容生成改成口播稿驱动的 AI 页面
- 在线预览成为主路径，HTML 下载作为次要出口
- 没有 LLM 配置时使用确定性 fallback 页面，不阻断预览
- 覆盖表 / 门禁规则与 BokeBox 的 TTS 时间轴（毫秒）直接对齐
- 纯逻辑（解析 / 优化 / 门禁）放 `@bokebox/shared`，服务端与前端共用，避免规则漂移
- B-roll 用「强制切分 + 填充」实现：大空档先切开 beat 再生成 broll 页，保证门禁可过且画面不空等
- 门禁空档门限从 500ms 放宽到 1500ms：自动化分镜无法像人工分镜那样精细填充，TTS 句间停顿可达 ~1.5s（属正常口播节奏）；≥1.5s 仍强制填充 broll
