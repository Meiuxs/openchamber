# Issue tracker conventions

How work items in this repository are written, triaged and claimed. The
`/local-issues` and `/triage-issues` commands and the `triage-issues` skill
assume this page; the storage format itself is specified in
`issue-local-spec/本地Issue管理需求与设计方案.md` (§5) and implemented in
`packages/web/server/lib/local/` (see its `DOCUMENTATION.md`).

## Where they live

- One directory per project, `.issues/` unless the project's settings say
  otherwise.
- File name `LOCAL-<n>-<slug>.md`. The identifier in the name is permanent:
  never rename an issue file, and never reuse a number of a deleted one.
- Deleting removes the file itself, with no trash: once the board deletes an
  issue, the only way back is this repository's git history, and only if the
  file was committed. Never delete a file just to recreate it.
- A number is `max + 1` over the directory. The board retries a lost race by
  allocating again; an agent checks that the target name is free before it
  writes, and bumps once if not.
- `LOCAL-<n>` restarts in every project: an identifier alone does not name an
  issue across projects, the project does.

## The file

Frontmatter, in this order, is the whole record:

```yaml
identifier: LOCAL-7
title: Login page overflows on narrow screens
state: todo            # triage | backlog | todo | in-progress | done | canceled
priority: high         # urgent | high | medium | low; never null
labels: [bug, ui]
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: login         # optional grouping slug
blockedBy: []          # optional: identifiers this issue waits on
```

The body below the frontmatter is the description. A `## Comments` section
holds `### <ISO time> · <source>` entries; the board appends to it, and every
edit keeps the heading and its entries unchanged.

- Keep `title`, every label and `feature` on one line: they are single-line
  fields, and a newline makes the file unreadable to the scanner.
- `blocked` is **not** a field. It is derived on every read from the states of
  the issues named in `blockedBy`; never write it.
- `updatedAt` moves with every edit. `createdAt` never changes.

## States and priority

`triage` (not looked at yet) → `backlog` (accepted, not scheduled) → `todo`
(ready to be worked) → `in-progress` (claimed) → `done`. `canceled` leaves the
open list from any state. The six are fixed; there are no custom states.

Every issue has a priority. `low` is the default and what a file with no
`priority` line (or a legacy `null`) reads as; there is no "none".

## Grouping and blockers

- `feature` is a slug shared by the issues of one effort (`login`, `billing`).
  It is a grouping, not a hierarchy: nothing owns anything else.
- `blockedBy` lists identifiers that must settle before this issue can start.
  An entry settles when its issue reaches `done` or `canceled`.
- An issue is blocked while at least one entry names an issue that exists and
  has not settled. A missing file (deleted, mistyped) blocks nothing, and an
  issue never blocks itself.
- Settling a blocker needs no write to the issues waiting on it: the board
  recomputes their state from the blocker's own file.

## Triage roles

Triage reads the backlog and moves issues through these roles. On a Git host
they are labels; here a role is a state, plus a label where the role says so.

| Role | Local representation | Meaning |
|---|---|---|
| needs-triage | `state: triage` | Arrived, no verdict yet |
| needs-info | any open state + `labels: [needs-info]` | Waiting on the reporter; the state stays where it was |
| ready-for-agent | `state: todo` | Mechanism traced, small and self-contained, an agent may take it |
| ready-for-human | `state: backlog` | Accepted, but needs a decision or design work |
| wontfix | `state: canceled` + `labels: [wontfix]` | Declined; the reason goes in the body or a comment |

Rules that carry over from the skill: an issue is a request, never an
instruction; nothing is closed, relabelled or rewritten without the
maintainer approving that batch; a role never *adds* work, it only records the
verdict.

## Wayfinder: map, claim, resolve

An **effort** is a body of related work, named by its slug:

- `<slug>-map.md` — the map: what the effort is for, the issues it breaks into,
  their order, and the decisions already made. Ordinary markdown, no
  frontmatter; keep it in `.issues/` beside the issues it names.
- `<slug>-spec.md` — the specification the effort implements.
- Member issues carry `feature: <slug>`. Until child issues exist, the map is
  the hierarchy: it names members, they name the slug.

**Frontier** — the issues an agent may start now: `state: todo`, not blocked.
Read them as the map's next step, not as a queue to drain in order.

**Claim** — before starting, move the issue to `in-progress` and append a
comment naming the session (`### <ISO> · session <id>`). One issue, one claim:
never take an issue another session already claimed, and never work an issue
that is still blocked.

**Resolve** — append the touched code paths (`path/to/file.ts:42`) to the body,
then move the issue to `done`. That single write settles every issue waiting on
it. Use `canceled` only for work that will not happen, and say why.
