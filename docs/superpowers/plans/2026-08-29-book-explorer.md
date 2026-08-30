# Book Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the refined Book Explorer v1 local application with durable Pi conversations, a SQLite book library, guarded Codex web research, proposal approval, SSE chat, and a safe framework-free browser UI.

**Architecture:** A single Node process owns one synchronous SQLite handle, one long-lived Pi `SessionManager` per opened conversation, and at most one ephemeral `AgentSession` per model turn. Focused modules expose persistence, session, model, tool, Open Library, HTTP, and rendering boundaries; the HTTP server composes them without introducing a framework or generic service layer.

**Tech Stack:** Node 24.15.0, TypeScript 7.0.2, ESM, `node:sqlite`, `node:http`, Node test runner, `@earendil-works/pi-coding-agent@0.84.2`, `pi-web-access@0.24.2`, static HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-29-book-explorer-design.md`

## Global Constraints

- Require Node 24.15 or newer; record Node 24.15.0 and exact dependency versions in source control.
- Bind only to `127.0.0.1`; do not emit cross-origin access headers.
- Use `@earendil-works/pi-coding-agent@0.84.2` and `pi-web-access@0.24.2` exactly.
- Keep SQLite access inside `src/db.ts`; use one synchronous `DatabaseSync` handle and no awaited work inside transactions.
- Keep Pi JSONL authoritative for conversation history and SQLite authoritative for book-domain state.
- Reuse only `~/.pi/agent/auth.json`; keep every other application path under the Book Explorer data directory.
- Resolve only `openai-codex/gpt-5.6-sol` with medium thinking; never fall back to another model or API-key credential.
- Expose exactly six custom tools plus `web_search`; disable all built-in, skill, context-file, and other extension tools.
- Permit only one model turn globally and always abort/dispose before releasing the gate.
- Render untrusted content with DOM text nodes; accept only HTTP(S) links and covers, with safe link and image attributes.
- Enforce POSIX `0700` directory and `0600` file modes; fail closed on unsafe paths, permissions, migrations, credentials, and tool surfaces.
- Use TDD for every behavior change: observe the focused test fail for the intended reason before production code, then implement the minimum change and re-run the focused and full suites.

---

### Task 1: Project Foundation, Normalization, and Frozen v1 Database

**Files:**

- Create: `.nvmrc`
- Modify: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `src/db.ts`
- Create: `src/normalize.ts`
- Create: `test/db.test.ts`
- Create: `test/normalize.test.ts`

**Interfaces:**

- Produces: `openDatabase(path: string): Database`, `closeDatabase(db: Database): void`, `transaction<T>(db: Database, fn: () => T): T`.
- Produces: `normalizeName`, `normalizeOpenLibraryWorkId`, `normalizeIsbn`, and `normalizeCitationUrl`, each returning a normalized string or throwing `ValidationError`.
- Produces: exported `READING_STATUSES` and `ReadingStatus`.

- [ ] **Step 1: Write failing normalization tests**

Cover literal cases: NFKC/lowercase/whitespace collapse, `OL123W` and `/works/ol123w`, valid/invalid ISBN-10 and ISBN-13 checksums, URL fragment removal/default-port serialization/sorted query pairs, and rejection of non-HTTP(S) URLs. Include this representative assertion:

```ts
assert.equal(
  normalizeCitationUrl('HTTPS://Example.COM:443/a/?z=2&a=1#fragment'),
  'https://example.com/a/?a=1&z=2',
);
```

- [ ] **Step 2: Run the normalization test and verify RED**

Run: `npm test -- --test-name-pattern='normaliz'`
Expected: FAIL because `src/normalize.ts` does not exist.

- [ ] **Step 3: Implement the normalization functions minimally**

Use `String.prototype.normalize('NFKC')`, `toLowerCase()`, Unicode whitespace replacement, checksum arithmetic, the WHATWG `URL`, and `URLSearchParams.sort()`. Do not add a validation dependency.

- [ ] **Step 4: Run normalization tests and verify GREEN**

Run: `npm test -- --test-name-pattern='normaliz'`
Expected: all normalization tests pass.

- [ ] **Step 5: Write failing database migration and constraint tests**

Assert migration 1 creates exactly the spec tables and indexes, enables foreign keys and WAL, rejects invalid status/rating, enforces every unique constraint, sets series links null on series deletion, nulls conversation provenance on conversation deletion, and rolls back an injected failing migration.

- [ ] **Step 6: Run database tests and verify RED**

Run: `npm test -- --test-name-pattern='database|migration|constraint'`
Expected: FAIL because `openDatabase` is missing.

- [ ] **Step 7: Add exact project metadata and the minimal database implementation**

Use these manifest decisions verbatim:

```json
{
  "type": "module",
  "engines": { "node": ">=24.15.0" },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "pi-web-access": "0.24.2"
  },
  "devDependencies": { "typescript": "7.0.2" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test dist/test",
    "start": "npm run build && node dist/src/main.js"
  }
}
```

Create migration 1 as a frozen SQL string in `src/db.ts`; include the cache payload version, all foreign-key actions, checks, indexes, and unique constraints from the spec. Pre-create a new database file as `0600` before `DatabaseSync` opens it.

- [ ] **Step 8: Install dependencies, run the complete suite, and commit**

Run: `npm install && npm test`
Expected: all tests pass with no warnings.

```bash
git add .nvmrc .gitignore package.json package-lock.json tsconfig.json src/db.ts src/normalize.ts test/db.test.ts test/normalize.test.ts
git commit -m "feat: add Book Explorer database foundation"
```

---

### Task 2: Library Repository and Recommendation Persistence

**Files:**

- Create: `src/library.ts`
- Create: `test/library.test.ts`
- Modify: `src/db.ts`

**Interfaces:**

- Consumes: `Database`, normalization functions, `ReadingStatus`.
- Produces: `LibraryRepository` with `searchBooks`, `getBook`, `createOrFindBook`, `updateBook`, `deleteBook`, series CRUD, note edit/delete, `recordRecommendation`, and paged recommendation history.
- Produces: `AmbiguousBookError` carrying safe candidate summaries.

- [ ] **Step 1: Write failing repository tests**

Test exact identifier reuse, ambiguous normalized title/author candidates without merge, missing-field-only agent updates, direct user updates winning, series uniqueness, note edit/delete, recommendation `(requestId, bookId)` idempotency despite changed prose, and citation upsert/linking.

```ts
const first = library.recordRecommendation(requestId, bookId, 'first', null, [citation]);
const repeated = library.recordRecommendation(requestId, bookId, 'changed', null, [citation]);
assert.equal(repeated.id, first.id);
assert.equal(repeated.rationale, 'first');
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --test-name-pattern='library|recommendation'`
Expected: FAIL because `LibraryRepository` is missing.

- [ ] **Step 3: Implement direct prepared-statement methods**

Keep SQL in `src/db.ts`; keep domain decisions in `src/library.ts`. Return plain serializable records. Do not create generic repository/base classes.

- [ ] **Step 4: Run focused and full suites, then commit**

Run: `npm test -- --test-name-pattern='library|recommendation' && npm test`
Expected: all tests pass.

```bash
git add src/db.ts src/library.ts test/library.test.ts
git commit -m "feat: persist library and recommendations"
```

---

### Task 3: Durable Conversation Registry and Proposal Recovery

**Files:**

- Create: `src/conversations.ts`
- Create: `src/proposals.ts`
- Create: `test/conversations.test.ts`
- Create: `test/proposals.test.ts`

**Interfaces:**

- Consumes: `Database`, `SessionManager`, `LibraryRepository`.
- Produces: `ConversationRegistry.create/get/list/archive/rename/delete/close` and `withConversation(id, fn)` FIFO serialization.
- Produces: `listPendingProposals`, `acceptProposal`, and `rejectProposal`.

- [ ] **Step 1: Write failing session durability and registry tests**

Test file-before-row creation, `0600` header materialization, immediate custom-entry persistence before assistant output, atomic one-manager acquisition, path/symlink rejection, archive retention, active deletion conflict, acquisition rejection after deleting mark, both tombstone crash windows, missing/corrupt referenced files, orphan cleanup, and process restart/reopen.

- [ ] **Step 2: Add the required rollback failure-injection test**

Inject SQLite deletion failure after tombstone rename and assert the original filename exists, the exact same manager object is republished, the deleting marker is cleared, and a later custom append succeeds.

- [ ] **Step 3: Run conversation tests and verify RED**

Run: `npm test -- --test-name-pattern='conversation|session|tombstone'`
Expected: FAIL because `ConversationRegistry` is missing.

- [ ] **Step 4: Implement the registry with one small FIFO promise chain per conversation**

Use only public `SessionManager` methods. Create the header file with `openSync(path, 'wx', 0o600)`, write `JSON.stringify(header) + '\n'`, then call `setSessionFile(path)` before inserting the row.

- [ ] **Step 5: Write failing proposal lifecycle tests**

Use an in-memory/fake session adapter with the same append/read contract. Cover deterministic proposal IDs, duplicate proposal calls, `applying → SQLite → accepted`, crash after applying, crash after commit, edited acceptance, rejection, restart reconstruction, and approved state excluding pending proposals.

- [ ] **Step 6: Implement proposal reconstruction and recovery minimally**

Hash request UUID, kind, normalized book target, and semantic slot with `node:crypto`. Reapply `applying` entries idempotently and append terminal decisions only through the registry mutex.

- [ ] **Step 7: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='conversation|session|proposal|tombstone' && npm test`
Expected: all tests pass.

