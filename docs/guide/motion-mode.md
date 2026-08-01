---
description: Motion 模式：根据口播稿生成可在线预览的 16:9 AI 信息页面，并由 SRT 主时钟同步播放。
---

# Motion 模式（信息动画）

Motion 把一集已经合成音频的播客变成一套 **16:9 在线信息页面**：口播稿生成阶段就规划 2–3 个主章节，音频合成阶段同步产出真实 SRT；AI 只负责为这些章节设计视觉页，SRT / `script-timing` 负责在章节内部推进真实口播时钟。

页面会直接嵌入播放器预览，不需要先下载 HTML。下载单文件 HTML 仍保留为录屏和离线分发的次要出口。

设计参考 [jacky-motion](https://github.com/jackywxsz/jacky-motion)（MIT），保留「SRT 主时钟 + 确认门」核心思想，并按 BokeBox 的产品形态重构。

页面生成进一步采用 Jacky-motion 的方法：先锁定单一风格和信息原语，再选择稳定版式骨架；每页只保留一个第一眼主视觉，不做“标题 + 多张等宽卡片”的 Dashboard。当前支持 `apple-tech-gradient`、`editorial-magazine`、`sketch-note`、`finance-studio-cards`、`newspaper-evidence`、`paper-collage` 六种风格。

## 在播放器中生成

1. 生成或重新生成一集节目；系统会同时得到章节化口播稿、合成音频和 `podcast.srt`。
2. 切换到 **Motion（动效）** 面板。
3. 先检查已经准备好的 2–3 个章节卡片；章节边界来自口播稿，不再由每条字幕临时猜测。
4. 在视觉要求输入框里写方向，例如“像 Apple 发布会一样克制，突出三个结论”。
5. 点击 **生成页面**。AI 只为这些固定章节生成视觉内容，页面数量保持在 2–3 张。
6. 页面生成后，直接播放下方音频；章节切换和章节内步骤会跟随 SRT 实时推进。需要录屏或离线分发时，再下载 HTML。

没有配置 LLM Key 时，Motion 会生成一套确定性的基础页面，保证仍可预览；配置 LLM 后才会使用 AI 页面内容。

## 工作流

| 阶段 | 说明 |
| --- | --- |
| **S1 章节化口播稿** | AI 在生成 `script` 的同时返回 2–3 个 `motionChapters`，每章包含标题、摘要和可直接送入 TTS 的口播片段；完整 script 按章节顺序拼接 |
| **S2 音频与 SRT** | TTS 按句合成音频，使用实测语音区间与句间停顿生成 `script-timing.json` 和 `podcast.srt`；这一步完成后 Motion 已具备稳定时钟与章节计划 |
| **S3 章节时间轴** | 将 2–3 个章节首句映射到真实 SRT cue，章节窗口覆盖其中的自然停顿；页面数量固定，不再按每条 cue 创建页面 |
| **S3.5 P3.5 确认门** | 检查首章从 0ms 开始、章节不重叠、收束章贴合总时长、step 毫秒点合法，最后一个 beat 必须是 closing |
| **S4 AI 页面** | AI 只为固定章节锁定单一风格、版式骨架和信息原语，每章一张主视觉页 |
| **S5 在线预览 / 导出** | React 播放器跟随音频实时切换 2–3 张页面；需要时装配单文件 `motion.html` |

## 在播放器中生成

时间轴一经确认即锁定（`motion-timeline.json`），AI 页面可以反复生成，不会改动原始口播稿、音频或 SRT。

## 章节与镜头

- **chapter beat**：来自口播稿的固定章节，一章一页；标题和摘要由上游脚本阶段确定，步骤毫秒点来自章节内部的 SRT cue
- **自然停顿**：章节内部的句间停顿保留在同一个章节窗口内，不再为了填空档新增 B-roll 页面；页面数量不会因字幕碎片或长停顿膨胀
- **closing beat**：最后一个口播章节自动标记为收束页，`endMs` 贴合主时钟总时长（±300ms），SRT 播完定格终帧

### 页面与镜头规则

- 信息原语分为 Claim、Contrast、Path、System、Evidence；每个 beat 只选择一种主原语。
- 每个章节只生成一张主视觉页；章节内部最多做少量步骤揭示，动画完成后停在可截图的最终帧。
- 风格由整集统一锁定，AI 不会在相邻页面之间随机换皮。

## HTML 播放器

- **主时钟**：`performance.now()` + `requestAnimationFrame`，无 setTimeout 链；切后台回来按绝对时间追帧
- **门 overlay**：准备播放 → 3-2-1 倒计时（录屏前预留）
- **HUD**：分镜圆点 + 当前毫秒时钟
- **键盘**：`空格` 暂停 / 继续 · `←` `→` 跳 5 秒 · `R` 重播 · `F` 全屏
- **样式**：整集单一风格；支持产品发布会黑场、编辑杂志、手绘线稿、财经演播室、证据报纸和纸张拼贴六种方向，纯 CSS 过渡 + class 切换，零外部依赖

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
- 章节由口播稿上游一次确定，避免音频完成后再从字幕反推页面结构
- 音频阶段直接产出真实 `podcast.srt`；Motion 不再依赖公开下载接口临时恢复时间轴
- 页面数量由章节数量控制在 2–3 张，长音频也不会生成几十张字幕卡
