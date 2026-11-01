---
description: Create, find, update and delete local issues (markdown files in .issues/)
---

Manage local issues in this project. Issues live in `.issues/` as `LOCAL-<n>-<slug>.md` files.

$ARGUMENTS

Rules:

1. Creating: use the project's issues directory — the `issuesDir` configured in Settings → Projects for that project, `.issues` when none is set. Read it, take the highest `LOCAL-<n>` number (1 to 6 digits), use n+1. If the target file already exists, increment and retry. File name `LOCAL-<n>-<slug>.md`, slug lowercase `[a-z0-9-]`, max 60 chars. Frontmatter (exactly these keys, in this order): `identifier` (must equal the `LOCAL-<n>` from the file name — a mismatch makes the file invisible on the board), `title`, `state` (one of `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`), `priority` (`urgent`|`high`|`medium`|`low`, default `low` — a local issue always has one, never write `null`), `labels` (array), `assignee` (`null` or a name), `createdAt` and `updatedAt` (ISO), `feature` (`null`), `blockedBy` (array). Quote any scalar that would reparse as a non-string: a value that is literally `null`, `true` or `false`, starts with `[` or `{`, or contains `: `, `#`, quotes, commas or newlines goes in double quotes (`title: "null case in retry loop"`). Arrays stay bracketed (`labels: [ui, sync]`). The scanner skips a malformed file with only a server-log warning, so keep the frontmatter exact. The body below the frontmatter is the description.
2. Finding: list the directory, match by identifier prefix or search titles and bodies.
3. Updating state: edit the `state` frontmatter value only, and bump `updatedAt`.
4. Code references: when a session fixed something, append the touched file paths (with `:line` when useful) to the issue body so the UI can link them.
5. Never rename files: the identifier in the name is permanent.
6. Deleting: removing the file deletes the issue — the board offers the same action from the edit dialog. Only do it when asked, and leave an issue that others name in `blockedBy` alone unless the deletion is the point: the waiting issues stop being blocked, but the reference they keep points at nothing.
7. Comments: the board appends entries under a `## Comments` heading as `### <ISO> · <source>` sections. When you edit an issue body, keep that heading and every entry under it unchanged.
8. Grouping and blockers: `feature` is a slug shared by related issues (`login`), `blockedBy` lists the identifiers an issue waits on. Set them when the work needs them and keep the existing values when you edit anything else. The board decides whether an issue is still blocked from the states of the issues it names, so settling a blocker needs no change to the issues waiting on it.
9. Body template (required when you create an issue):

   ```markdown
   ## Symptom
   <!-- one line: what the user sees -->
   <!-- required -->
   ## Reproduce
   <!-- steps; if not reproducible, say why not -->
   <!-- required -->
   ## Environment
   <!-- surface (web/desktop/vscode/mobile), OS, branch+commit where found; `n/a` for pure code-behavior issues -->
   <!-- required -->
   ## Evidence
   <!-- error strings, file:line, source (which session / which log) -->
   <!-- required -->
   ## Mechanism
   <!-- root-cause mechanism with file:line; omit the whole section until known -->
   <!-- optional; may carry `root-cause:found` only when this section exists -->
   ```

   The `<!-- ... -->` lines in the template are instructions: replace each with the real content, never keep them. When you edit an issue body, keep the section headings and everything under `## Comments` unchanged, and bump `updatedAt`. Add `root-cause:found` to `labels` only when a `## Mechanism` section with file:line evidence exists. When the issue comes from your own debugging session, say which session it came from under `## Evidence`.
