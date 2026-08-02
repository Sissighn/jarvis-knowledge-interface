# JARVIS — Personal Knowledge Interface

[![Next.js](https://img.shields.io/badge/Next.js-16-111111?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-111111?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![Local first](https://img.shields.io/badge/local--first-yes-f2b5d0)
![AI API](https://img.shields.io/badge/paid_AI_API-not_required-f2b5d0)
![Notion access](https://img.shields.io/badge/Notion-read--only-f2b5d0?logo=notion&logoColor=111111)

A local-first personal knowledge interface that turns selected Notion content into an interactive neural map and combines it with a private, relevance-ranked daily tech briefing.

## Why this exists

The project is designed to reduce friction rather than become another system that needs constant maintenance. It keeps Notion as the source of truth, derives useful connections locally, and surfaces a focused daily view without requiring a paid AI API.

## Highlights

- fluid, mouse-controlled neural core
- interactive knowledge graph generated from selected Notion content
- local TF-IDF and cosine-similarity analysis
- automatically detected topic clusters and semantic relationships
- personalized Morning Tech Briefing with up to ten relevant stories
- local bookmarks, relevance feedback, and daily browser cache
- responsive focus mode that removes side panels on smaller screens
- read-only data access and no mandatory cloud database

## Local start

```bash
npm install
npm run dev
```

Then open the local URL printed by the development server.

## Read-only Notion connection

1. Create an internal Notion integration and enable read-content access only.
2. Add that connection to the Notion pages or databases Jarvis may read.
3. Copy `.env.local.example` to `.env.local`.
4. Put the integration token into `NOTION_ACCESS_TOKEN` and restart the local server.

The token stays in the ignored local environment file. It is read only by the local server and is never sent to the browser.

## How it works

| Layer | Responsibility |
| --- | --- |
| Notion connector | Reads only the pages and databases explicitly shared with the integration |
| Knowledge engine | Builds graph edges from hierarchy, relations, mentions, TF-IDF, and cosine similarity |
| Neural interface | Renders the animated core and interactive knowledge map on Canvas |
| Briefing engine | Aggregates public sources, scores relevance, removes duplicates, and returns at most ten stories |
| Local preferences | Stores the daily cache, saved stories, and hidden stories in the browser |

## Morning Tech Briefing

The briefing loads public feeds directly on the local server. It does not need an AI model, an API key, or a paid news API. JARVIS ranks stories against the current interest profile (AI/ML, coding agents, developer tools, local AI, and knowledge workflows), removes near-duplicates, and shows no more than ten relevant items.

Techpresso is read through its public archive endpoint. Because that endpoint is not documented as a stable developer API, JARVIS treats it as optional: if it changes or is temporarily unavailable, the other sources continue to work and the last daily briefing remains in the browser cache.

## Privacy and cost

- no paid AI API is required
- no Notion token is exposed to the browser
- Notion access is read-only
- saved and hidden briefing items remain on the current device
- the app continues to work when an individual news source is unavailable

## Current limitations

- the command bar is a visual interaction layer and is not connected to a language model yet
- speech input and Notion write actions are intentionally not enabled
- Techpresso uses a public but undocumented archive endpoint

## Tech stack

Next.js, React, TypeScript, Canvas 2D, the Notion API, TF-IDF, cosine similarity, and public RSS/JSON feeds.
