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

One Node 24 LTS TypeScript process binds to `127.0.0.1` and serves the browser application and its API. Version 1 requires Node 24.15 or newer so `node:sqlite` has its release-candidate API. The project records its Node version and exact dependency versions in source control; `node:sqlite` access is confined to the database module because the API has not reached stable status.

The process uses:

- `@earendil-works/pi-coding-agent@0.84.2` for the agent loop, streaming, compaction, model selection, and OAuth-backed Codex access.
- `pi-web-access@0.24.2` as an explicitly loaded Pi extension, pinned by the project lockfile, for Codex-backed `web_search` and returned citations. This version's `openai-search.ts` resolves `openai-codex` credentials through Pi's model registry.
- Node's `node:http` server and server-sent events for response streaming.
- Node's synchronous `DatabaseSync` API from `node:sqlite` for persistence.
- Static HTML, CSS, and browser JavaScript with no frontend framework or frontend bundler.
- TypeScript compiled to ESM JavaScript with `tsc` before execution.
- Node's built-in test runner.

Application data lives under `$XDG_DATA_HOME/book-explorer/` or `~/.local/share/book-explorer/` when `XDG_DATA_HOME` is unset. On POSIX, startup creates and verifies the application directory as mode `0700` and database, configuration, and cache files as `0600`; unsafe permissions fail startup with a corrective message. On Windows, files remain under the current user's profile and inherit its ACL, with a warning if the directory is broadly accessible. The SQLite database is the sole durable application store.

A Pi `AgentSession` exists only for the duration of one model turn and always receives `sessionManager: SessionManager.inMemory(cwd)`, so Pi never writes JSONL session files. SQLite stores a versioned serialization of the conversation's active linear Pi `SessionEntry[]` branch, not merely projected agent messages. Images and branching are not supported in version 1.

Before creating a session, the application replays those entries into a new in-memory manager while mapping each stored entry ID to the new ID returned by Pi. Message entries use `appendMessage`; compaction entries use `appendCompaction` with the mapped `firstKeptEntryId`, summary, `tokensBefore`, details, hook marker, and usage; model and thinking changes use their matching append methods. Extension-private custom entries, labels, and session display metadata are not restored. This preserves native compaction chaining and boundaries across restarts.

The application then calls `createAgentSession` with `cwd` pinned to Book Explorer's dedicated application directory, which builds both agent context and Pi's compaction input from the populated manager. After a successfully completed turn, including any compaction performed during it, the application filters extension-private custom entries and search-only tool details from `sessionManager.getBranch()`, transactionally stores that active branch, and calls synchronous `session.dispose()`. It never restores by assigning `session.agent.state.messages` alone. A failed or interrupted turn leaves the previous complete snapshot intact for retry; mid-stream compaction state is never persisted separately.

The application awaits `ModelRuntime.create` with `authPath` explicitly set to Pi's existing `~/.pi/agent/auth.json`, `modelsPath` set to an application-local file, and `modelsStorePath` set under Book Explorer's data directory. At startup it resolves the conversational model explicitly as `openai-codex/gpt-5.6-sol` with medium thinking and fails closed if that model or OAuth credential is unavailable. It passes that exact model and runtime instance to every agent session and guard. `agentDir`, `SettingsManager`, extension configuration, model cache, sessions, and all other application paths also remain under Book Explorer's data directory. Setting an application-specific `agentDir` alone is insufficient and must not be used as the authentication mechanism.

Each model turn constructs a fresh `DefaultResourceLoader` configured with `noExtensions`, `noSkills`, and `noContextFiles`, `systemPromptOverride: () => completePrompt`, and `appendSystemPromptOverride: () => []`, then awaits `loader.reload()` before session creation. The project-local `pi-web-access` extension entry point is the only `additionalExtensionPaths` entry. A loader is never reused after its session is disposed because disposal invalidates that loader's extension runtime; a fresh loader creates a fresh runtime while the cached extension module remains process-wide. Seven application tools are registered through `customTools`; an inline `extensionFactories` guard handles the `tool_call` event and blocks forbidden search parameters. `createAgentSession` uses `noTools: "builtin"` and an explicit allowlist containing those seven tools plus `web_search`:

