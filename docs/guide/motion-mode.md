---
description: Motion 模式：把单集播客变成 SRT 主时钟驱动的 16:9 信息动画 HTML，用于播放与录屏。
---

# Motion 模式（信息动画）

Motion 模式把已合成的单集（`script` + `script-timing` + `podcast.srt`）变成一页 **16:9（1920×1080）单文件 HTML 信息动画**：分镜、步骤与收束页全部绑定真实毫秒点，由 SRT 主时钟驱动，可直接在浏览器播放、用于屏幕录制。

设计参考 [jacky-motion](https://github.com/jackywxsz/jacky-motion)（MIT），保留其「SRT 主时钟 + 确认门」核心思想，并按 BokeBox 的产品形态重新架构（确定性分镜、内置深色编辑风、无 LLM 依赖）。

## 何时使用

- 想把口播内容变成可反复观看的视觉节目（视频号 / 播客预告 / 课程片段）
- 想在 OBS / QuickTime 里直接录屏，画面按口播时间轴自动推进
- 想要一份离线、零依赖、可分发（单文件）的动画版本

## 工作流

| 阶段 | 说明 |
| --- | --- |
| **S1 优化 SRT** | 读取 `podcast.srt`（缺失时用 `script-timing.json` 兜底），合并碎句、切分超长句、修复重叠、统计覆盖率 |
| **S2 主时钟** | 总时长 = 优化后最后一条 cue 的 `endMs`，全时间轴以毫秒为唯一基准 |
| **S3 分镜** | 大纲 segment → beat（边界钉在 anchor cue 的 `startMs`），无大纲时按字重均分；末 beat 为收束页 |
| **S3.5 P3.5 确认门** | 全覆盖检查：首 beat 从 0ms 开始、空档 ≤500ms、beat 不重叠、step 毫秒点严格递增且在区间内、收束页贴合主时钟（±300ms） |
| **S4 装配** | 通过门禁后确认时间轴（`motion-timeline.json` 落盘）并装配单文件 `motion.html` |
| **S5 静态校验** | 字符串级复检：beat 数量、毫秒点、step 单调、运行时标记、id 唯一 |

## 在播放器中生成

1. 打开某集节目（已合成音频）
2. 切换到 **Motion（动效）** 面板
3. 点 **生成分镜（P3.5 预检）**，查看覆盖表：每个分镜的毫秒窗口、核心信息、步骤毫秒点
4. 门禁通过后点 **确认时间轴**，随后可 **下载信息动画**（单文件 HTML）

时间轴一经确认即锁定（`motion-timeline.json`），可反复 **重新装配** 导出，不会因重跑流水线而漂移。

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
| POST | `/api/jobs/:id/motion/draft` | S1→S3.5 预检，返回覆盖表与违规（不落盘） |
| POST | `/api/jobs/:id/motion/confirm` | 确认时间轴（门禁不通过返回 422）并装配 HTML |
| POST | `/api/jobs/:id/motion/build` | 用已确认时间轴重新装配 |
| GET | `/api/jobs/:id/motion.html` | 下载 `motion.html`（`?download=1`） |
| GET | `/api/jobs/:id/motion.srt` | 下载优化后的 SRT |

写操作需要登录；已确认产物支持公开站点访客下载（与音频一致）。

## 产物文件

任务目录下新增：

- `motion-timeline.json`：已确认时间轴（门禁通过才写入）
- `motion.html`：单文件信息动画

## 与 jacky-motion 的关系

BokeBox 的 Motion 模式改编自 [jacky-motion](https://github.com/jackywxsz/jacky-motion)（MIT License），生成文件的文件头保留原作者署名。改编点：

- 移除 6 阶段 LLM 风格选择，改为确定性分镜 + 内置一种深色编辑风
- 覆盖表 / 门禁规则与 BokeBox 的 TTS 时间轴（毫秒）直接对齐
- 纯逻辑（解析 / 优化 / 门禁）放 `@bokebox/shared`，服务端与前端共用，避免规则漂移
