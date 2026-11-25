# Process-wide server helpers

## Ownership

The files directly in this folder own process environment cleanup, network
defaults, administrator policy, package installation discovery, tunnel child
processes, desktop realtime forwarding and session lineage. Feature runtimes
live in the nested folders. Server composition and the source-entry contract
belong to `../DOCUMENTATION.md`.

## Invariants

- Relative imports keep `.js` specifiers in both source languages. The source
  hook resolves converted implementations; installed processes use emitted
  JavaScript.
- Environment cleanup mutates and returns the same environment. Injected names
  are recorded only when their value changes. User overrides remove their
  names from that record.
- AppImage cleanup removes launcher-added directories and launcher-created
  empty library/data entries. Empty PATH entries and system XDG defaults stay.
  `ARGV0` changes zsh's external-command argv and can break virtual environments.
  Bun's native environment may retain it after a JavaScript deletion, so Linux
  also attempts libc `unsetenv`. Missing FFI support remains harmless.
- POSIX PTYs launch through `env -u` when available to remove `ARGV0` and
  `NODE_CHANNEL_FD` from the native environment before executing the shell.
  Windows and systems without `env` retain their original launch.
- Address-family attempts allow 5 seconds for distant providers while retaining
  IPv6-to-IPv4 fallback. System certificates augment the default trust store
  unless OpenSSL trust was explicitly selected; the bundled OpenCode server
  (`opencode-server/serve.mjs`) runs the same step in its own process.
  Unsupported runtime APIs retain the existing catch-and-return behavior.
  The choice is read as Node reads it: `NODE_OPTIONS` splits on spaces outside
  double quotes (a backslash escapes only inside them), `_` equals `-` in option
  names, a value after `=` is ignored, and the last of `--use-openssl-ca` and
  `--no-use-openssl-ca` wins, with the command line after `NODE_OPTIONS`.
- Outbound proxy environment resolution accepts uppercase and lowercase names,
  appends loopback bypasses and writes both NO_PROXY spellings. Node's optional
  global proxy API and Bun's environment-based fetch retain their own behavior.
- Enterprise policy parses file JSON through its existing schema. Invalid or
  unreadable policy enables protection. Environment values cannot override a
  file that enables enterprise mode. Policy polling rewrites managed config
  when its effective value changes, including when the policy file first
  appears.
- Provider-route matching retains case folding, duplicate separators, escapes,
  MCP OAuth exceptions and refusal of ambiguous paths. MCP integration ids
  contain 16 hexadecimal digits. Credential creation is refused in enterprise
  mode; credential listing is refused for all UI clients.
- Cloudflare YAML ingress and ngrok JSON logs/API responses remain untrusted.
  Optional fields are `unknown` until their existing array or string test
  succeeds. Invalid ngrok log lines still fall back to text matching.
- Tunnel stdout remains drained without exposing managed Cloudflare stdout.
  Stderr, readiness patterns, timeout values, token-file permissions, cleanup
  order and SIGINT behavior stay unchanged. Child interruption errors remain
  ignored.
- Cloudflare provider options accept explicit undefined for optional config,
  hostname and token fields. Quick-tunnel options also carry the unused port
  forwarded by providers. Ngrok accepts a missing or null port at entry and
  retains its dependency, authentication and finite-port checks in that order.
- Session parent ids prefer OpenCode's nonempty string, then a schema-validated
  workflow/operator metadata link. Creation/deletion events still use their
  schemas. Bounded eviction makes forgotten ancestry unknown, and takeover
  clears a previously learned child link.
- Realtime forwarding retains raw WebSocket data and its binary flag, including
  queued frames before the upstream opens. Runtime configuration fields remain
  unchecked until their string or object guard succeeds. Header arrays retain
  their enumerable string entries; authorization and malformed headers are
  excluded. Authentication, origin and target allowlists remain independent gates.

## Decisions

### Why runtime guards remain at external inputs

