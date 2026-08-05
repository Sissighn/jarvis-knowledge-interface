# Architecture

JARVIS is organized by product feature rather than framework primitive. Each feature owns its domain types and implementation, while `app/` remains a thin routing layer.

## Design principles

1. **Local-first by default.** Search, preferences, graph interaction, and semantic analysis run locally whenever practical.
2. **Server-only credentials.** The Notion token is read only in the server connector and never crosses the API boundary.
3. **Pure algorithms.** Chunking, concept normalization, relation building, ranking, and graph layout are isolated from network and UI code.
4. **Graceful degradation.** The last real index, cached briefings, and independent feed results keep the interface useful when an external source is unavailable; knowledge is never replaced with demo data.
5. **Grounded generation.** The language model receives only retrieved note excerpts and must cite the context it uses.
6. **Feature ownership.** Components, types, integrations, and tests are grouped around the capability they implement.
7. **One application core.** The browser and macOS app use the same React UI, API routes, retrieval logic, and server integrations.
8. **Evidence before display.** A concept needs at least one indexed occurrence and every relation needs a readable reason plus a source; nothing enters the map from model knowledge alone.

## Knowledge flow

The map shows concepts supported by selected Notion content. Navigation titles such as
`5. Übung` are only source references and never become map nodes.

```text
accessible data sources ──► stable Notion database IDs + parent metadata
   │
   ▼
concrete database picker ──► SQL-enforced selection boundary
   │
   ▼
full crawl (search pagination, nested blocks, depth 12, ≤ 5.000 blocks/page)
   │
   ▼
heading and toggle paths ──► 500–1.200 character chunks ──► SQLite + FTS5
   │
   ▼
DE/EN tokenization + TF-IDF/phrase scoring ──► evidenced concepts (≤ 100 in overview)
   │
   ▼
Notion relations + mentions + tags + co-occurrence ──► optional embedding similarity
   │
   ▼
/api/knowledge/graph ──► concept map ──► /api/knowledge/search (BM25 + vectors + RRF)
                                            │
                             ≤ 8 chunks from ≤ 5 sources
                                            │
                                            ▼
                                    /api/ai/answer
                                            │
                                            ▼
                         local Ollama + Qwen 3.5 + recent turns
                                            │
                                            ▼
                      claim verification + chunk citations + highlighting
```

The picker persists stable database IDs while data-source IDs remain query metadata. The crawler
reads only selected databases and content explicitly shared with the integration. Pages are
re-read when `last_edited_time` changes and are replaced atomically. Concepts are scored from
real chunk text with navigation/generic-term filtering; no chat model runs during indexing.
Each completed database publishes a graph snapshot. Relations come from explicit Notion
properties, page mentions, shared tags, co-occurrence and optional semantic similarity, with
stored evidence and confidence. Retrieval is selection-filtered in SQL and fuses BM25 and
optional embedding rankings with reciprocal rank fusion. Qwen receives
those chunks plus up to four session-only conversation turns, where previous answers may
clarify references but never count as evidence. Every factual sentence needs an inline citation
and passes a deterministic lexical support check before display. The browser receives concept
data and snippets, never the integration token.

## Local index

| Path | Purpose |
| --- | --- |
| `~/Library/Application Support/com.sissighn.jarvis/knowledge-index.sqlite3` | production index |
| `.jarvis-dev/knowledge-index.sqlite3` | development index (git-ignored) |

The index runs on `node:sqlite` with WAL, foreign keys, a busy timeout, `PRAGMA optimize`, and
numbered idempotent migrations tracked in `schema_version`. It stores stable database/data-source
mappings, selected sources, chunks, concepts, occurrences, relation evidence, optional float32
embeddings, sync runs, and an FTS5 index. Schema version 3 adds database-scoped selection and
relation provenance while retaining legacy tables only for safe migration. Notion content, tokens, and embeddings never leave this Mac: no Cloudflare D1 or R2,
no browser storage, no logs, no git.

The indexer is a Node service in `desktop/indexer/`. The desktop server answers
`/api/knowledge/*` in-process before the vinext worker; `npm run dev` starts the same service on
`127.0.0.1:4318` and the app route proxies to it. Hosted builds have no index and answer
`desktop_required`.

## Briefing flow