```bash
git add src/conversations.ts src/proposals.ts test/conversations.test.ts test/proposals.test.ts
git commit -m "feat: add durable conversations and proposals"
```

---

### Task 4: Open Library FIFO Client and Cache

**Files:**

- Create: `src/open-library.ts`
- Create: `test/open-library.test.ts`
- Modify: `src/db.ts`

**Interfaces:**

- Consumes: `Database`, identifier normalization.
- Produces: `OpenLibraryClient.lookup(input, { refresh?: boolean })`.
- Produces: `OpenLibraryResult` containing metadata/candidates and optional `{ stale, refreshError }`.

- [ ] **Step 1: Write failing client tests with a local fake HTTP server**

Cover identifying user agent, work/ISBN/title-author endpoints, exactly one request in flight and FIFO order, 30-day freshness, schema-version miss, explicit refresh replacement, stale retention plus visible failed-refresh error, and timeout/429/malformed/404 behavior without blocking manual entry.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='Open Library'`
Expected: FAIL because `OpenLibraryClient` is missing.

- [ ] **Step 3: Implement one queued promise tail and built-in `fetch`**

Do not add retry infrastructure or a cache abstraction. Parse only documented response fields needed by v1 and validate before caching payload version `1`.

- [ ] **Step 4: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='Open Library' && npm test`
Expected: all tests pass.

