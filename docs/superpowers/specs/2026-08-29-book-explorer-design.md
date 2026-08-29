# Book Explorer Design

**Status:** Draft

## Purpose

Book Explorer is a single-user local web application for the kind of iterative book-recommendation discussion demonstrated in the “Frontlines RPG Potential” ChatGPT conversation. It preserves reading history, recommendations, nuanced reactions, and approved taste observations across conversations while using a hosted model and live web research.

The first version proves one thing: a local application can provide a ChatGPT-like recommendation conversation while reliably retaining the user's book history and preferences.

## Goals

- Run as a lightweight local website, not a hosted service.
- Support multiple named conversations sharing one library and taste profile.
- Reuse the user's existing Pi Codex OAuth authentication.
- Search the live web and retain citations for recommendation claims.
- Track works, series, recommendation history, reading state, optional 1–5 ratings, and nuanced notes.
- Let the assistant create recommendations automatically while requiring approval for anything that claims to represent the user's opinion.
- Support a small, controlled, evolving vocabulary for book characteristics and preferences.
- Keep all application state in one local SQLite database.

## Non-goals for Version 1

- General-purpose assistant behavior.
- A hosted site, user accounts, remote access, or multi-user support.
- S3 synchronization or backup.
- Edition, format, ownership, lending, Libby, Hoopla, or Kindle Unlimited tracking.
- Goodreads or StoryGraph import before their exports have been evaluated.
- Embeddings, vector search, collaborative filtering, learned ranking, or graph visualization.
- Autonomous background work, messaging channels, scheduling, or NanoClaw integration.
- Mobile-specific UI work.

## Architecture

One Node 24 LTS TypeScript process binds to `127.0.0.1` and serves the browser application and its API. It uses:

- `@earendil-works/pi-coding-agent` for the agent loop, streaming, compaction, model selection, and OAuth-backed Codex access.
- `pi-web-access` for web search, page retrieval, and citations using the same Codex authentication where supported.
- Node's `node:http` server and server-sent events for response streaming.
- Node's built-in `node:sqlite` for persistence.
- Static HTML, CSS, and browser JavaScript with no frontend framework or build pipeline.
- Node's built-in test runner.

Application data lives under `$XDG_DATA_HOME/book-explorer/` or `~/.local/share/book-explorer/` when `XDG_DATA_HOME` is unset. The SQLite database is the sole durable application store.

Each active conversation has an in-memory Pi `AgentSession`. On activation, the application restores its stored Pi messages and latest compaction summary from SQLite. Messages and updated summaries are persisted after accepted turns. Restarting the process must not lose completed turns.

The application supplies a replacement system prompt and only these tool classes:

- library and series lookup
- book and series creation or editing
- recommendation recording
- pending suggestion creation
- approved taste-profile lookup
- web search and cited page retrieval

Coding, shell, filesystem editing, subagent, and general Pi tools are disabled. Global project context, prompts, skills, and unrelated extensions are not loaded. The application has its own settings, model catalog cache, sessions, and data; only Pi's credential file is shared.

Pi's credential storage uses a cross-process file lock during OAuth refresh and mutation. Concurrent coding and Book Explorer sessions therefore do not share conversation state or corrupt credentials. They can still compete for account-level subscription rate and concurrency limits; the UI reports those errors directly.

## Data Model

SQLite enables foreign keys and WAL mode. Numbered migrations run transactionally at startup. A failed migration prevents startup rather than opening a partially migrated database.

### Core records

- `conversations`: name, timestamps, latest compacted summary, archival state.
- `messages`: conversation, ordered position, Pi-compatible serialized message, creation time, completion state.
- `series`: canonical name and optional descriptive note.
- `books`: title, author text, publication year, cover URL, optional Open Library work ID, optional series and series position, reading status, optional integer rating from 1 through 5, and timestamps.
- `book_notes`: book, note text, origin conversation/message, and timestamp. Notes are append-only by default so changes in opinion remain visible; the user can edit or delete them explicitly.
- `recommendations`: book, conversation/message, rationale, cautions, and timestamp.
- `citations`: recommendation or message, URL, title, supported text span when available, and retrieval timestamp.
- `facets`: controlled facet name, allowed values, and description.
- `book_facets`: book, facet/value, explanatory note, source conversation/message, and approval state.
- `taste_observations`: approved preference statement, optional facet/value association, polarity, source conversation/message, and timestamp.
- `suggestions`: pending proposal type, target book when applicable, proposed value, explanation, source conversation/message, and state (`pending`, `accepted`, or `rejected`).
- `tool_actions`: conversation/message and idempotency key for database-changing agent calls.

### Reading status

A work has one of:

- `recommended`
- `interested`
- `reading`
- `read`
- `abandoned`
- `not_interested`

Rating is optional and constrained to integer values from 1 through 5.

### Identity and duplicates

The application tracks works, not editions. An Open Library work ID is the strongest identifier when available. Otherwise it uses normalized title and author as a duplicate candidate, not as an unconditional identity. Ambiguous matches are shown for manual resolution; the application never silently merges them.

Open Library may supply work-level title, author, year, cover, series hints, and identifiers. Every metadata field remains editable, and metadata lookup failure does not prevent creating a work.

## Facet Vocabulary

The vocabulary is controlled but extensible. Version 1 seeds these facets:

