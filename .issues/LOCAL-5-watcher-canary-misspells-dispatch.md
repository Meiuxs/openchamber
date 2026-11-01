---
identifier: LOCAL-5
title: Watcher canary misspells dispatch in the smoke canary file
state: todo
priority: medium
labels: [root-cause:found]
assignee: assistant
createdAt: 2026-11-02T00:05:00.000Z
updatedAt: 2026-11-01T17:52:03.643Z
feature: null
blockedBy: []
---
## Symptom
The smoke watcher canary file contains the misspelled word `DISPATCHH` where it should say `DISPATCH`.

## Reproduce
1. Read `.box-agent-scratch/2391443b8cc8442e8d1b7bb72f9d099a/openchamber-smoke/watcher-canary.txt`.
2. The single line reads `watcher DISPATCHH canary` instead of `watcher DISPATCH canary`.

## Environment
- Machine: this workstation, branch main (shared checkout).
- The canary file is a scratch file, not tracked by git; fixing it must not touch anything else.

## Evidence
`cat` of the file shows the misspelling; no other file contains `DISPATCHH`.

## Mechanism
The canary file was hand-written with a typo: the token on its single line is `DISPATCHH` (double H). Fixing means rewriting the line with the correct token `DISPATCH`. Nothing else references the file.
## Comments

### 2026-11-01T16:06:41.898Z · session ses_e68230e2

Session started — auto-dispatch

### 2026-11-01T16:24:08.559Z · session ses_e68230e2

Session completed — auto-dispatch

### 2026-11-01T17:52:03.643Z · user

啊实打实的萨德是啊打撒的