```bash
git add src/db.ts src/open-library.ts test/open-library.test.ts
git commit -m "feat: add Open Library metadata lookup"
```

---

### Task 5: Isolated Pi Runtime and Guarded Web Search

**Files:**

- Create: `src/config.ts`
- Create: `src/agent-runtime.ts`
- Create: `src/search-guard.ts`
- Create: `test/agent-runtime.test.ts`
- Create: `test/search-guard.test.ts`

**Interfaces:**

- Consumes: application data paths and existing Pi auth path.
- Produces: `initializeAgentRuntime(paths): Promise<AgentRuntimeState>` with either the exact model or a library-only reason.
- Produces: `createTurnLoader(runtime, customTools, citationCapture)` returning a freshly reloaded `DefaultResourceLoader`.

- [ ] **Step 1: Write failing config/auth/model tests using injected runtime factories**

Cover `PI_OFFLINE` values, OAuth-only startup, missing/expired/non-OAuth failure, explicit refresh result inspection, timeout/error library-only mode, exact Sol/medium selection, app-local path isolation, and `PI_CODING_AGENT_DIR` assignment before dynamic extension import.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npm test -- --test-name-pattern='runtime|OAuth|model'`
Expected: FAIL because runtime initialization is missing.

- [ ] **Step 3: Implement startup configuration and runtime initialization**

Validate/write `web-search.json`, reject `openaiApiKey`, delete `OPENAI_API_KEY`, use `refreshOnCreate: false`, inspect explicit refresh results, and never read the user's general model/settings/session paths.

- [ ] **Step 4: Write failing search guard and tool-surface tests**

Cover omitted-or-pinned provider/workflow, array/other provider rejection, `includeContent` rejection, exact OAuth check, non-OpenAI outcome conversion, no fetch-cache writes, fresh loader on two consecutive turns, startup-probe disposal, and exact seven-name active tool set.

- [ ] **Step 5: Implement the inline extension factory and loader creation**

Correlate `details.searchId` to the `web-search-results` custom entry; preserve original result details, inject opaque citation tokens, and keep captured structured citations only in request-scoped memory.

- [ ] **Step 6: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='runtime|OAuth|model|search guard|tool surface' && npm test`
Expected: all tests pass.