YAML, HTTP JSON, policy-file JSON, process output, thrown values and optional
runtime APIs are not established by TypeScript. Guards keep their existing
acceptance rules, including inherited dictionary members and malformed values.
The checked optional fields of tunnel data do not imply a complete provider
record.

### Why copied helper fixtures emit TypeScript

`path-realpath-cache.ts` declares its injected realpath callback and retained
cache entries. The bare Node fixture in `fs/routes.test.js` emits the helper
alongside the filesystem modules before importing them without dependencies.
Its string and callable guards retain the existing JavaScript fallback for
invalid injected values.

`web-package-paths.test.js` strips types before writing its installed-layout
JavaScript fixture. It runs without a workspace source resolver, preserving
the installed package's self-discovery contract.

### Why package entry fields retain Node validation

`web-package-paths.ts` reads the package-owned manifest contract, whose `main`
and `bin.openchamber` fields are strings. The name check selects the web package
before using these fields. JSON decoding adds no schema or coercion, so missing
or malformed entry fields still produce the original property-access or Node
`path.resolve` errors. The malformed-entry fixture covers these failures.

### Why Tailscale diagnosis checks the target

`tailscale-tunnel.ts` requires a resolved target when checking backend status.
Availability can be true only when a target exists; diagnosis checks both
bindings so TypeScript can establish the same invariant. A missing target keeps
the dependency-installation result and never runs a status command.
The macOS app binary receives `TAILSCALE_BE_CLI=1`, and foreground Serve/Funnel
configuration ends with its CLI process. Approval links, backend state names,
SIGINT cleanup and startup timeout behavior follow the existing CLI contract.

### Why update versions retain decoded JSON types

`getCurrentVersion` and registry fallback results pass through truthy version
values without checking for strings. Their types retain numbers, booleans,
arrays and objects. The version comparator already coerces its inputs with
`String`; release-note range types let that comparator receive the original
values without claiming validation in the functions that forward them.

The API channel regex makes its existing string coercion explicit. `RegExp.test`
performs the same conversion for decoded JSON, so this preserves array and object
versions without changing standard-library declarations. Package discovery
passes a file URL's `href` to the JavaScript helper, whose inferred parameter is
a string; `fileURLToPath` resolves that href identically to the original URL.

JSON object guards establish field access only. String, number and array checks
still decide which API fields are usable. A missing or malformed installed
version retains the existing fallback; truthy unchecked versions remain visible
in update results.

### Why package-manager output accepts two version separators

