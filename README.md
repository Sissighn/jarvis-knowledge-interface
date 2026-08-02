# JARVIS — Personal Knowledge Interface

[![CI](https://github.com/Sissighn/jarvis-knowledge-interface/actions/workflows/ci.yml/badge.svg)](https://github.com/Sissighn/jarvis-knowledge-interface/actions/workflows/ci.yml)
[![Next.js](https://img.shields.io/badge/Next.js-16.2-111111?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-111111?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-111111?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
![Local first](https://img.shields.io/badge/local--first-yes-f2b5d0)
![Paid AI API](https://img.shields.io/badge/paid_AI_API-not_required-f2b5d0)

A local-first dashboard that turns selected Notion content into an interactive knowledge graph and combines it with focused tech news, weather, local search, and browser voice input.

![JARVIS interface](./public/jarvis-interface.png)

## Why JARVIS

JARVIS is designed to reduce information friction without creating another system to maintain. Notion remains the source of truth. The application reads only explicitly shared content, derives relationships locally, and brings the most useful context into one calm interface. No paid AI API is required for its current capabilities.

## Features

- animated, pointer-controlled neural core rendered with Canvas 2D
- interactive map generated from selected Notion pages and data sources
- hierarchy, relation, mention, and semantic-similarity graph edges
- local TF-IDF retrieval and cosine-similarity ranking
- deterministic topic clustering and collision-aware graph layout
- typed and browser-native voice search across loaded knowledge
- relevance-ranked daily tech briefing from multiple public sources
- local story bookmarks, relevance feedback, and daily browser cache
- current weather and four-day forecast from Open-Meteo
- focused small-screen layout that prioritizes the core and knowledge map
- read-only Notion access with server-only credentials

## Architecture

The application follows a feature-oriented structure. UI, domain types, server integrations, and pure algorithms are separated so each module has one clear responsibility.

```text
app/                         Next.js routes and API boundaries
config/                      build integration
features/
  briefing/                  news aggregation, ranking, and types
  interface/                 components, hooks, renderers, and styles
  knowledge/                 Notion connector, graph algorithms, and search
  weather/                   Open-Meteo client and types
tests/
  unit/                      deterministic domain tests
  integration/               built-worker and security-boundary tests
worker/                      Cloudflare/vinext runtime entry point
```

See [Architecture](./docs/ARCHITECTURE.md) for the data flows and design decisions.

## Getting started

### Requirements

- Node.js 22.13 or newer
- npm
- an optional Notion internal integration for real workspace data

### Installation

```bash
git clone git@github.com:Sissighn/jarvis-knowledge-interface.git
cd jarvis-knowledge-interface
npm install
cp .env.local.example .env.local
npm run dev
```

Open the local URL printed by the development server. Without Notion credentials, JARVIS starts with a small built-in sample graph.

## Connect Notion safely

1. Create an internal Notion integration with read-content access only.
2. Share only the pages or data sources JARVIS may read with that integration.
3. Add the token to the ignored `.env.local` file.
4. Restart the development server.

```dotenv
NOTION_ACCESS_TOKEN=secret_your_internal_notion_token
NOTION_MAX_PAGES=80
NOTION_CONTENT_SCAN_LIMIT=40
```

The token is consumed only by server routes. It is never embedded in the browser bundle or stored in the repository.

## Configure weather

Weather uses [Open-Meteo](https://open-meteo.com/) and requires no API key for this personal setup. Berlin is the default. Override it in `.env.local`:

```dotenv
WEATHER_LOCATION_NAME=Regensburg
WEATHER_LATITUDE=49.0134
WEATHER_LONGITUDE=12.1016
```

## Data sources and local processing

| Capability | Source | Processing |
| --- | --- | --- |
| Knowledge graph | Notion API | server-side parsing; local TF-IDF, clustering, and layout |
| Knowledge search | loaded graph | entirely in the browser |
| Tech briefing | OpenAI News, GitHub Changelog, Techpresso, Hacker News | server-side aggregation, scoring, and deduplication |
| Weather | Open-Meteo | server-side fetch with a 30-minute memory cache |
| Voice input | browser Speech Recognition API | availability and audio processing depend on the browser |
| Preferences | browser storage | stays on the current device |

Techpresso is an optional source because its public archive endpoint is undocumented. If it changes or becomes unavailable, the other sources and the last daily browser cache continue to work.

## Quality checks

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run check
```

`npm run check` executes the complete local CI pipeline. Integration tests build the application, verify server-rendered output, exercise the disconnected Notion state, and confirm that credentials remain behind the server boundary.

## Privacy and cost

- no paid AI API or hosted database is required
- the Notion token stays server-side and is excluded from Git
- Notion access is intentionally read-only
- saved and hidden stories remain on the current device
- individual feed failures do not break the entire briefing
- search and graph analysis do not send note content to an AI model

## Current scope

The command bar retrieves and ranks relevant notes; it does not synthesize new answers yet. JARVIS also does not write to Notion. Both choices keep the current system predictable, inexpensive, and privacy-conscious.

## Technology

Next.js 16, React 19, TypeScript, Canvas 2D, vinext, Cloudflare Workers, the Notion API, Open-Meteo, TF-IDF, and cosine similarity.
