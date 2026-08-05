# Privacy

Last updated: August 5, 2026

JARVIS is a local-first, self-hosted personal application. In its default setup, the interface, knowledge retrieval, answer model, and speech model run on the user's own device. The project does not include user accounts, advertising, analytics, tracking pixels, or a hosted database.

This document describes the data flows implemented by the repository. It is not legal advice and is not a substitute for a privacy notice tailored to a public or shared deployment.

## Data processing in the default local setup

| Feature | Data involved | Processing and recipients | Retention |
| --- | --- | --- | --- |
| Notion sync | integration token and content from the concrete databases selected by the user | the local indexer requests content from the Notion API; the token is not sent to the browser | the token remains in the ignored `.env.local` file; page text, chunks, concepts, and optional float32 embeddings are stored in the local SQLite index on this Mac |
| Concept extraction | indexed passages of the selected databases | deterministic phrase scoring runs inside JARVIS; only optional embeddings are sent to the loopback Ollama service | concepts, occurrences, relations, and vectors remain in the local index until a sync removes them or the index is deleted |
| Knowledge Q&A | the question, at most eight indexed passages from at most five sources, and up to four recent Q&A turns | retrieval and claim verification run locally; selected context and recent turns are sent only to the local Ollama service | recent turns stay in application memory for the current session and are not intentionally persisted by JARVIS |
| Voice input | microphone recording and resulting transcript | the browser sends the completed recording to the local JARVIS route, which forwards it to the whisper.cpp service configured by `WHISPER_BASE_URL`, which defaults to loopback | JARVIS does not intentionally persist recordings; the local speech runtime or conversion tools may use transient working files while processing |
| Tech briefing | public articles and local relevance choices | public feeds are fetched server-side; saved and hidden story identifiers are stored in browser storage | feed results are cached temporarily in memory and in the browser; preferences remain until browser site data is cleared |
| Tech vocabulary | the selected term and its seven explanatory fields | the daily selection is computed locally; only an explicit **ZU NOTION +** action sends that term to the configured Notion table | successful term identifiers remain in browser storage; the exported row remains in Notion until deleted there |
| Weather | configured location name and coordinates | coordinates are sent to Open-Meteo to retrieve the forecast | the result is cached in server memory for approximately 30 minutes |
| Local logs | technical status and error information | shown in or written by the local development processes | retained according to the local terminal, shell, and development-tool configuration |
| macOS integration | app lifecycle, the registered `⌘⇧J` shortcut, launch-at-login state, and notification permission | handled locally by macOS and the Tauri process | settings remain until disabled in JARVIS or macOS; delivered notifications follow the user's Notification Center settings |

## External services

The default application may contact the following services:

- [Notion](https://www.notion.so/) for content explicitly shared with the configured integration.
- [Open-Meteo](https://open-meteo.com/) for weather data. The configured coordinates are part of the request.
- [OpenAI News](https://openai.com/news/), [GitHub Changelog](https://github.blog/changelog/), [Techpresso](https://www.dupple.com/techpresso), and [Hacker News](https://news.ycombinator.com/) for the public briefing.
- [Hugging Face](https://huggingface.co/) when `npm run setup:speech` downloads the local Whisper model.
- [Ollama](https://ollama.com/) when a model is installed manually. Answer generation itself uses the configured Ollama runtime and defaults to the local device.

Opening a Notion page, news story, or another external link transfers the usual browser request data to that destination. Each external provider processes data under its own terms and privacy policy.

## Browser storage

JARVIS uses `localStorage` for the daily briefing cache, saved or hidden story identifiers, and identifiers of vocabulary terms already exported to Notion. Indexed Notion content, concepts, and embeddings are never written to browser storage; they exist only in the local SQLite index. It does not set analytics or advertising cookies. Browser storage can be removed through the browser's site-data controls.

The native app uses an embedded WebView with its own site storage. The release build prepares a private runtime copy of `.env.local` and the local speech-model reference in `~/Library/Application Support/com.sissighn.jarvis/`. The copied environment file is created with owner-only file permissions and is not included in the `.app`, DMG, or repository.

## Security choices

- secrets are read only by server-side routes and `.env*` files are excluded from Git
- the knowledge index is a local SQLite file; hosted builds have no index and answer `desktop_required` for every `/api/knowledge/*` request
- no Cloudflare D1 or R2 binding exists, and the index directories are excluded from Git
- Notion graph access is read-only and limited to explicitly shared content; optional update access is used only after an explicit glossary-export click and only for the configured table
- Ollama and whisper.cpp default to loopback addresses
- the packaged application server listens only on `127.0.0.1`
- native WebView permissions are limited to Tauri core functionality and notifications for the fixed loopback origin
- native shell, autostart, menu bar, and global-shortcut operations are not exposed to application JavaScript
- audio is reviewed as text before a question is submitted
- the repository does not include model files, personal Notion content, or credentials

Do not expose the development server, Ollama, whisper.cpp, or their ports to an untrusted network without authentication, transport encryption, and an appropriate access-control design.

## The local knowledge index

Indexed Notion content is stored only on this Mac:

| Environment | Location |
| --- | --- |
| Desktop app | `~/Library/Application Support/com.sissighn.jarvis/knowledge-index.sqlite3` |
| Development | `.jarvis-dev/knowledge-index.sqlite3` (git-ignored) |

The index holds selected database IDs, page metadata, page text in chunks, concepts with descriptions,
occurrences with snippets, relations, and float32 embeddings. **INDEX LÖSCHEN UND NEU AUFBAUEN**
in the setup dialog deletes all of it after a confirmation click. Removing a database from the
selection removes its content from the map immediately and from the index after the next sync.

## Deleting local data

To remove data associated with the local setup:

1. Clear the site's browser data to delete briefing preferences and caches.
2. Delete the local knowledge index through the setup dialog or by removing the SQLite file listed above.
3. Stop JARVIS to clear in-memory application caches.
4. Delete `.env.local` and revoke the Notion integration token in Notion.
5. Delete downloaded model files or uninstall the local model runtimes if they are no longer needed.
6. For the native app, disable **Beim Anmelden öffnen**, remove the JARVIS application, and delete `~/Library/Application Support/com.sissighn.jarvis/`.

The macOS notification history can be managed separately in Notification Center, and notification permission can be revoked in System Settings.

This does not delete the original content stored in Notion or data independently retained by external providers.

## Public or shared deployments

This repository's default privacy description applies only to the local, personal workflow. Anyone who deploys or operates a modified version for other people is responsible for assessing their own role and obligations, including an operator identity and contact, legal bases, retention periods, processors, international transfers, security, data-subject rights, consent requirements, and any legally required imprint or privacy interface.

## Questions and changes

Privacy-relevant changes should be documented in this file. Questions can be raised through the repository's [GitHub issues](https://github.com/Sissighn/jarvis-knowledge-interface/issues).
