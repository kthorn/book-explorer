# Book Explorer

Book Explorer is a local, single-user book recommendation workspace. It binds
only to `127.0.0.1` and stores the library in SQLite plus each conversation in
Pi's native JSONL session format.

## Setup

Book Explorer requires Node **24.15.0 or newer**.

```bash
npm install
npm test
npm start
```

Open <http://127.0.0.1:3000/> after `npm start`. Set `PORT` to choose another
local port; the host is always `127.0.0.1`.

## Data and authentication

On POSIX systems data is stored in `$XDG_DATA_HOME/book-explorer/`. When
`XDG_DATA_HOME` is unset, the default is `~/.local/share/book-explorer/`.
Windows keeps the same application data under the current user's profile and
warns when its ACL is broadly accessible. The directory contains the private
SQLite database, Pi session JSONL files, application-local model files, and
web-search configuration/cache files.

Before starting, sign in to Pi Codex so the existing
`~/.pi/agent/auth.json` contains a current **OAuth** credential for
`openai-codex`. Book Explorer never uses `OPENAI_API_KEY` or an API-key
fallback. Missing, expired, invalid, or non-OAuth Codex credentials prevent
startup.

If `PI_OFFLINE=1`, `PI_OFFLINE=true`, or `PI_OFFLINE=yes` (case-insensitive),
or if the online model-catalog refresh fails, startup still opens the local
library but model turns are unavailable. Restart after authentication,
connectivity, or catalog problems are resolved; Book Explorer does not silently
switch to another model or an offline catalog.

The normal test suite is fully offline. The subscription-consuming live check
is opt-in only:

```bash
BOOK_EXPLORER_LIVE_TEST=1 node --test dist/test/integration-live.test.js
```

Do not run that command unless network access and subscription usage are
intended.
