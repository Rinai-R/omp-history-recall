# OMP History Recall

[English](./README.md) | [简体中文](./README.zh-CN.md)

An Oh My Pi extension for explicit, progressive retrieval of historical project conversations.

## Behavior

- Adds one static capability instruction to the system prompt. It contains no project topics or historical facts.
- Maintains project-level topics whose descriptions include a readable timeline.
- Treats each historical session as one conversation with a summary and activity windows.
- Never indexes automatically. The user runs an indexing command, or the agent explicitly indexes a selected conversation.
- Searches indexed original text and filters time metadata in code.
- Pages through original JSONL entries with stable IDs and hashes. Summaries are navigation aids, not evidence.

## Install

```sh
cd /path/to/omp-history-recall
npm ci
omp plugin link .
```

Bun >=1.3.14 and OMP 18.2.6 are the verified development versions. If `omp` is not global, use `npm exec -- omp plugin link .`.

Select an authenticated OMP model, list conversations, then index a selected file:

```text
/history-recall conversations
/history-recall index /absolute/path/to/session.jsonl
```

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

Browsing and listing do not invoke a model. Indexing invokes the selected model once for an unchanged conversation. Search may invoke one bounded query-rewrite call and falls back to lexical search if it fails.

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

- Preparing a conversation sends a bounded head/tail text sample to the selected OMP model provider. Search with model rewrite sends the query. No embedding service is used, but this is not local-only inference.
- Common credentials are redacted, but regex redaction cannot identify every secret. Do not prepare histories that the selected provider must not see.
- The SQLite index and utility-call metrics are local with owner-only database permissions. Source JSONL files are never modified.
- OMP v3 file-backed sessions are supported. Remote-only/SQL session storage and image understanding are not.
- A source file limit is 128 MiB. Index previews cap each entry; original reads remain bounded and resumable.
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

Preparation calls time out after 90 seconds. Query rewrite has a 30-second deadline. Failed jobs retain progress and stop after three attempts.

## Verification

```sh
npm test
npm run typecheck
npm run bench:offline
```

Tests cover explicit indexing, topic timeline rendering, time filtering, original reads, project integration and the real OMP extension/tool loop. The offline benchmark uses controlled fixtures and makes no semantic-quality claim.
