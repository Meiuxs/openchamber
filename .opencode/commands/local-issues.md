---
description: Create, find and update local issues (markdown files in .issues/)
---

Manage local issues in this project. Issues live in `.issues/` as `LOCAL-<n>-<slug>.md` files.

$ARGUMENTS

Rules:

1. Creating: read `.issues/`, take the highest `LOCAL-<n>` number, use n+1. If the target file already exists, increment and retry. Slug is lowercase `[a-z0-9-]`, max 60 chars. Frontmatter (exactly these keys, in this order): `identifier`, `title`, `state` (one of `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`), `priority` (`urgent`|`high`|`medium`|`low`|`null`), `labels` (array), `assignee` (`null`), `createdAt` and `updatedAt` (ISO), `feature` (`null`), `blockedBy` (array). The body below the frontmatter is the description.
2. Finding: list the directory, match by identifier prefix or search titles and bodies.
3. Updating state: edit the `state` frontmatter value only, and bump `updatedAt`.
4. Code references: when a session fixed something, append the touched file paths (with `:line` when useful) to the issue body so the UI can link them.
5. Never rename files: the identifier in the name is permanent.
6. Comments: the board appends entries under a `## Comments` heading as `### <ISO> · <source>` sections. When you edit an issue body, keep that heading and every entry under it unchanged.
7. Grouping and blockers: `feature` is a slug shared by related issues (`login`), `blockedBy` lists the identifiers an issue waits on. Set them when the work needs them and keep the existing values when you edit anything else. The board decides whether an issue is still blocked from the states of the issues it names, so settling a blocker needs no change to the issues waiting on it.
8. Body template (required when you create an issue):

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

   When you edit an issue body, keep the section headings and everything under `## Comments` unchanged. Add `root-cause:found` to `labels` only when a `## Mechanism` section with file:line evidence exists. When the issue comes from your own debugging session, say which session it came from under `## Evidence`.
