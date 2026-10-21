<h1 align="center">OMP History Recall</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">在本地搜索你的每一段 Oh My Pi 会话。</p>

OMP History Recall 是 Oh My Pi（OMP）的开源插件。它把会话文件增量写入本地 SQLite FTS5 索引，并给 Agent 提供查找、引用历史工作的工具。不调用模型，不做 embedding，不上传数据。

- **所有会话：** 覆盖当前 OMP profile，跨工作目录。
- **增量：** 只入库变化的文件，单次有界处理，并返回 `pending_files`。
- **全文检索：** 消息、工具调用与输出、compaction/branch summary、custom message；中文使用 bigram。
- **证据而非摘要：** 搜索只给定位；读取时分页返回原始 JSONL 条目，带稳定 ID 和哈希。
- **本地私有：** 数据不出本机；入库前会脱敏常见凭据。
- **安全：** 排除当前会话，从不修改原始会话文件。

## 快速开始

### 前置条件

- Oh My Pi `18.2.6` 或更高版本

### 安装

```bash
omp install omp-history-recall
```

等价完整命令为 `omp plugin install omp-history-recall`。安装后重启 OMP。

### 使用

```text
/history-recall sync
/history-recall conversations
/history-recall status
```

Agent 可以使用 `history_recall_search`、`history_recall_conversations` 和 `history_recall_read_conversation`。搜索覆盖当前 profile；传入 `source_cwd` 可限定到某个工作目录。

可选环境变量：`OMP_HISTORY_RECALL_DB`（索引路径）、`OMP_HISTORY_RECALL_INGEST_FILES`（默认 64）、`OMP_HISTORY_RECALL_INGEST_BYTES`（默认 32 MiB）、`OMP_HISTORY_RECALL_DISABLED=1`。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run bench:offline
```

## 许可证

本仓库尚未选择许可证。