- `search_library`
- `get_book`
- `upsert_book`
- `upsert_series`
- `record_recommendation`
- `create_suggestion`
- `get_taste_profile`
- `web_search`

These constants are the complete `tools` allowlist. The application-local web-search config must exist and validate before loader creation. After `loader.reload()` and session creation, every turn inspects the active `session.agent.state.tools` names before prompting and fails closed if the allowlist was omitted or any unexpected registered tool survived filtering. A startup probe uses and disposes its own loader rather than the first turn's loader. Coding, shell, filesystem editing, subagent, page-fetching, curator UI, and other Pi or `pi-web-access` tools are disabled.

The application-local `web-search.json` sets `provider: "openai"`, `workflow: "none"`, and nested `tools.sourceCheck.enabled`, `tools.fetchContent.enabled`, and `tools.getSearchContent.enabled` to `false`. The headless extension runner is never bound to Pi dialog/TUI services, so curator mode remains unavailable. A small inline guard extension requires `provider: "openai"` and `workflow: "none"`, blocks `includeContent`, and rejects provider arrays. Before allowing the call, it uses the exact `ModelRuntime` passed to the session to verify an `openai-codex` model and OAuth credential; API-key and environment fallbacks do not satisfy this check. Otherwise it returns a visible search-unavailable error instead of letting `pi-web-access` choose a fallback. `PI_CODING_AGENT_DIR` is set before importing the extension, causing `pi-web-access@0.24.2` to place its configuration and any on-disk fetch cache under Book Explorer's application directory rather than the user's general Pi directory. `pi-web-access` module state is process-wide even though each agent session is ephemeral. Book Explorer therefore permits only one model turn globally, avoiding cross-conversation mutation of that extension state. Each complete search result is consumed during its turn and durable citations are recorded in SQLite. The application clears any stale `web-search-cache` directory at startup, and the guarded search path must not write to it.

Pi's credential storage uses a cross-process file lock during OAuth refresh and mutation. Concurrent coding and Book Explorer sessions therefore do not share conversation state or corrupt credentials because both runtimes open the same auth path. They can still compete for account-level subscription rate and concurrency limits; the UI reports those errors directly.

## Data Model

SQLite enables foreign keys and WAL mode. The process owns one `DatabaseSync` handle. Every database operation and transaction is synchronous and contains no awaited work, so Node's event loop serializes writes from concurrent conversations; network calls occur outside transactions. Numbered migrations run transactionally at startup. A failed migration prevents startup rather than opening a partially migrated database.

### Core records

- `conversations`: name, timestamps, the last complete versioned serialized active Pi `SessionEntry[]` branch, pinned Pi format version, and archival state.
- `messages`: stable ID, conversation, ordered position, Pi-compatible serialized message, creation time, and completion state. The UI history remains independent from the compacted agent context snapshot.
- `series`: canonical name and optional descriptive note.
- `books`: title, author text, publication year, cover URL, optional Open Library work ID, optional series and series position, reading status, optional integer rating from 1 through 5, and timestamps.
- `book_notes`: book, note text, origin conversation/message, and timestamp. Notes are append-only by default so changes in opinion remain visible; the user can edit or delete them explicitly.
- `recommendations`: book, conversation/message, rationale, cautions, and timestamp.
- `citations`: unique normalized URL, title, supporting snippet when available, observed search provider, and retrieval timestamp. `message_citations` and `recommendation_citations` provide explicit foreign-key links rather than a polymorphic parent column.
- `facets`: controlled facet name and description.
- `facet_values`: facet, canonical value, and description. The `(facet_id, value)` pair is unique.
- `book_facets`: approved book-to-facet-value link, explanatory note, and source conversation/message. Pending classifications exist only in `suggestions`; acceptance inserts this row.
- `taste_observations`: approved preference statement, optional facet-value association, polarity, source conversation/message, and timestamp.
- `suggestions`: discriminated proposal kind, target book when applicable, original kind-specific JSON payload, optional applied/edited payload, explanation, source conversation/message, state (`pending`, `accepted`, or `rejected`), and decision timestamp. Each proposal kind has a server-side schema: ratings and statuses contain one validated scalar; opinions contain note text; book classifications contain facet value plus note; taste observations contain statement, polarity, and optional facet value; vocabulary additions contain their parent facet when applicable, canonical name, description, and why existing vocabulary is insufficient.
- `tool_actions`: conversation/message, idempotency key, action state, and serialized result containing the affected entity type and ID. The key and result are committed in the same transaction as the action so retries can return the original result.

