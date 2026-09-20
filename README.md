# OMP History Recall

[![npm version](https://img.shields.io/npm/v/omp-history-recall)](https://www.npmjs.com/package/omp-history-recall)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/Rinai-R/omp-history-recall)

[English](./README.md) | [简体中文](./README.zh-CN.md)

An Oh My Pi extension for explicit, progressive retrieval of historical project conversations.

## Quick Start

```sh
omp install omp-history-recall
```

The equivalent full command is:

```sh
omp plugin install omp-history-recall
```

If your binary still uses the upstream Pi name, the same operation is `pi install omp-history-recall`.
Restart OMP after installation, select an authenticated model, then explicitly index a conversation:

```text
/history-recall conversations
/history-recall index /absolute/path/to/session.jsonl
/history-recall status
```

## Behavior

- Adds one static capability instruction to the system prompt. It contains no project topics or historical facts.
- Maintains project-level topics whose descriptions include a readable timeline.
- Treats each historical session as one conversation with a summary and activity windows.
- Never indexes automatically. The user runs an indexing command, or the agent explicitly indexes a selected conversation.
- Searches indexed original text and filters time metadata in code.
- Pages through original JSONL entries with stable IDs and hashes. Summaries are navigation aids, not evidence.

## Install

Install the published npm package:

```sh
omp install omp-history-recall
```

Or install directly from GitHub:

```sh
omp install github:Rinai-R/omp-history-recall
```

For development:

```sh
git clone git@github.com:Rinai-R/omp-history-recall.git
cd omp-history-recall
npm ci
npm test
omp plugin link .
```

Bun >=1.3.14 and OMP 18.2.6 are the verified development versions.

## Data Model

```text
project
└── topic (unified project-wide scope, timeline in description)
    └── conversation (one historical OMP session)
        └── original entries (paged evidence)
```

There is no separate item layer. A conversation can contain multiple requirements or events; the agent reads its original entries and identifies the relevant part itself.

Topic descriptions are rendered like Skill descriptions:

```text
WAL persistence and sync failure semantics. Timeline: ... across 3 conversations.
Latest: ...
```

Raw timeline arrays are not returned in directory listings. Time filtering uses stored conversation timestamps and active windows through SQL.

Sessions found in the current bucket whose source `cwd` differs from the current project are integrated into the current unified project directory and marked `unprojected: true`.

## Tools

| Tool | Result |
| --- | --- |
| `history_recall_browse` | Project topics, then conversations for a topic; supports time filters and pagination |
| `history_recall_conversations` | Indexed and unindexed session files without model calls |
| `history_recall_index` | Explicitly indexes one selected conversation |
| `history_recall_search` | Searches original text with an array of 1-8 queries, optional topic/conversation/time filters, and returns matched entry IDs |
| `history_recall_read_conversation` | Pages the active branch, or returns recent same-branch context around a matched `entry_id` using `before`/`after` |

Browsing and listing do not invoke a model. Unchanged indexed files are skipped. A new conversation uses one model call when it fits in one chunk; larger conversations use chunk summaries and bounded hierarchical merging. Cached requests are free. Search may invoke one query-rewrite call and falls back to lexical search if it fails.

Time filters use `days`, or inclusive `from` plus exclusive `to`. Date-only values mean UTC midnight; use an explicit offset for a local calendar day. If an entry has multiple child branches, focused context follows one contiguous descendant path and reports other branch entry IDs separately instead of silently merging sibling branches.

## Commands

| Command | Purpose |
| --- | --- |
| `/history-recall status` | Counts, pending jobs and today's indexing calls |
| `/history-recall conversations` | Indexed and unindexed source candidates |
| `/history-recall index FILE` | Index one selected conversation |
| `/history-recall index-all` | Explicitly process a bounded batch |
| `/history-recall rebuild` | Clear preparation cache and explicitly requeue the bucket |

There is no idle background indexer.

## Privacy and Limits

- Preparing a conversation sends all extracted, redacted text across bounded chunks to the selected OMP model provider, not merely a head/tail sample. Search with model rewrite sends the query. No embedding service is used, but this is not local-only inference.
- Common credentials are redacted, but regex redaction cannot identify every secret. Do not prepare histories that the selected provider must not see.
- The SQLite index and utility-call metrics are local with owner-only database permissions. Source JSONL files are never modified.
- OMP v3 file-backed sessions are supported. Remote-only/SQL session storage and image understanding are not.
- A source file limit is 128 MiB. Oversized text entries are fragmented without truncation; original evidence reads remain bounded and resumable. Reasoning blocks, images and provider signatures are not indexed.
- Source changes invalidate evidence hashes. Catalog listings do not queue or modify anything.
- Static system-prompt injection does not guarantee provider cache hits; OMP, other extensions, tools, or provider policy can still invalidate a cache.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_HISTORY_RECALL_DISABLED` | unset | `1` disables the extension after restart |
| `OMP_HISTORY_RECALL_DB` | sibling `history-recall/index.db` | SQLite index path |
| `OMP_HISTORY_RECALL_MODEL` | current OMP model | Indexing/query-rewrite model |
| `OMP_HISTORY_RECALL_BATCH_SESSIONS` | `2` | Maximum conversations in an explicit batch |
| `OMP_HISTORY_RECALL_BATCH_CALLS` | `12` | Uncached model calls per batch |
| `OMP_HISTORY_RECALL_DAILY_CALLS` | `60` | Indexing calls per project per UTC day |
| `OMP_HISTORY_RECALL_CONCURRENCY` | `3` | Maximum concurrent model calls in an indexing layer; integer 1–32 (`1` restores sequential execution) |

Each preparation call times out after 90 seconds; this is not a whole-conversation deadline. Query rewrite has a 30-second deadline. Failed jobs retain validated chunk progress. Cancellation, source changes during indexing and exhausted budgets do not count toward the three-failure limit. Retries are processed by explicit batches, not an idle background worker.

For example, start OMP with `OMP_HISTORY_RECALL_CONCURRENCY=6 omp` to allow up to six calls per layer.

## Verification

```sh
npm test
npm run typecheck
npm run bench:offline
```

