# OMP History Recall

[![npm version](https://img.shields.io/npm/v/omp-history-recall)](https://www.npmjs.com/package/omp-history-recall)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/Rinai-R/omp-history-recall)

[English](./README.md) | [简体中文](./README.zh-CN.md)

An Oh My Pi extension for explicit, progressive retrieval of semantic topics and conversations within the current OMP profile.

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

- Adds one static capability instruction to the system prompt. It contains no dynamic topics or historical facts.
- Maintains stable semantic topics across directories within one profile, with readable timelines.
- Treats each historical session as one conversation with a summary, evidence-backed facets and activity windows. A conversation may belong to multiple topics.
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
npm run patch:omp
npm test
omp plugin link .
```

Bun >=1.3.14 and OMP 18.2.6 with the checked-in settlement patch are the verified development versions.

`patches/omp-sdk-18.2.6.json` fixes reader cancellation ownership, iterator cleanup and lazy-stream terminal forwarding in `pi-utils`/`pi-ai`. `npm run patch:omp` applies it only to this project's dependencies, verifies exact package versions and whole-file pre/post hashes, and refuses unknown revisions or redirected files. It is idempotent and also runs before the project test, typecheck and benchmark commands. It is not an install hook and never searches for or patches a real OMP installation. Native repair fails with `unsupported_omp` when the SDK settlement capability is absent; ordinary conversation and no-history indexing do not require a child. Deploying this development version to a real profile therefore requires a compatible SDK separately.

## Data Model

```text
OMP profile
└── semantic topic (stable ID, evolving definition and timeline)
    └── conversation facets (multiple topics per historical session)
        └── original entries (paged evidence)
```

Facets describe separate discussion scopes and cite original entries. Topics are matched semantically against the entire profile catalog, not by `cwd` or title equality. The agent reads original entries before relying on historical facts.

Topic descriptions are rendered like Skill descriptions:

```text
WAL persistence and sync failure semantics. Timeline: ... across 3 conversations.
Latest: ...
```

Raw timeline arrays are not returned in directory listings. Time filtering uses stored conversation timestamps and active windows through SQL.

Accessible sources are the profile's managed sessions and immediate buckets, the current session directory, exact custom-file registrations, and previously indexed or queued files. Registration never authorizes scanning sibling files. The active session is excluded. `source_cwd` is provenance, not a namespace or classification input.

Explicit indexing automatically runs a restricted native OMP child when usable indexed history exists. It reads original evidence before proposing definition updates, historical reassignments, duplicate-topic merges, or facet-based splits. One complete evidence review can publish a repair; no second-conversation vote is required. Each run audits at most eight historical facets, moves at most eight historical and five incoming facets, creates at most five repair drafts, and merges at most one persisted pair. Changed definitions and merges require every final member to pass singleton coverage checks, including explicit end-of-pagination confirmation. Renames, moves and merges leave original entries, FTS rows and evidence identities unchanged.

The six `repair_*` tools exist only in the indexing child, not in the ordinary parent conversation's tool directory. OMP owns its model/tool loop; the extension does not run a separate agent loop. The child uses the same captured model and shared call budget as analysis and topic selection. There is no idle repair timer. A short first conversation with no indexed history still needs only its content-analysis call.

Sources already missing, unreadable or stale before repair are reported in `repair_deferred`; they cannot support a repair proof or a definition change/merge of their topics. Other healthy memberships can still be repaired. Once evidence has been used or a source confirmed healthy, subsequent changes fail the whole publication. Incoming indexing and historical repair commit in one transaction; repair failure never publishes incoming state alone.

The derived database uses schema 5, without a vote table. Schema 4, schema 3 and other older indexes are rejected with a rebuild-path message; there is no migration or automatic deletion. Recreate the derived database explicitly when upgrading. Original OMP v3 JSONL files remain untouched. The `rebuild` command below refreshes a schema-5 index; it does not convert older schemas.

## Tools

| Tool | Result |
| --- | --- |
| `history_recall_browse` | Profile semantic topics with distinct conversation counts, then conversations and facet memberships; supports time filters and pagination |
| `history_recall_conversations` | Paged authorized source files (`source_file`), indexing state and discovery warnings, without model calls |
| `history_recall_index` | Explicitly indexes one absolute `source_file` selected from the catalog |
| `history_recall_search` | Searches original text with an array of 1-8 queries, optional topic/conversation/time filters, and returns matched entry IDs |
| `history_recall_read_conversation` | Pages the active branch, or returns recent same-branch context around a matched `entry_id` using `before`/`after` |

Browsing and listing do not invoke a model. Unchanged indexed files are skipped unless already queued. Content analysis uses one request for short conversations and lossless chunks with bounded hierarchical reduction for longer ones. Topic selection compares the full catalog through byte-bounded pages. Analysis, selection and each uncached native repair request share the same hard call budgets; failed requests count, cache hits do not. Cached native responses replay the real tools and rebuild evidence receipts before publication. Topic changes do not resend cached source analysis. Search may invoke one query-rewrite call and falls back to lexical search if it fails.

Time filters use `days`, or inclusive `from` plus exclusive `to`. Date-only values mean UTC midnight; use an explicit offset for a local calendar day. If an entry has multiple child branches, focused context follows one contiguous descendant path and reports other branch entry IDs separately instead of silently merging sibling branches.

## Commands

| Command | Purpose |
| --- | --- |
| `/history-recall status` | Counts, pending jobs and today's indexing calls |
| `/history-recall conversations` | Indexed and unindexed source candidates |
| `/history-recall index FILE` | Index one selected absolute source path; bare `index` returns usage |
| `/history-recall index-all` | Discover authorized profile sources and explicitly process a bounded batch |
| `/history-recall rebuild` | Clear this profile's model cache and force-requeue authorized sources, preserving topic IDs and daily quota |

There is no idle background indexer. Continue unfinished work with `index-all`; repeating `rebuild` discards cached progress. Commands reject extra arguments.

## Privacy and Limits

- Preparing a conversation sends all extracted, redacted text across bounded chunks to the selected OMP model provider, not merely a head/tail sample. Repair also sends relevant historical evidence and model-written rolling notes. Search with model rewrite sends the query. No embedding service is used, but this is not local-only inference.
- Common credentials are redacted, but regex redaction cannot identify every secret. Do not prepare histories that the selected provider must not see.
- The SQLite index and utility-call metrics are local with owner-only database permissions. Source JSONL files are never modified.
- OMP v3 file-backed sessions are supported. Remote-only/SQL session storage and image understanding are not.
- A source file limit is 128 MiB. Oversized text entries are fragmented without truncation; original evidence reads remain bounded and resumable. Reasoning blocks, images and provider signatures are not indexed.
- Source changes invalidate evidence hashes. Catalog listings do not queue or modify anything.
- Static system-prompt injection does not guarantee provider cache hits; OMP, other extensions, tools, or provider policy can still invalidate a cache.
- Repair requires native tool-call support. Models explicitly declaring no tools and a nonempty `PI_DIALECT` override are rejected; there is no silent text-tool fallback. Restricted SDK tools are not a process sandbox: provider/auth/runtime infrastructure remains shared.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_HISTORY_RECALL_DISABLED` | unset | `1` disables the extension after restart |
| `OMP_HISTORY_RECALL_DB` | `<profile sessions root>/history-recall/index.db` | Physical SQLite path; a shared override still isolates profiles, and relative overrides resolve once against startup cwd |
| `OMP_HISTORY_RECALL_MODEL` | current OMP model | Indexing/query-rewrite model |
| `OMP_HISTORY_RECALL_BATCH_SESSIONS` | `2` | Maximum conversations in an explicit batch |
| `OMP_HISTORY_RECALL_BATCH_CALLS` | `12` | Uncached model calls per batch |
| `OMP_HISTORY_RECALL_DAILY_CALLS` | `60` | Indexing calls per profile per UTC day, shared by every indexing stage |
| `OMP_HISTORY_RECALL_CONCURRENCY` | `3` | Maximum concurrent analysis/selection calls and repair source reads; integer 1–32. Native repair model turns are sequential. |

Each analysis/selection request and native model turn has a 90-second deadline; this is not a whole-conversation deadline. Query rewrite has a 30-second deadline. Failed jobs retain validated request progress. Cancellation, incoming-source changes, concurrent topic-state changes and exhausted budgets do not count toward the three-failure limit. Used historical evidence changing produces `stale_evidence`; malformed repair output cannot become a successful no-op. Publication is atomic: failures cannot publish partial topic or conversation changes. Retries require explicit batches.

Cancellation retains the lease until admitted provider requests, source reads and child disposal settle. OMP 18.2.6 also performs an SDK-owned authentication preflight before its model hooks; that lookup has no cancellation-signal parameter. Cancellation is latched immediately, prevents subsequent provider dispatch, and waits for this preflight to settle without mutating the shared model registry or closing parent authentication storage.

For example, `OMP_HISTORY_RECALL_CONCURRENCY=6 omp` allows up to six analysis/selection calls or source reads, not six simultaneous child model turns.

## Verification

```sh
npm run typecheck -- --noUnusedLocals --noUnusedParameters
npm test
npm run bench:offline -- --conversations 128 --out /tmp/omp-native-repair-benchmark.json
```

Tests and the benchmark use temporary profiles and a local SSE provider with real native tool calls. They verify execution, evidence, accounting and publication boundaries, not real-LLM semantic accuracy.

