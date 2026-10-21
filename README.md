<h1 align="center">OMP History Recall</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">Search every past Oh My Pi session, locally.</p>

OMP History Recall is an open source plugin for Oh My Pi (OMP). It indexes session files into a local SQLite FTS5 index and gives the agent tools to find and cite past work. No model calls, no embeddings, no uploads.

- **Every session:** the active OMP profile, across working directories.
- **Incremental:** only changed files are ingested, in bounded passes that report `pending_files`.
- **Full text:** messages, tool calls and output, compaction and branch summaries, custom messages; Han queries use bigrams.
- **Evidence, not summaries:** hits are pointers. Reading pages the original JSONL entries with stable IDs and hashes.
- **Private:** everything stays on this machine; common credentials are redacted before indexing.
- **Safe:** the current session is excluded, and original session files are never modified.

## Getting Started

### Prerequisites

- Oh My Pi `18.2.6` or later

### Install

```bash
omp install omp-history-recall
```

The equivalent full command is `omp plugin install omp-history-recall`. Restart OMP afterwards.

### Use

```text
/history-recall sync
/history-recall conversations
/history-recall status
```

The agent gets `history_recall_search`, `history_recall_conversations` and `history_recall_read_conversation`. Search covers the active profile; pass `source_cwd` to restrict it to one working directory, and follow `next_cursor` to page through hits. Pass `session_id` to target one session; the current session is read directly and gets a local index only when it is large. `last=N` returns a session's newest entries.

Optional environment variables: `OMP_HISTORY_RECALL_DB` (index path), `OMP_HISTORY_RECALL_INGEST_FILES` (default 64), `OMP_HISTORY_RECALL_INGEST_BYTES` (default 32 MiB), `OMP_HISTORY_RECALL_DISABLED=1`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run bench:offline
```

## License

No license has been chosen for this repository yet.
