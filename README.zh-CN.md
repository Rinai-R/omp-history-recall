# OMP History Recall

[![npm version](https://img.shields.io/npm/v/omp-history-recall)](https://www.npmjs.com/package/omp-history-recall)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/Rinai-R/omp-history-recall)

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个显式、渐进加载历史项目会话的 Oh My Pi 插件。

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

- 向 system prompt 追加一条静态能力说明，不包含项目 topic 或历史事实。
- 维护项目级 topic，description 中直接整合可读时间线。
- 每个历史 session 是一个 conversation，带简介和活跃时间窗口。
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
npm test
omp plugin link .
```

验证过的开发版本为 Bun 1.3.14 和 OMP 18.2.6。

## 数据模型

```text
project
└── topic（项目统一范围，description 内含 timeline）
    └── conversation（一个历史 OMP session）
        └── original entries（分页证据）
```

没有单独的 item 层。一个 conversation 可以包含多个需求或事件，Agent 直接读取原文并自行提取重点。

Topic description 类似 Skills 的描述方式：

```text
WAL 持久化与同步失败语义。Timeline: ... across 3 conversations.
Latest: ...
```

目录列表不返回结构化 timeline 数组。时间检索基于存储的会话时间戳和活跃窗口，由 SQL 过滤。

当前 bucket 中源 `cwd` 与当前项目不同的会话，会整合进当前统一项目目录，并标记 `unprojected: true`。

## 工具

| 工具 | 返回 |
| --- | --- |
| `history_recall_browse` | 项目 topic，以及某个 topic 下的 conversations；支持时间过滤和分页 |
| `history_recall_conversations` | 已索引和未索引的 session 文件，不调用模型 |
| `history_recall_index` | 显式索引一个选中的 conversation |
| `history_recall_search` | 用 1-8 个 query 数组搜索原文，支持 topic/会话/时间过滤，返回命中 entry ID |
| `history_recall_read_conversation` | 分页读取 active branch，或用命中 `entry_id` 加 `before`/`after` 返回同分支最近上下文 |

浏览和列表不调用模型。未变化的 conversation 索引只需一次模型调用。搜索最多一次有界查询改写，失败时降级为词项搜索。

时间过滤支持 `days`，或包含的 `from` 加不包含的 `to`。纯日期表示 UTC 零点；本地自然日请带时区偏移。若命中 entry 有多个子分支，聚焦上下文只沿一条连续后代路径返回，并单独列出其他分支入口，不会静默合并 sibling branches。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/history-recall status` | 数量、待处理任务和今日索引调用 |
| `/history-recall conversations` | 已索引与未索引源文件 |
| `/history-recall index FILE` | 索引一个选中会话 |
| `/history-recall index-all` | 显式处理一批 |
| `/history-recall rebuild` | 清准备缓存并显式重新排队 |

没有空闲后台索引器。

## 隐私与边界

- 准备 conversation 时会向选定的 OMP 模型 provider 发送有界头尾文本样本；带改写的搜索会发送查询。没有 embedding 服务，但也不是纯本地推理。
- 会脱敏常见凭据，但正则无法识别所有秘密。不要让无权处理该历史的 provider 参与索引。
- SQLite 索引和辅助调用指标保存在本地，数据库仅拥有者可访问；不修改源 JSONL。
- 支持 OMP v3 文件会话；不支持仅远端/SQL 会话和图片理解。
- 单个源文件上限 128 MiB。索引预览限制 entry 大小；原文读取保持有界并可续页。
- 源文件变化会使证据哈希失效。目录列表不排队、不修改任何状态。
- 静态 system prompt 注入不保证 provider 缓存命中；OMP、其他插件、工具或 provider 策略仍可能影响缓存。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `OMP_HISTORY_RECALL_DISABLED` | 不设置 | `1` 重启后禁用 |
| `OMP_HISTORY_RECALL_DB` | 会话目录同级 `history-recall/index.db` | SQLite 索引路径 |
| `OMP_HISTORY_RECALL_MODEL` | 当前 OMP 模型 | 索引/查询改写模型 |
| `OMP_HISTORY_RECALL_BATCH_SESSIONS` | `2` | 显式批处理最大会话数 |
| `OMP_HISTORY_RECALL_BATCH_CALLS` | `12` | 每批未缓存模型调用 |
| `OMP_HISTORY_RECALL_DAILY_CALLS` | `60` | 每项目每 UTC 日索引调用 |

准备调用超时 90 秒；查询改写期限 30 秒。失败任务保留进度，连续三次后停止。

## 验证

```sh
npm test
npm run typecheck
npm run bench:offline
```

测试覆盖显式索引、topic timeline 渲染、时间过滤、原文读取、无项目会话整合，以及真实 OMP 扩展和工具循环。离线 benchmark 使用受控 fixture，不宣称语义质量。