[pnpm list](https://pnpm.io/cli/list) separates package names and versions with
whitespace; npm, Bun and Yarn print `name@version`. Global version detection
accepts both formats.

[pnpm add](https://pnpm.io/cli/add#--allow-build) restricts dependency build
scripts in pnpm 10+. Update commands approve the existing `msgpackr-extract` and
`node-pty` builds only from 10.4 onward, because earlier releases reject
`--allow-build`.

### Why WebSocket send accepts raw Buffer arrays

The installed `ws` implementation forwards non-string send data through
`buffer-util.toBuffer`, which calls `Buffer.from` for arrays. `SendData` includes
`Buffer[]` to describe that existing acceptance without converting or
concatenating received frames in the proxy. This does not promise fragment
concatenation: the contract test retains the installed array-to-byte conversion.

The upstream WebSocket receives an explicit HTTP origin derived from its target.
The `ws` client makes origin optional, while protected upstreams require it.
The pending queue checks that a shifted frame exists before reading its tuple;
the synchronous queue loop guarantees occupancy during normal forwarding.

## Enterprise mode (`enterprise-mode.ts`)

### Purpose and scope

Enterprise mode is an administrator's promise that conversation content goes
only to the model providers configured in OpenCode. Two sources turn it on, and
either one is enough:

- the machine policy file (`policyFilePaths`), which only an administrator can
  write and a device manager can roll out; nothing a user sets can turn off what
  it turns on;
- `OPENCHAMBER_ENTERPRISE_MODE=1` (or `true`) in the server's environment, which
  includes the login-shell snapshot. Meant for servers and containers, where the
  administrator owns the environment.

It is read at every use, so a changed file applies without a restart.

The policy file also pins the self-hosted relay and the Jev endpoint, and can
allow network access. Who decides those follows who turned the mode on:

- the file turned it on: only the file's values count. The environment is the
  user's to edit, so a variable there must not reopen what the administrator
  left closed (pointing Jev at an endpoint of their own, say);
- otherwise (the environment turned it on, or the mode is off): a value in the
  file wins over its variable, and the variable fills the gap.

A file that exists but cannot be read or parsed turns enterprise mode on, pins
nothing and allows nothing: a broken policy must not quietly lift the protection
it was meant to give.

Each feature that could send conversation content anywhere else checks it at its
own server boundary:

- Model providers come only from the OpenCode config: connecting one, signing
  in, adding a key or creating a custom provider through this server is refused,
  as is probing a custom provider's model endpoint (`opencode/routes.js`).
  OpenCode's `provider.use` policy is the real lock; this closes the way in
  through the app. Signing in to a remote MCP server from the OpenCode config
  uses the same routes and stays allowed.
- Jev classification is off, unless the administrator pinned their own endpoint
  (`routing/runtime.js`).
- External tunnels are refused: Cloudflare and ngrok see plain text, and
  Tailscale opens this machine to other devices (`tunnels`).
- The private relay runs only on a pinned self-hosted endpoint
  (`relay/service.js`).
- Pages an agent shares with other people by link and PIN exist only with that
  pinned relay (`share-pages/relay-client.js` `isSharingAvailable`): without it
  the render tool declares no `share` input, `render.page` refuses one
  (`openchamber-control/render-page.js`), uploads are refused, and no share call
  reaches a relay other than the pinned one (`isRelayBaseAllowed`). The managed
  config is rewritten on a policy change, so the tool's schema follows it.
  Opening a page someone else shared follows the same rule
  (`share-pages/received-runtime.js`): the server reports no relays to take links
  from, every received-page route answers 403, and a pasted link is opened only
  on the pinned relay.
- Speech and transcription go only to servers on this machine (`tts`,
  `dictation`).
- Push notifications carry no message text or session name (`notifications`).
- Update checks still run but never report usage (`package-manager.js`).
- Environment variables from Settings and `opencode service set env` do not
  reach the managed OpenCode: one could carry a provider key
  (`environment/runtime.js`). Git, the terminal and exec still get them.
- The draw.io diagram editor, diagrams.net's own page in a frame, is not loaded;
  a .drawio file opens as its XML (`packages/ui` FilesView). The crossing happens
  in the browser, so the UI is where it is held back.
- Web fonts that load from a public CDN fall back to the system fonts
  (`packages/ui` useFontPreferences); the stored choice is kept.
- The integrations catalog, a bundled list of outside services to install, is
  hidden (`packages/ui` SidebarHeader); administrator-curated sources for it do
  not exist yet. MCP, plugin and skill entry in Settings is unchanged.
- The agent image tool (`openchamber-control/generate-image.js`) is not gated: it
  reaches an image model through OpenCode, so `provider.use` covers it like any
  other provider (maintainer decision, 2026-10-27).
- The Settings card that installs the Claude Code plugin, a model provider, is
  hidden (`packages/ui` IntegrationsPage). The plugin itself is not refused:
  OpenCode's `provider.use` policy covers `claude-code` like any other provider.
- Source control cards show only instances an account already made known. A
  built-in default such as gitlab.com does not stand in as an empty card
  (`source-control/routes.js`, `packages/ui` IntegrationsPage).
- The server listens only on this machine unless network access is allowed
  (`allowNetworkAccess` / `OPENCHAMBER_ALLOW_NETWORK_ACCESS`): it refuses to start
  on a network address and drops connections from other machines (`../index.js`);
  the desktop shell binds loopback (`packages/electron`). Pairing a device then
  goes through a pinned relay only.
- Extensions that could send what they see elsewhere (`network`, `origins`,
  `service`, `transcript`, session content posted to such a service, and
  `opencode`, sessions such a service reads from OpenCode) install and run only
  from a Git repository the administrator listed (`allowedExtensions` /
  `OPENCHAMBER_ALLOWED_EXTENSIONS`), or from a local folder where
  `allowLocalExtensions` / `OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS` allows it; see
  `guests/enterprise.js`. A package that starts sessions, answers the agent's
  permission requests, adds to agents' instructions or ships skills answers to
  the same list (`guests/enterprise.js`). An allowed extension serving as a
  notification channel gets the kind's generic title with no body, session name
  or directory, as the phone does (`notifications/runtime.js` `sendToChannels`).
  An allowed extension serving as a tracker receives the user's searches and item
  identifiers, and the session comments it posts carry a fixed label and the
  session link only (`trackers/extension-tracker.js`), so no conversation content
  crosses; the allowlist is its gate, as for every service. An allowed extension
  serving as a usage provider receives the credentials OpenCode holds for the
  providers its manifest lists, which the user approved in the dialog, and no
  conversation content (`quota/extension-quota.js`); the allowlist is its gate
  too, re-read on every call. An extension that claims identifiers and links in
  chat messages (`links`) receives only the one the user clicked, in its own
  frame on this machine; passing it on needs a gated capability, so `links`
  itself is not gated. An extension that ships an OpenCode plugin
  (`opencodePlugin`: code inside OpenCode itself) answers to the same list at
  install, in the managed OpenCode config (`guests/agent-context.js`), and at the
  card's button that writes the user's global OpenCode config
  (`guests/routes.js`), re-read before the write. The managed config is rewritten
  when the policy changes while the app runs (`watchEnterprisePolicy` below,
  started by `../index.js`), so a plugin or skill the policy now refuses leaves
  the running OpenCode.

The file can also pin the OpenCode CLI (`opencodeBinary`), with or without
enterprise mode: managed OpenCode then starts only from that path, never falls
back to the bundled CLI or PATH, ignores the user's binary setting, and
OpenChamber neither installs nor upgrades it (`opencode/env-runtime.js`,
`packages/vscode/src/opencode.ts`).

The file can also hide the skills catalogs OpenChamber ships with
(`hideBuiltinSkillCatalogs`), with or without enterprise mode, so the only
catalogs on offer are the ones the organization added
(`skills-catalog/curated-sources.js`, `packages/vscode/src/skillsCatalog.ts`).

The file can also allow exact plain-HTTP origins for Git hosting providers
(`allowedInsecureGitOrigins`), with or without enterprise mode: an administrator
who runs a forge (GitLab, Gitea, Forgejo, Gerrit) on an intranet without TLS lists
its origins, and the app accepts them for instance, binding, credential and
transport validation where HTTPS is otherwise required. Only an exact
`http://host[:port]` origin decides; a malformed entry counts as unset, and
extension-provided forges stay loopback-only. The same list exists as a user
setting (Settings → Git, persisted in `preferences.json` as one-per-line text
under `allowedInsecureGitOrigins`): while enterprise mode is off the two sources
merge, and once the mode is on only the file counts — widening plaintext trust
never becomes the user's move. `allowedInsecureGitOrigins()` resolves both for
the consumers that check it.

The file can also pin where the model catalog is read from (`modelsDevUrl`, a
models.dev `api.json` format address), with or without enterprise mode, for
networks that cannot reach models.dev. The consumers validate it at use
(`readPinnedModelsDevUrl`, `opencode/models-metadata.js`) and treat a malformed
value as unset: only plain `http(s)` without credentials counts.
`publicEnterprisePolicy` carries the boolean `modelsDevUrlPinned` and never the
address, and the browser drops its models.dev fallback while the flag is set
(`useConfigStore`).

The file can also replace the built-in skill catalogs entirely
(`skillsCatalogSources`, Git sources the organization serves), with or without
enterprise mode; the replacement list wins over `hideBuiltinSkillCatalogs`
(`skills-catalog/curated-sources.js`, `skills-catalog/source.js`). An entry the
schema cannot read makes the whole file invalid, which fails closed: no catalog
at all.

The VS Code extension host, which runs no OpenChamber server, reads the same
policy through this module for the parts it has (provider connection, update
checks).

### Policy file paths and parsing

- `userPolicyFilePath` resolves the user-writable policy file path under the
  OpenChamber data directory (default `~/.config/openchamber/policy.json`, or
  `$OPENCHAMBER_DATA_DIR/policy.json`).
- `policyFilePaths` lists where the policy file may live, checked in order: (1)
  the user configuration directory (`~/.config/openchamber/policy.json` or
  `OPENCHAMBER_DATA_DIR`), which requires no administrator/root privileges; (2)
  system administrator paths (`/Library/Application Support/...`,
  `C:\ProgramData\...`, `/etc/openchamber/...`) for machine-level policies.
- The JSON parser strips single-line (`//`) and multi-line (`/* ... */`)
  comments and trailing commas from policy text, allowing human-friendly
  annotated files while preserving string literals (such as URLs containing
  `//`). It returns the file's content and throws an `Error` describing what is
  wrong with it. Windows PowerShell 5 writes UTF-8 with a byte-order mark, which
  the reader accounts for.
- Reading the machine policy returns `{ status: 'absent' }`,
  `{ status: 'ok', path, policy }`, or `{ status: 'invalid', path, error }` when
  it exists but cannot be used.
- `watchEnterprisePolicy` calls `onChange` once the policy in effect differs from
  the last read: a managed OpenCode config written before the change still lists
  what the policy now refuses (`guests/agent-context.js`), and only a rewrite
  takes it out of the running OpenCode. It polls, since the policy file lives at
  a fixed path that may not exist yet and is read on every use anyway.

### Effective policy resolution

`getEnterprisePolicy` returns the policy in effect, from the file and the
environment together. `relayUrl` and `jev` are the raw pinned values; their
consumers validate them and treat an invalid one as unset. `source` says where
enterprise mode came from, for the UI and the logs.

- A blank optional string counts as unset, so a template with empty fields pins
  nothing.
- `allowedExtensions` holds Git repository URLs, not package ids: a package
  names its own id, so a user could otherwise ship any code under an allowed one.
- All the fail-closed clauses apply: a broken policy allows no plaintext origin
  it might have withheld, offers no catalog it might have hidden, and pins no
  endpoint or catalog it might have replaced. With the file in charge, the
  environment adds nothing.
- The CLI pin (`opencodeBinary`) and catalog toggles (`hideBuiltinSkillCatalogs`,
  `skillsCatalogSources`) are file-only, in or out of enterprise mode:
  `OPENCODE_BINARY` already lets a user pick a binary, and a pin they could
  override would not be one. For the others the reason is the same (a user
  setting must not reopen an administrator's decision).

### Insecure Git origins and registry pins

- `readPinnedModelsDevUrl` returns the administrator-pinned model catalog URL, or
  null when unset or not a plain `http(s)` URL without credentials (a malformed
  value counts as unset).
- `readNpmRegistry` returns the npm registry this server serves plugin metadata
  and version checks from, or null. Priority: the policy file, the environment
  (`OPENCHAMBER_NPM_REGISTRY`), then — while enterprise mode is off — the user's
  `npmRegistry` setting in `preferences.json` (Settings → npm, read the same way
  `readProfileInsecureGitOrigins` reads profile settings). The winner is
  validated the same way `npm-registry-config.js` validates a registry URL, and
  a malformed value counts as unset. It is read at every use, like the policy, so
  a changed file or setting applies without a restart.
- `readProfileInsecureGitOrigins` returns the user's own plain-HTTP Git origins:
  the `allowedInsecureGitOrigins` profile key (Settings → Git), one origin per
  line, read from `preferences.json` the same way `small-model/index.js` reads
  profile settings. A missing or broken file, or a value that is not text, adds
  nothing. It is consulted only while enterprise mode is off; entries are
  validated by the caller like the file's.
- `normalizeInsecureGitOrigin` returns one exact plain-HTTP origin, or null when
  the value is not text, over 512 characters, a non-`http:` scheme, has
  credentials, a path, a query, a fragment, or a hostname no real origin can have
  (empty, wildcard). A missing scheme is repaired as `http://`, so
  `git.internal:8080` is the same origin as `http://git.internal:8080`. The
  Settings → Git parser in `packages/ui/src/lib/settings/parsers.ts` mirrors this
  by hand and `opencode/settings-helpers.js` reuses it directly, so what persists
  and the trust it buys never diverge.
- `allowedInsecureGitOrigins` returns the exact plain-HTTP origins allowed for Git
  hosting providers: the file's `allowedInsecureGitOrigins`, or — where the file
  says nothing — `OPENCHAMBER_ALLOWED_INSECURE_GIT_ORIGINS` (comma-separated)
  unless the file turned enterprise mode on, plus, while enterprise mode is off,
  the user setting of the same name in `preferences.json`. Entries go through
  `normalizeInsecureGitOrigin`; a malformed one counts as unset. It is read at
  every use, like the rest of the policy; its callers are
  `source-control/origin-instance.js`, the Git transport checks
  (`git/network-operation-plan.js`, `git/credential-resolver.js`,
  `git/network-operation-storage.js`, `git/repository-credential-runtime.js`) and
  the provider listing route.

### Public policy and provider-route matching

- `isLoopbackOnly` reports whether enterprise mode keeps this server off the
  network (loopback only).
- `publicEnterprisePolicy` exposes what a client may know about the policy;
  pinned endpoints and keys stay on the server. It carries only the boolean
  `modelsDevUrlPinned` — the address itself stays on the server, and the browser
  needs just the flag to honor a pinned answer that never arrived.
- OpenCode registers every remote MCP server with OAuth as an integration whose
  id is `mcp_` plus 16 hex digits of a hash of its name and URL
  (`packages/core/src/mcp/index.ts` upstream). Signing in to one reaches a tool
  server from the OpenCode config, not a model provider.
- Provider-route segment matching follows OpenCode 2.0.18 to 2.0.20 routing.
  Bun's URL parsing turns `\` into `/`; OpenCode's router
  (`effect/unstable/http` FindMyWay: case-insensitive, duplicate and trailing
  slashes ignored, `safeDecodeURI`) ends the path at `?`, `#` or `;` and decodes
  percent escapes. So `/API//integration\%6Fpenai/connect/key;x` reaches the same
  handler as `/api/integration/openai/connect/key`. Matching returns null when a
  segment cannot be decoded or is a dot segment: such a path is refused. Recheck
  the segment list when OpenCode changes its router.
- `POST connect/oauth` starts an MCP sign-in; `connect/oauth/:attempt/complete`
  finishes it with a pasted code.
- Provider-connect detection decides whether a request to OpenCode would add a
  way to reach a model provider: every POST under `/api/integration/:id/connect`
  (key, oauth start and complete, command, external since 2.0.25), storing a key
  with `POST /api/credential`, and adding a well-known integration. Signing in to
  a remote MCP server goes through the same routes and stays allowed. Reads,
  cancelling an attempt and removing or switching an existing account stay
  allowed too: they only narrow access. A path that cannot be read safely counts
  as a connect.
- `POST /api/credential` stores a new key (OpenCode 2.0.20);
  `/api/credential/:id/activate` only switches between existing ones.
- Credential-listing detection decides whether a request asks OpenCode for every
  stored credential. Since 2.0.20 `GET /api/credential` answers with the secrets
  themselves. This server and the VS Code extension host read it for themselves
  (`opencode/auth.js`); no client gets it, in or out of enterprise mode, because
  anyone signed in to the UI (over a tunnel or a paired phone too) would
  otherwise read every key. It lives in this module because it needs the same
  reading of an OpenCode path as the provider-connect check. A path under `/api`
  that cannot be read safely counts as a read; anything else never reaches
  OpenCode and is left alone.
