# OMP History Recall

[![npm version](https://img.shields.io/npm/v/omp-history-recall)](https://www.npmjs.com/package/omp-history-recall)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/Rinai-R/omp-history-recall)

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个在当前 OMP profile 内显式、渐进召回语义主题与历史会话的 Oh My Pi 插件。

## 快速开始

```sh
omp install omp-history-recall
```

等价完整命令：

```sh
omp plugin install omp-history-recall
```

如果你的可执行文件仍使用上游 Pi 名称，对应命令是 `pi install omp-history-recall`。
安装后重启 OMP，选择已认证模型，再显式索引一个会话：

```text
/history-recall conversations
/history-recall index /absolute/path/to/session.jsonl
/history-recall status
```

## 行为

- 向 system prompt 追加一条静态能力说明，不包含动态主题资料或历史事实。
- 在同一个 profile 的不同目录之间维护稳定语义主题，description 中整合可读时间线。
- 每个历史 session 是一个 conversation，带简介、有原文证据的 facets 和活跃时间窗口；一个会话可归属多个主题。
- 绝不自动索引：用户执行命令，或 Agent 对选中的会话显式调用索引工具。
- 搜索已索引原文，时间过滤由代码处理会话元数据完成。
- 原始 JSONL entry 分页读取，带稳定 ID 和哈希；摘要只是导航，不是证据。

## 安装

安装已发布的 npm 包：

```sh
omp install omp-history-recall
```

或直接从 GitHub 安装：

```sh
omp install github:Rinai-R/omp-history-recall
```

开发安装：

```sh
git clone git@github.com:Rinai-R/omp-history-recall.git
cd omp-history-recall
npm ci
npm run patch:omp
npm test
omp plugin link .
```

验证过的开发版本为 Bun 1.3.14 和带仓库内 settlement 补丁的 OMP 18.2.6。

`patches/omp-sdk-18.2.6.json` 修复 `pi-utils`/`pi-ai` 的 reader 取消清理、iterator 结束及 lazy stream 终态转发。`npm run patch:omp` 只修改本项目依赖，核对精确包版本及完整文件的修改前后哈希，拒绝未知版本、内容或重定向文件；可重复执行，也会在本项目测试、类型检查和 benchmark 前执行。它不是安装 hook，不查找或修改真实 OMP 安装。SDK 缺少该 settlement 能力时，原生修复返回 `unsupported_omp`；普通对话和无历史的首次索引不需要 child。将此开发版本部署到真实 profile 前，须另行准备兼容 SDK。

## 数据模型

```text
OMP profile
└── semantic topic（稳定 ID、可演化定义和 timeline）
    └── conversation facets（同一历史会话可关联多个主题）
        └── original entries（分页证据）
```

Facet 表示不同讨论范围并引用原始 entry。主题匹配会按字节分页比较整个 profile 目录，不按 `cwd` 或标题相等决定归属。Agent 依赖历史事实之前仍须读取原文。

Topic description 类似 Skills 的描述方式：

```text
WAL 持久化与同步失败语义。Timeline: ... across 3 conversations.
Latest: ...
```

目录列表不返回结构化 timeline 数组。时间检索基于存储的会话时间戳和活跃窗口，由 SQL 过滤。

授权来源包括 profile 管理的 sessions 根与直接 bucket、当前会话目录、精确登记的 custom 文件，以及已索引或已排队的文件。登记一个文件不授权扫描其兄弟文件。活动会话被排除。`source_cwd` 仅表示来源，不用于命名空间或分类。

显式索引在存在可用已索引历史时自动运行受限的 OMP 原生 child。它先读取原文，再提出定义更新、错误归属移动、重复主题合并或按已有 facets 拆分；一次完整取证即可提交，不再等待第二条会话投票。每次最多 audit 八个历史 facets、移动八个历史和五个 incoming facets、创建五个额外 repair drafts、合并一对持久主题。修改定义或合并必须逐个验证全部最终成员，并确认分页 EOF。主题变化不改写原始 entries、FTS 或证据身份。

六个 `repair_*` 工具只存在于索引 child，普通父会话的工具目录不可见。模型与工具循环由原生 OMP 执行，插件不自建 agent loop。Child 使用与分析、初选相同的已捕获模型和调用用量统计；没有空闲维护定时器。没有已索引历史时，短会话首次索引仍只需一次内容分析调用。

维护开始前已经缺失、不可读或陈旧的来源通过 `repair_deferred` 返回，不能参与 proof，也不能修改或合并包含它们的主题；其他健康成员的独立归属仍可修复。来源一旦确认健康或交付过原文，之后变化会导致整次发布失败。Incoming 索引与历史修复同事务提交，不会在维护失败后单独发布 incoming。

派生数据库使用 schema 5，不再有 vote 表。Schema 4、schema 3 等旧索引明确提示需重建的路径，不迁移或自动删除；升级时须显式重建派生数据库。原始 OMP v3 JSONL 始终不变。下面的 `rebuild` 命令只刷新 schema-5 索引，不能转换旧 schema。

## 工具

| 工具 | 返回 |
| --- | --- |
| `history_recall_browse` | 当前 profile 的语义主题、去重会话数及 facet memberships；支持时间过滤和分页 |
| `history_recall_conversations` | 分页列出授权 `source_file`、索引状态和发现警告，不调用模型 |
| `history_recall_index` | 显式索引从 catalog 选出的绝对 `source_file` |
| `history_recall_search` | 用 1-8 个 query 数组搜索原文，支持 topic/会话/时间过滤，返回命中 entry ID |
| `history_recall_read_conversation` | 分页读取 active branch，或用命中 `entry_id` 加 `before`/`after` 返回同分支最近上下文 |

浏览和列表不调用模型。已索引、未变化且未排队的文件直接跳过。短会话内容分析使用一次请求，长会话使用无损切块和有界分层 reduce；主题选择按字节分页比较完整目录。分析、初选和原生 repair 请求共享用量统计，插件不设每日或单次命令的调用次数上限；失败请求计数，缓存命中不计数。原生缓存重放仍执行真实取证工具、重建 receipts 并验证后才能发布。主题变化不会重发已缓存的原文分析。搜索可能调用一次查询改写，失败时降级为词项搜索。

时间过滤支持 `days`，或包含的 `from` 加不包含的 `to`。纯日期表示 UTC 零点；本地自然日请带时区偏移。若命中 entry 有多个子分支，聚焦上下文只沿一条连续后代路径返回，并单独列出其他分支入口，不会静默合并 sibling branches。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/history-recall status` | 数量、待处理任务和今日索引调用 |
| `/history-recall conversations` | 已索引与未索引源文件 |
| `/history-recall index FILE` | 索引一个绝对来源路径；bare `index` 返回 usage |
| `/history-recall index-all` | 发现授权来源，并处理本次命令开始时捕获的整个待索引队列 |
| `/history-recall rebuild` | 清当前 profile 的模型缓存并 force 重新排队，保留主题 ID 和用量统计 |

没有空闲后台索引器。一次显式命令对快照中的每个文件尝试一次，跳过仍被其他进程持有 lease 的任务；单个文件失败后保留在队列，继续处理后续文件，下次显式命令可再尝试，不受历史重试次数或退避时间阻挡。快照之后新增的任务留到下次命令。取消会保留未完成任务。不再有“两条会话、十二次调用”的批次截断。重复 `rebuild` 会清除缓存进度；命令拒绝多余参数。

交互式 TUI 会在发现来源/调用模型前，于输入框上方显示实时进度面板：转圈动效、当前文件和阶段、耗时、实际处理/提交数量、剩余队列与模型调用数。进度条不伪造模型思考百分比。完成、失败或取消后立即停止动画、清空底部状态栏，精简结果面板三秒后自动收起；新任务和会话退出都会取消旧面板的定时器。Print 模式按阶段向 stderr 输出进展，向 stdout 输出最终摘要，不刷动画日志。

## 隐私与边界

- 准备 conversation 时会分块向选定的 OMP 模型 provider 发送全部提取并脱敏的文本，而非仅头尾样本；修复还会发送相关历史原文与模型写出的滚动事实笔记；带改写的搜索会发送查询。没有 embedding 服务，但也不是纯本地推理。
- 会脱敏常见凭据，但正则无法识别所有秘密。不要让无权处理该历史的 provider 参与索引。
- SQLite 索引和辅助调用指标保存在本地，数据库仅拥有者可访问；不修改源 JSONL。
- 支持 OMP v3 文件会话；不支持仅远端/SQL 会话和图片理解。
- 单个源文件上限 128 MiB。超长文本 entry 无损切片；原文取证仍然有界、可续页。不索引 reasoning block、图片数据和 provider 签名。
- 源文件变化会使证据哈希失效。目录列表不排队、不修改任何状态。
- 静态 system prompt 注入不保证 provider 缓存命中；OMP、其他插件、工具或 provider 策略仍可能影响缓存。
- 修复要求原生 tool calls。明确不支持工具的模型或非空 `PI_DIALECT` override 会被拒绝，不静默切换文本工具格式。受限工具不等于进程沙箱，仍共享 SDK 的 provider/auth/runtime 基础设施。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `OMP_HISTORY_RECALL_DISABLED` | 不设置 | `1` 重启后禁用 |
| `OMP_HISTORY_RECALL_DB` | `<profile sessions root>/history-recall/index.db` | SQLite 物理路径；共享 override 仍按 profile 隔离，相对路径按启动 cwd 解析一次 |
| `OMP_HISTORY_RECALL_MODEL` | 当前 OMP 模型 | 索引/查询改写模型 |
| `OMP_HISTORY_RECALL_CONCURRENCY` | `1` | 单会话内并发（分析分块、初选分页、修复原文读取）与 repair 原文读取的最大并发，整数 1–32；child 模型 turns 始终顺序执行 |

仍保留请求超时、来源/证据校验、上下文大小与并发控制；这些不是调用次数配额。失败任务保留已校验的请求进度，可以在下一次显式命令中再次尝试。已经使用的历史证据变化返回 `stale_evidence`，非法终态不能伪装为成功 no-op。发布保持原子性，不提交半份会话或主题变化。

取消后仍持有 lease，直到已开始的 provider 请求、原文读取和 child 销毁全部结束。OMP 18.2.6 在模型 hook 前还有一次 SDK 自有认证预检，该 lookup 没有取消信号参数；插件立即锁存取消、阻止后续 provider 请求，并等该预检结束，不修改共享 model registry 或关闭父会话认证存储。

例如 `OMP_HISTORY_RECALL_CONCURRENCY=6 omp` 允许最多六个并发分析/初选调用或原文读取，不会同时运行六个 child 模型 turns。

## 验证

```sh
npm run typecheck -- --noUnusedLocals --noUnusedParameters
npm test
npm run bench:offline -- --conversations 128 --out /tmp/omp-native-repair-benchmark.json
```

测试与 benchmark 使用临时 profile、本地 SSE provider 和真实原生 tool calls，验证执行、取证、配额与发布边界，不评估真实 LLM 的语义准确率。