```text
public sources ──► isolated fetchers ──► topic scoring ──► deduplication
                                                         │
                                                         ▼
browser cache ◄──────────── /api/briefing ◄──────── top 10 relevant stories
```

Source failures are collected independently. A single unavailable feed cannot fail the full response, and the browser retains the latest daily result. Stories older than 72 hours are discarded rather than used as filler; within that window, a steep freshness score favors the newest relevant reports, and only stories no older than 36 hours can enter the “important” group.

## Vocabulary flow

```text
curated catalogue ──► date-based rotation ──► five daily terms ──► carousel
                                                                      │
                                                        explicit ZU NOTION +
                                                                      │
                                                                      ▼
                                            validated eight-column table row
```

The daily vocabulary is deterministic, local, and independent of the news feeds or language model. Each term includes a definition, category, purpose, professional example, everyday analogy, conversational sentence, and takeaway. Export is a separate POST boundary: the server validates the requested term against that day's catalogue, checks the configured table schema, rejects duplicates, and appends exactly one row only after the user's explicit action.

## Speech flow

```text
microphone ──► MediaRecorder session ──► user presses Stop
                                               │
                                               ▼
                                    /api/speech/transcribe
                                               │
                                               ▼
                              local whisper.cpp + large-v3-turbo
                                               │
                                               ▼
                            editable command text ──► explicit Send
```

Recording never stops because of silence. Audio is held in browser memory for the active session, sent only to the loopback transcription service, and discarded after the transcript returns. Transcription and question submission are separate user actions.

## Runtime boundaries

| Boundary | Responsibilities |
| --- | --- |
| React client | interaction, Canvas rendering, live sync status, concept detail, session conversation context, answer presentation, speech controls, preferences |
| Canvas renderers | one shared visual language in `features/interface/renderers/neural-style.ts`; the core sphere and the knowledge map compose the same additive ink, filaments, trails, links, points, and halo |
| Next.js API routes | input validation, Ollama, Whisper, and explicit Notion-write boundaries, indexer proxying in development, error mapping, cache controls |
| Local indexer | Notion crawl, SQLite index, concept extraction, embeddings, relation building, hybrid retrieval |
| Feature server modules | local language and speech models, Notion connection, feeds, and weather access |
| Pure feature modules | chunking, concept normalization, relation math, ranking, layout, and domain types |
| Worker | vinext request handling and image optimization |
| Desktop sidecar | self-contained Node runtime that serves the built worker and static assets on loopback |
| Tauri shell | window lifecycle, menu bar, launch at login, global shortcut, notifications, and child-process ownership |

## macOS runtime

```text
JARVIS.app
   │
   ├── Tauri process ──► window + menu bar + ⌘⇧J + autostart
   │        │
   │        ├──► packaged jarvis-server sidecar ──► http://127.0.0.1:4317
   │        │                                         │
   │        │                                         ├──► /api/knowledge/* local index
   │        │                                         ▼
   │        │                                shared React + API application
   │        │
   │        └──► local whisper-server when no existing service is active
   │
   └──► existing Ollama service at 127.0.0.1:11434
```

The desktop server contains the vinext worker and generated client assets, but not secrets, Notion data, or model weights. Runtime configuration and the speech-model reference are prepared in the user's macOS Application Support directory. The window loads only the fixed loopback origin, and its native capability grants only core Tauri access plus notifications; shell, autostart, tray, and shortcut operations stay in Rust.

The Tauri process owns every child it starts and terminates those children during a full app exit. Closing the main window only hides it so the global shortcut and menu bar remain useful.

## Testing strategy

- unit tests cover chunking, concept and navigation-title filtering, alias merging, relation evidence, edge limits, SQLite migrations and rollback, a full stubbed sync of a course workspace, Notion crawling, hybrid retrieval, generated-answer grounding, session conversation context, briefing freshness, daily vocabulary rotation, and map viewport, interaction, and rendering behaviour
- TypeScript strict mode validates contracts across feature boundaries
- ESLint covers React, Next.js, and TypeScript conventions
- integration tests run against the built worker and verify SSR plus the Notion credential boundary
- the desktop sidecar is smoke-tested against server-rendered HTML, bundled assets, and API routes
- `cargo check` validates the native shell on the primary Apple Silicon development environment
- GitHub Actions runs isolated web and Apple Silicon desktop jobs on pushes and pull requests
