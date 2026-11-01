# Local issues tracker

The design and requirements live in `issue-local-spec/本地Issue管理需求与设计方案.md` (repo root); this document describes the server module as it is now.

## Ownership

This module is the `local` tracker in the tracker registry (`../trackers/registry.js`, id `local`). It owns the markdown issue files under each project's issues directory — `<project.path>/<issuesDir ?? '.issues'>/LOCAL-<n>-<slug>.md` — and everything derived from them: the frontmatter fields, the body, the `## Comments` section, per-project preferences (`preferences.js`, stored in the OpenChamber data dir) and the session-status comment posts. The issues directory default and the per-project `issuesDir` override belong to the settings layer (`server/index.js` sanitizes the `projects` array; the module only reads it through the `listProjects` it is given).

It is deliberately remote-free: no account, credential, or network call. `tracker.js` maps the scanner's shapes onto the neutral tracker contract (`../trackers/tracker-contract.d.ts`); `index.js` is the registry entry and takes the settings reader by injection (see *Decisions*).

Routes answered (through the shared `/api/tracker/local/*` routes, host-only in `spaces/dispatcher.js`): `GET providers` includes the descriptor; `GET auth/status` (always connected as `Local`; `auth/start`, `auth/activate`, `DELETE auth` answer 404 — there is nothing to authenticate); `GET items/list`, `GET items/get`, `POST items/update` (state only), `POST items/create`, `POST items/edit` (fields present in the body only), `GET states` (the descriptor's `create`/`edit` capabilities are true); `GET|PUT preferences` (`{ sessionComments }`); `POST session-status` (the runtime posts comments on OpenCode session events, and the UI can post the same shape directly). `mapping` is not offered (`projectMapping: false`).

## Invariants

- **Identifiers are immutable.** `LOCAL-<n>` is assigned at create time from the per-project counter, becomes the file name, and never changes. The number restarts at 1 per project; the project is what makes an issue unique. A file whose parsed identifier disagrees with its file name, or a duplicated identifier in one project, is skipped with a warning, never served.
- **Six states, exactly:** `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled` (`files.js` `STATES`). Parse does not validate the state — a file with an unknown state parses and is served as it is — but an update to an unknown state is rejected.
- **The scan cache is per-file `mtimeMs`+`size`.** Parsed issues are reused while both match the directory stat; any outside writer (the user in an editor, this module's own `writeIssue`) invalidates the file on the next scan. The cache is per project and lives for the server run.
- **Writes are atomic: tmp file + rename** (`writeIssue`). `writeIssue` does not create the directory — callers guarantee it exists (`scanner.create` does); a caller that does not fails with the rename error rather than silently writing elsewhere.
- **The `## Comments` section format:** entries are `### <iso> · <source>` headings followed by body lines. The section is rebuilt in normalized form on every comment append; the head (everything above it) is preserved verbatim. `updatedAt` is bumped by the append.
- **`blockedBy` is stored, `blocked` is derived.** A file records the identifiers it waits on; whether it still waits is computed on every scan from those identifiers' current states, and never written back. A blocker counts while its file exists and its state is neither `done` nor `canceled`; an identifier with no file behind it blocks nothing, and an issue never counts itself. `persist` recomputes the whole project after a write, so a state change settles or revives the issues waiting on it.
- **`feature` is a free-form grouping slug.** The file format does not validate it, `list` narrows on exact equality, and no derived state depends on it. `list` also reports `facets.feature` — every slug in the container — so a consumer's filter options survive its own filter.
- **`feature` and `blockedBy` are writable through the API.** `items/create` and `items/edit` forward them when the body carries the key (an absent key leaves the stored value alone, `null`/`[]` clears it), so the board's form and an agent end up in the same place. The descriptor's `feature`/`blockers` bits say which trackers have the fields; `readListOptions` passes `feature` through without a gate.
- **Search covers what the row shows:** identifier, title, body, file name, the grouping slug and every label, plus the pasted-file-name shortcut.
- **The item `url` is an identity, not an address.** `itemUrl()` builds `https://openchamber.local/tracker/local/<ID>`; the host is synthetic and nothing serves it. Its only job is to be recognised when pasted back (`matchUrl`, the descriptor's `urlPatterns`, session links). The descriptor therefore answers `capabilities.externalUrl: false`, which is the UI's instruction to open and copy the item in-app (`?reference=`) instead of handing a browser a dead address.
- **A container is a project, and `state.name` is a slug.** `containers()` and every returned item's `container.id` are the project id, so the board scopes a list by the project it shows; the descriptor answers `capabilities.containersAreProjects: true` for that, and `capabilities.translatedStates: true` because `states()` hands back `STATES` values as `name` — the words belong to the UI's i18n, not to the file. A tracker whose names a team wrote (Linear) answers false to both and is shown as written.

## Decisions

### Why `blocked` is derived instead of stored

The frontmatter holds one direction of the relation, `blockedBy`. Storing the blocked flag too would need every writer (the board, an agent, a hand edit) to update the issues that wait whenever a blocker changes state, which is exactly the coordination the file format avoids. Deriving it costs one in-memory pass over a project's parsed issues per scan, and it cannot disagree with the files.

### Why the feature filter has a capability bit and its own facets

`capabilities.feature` says whether a tracker's items carry a grouping slug at all, which is what a form needs to know before offering the field; the values themselves are data, so the filter is offered only when `list` reports at least one slug.

Those options come from `facets`, counted over the whole container rather than the returned page: read off the items that came back, the options would be narrowed by the filter in force, leaving the chosen slug as the only one selectable until the filter was cleared. Counting them costs one more pass over issues already parsed for the list.

### Why the search also matches the file name

FR-4 asks for a pasted file path to reach its issue. A path or file name (`LOCAL-7-fix-login.md`, `.issues/LOCAL-7-fix-login.md`) is recognized by its last path segment and resolved to its identifier, which keeps a pasted name exact; the file name and slug are in the searchable text as well, so a partial name finds the issue too.

### Why the settings reader is injected instead of imported

`settings-runtime.js` exports only the `createSettingsRuntime` factory; the runtime instance (and with it the migrated settings state) belongs to `server/index.js`, which builds it from server-level paths and sanitizers. Importing the factory here would build a second runtime over the same settings file — two caches and two writers racing. So `index.js` exports `configureLocalTracker({ readSettings })`, called once at startup before the registry can load the tracker, and `load()` refuses to run before that with a loud error rather than serving an empty project list.

### Why the session-comment link and dedupe maps are in memory only

`sessionLinks` (session id → `{ identifier, sessionOrigin }`, recovered from the `started` post because OpenCode events carry neither) and `postedStatuses` (dedupe key `sessionId:kind`, FIFO cap 500) live for the server run. A restart loses in-flight links and dedupe markers: the `started` comment on the issue file already records the link for humans, and the maps refill on the next post. Linear persists a records file; if duplicates appear in practice, revisiting that is an M2 decision, not a default.

### Why `appendComment` drops content below a second `## ` heading under `## Comments`

`splitComments` reads the section as `###` entries only. A second `## ` heading inside the section (user-added structure under the comments) is not an entry, so the rebuilt section drops it. Everything above `## Comments` survives verbatim; the drop is confined to content that the format cannot represent.

### Why issue files live outside the OpenChamber data dir

The spec puts issues in each project so they version with the project and travel with a checkout. The cost — scan caching by stat, path traversal care, slug sanitizing — is owned here; no other module writes into `issuesDir`.

### Why edit renames the issue file when the title changes

The file name derives from the issue number and the sanitized title slug (`LOCAL-<number>-<slug>.md`). When an edit changes the title, `scanner.edit` computes the new slug and target file name, writes the updated file, removes the old file, and purges the stale file name from the cache. This keeps the file name on disk in sync with the issue title while avoiding stale duplicate files.

### Why the item URL is not a page

An issue needs a link: one value that names it in a session, in a pasted reference and in the tracker contract's `url` field. Linear's link is also an address, so the UI can offer it to a browser. A local issue has no server behind it — the data is a markdown file in one project on one machine — so there is nothing to address, and inventing a reachable one would mean either a per-machine server route or a real host in someone's DNS.

`openchamber.local` is the smallest thing that works as an identity: a host nobody resolves, a path that reads like the Linear shape, and a `urlPatterns` entry that makes a paste resolve back to `LOCAL-<n>`. `capabilities.externalUrl: false` is what keeps that honest downstream: the UI copies the page's own address with `?reference=<that link>` instead, which opens the item in this app for whoever can already reach it, and nothing pretends the link works anywhere else.

### Why locate scopes to project hint when provided

`LOCAL-<n>` identifiers restart from 1 per project. When `locate` or `get` receives a `containerId` or `projectDirectory` hint, it scopes the lookup strictly to that project without falling back to other projects, preventing cross-project mutations or state updates on ambiguous identifiers.