All tables use explicit primary keys. Durable turn/message IDs are UUIDs; application entities use integer primary keys. Foreign keys use `ON DELETE CASCADE` only for genuinely conversation-owned messages, pending suggestions, and message-citation join rows. Provenance links from approved notes, book facets, taste observations, and recommendations to source conversations/messages use `ON DELETE SET NULL`, so deleting or archiving a conversation cannot erase library or taste state. Deleting books and series is always an explicit user action, with their dependent book-owned rows cascading. Unique constraints cover conversation position, Open Library work ID, facet name, `(facet_id, value)`, normalized citation URL, recommendation identity, and `tool_actions.idempotency_key`. The first numbered migration contains the authoritative v1 DDL and is frozen by schema tests.

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

Open Library lookup is application code, not an agent or `pi-web-access` tool. It uses `https://openlibrary.org` and `https://covers.openlibrary.org`, sends an identifying user agent, and places requests in one process-wide FIFO queue with at most one request in flight. A slow request therefore delays later metadata lookups but never holds a database transaction or blocks manual entry. The client caches successful work metadata in SQLite and does not perform bulk catalog retrieval. Open Library may supply work-level title, author, year, cover, series hints, and identifiers. Every metadata field remains editable, and timeout, rate-limit, malformed-response, or not-found errors do not prevent creating a work manually.

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

Before each model turn, the server allocates and commits a stable user-message ID and ordered position. It then creates an ephemeral `AgentSession`, replays the conversation's last complete active-entry branch, and prompts with the new user message. This durable message ID scopes every tool idempotency key, including retries after cancellation or failure.

For each user turn, the server provides the agent with:

1. the conversation's restored, compaction-aware context snapshot;
2. approved taste observations;
3. tool access to relevant books, notes, recommendations, facets, and web research.

The database, not the conversation context, is authoritative for library and taste state. The agent queries it rather than relying on remembered prose.

The agent may automatically:

- create a work or series needed for an explicit recommendation;
- record a deliberate recommendation with rationale, cautions, and available citations;
- update assistant-owned recommendation metadata.

A mere mention of a title is not a recommendation. The agent must make a deliberate recommendation tool call. A newly recommended work defaults to `recommended`; this is assistant-owned provenance, not an inferred user reading status.

The agent may only propose, not directly apply:

- the user's reading status;
- a 1–5 rating;
- a note representing the user's opinion;
- a book facet classification;
- a generalized taste observation;
- a vocabulary addition.

Each proposal appears in the approval queue and can be accepted, edited, or rejected. Acceptance applies the edited value transactionally. Rejection records the decision without changing the target record.

Database-changing tool calls use backend-derived idempotency keys containing the durable message ID, exact tool name, normalized target identity, and semantic slot. Free-form rationale or note wording is never part of the key. For example, two `upsert_book` calls in one message differ by normalized title/author, while a retried `record_recommendation` for the same book returns the first result even if its regenerated prose differs. Version 1 permits at most one suggestion of each kind and semantic slot for the same target within one message. Retries return the serialized original result rather than creating duplicates. Tool transactions commit immediately. If a later model step fails, completed tool effects remain visible and the incomplete turn identifies that some actions were applied; retrying reuses their stored results rather than rolling them back.