- `pace`: `measured`, `frenetic`
- `scope`: `intimate`, `institutional`, `epic`
- `character`: `shallow`, `developing`, `long_arc`
- `tone`: `escapist`, `emotionally_heavy`, `grim`, `humorous`
- `competence`: `low`, `moderate`, `central`
- `speculation`: `realistic`, `consistent_black_box`, `pseudo_realistic`
- `action`: `clear`, `chaotic`, `spectacle_driven`
- `politics`: `background`, `observational`, `didactic`
- `structure`: `standalone`, `episodic_series`, `continuous_series`

A book can have multiple values where meaningful, each with an explanatory note. Book characteristics and user preferences are separate: a book may be `grim` without implying the user dislikes grim books in every context.

The assistant may propose book classifications, preference observations, new facet values, or new facets. These remain pending until approved. New vocabulary proposals must explain why an existing term is insufficient, preventing accidental synonyms such as `slow`, `patient`, and `measured`.

## Conversation and Agent Behavior

For each user turn, the server provides the agent with:

1. the conversation's recent messages and compacted summary;
2. approved taste observations;
3. tool access to relevant books, notes, recommendations, facets, and web research.

The database, not the conversation context, is authoritative for library and taste state. The agent queries it rather than relying on remembered prose.

The agent may automatically:

- create a work or series needed for an explicit recommendation;
- record a deliberate recommendation with rationale, cautions, and available citations;
- update assistant-owned recommendation metadata.

A mere mention of a title is not a recommendation. The agent must make a deliberate recommendation tool call.

The agent may only propose, not directly apply:

- the user's reading status;
- a 1–5 rating;
- a note representing the user's opinion;
- a book facet classification;
- a generalized taste observation;
- a vocabulary addition.

Each proposal appears in the approval queue and can be accepted, edited, or rejected. Acceptance applies the edited value transactionally. Rejection records the decision without changing the target record.

Database-changing tool calls require an idempotency key derived from the conversation, message, and logical action. Retries return the existing result rather than creating duplicate books, recommendations, notes, or suggestions.

There is no second extraction model or background analysis pass in version 1. The active conversational agent performs explicit tool calls during its response.

## Web Research and Citations

The agent uses `pi-web-access` when recommendations require discovery, current information, obscure-book verification, or factual support. Stored recommendations retain their rationale, cautions, and cited URLs. Search-result caches remain ephemeral and are not copied wholesale into the application database.

If search is unavailable, the assistant must distinguish model-memory suggestions from researched claims and must not invent citations. Failure to retrieve metadata or a source is visible but does not erase an otherwise useful recommendation.

## Local Web Interface

The default screen is chat-focused:

- A left sidebar lists named conversations and links to the Library.
- The center streams conversation text, citations, and inline recommendation cards.
- A right drawer shows the current book or pending suggestions.

Recommendation cards show title, author, series, rationale, cautions, current status, citations, and quick actions for `Interested`, `Reading`, `Not interested`, and `Open book`. These quick actions are direct user actions, not assistant inferences.

The Library view supports text search and filtering by status, rating, series, and approved facet. A work's editable view includes metadata, series position, status, rating, notes, facets, recommendation history, and citations.

Pending suggestions are reviewed individually. Each supports accept, edit-and-accept, or reject. Version 1 does not include bulk approval.

## API and Streaming

The local API exposes narrowly scoped routes for:

- conversation listing, creation, renaming, and message submission;
- SSE streaming and cancellation of the active turn;
- library search and work/series CRUD;
- recommendation history;
- pending suggestion review;
- controlled facet vocabulary management.

All state-changing routes validate request bodies and use transactions. The server accepts requests only from the loopback-bound application and rejects unexpected `Origin` headers to reduce local cross-site request risk. OAuth credentials and provider responses containing secrets are never sent to the browser or stored in messages.

Only one model turn may run per conversation. A second submission to the same conversation is rejected with a visible busy response rather than run concurrently. Different conversations may run concurrently subject to subscription limits.

## Error Handling and Recovery

- Database open or migration failure prevents startup.
- A failed database tool action aborts that action and is reported to the agent and UI; there is no success-shaped fallback.
- A failed model turn preserves the completed user message and records the turn as failed, allowing an explicit retry with the same idempotency keys.
- Partial assistant output is visibly marked incomplete and is not treated as a completed recommendation rationale.
- Authentication, quota, and concurrency failures are shown distinctly.
- Web-search failure produces a visible limitation and no fabricated source claims.
- Incomplete metadata remains editable rather than blocking work creation.

## Testing

Automated tests use temporary SQLite databases and cover:

- transactional migrations and migration failure;
- book and series creation, validation, and ambiguous duplicate handling;
- reading-status and 1–5 rating constraints;
- recommendation recording and citation linkage;
- suggestion acceptance, edited acceptance, and rejection;
- facet vocabulary validation and synonym-proposal behavior;
- approved taste context versus pending data;
- conversation persistence, restoration, compaction-summary storage, and failed-turn recovery;
- tool-call idempotency;
- origin validation and primary HTTP routes;
- SSE completion, cancellation, and incomplete-response marking.

Agent-facing tests use a fake model/tool driver and assert actions and persisted effects rather than exact prose. A separate opt-in integration check verifies current Pi OAuth, Codex model access, `pi-web-access` search, citations, and streaming. Normal tests never require network access or consume subscription capacity.

## Deferred Evaluation

After the conversational workflow proves useful, evaluate:

1. what Goodreads and StoryGraph exports actually contain and whether either merits an importer;
2. whether approved facets and SQLite full-text search are sufficient;
3. whether embeddings or an explorable graph solve a demonstrated retrieval problem;
4. whether Bedrock billing or S3 backup provides enough value to justify another integration.

These are future decisions, not version 1 scaffolding.