```bash
git add src/config.ts src/agent-runtime.ts src/search-guard.ts test/agent-runtime.test.ts test/search-guard.test.ts
git commit -m "feat: isolate Pi runtime and web search"
```

---

### Task 6: Six Agent Tools and Citation Tokens

**Files:**

- Create: `src/tools.ts`
- Create: `test/tools.test.ts`

**Interfaces:**

- Consumes: `LibraryRepository`, proposal functions, request UUID, conversation ID, request-scoped citation token map.
- Produces: `createBookExplorerTools(context): ToolDefinition[]` with exactly six definitions.

- [ ] **Step 1: Write failing schema and ownership tests for all six tools**

Use table-driven literal inputs for valid bounds, unknown properties, overlong strings, enum/range failures, identifier/URL errors, missing citation tokens, direct status/rating/note attempts, and request UUID closure ownership. Assert effects in the real temporary database, not mock call counts.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='tool schema|tool effect|citation token'`
Expected: FAIL because tool definitions are missing.

- [ ] **Step 3: Implement literal TypeBox-compatible schemas and direct handlers**

Reuse Pi's installed schema facilities; add no schema package. Return the exact `{ ok, data/error }` envelope and keep each transaction synchronous.

- [ ] **Step 4: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='tool schema|tool effect|citation token' && npm test`
Expected: all tests pass.

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose constrained book agent tools"
```

---

### Task 7: Model-Turn Gate, Streaming, Retry, and Disposal

**Files:**

- Create: `src/turns.ts`
- Create: `test/turns.test.ts`

**Interfaces:**

- Consumes: `ConversationRegistry`, runtime/loader factory, six tools.
- Produces: `TurnCoordinator.submit`, `cancel`, and `activeRequestId`.
- Produces: `BrowserStreamEvent` union for `text_delta`, `tool_status`, `citation`, `complete`, and `error`.

- [ ] **Step 1: Write failing fake-driver turn tests**

Cover request marker before prompt, retry UUID reuse, committed tool success followed by model failure, distinct same-tool calls, global exclusion across conversations, direct user edits during network waits, backpressure waiting, cancellation/disconnect, safe auth/quota/search/internal classification, incomplete output, and every exit releasing the gate only after abort/dispose.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='turn|stream|cancel|global gate'`
Expected: FAIL because `TurnCoordinator` is missing.

- [ ] **Step 3: Implement the coordinator around one active request record**

Use one `try/finally`; on abnormal exit await `session.abort()`, then dispose, then clear the gate. Do not create a generic queue because the spec requires visible global busy.

- [ ] **Step 4: Add Pi JSONL compaction/restart integration tests with fake model output**

Exercise conversation → compaction → reopen → second turn → second compaction through public Pi APIs, plus loader disposal/recreation in one process.

- [ ] **Step 5: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='turn|stream|cancel|global gate|compaction' && npm test`
Expected: all tests pass.

```bash
git add src/turns.ts test/turns.test.ts
git commit -m "feat: coordinate streamed model turns"
```

---

### Task 8: Loopback HTTP API, CSRF, and SSE Routes

**Files:**

- Create: `src/http.ts`
- Create: `test/http.test.ts`

**Interfaces:**

- Consumes: database/library/conversation/proposal/Open Library/turn services.
- Produces: `createHttpServer(deps): http.Server` and generated per-process CSRF token.

- [ ] **Step 1: Write failing route-contract and security tests**

Exercise every endpoint in the spec table, pagination defaults/caps, duplicate-candidate details, uniform errors, JSON body limits, CSRF, exact Host/Origin, content type, cancellation UUID, no CORS headers, global busy, SSE event schema, and socket backpressure.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='HTTP|route|CSRF|SSE'`
Expected: FAIL because `createHttpServer` is missing.

- [ ] **Step 3: Implement one `node:http` router with URLPattern-like regex matching**