There is no second extraction model or background analysis pass in version 1. The active conversational agent performs explicit tool calls during its response.

## Web Research and Citations

The agent uses the explicitly loaded `pi-web-access@0.24.2` extension when recommendations require discovery, current information, obscure-book verification, or factual support. Its OpenAI search implementation resolves the active `openai-codex` model and shared OAuth through Pi's model registry. Only `web_search` is exposed; search requests select its OpenAI provider and disable its optional curator workflow.

An inline `tool_result` hook runs immediately after each `web_search`. The system prompt states the pinned search constraints and requires search and citation-backed recommendation recording in separate tool rounds. If the model nevertheless issues them as parallel sibling calls, `record_recommendation` rejects the not-yet-captured IDs and the model must retry it after the search result arrives. It reads the in-memory `SessionManager.getEntries()` entry whose `type` is `custom`, `customType` is `web-search-results`, `data.type` is `search`, and `data.id` equals the tool result's `details.searchId`. That custom entry—not the formatted tool-result text—is the source of structured titles, URLs, snippets, and actual search-provider names. Search attribution `openai` is distinct from the credential-provider ID `openai-codex`. Every result must report search provider `openai`; any fallback-provider result is converted to an error result and not persisted.

For accepted results, the hook transactionally creates or finds citation rows linked to the durable turn message ID, then returns replacement content that appends a machine-readable citation-ID list while re-emitting the original tool-result details unchanged. `record_recommendation` accepts only IDs in that turn-local captured set; unknown IDs or model-invented URLs are rejected. Stored recommendations therefore retain source provenance without trusting prose-generated links. Search-result custom entries and other extension-private `details` are excluded when serializing the durable conversation context, so snapshots never contain dangling search-cache identifiers after restart.

If search is unavailable, the assistant must distinguish model-memory suggestions from researched claims and must not invent citations. Failure to retrieve metadata or a source is visible but does not erase an otherwise useful recommendation.

## Local Web Interface

The default screen is chat-focused:

- A left sidebar lists named conversations and links to the Library.
- The center streams conversation text, citations, and inline recommendation cards. All model text, notes, metadata, source titles, and snippets are rendered with DOM text nodes, never `innerHTML`. Citation links are created through DOM APIs only after parsing and allowlisting `https:` or `http:` URLs, and use `rel="noopener noreferrer"`. Version 1 does not render arbitrary Markdown or HTML.
- A right drawer shows the current book or pending suggestions.

Recommendation cards show title, author, series, rationale, cautions, current status, citations, and quick actions for `Interested`, `Reading`, `Not interested`, and `Open book`. These quick actions are direct user actions, not assistant inferences.

The Library view supports text search across title and author plus filtering by status, rating, series, and approved facet. A work's editable view includes metadata, series position, status, rating, notes, facets, recommendation history, and citations.

Pending suggestions are reviewed individually. Each supports accept, edit-and-accept, or reject. Version 1 does not include bulk approval.

## API and Streaming

The local API exposes narrowly scoped routes for:

- conversation listing, creation, renaming, and message submission;
- SSE streaming of the active turn plus a separate CSRF-protected `POST` cancellation route;
- library search and work/series CRUD;
- recommendation history;
- pending suggestion review;
- controlled facet vocabulary management.

All state-changing routes validate request bodies and use transactions. At startup the server generates an unguessable per-process CSRF token, embeds it in the served application shell, and requires it in a custom header on every state-changing request. The cancellation route additionally requires the exact active durable turn/message ID, so a delayed cancellation cannot affect a later turn. It also requires the configured loopback `Host`, an exact same-origin `Origin`, and a JSON content type where applicable. Missing or unexpected values are rejected. These controls prevent drive-by browser requests; they do not attempt to defend against another process running as the same operating-system user.

OAuth credentials and provider responses containing secrets are never sent to the browser or stored in messages.

