# Privacy

Last updated: August 6, 2026

JARVIS is a local-first, self-hosted personal application. In its default setup, the interface, knowledge retrieval, answer model, and speech model run on the user's own device. The project does not include user accounts, advertising, analytics, tracking pixels, or a hosted database.

This document describes the data flows implemented by the repository. It is not legal advice and is not a substitute for a privacy notice tailored to a public or shared deployment.

## Data processing in the default local setup

| Feature | Data involved | Processing and recipients | Retention |
| --- | --- | --- | --- |
| Notion sync | integration token and content from the concrete databases selected by the user | the local indexer requests content from the Notion API; the token is not sent to the browser | the token remains in the ignored `.env.local` file; page text, chunks, concepts, and optional float32 embeddings are stored in the local SQLite index on this Mac |
| Concept extraction | indexed passages of the selected databases | deterministic phrase scoring runs inside JARVIS; only optional embeddings are sent to the loopback Ollama service | concepts, occurrences, relations, and vectors remain in the local index until a sync removes them or the index is deleted |
| Knowledge Q&A | the question, at most eight indexed passages from at most five sources, and up to four recent Q&A turns | retrieval and claim verification run locally; selected context and recent turns are sent only to the local Ollama service | recent turns stay in application memory for the current session and are not intentionally persisted by JARVIS |
| Voice input | microphone recording and resulting transcript | in the browser `MediaRecorder` captures the audio; in the app it is captured natively in the Tauri process and kept in memory as a WAV file. Both paths send the completed recording to the local JARVIS route, which forwards it to the whisper.cpp service configured by `WHISPER_BASE_URL`, which defaults to loopback | JARVIS does not intentionally persist recordings; the native capture is discarded after the transcript returns, and the local speech runtime may use transient working files while processing |
| Voice assistant | the transcript, the recent turns of the current conversation, and the results of the executed functions | the transcript and the tool catalogue are sent only to the local Ollama service, which selects a function; dashboard functions reuse the existing local routes, and Mac, Spotify, Google, and browser functions run in the local action layer | the conversation stays in application memory for the current session and is not intentionally persisted |
| Spotify control | search terms, playback commands, and the OAuth tokens of the connected account | the loopback login uses PKCE without a client secret; playback commands and the current track are exchanged with the Spotify Web API under the granted scopes | access and refresh tokens are stored in `spotify-auth.json` next to the knowledge index with owner-only permissions until **TRENNEN** deletes them |
| Google Calendar | the requested time range, the events returned for it, and the title, time, and optional location of an appointment the user dictates | the loopback login uses PKCE; the primary calendar is read and new events are created through the Calendar API under the `calendar.events` scope. Events are created without attendees and with `sendUpdates=none`, so entering an appointment sends no invitation to anybody | access and refresh tokens are stored in `google-auth.json` next to the knowledge index with owner-only permissions until **TRENNEN** deletes them; created events remain in the Google account until deleted there |
| Gmail | the number of unread messages; sender, subject, and time of the few messages that are read out; a spoken search term or day; the text of a single message when a summary is asked for | requests to the Gmail API under the `gmail.modify` scope, which is the narrowest scope that allows archiving and trashing. Every request passes an allowlist of five endpoints in `desktop/actions/gmail.ts`; sending, drafts, and permanent deletion are unreachable. Archiving removes the inbox label, trashing is recoverable for 30 days, and both require an explicit confirmation and affect at most ten messages | nothing is persisted by JARVIS; mail text and metadata stay in the conversation in application memory for the current session |
| Browser search | a spoken search term or web address | the term becomes a Google search URL and is opened in Google Chrome through `open` with an argument list; only `http` and `https` addresses are accepted | nothing is persisted by JARVIS beyond the browser's own history |
| macOS actions | the name of an allowlisted program, a path inside the home directory, or a volume value | executed locally through `execFile` with argument lists; irreversible actions run only after an explicit confirmation | nothing is persisted by JARVIS beyond the effect of the action itself |
| Speech output | the text of the spoken answer and the chosen voice settings | read out locally by the macOS speech synthesis of the browser without a network request | voice, speed, and volume remain in browser storage |
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
- [Spotify](https://www.spotify.com/) once the voice assistant is connected to an account. Login, search terms, and playback commands are exchanged with Spotify; playback control requires Spotify Premium.
- [Google](https://www.google.com/) once the voice assistant is connected to a Google account. Calendar events are read and created; mail is read, archived, and trashed under the two scopes listed in `desktop/actions/config.ts`. Opening a search or an address additionally sends the usual browser request to Google or to the destination site.
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
- native WebView permissions are limited to Tauri core functionality, notifications, and the three microphone-capture commands for the fixed loopback origin
- microphone access is declared in the app bundle and granted by macOS itself; recording starts only after a click and never on a timer
- native shell, autostart, menu bar, and global-shortcut operations are not exposed to application JavaScript
- knowledge questions from the text field are reviewed as text before they are submitted
- the voice assistant may only call the functions defined in `features/assistant/tools.ts`; the model cannot extend that catalogue
- irreversible actions require an explicit confirmation, and the local action layer rejects them again without it
- launchable programs come from an allowlist, file access is limited to the home directory, and symlinks pointing out of it are rejected
- system commands run through `execFile` with argument lists, so no spoken text reaches a shell
- the local action layer answers only requests without an `Origin` or from a loopback origin, so no other page in the browser can drive it
- Spotify tokens are stored locally with owner-only permissions and no client secret exists
- Google access is limited to calendar events plus reading, archiving, and trashing mail; the assistant has no function that could send or answer a message, every Gmail request passes an endpoint allowlist that cannot reach sending, and the login refuses to start if the scope list ever gained a sending scope
- new calendar events carry no attendees and are created with `sendUpdates=none`, so no invitation mail leaves the account
- Google tokens are stored locally with owner-only permissions and are revoked when the account is disconnected
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
4. Press **TRENNEN** in the assistant panel or delete `spotify-auth.json` next to the knowledge index, and revoke JARVIS in the Spotify account settings.
5. Press **TRENNEN** for Google or delete `google-auth.json` next to the knowledge index, and remove JARVIS under [Google account third-party access](https://myaccount.google.com/connections).
6. Delete `.env.local` and revoke the Notion integration token in Notion.
7. Delete downloaded model files or uninstall the local model runtimes if they are no longer needed.
8. For the native app, disable **Beim Anmelden öffnen**, remove the JARVIS application, and delete `~/Library/Application Support/com.sissighn.jarvis/`.

The macOS notification history can be managed separately in Notification Center, and notification permission can be revoked in System Settings.

This does not delete the original content stored in Notion or data independently retained by external providers.

## Public or shared deployments

This repository's default privacy description applies only to the local, personal workflow. Anyone who deploys or operates a modified version for other people is responsible for assessing their own role and obligations, including an operator identity and contact, legal bases, retention periods, processors, international transfers, security, data-subject rights, consent requirements, and any legally required imprint or privacy interface.

## Questions and changes

Privacy-relevant changes should be documented in this file. Questions can be raised through the repository's [GitHub issues](https://github.com/Sissighn/jarvis-knowledge-interface/issues).