Use `URL`, method/path switches, `crypto.randomBytes`, and small local JSON/SSE helpers. Do not add a router, CORS, or validation dependency. Bind only in `src/main.ts`, never inside tests.

- [ ] **Step 4: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='HTTP|route|CSRF|SSE' && npm test`
Expected: all tests pass.

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat: add secure loopback HTTP API"
```

---

### Task 9: Safe Framework-Free Browser Interface

**Files:**

- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`
- Create: `public/render.js`
- Create: `test/render.test.ts`
- Modify: `src/http.ts`

**Interfaces:**

- Consumes: exact HTTP/SSE contracts from Task 8.
- Produces: chat/sidebar/library/drawer UI and exported pure DOM rendering functions from `public/render.js`.

- [ ] **Step 1: Write failing rendering tests with a minimal fake DOM**

Test malicious HTML remains text, `javascript:` and malformed links are omitted, HTTP(S) citation links receive `noopener noreferrer`, covers reject unsafe schemes and set `referrerPolicy = 'no-referrer'`, and incomplete assistant output is marked.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='render'`
Expected: FAIL because browser renderers are missing.

- [ ] **Step 3: Implement the smallest usable three-pane UI**

Use `textContent`, `createTextNode`, `createElement`, `fetch`, and `EventSource`-compatible stream parsing only. Include named conversation CRUD, chat streaming, recommendation cards, Library filters/editing, and individual proposal accept/edit/reject. Do not render Markdown.

- [ ] **Step 4: Serve static files with explicit content types and shell CSRF injection**

Read files from the fixed project `public/` directory only; do not accept user-supplied static paths. Inject the CSRF token into one script data value using JSON encoding.

- [ ] **Step 5: Run focused/full suites and commit**

Run: `npm test -- --test-name-pattern='render|static shell' && npm test`
Expected: all tests pass.

```bash
git add public/index.html public/styles.css public/app.js public/render.js src/http.ts test/render.test.ts
git commit -m "feat: add Book Explorer browser interface"
```

---

### Task 10: Startup Composition, Permissions, and End-to-End Verification

**Files:**

- Create: `src/main.ts`
- Create: `test/startup.test.ts`
- Create: `test/integration-live.test.ts`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: all prior task modules.
- Produces: executable startup path and opt-in live integration check.

- [ ] **Step 1: Write failing startup tests**

Cover XDG/default data roots, clear-then-recreate cache ordering, every POSIX directory/file/WAL mode, unsafe permission failure, Windows broad-ACL warning through injected platform checks, migration failure, missing/corrupt session failure, OAuth failure, library-only catalog failure, and loopback bind configuration.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern='startup|permission|data root'`
Expected: FAIL because `src/main.ts` composition helpers are missing.

- [ ] **Step 3: Implement startup composition and concise operator documentation**

Compose concrete modules directly, handle shutdown by closing sessions/server/database, and document Node 24.15.0, `npm install`, `npm test`, `npm start`, data location, OAuth prerequisite, and library-only restart behavior.

- [ ] **Step 4: Add an opt-in live check that normal tests skip**

Gate it on `BOOK_EXPLORER_LIVE_TEST=1`; verify current Pi OAuth, exact Codex model, web search citation capture, streaming, and concurrent auth refresh alongside a spawned Pi CLI process. Never run it in the normal suite.

- [ ] **Step 5: Run proactive diagnostics and all offline verification**

Run: `npm test && npm run build && git diff --check`
Expected: all tests pass, build exits 0, and diff check is clean.

- [ ] **Step 6: Run the live integration check only when credentials/network are intentionally available**

Run: `BOOK_EXPLORER_LIVE_TEST=1 node --test dist/test/integration-live.test.js`
Expected: pass, or report the exact external auth/quota/network blocker without weakening normal tests.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts test/startup.test.ts test/integration-live.test.ts README.md package.json package-lock.json
git commit -m "feat: compose Book Explorer application"
```

---

## Final Verification

- Run `npm test` and require zero failures/warnings.
- Run `npm run build` and require exit 0.
- Run project diagnostics on `src/`, `test/`, and `public/` and resolve every blocking issue.
- Verify `git diff --check`, inspect the full branch diff against its merge base, and run a final whole-branch reviewer.
- Do not push, merge, publish, or run the opt-in subscription-consuming integration test without explicit authorization.