Only one model turn may run in the process at a time. Direct user library edits and suggestion approvals remain allowed while the model awaits network I/O because no database transaction spans an await. Agent metadata upserts fill missing bibliographic fields but never overwrite user-owned status, rating, notes, or approved preferences; user changes therefore win and become visible to subsequent tool reads. A second submission from any conversation receives a visible global-busy response rather than running concurrently. This is sufficient for one local user and prevents process-global extension state and subscription limits from coupling concurrent turns; concurrency is reconsidered only if actual use requires it. Pi stream events are mapped to a small browser event schema (`text_delta`, `tool_status`, `citation`, `complete`, and `error`). Error events contain a stable application code, retryable flag, and safe message; authentication, quota/429, concurrency, search, and internal failures are classified before streaming rather than inferred by the browser from text. The streaming response never emits cross-origin access headers. The server honors socket backpressure. On cancellation, disconnect, model error, tool error, or any other non-normal exit it awaits `session.abort()` until Pi is idle, then calls `session.dispose()`, and only then releases the global turn gate. Normal completion also disposes the session before releasing that gate.

## Error Handling and Recovery

- Database open or migration failure prevents startup.
- A failed database tool action aborts that action and is reported to the agent and UI; there is no success-shaped fallback.
- A failed model turn preserves the preallocated user message, marks the attempted assistant turn failed, and leaves the prior complete context snapshot unchanged. An explicit retry reuses the user-message ID and therefore the same idempotency keys.
- Partial assistant output is stored for display as incomplete but excluded from the complete context snapshot and is not treated as a completed recommendation rationale.
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
- conversation context-snapshot persistence, failed-turn recovery, and ephemeral-session disposal with no Pi JSONL files created;
- compact conversation → process restart → active-entry replay with mapped compaction references → successful native second compaction;
- explicit `openai-codex/gpt-5.6-sol` medium model selection and startup failure when its OAuth or model is unavailable;
- exact tool allowlisting and a startup failure when the allowlist is absent or unexpected tools remain;
- rejection of `web_search.includeContent`, non-`none` workflows, provider arrays, unavailable Codex auth, and non-OpenAI provider outcomes, plus no fetch-cache writes;
- `PI_CODING_AGENT_DIR` initialization before extension import;
- tool-call idempotency across failure, cancellation, and retry, including committed tool success followed by model failure;
- two distinct same-tool calls in one message plus a retry with changed free-form prose;
- two consecutive successful web-search turns using separate loaders in one process;
- global model-turn exclusion across two conversations, including every error/abort path followed immediately by another submission;
- direct user edits during a model turn without lost updates to user-owned fields;
- mid-turn extraction of citations from correlated `web-search-results` custom entries, citation-ID injection into the model-visible tool result, preservation of actual provider names, and rejection of fallback-provider outcomes or unknown/invented citation IDs and URLs;
- CSRF, Host, Origin, content-type, active-turn cancellation ID, and POSIX data-permission validation plus primary HTTP routes;
- safe rendering of malicious HTML, `javascript:` URLs, and malformed links;
- SSE completion, backpressure, cancellation, disconnect, structured quota errors, and incomplete-response marking;
- Open Library user-agent, FIFO single-flight rate limiting, cache behavior, and timeout, rate-limit, malformed-response, and not-found handling.

Agent-facing tests use a fake model/tool driver and assert actions and persisted effects rather than exact prose. A separate opt-in integration check verifies current Pi OAuth, Codex model access, `pi-web-access` search, citations, streaming, and a concurrent credential refresh alongside a Pi CLI process. Normal tests never require network access or consume subscription capacity.

## Deferred Evaluation

After the conversational workflow proves useful, evaluate:

1. what Goodreads and StoryGraph exports actually contain and whether either merits an importer;
2. whether approved facets and SQLite full-text search are sufficient;
3. whether embeddings or an explorable graph solve a demonstrated retrieval problem;
4. whether Bedrock billing or S3 backup provides enough value to justify another integration.

These are future decisions, not version 1 scaffolding.
