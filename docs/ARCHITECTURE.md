# Architecture

JARVIS is organized by product feature rather than framework primitive. Each feature owns its domain types and implementation, while `app/` remains a thin routing layer.

## Design principles

1. **Local-first by default.** Search, preferences, graph interaction, and semantic analysis run locally whenever practical.
2. **Server-only credentials.** The Notion token is read only in the server connector and never crosses the API boundary.
3. **Pure algorithms.** Ranking, TF-IDF vectorization, clustering, and graph layout are isolated from network and UI code.
4. **Graceful degradation.** Sample knowledge, cached briefings, and independent feed results keep the interface useful when an external source is unavailable.
5. **Grounded generation.** The language model receives only retrieved note excerpts and must cite the context it uses.
6. **Feature ownership.** Components, types, integrations, and tests are grouped around the capability they implement.
7. **One application core.** The browser and macOS app use the same React UI, API routes, retrieval logic, and server integrations.

## Knowledge flow

```text
Notion API
   │
   ▼
server connector ──► normalized nodes and explicit edges
   │
   ▼
TF-IDF vectors ──► semantic edges ──► topic clusters ──► deterministic layout
   │
   ▼
/api/notion/graph ──► interface state ──► local TF-IDF retrieval
                                            │
                                  top five note excerpts
                                            │
                                            ▼
                                    /api/ai/answer
                                            │
                                            ▼
                                  local Ollama + Qwen 3.5
                                            │
                                            ▼
                            natural answer + citations + highlighting
```

The connector reads only content explicitly shared with the integration. The graph builder combines Notion hierarchy, relations, page mentions, and content similarity. The browser ranks notes and passes at most five retrieved excerpts to the server-only Ollama bridge. Qwen formulates the answer locally and returns numbered citations. If the model or context is unavailable, the deterministic extractive answer remains the fallback. The browser receives normalized graph data, never the integration token.

## Briefing flow

```text
public sources ──► isolated fetchers ──► topic scoring ──► deduplication
                                                         │
                                                         ▼
browser cache ◄──────────── /api/briefing ◄──────── top 10 relevant stories
```

Source failures are collected independently. A single unavailable feed cannot fail the full response, and the browser retains the latest daily result.

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
| React client | interaction, Canvas rendering, local retrieval, answer presentation, speech controls, preferences |
| Next.js API routes | input validation, Ollama and Whisper boundaries, error mapping, cache controls |
| Feature server modules | local language and speech models, Notion, feeds, and weather access |
| Pure feature modules | vector math, ranking, clustering, layout, and domain types |
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

- unit tests cover deterministic retrieval and generated-answer contracts
- TypeScript strict mode validates contracts across feature boundaries
- ESLint covers React, Next.js, and TypeScript conventions
- integration tests run against the built worker and verify SSR plus the Notion credential boundary
- the desktop sidecar is smoke-tested against server-rendered HTML, bundled assets, and API routes
- `cargo check` validates the native shell on the primary Apple Silicon development environment
- GitHub Actions runs the complete check pipeline on pushes and pull requests
