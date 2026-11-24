# GitLab automation runs

What the server's run ledger means for the UI, in one place: the runs page shows
every run of a project (or of all projects), and the board's preview shows the
one run that belongs to the item it has open.

## Contract

- `runModel.ts` owns the ledger answer (`runsResponseSchema`), `Run`, the phase
  list, `phaseLabelKey`/`guideKey`, the rail a kind walks, the run's own history
  (`runEventSchema`), the sessions it opened (`runSessionSchema`) and the issue's
  state (`issueStateSchema`), and `formatAge`. Everything that reads a run goes
  through it, so a new ledger field is added once. `projectEntryId`, `sessions`,
  `events` and `issueState` are optional: a server older than those fields still
  lists, and only the global view's actions need the first one.
  `recordPath` and `projectDirectory` are optional too and transform to null:
  a run whose delivery note was never written, or whose settings entry is gone,
  simply offers no note action.
- `GUIDE_KEYS` includes `record-write-failed`: a run blocked on the delivery
  note explains that the note could not be written and names the folder or path
  to fix, and says the automation retries on its own.
- `useGitlabRuns(directory, { pollWhileActive, includeDone })` reads
  `/api/gitlab-issues/runs`; a `null` directory asks for every project. A failed
  read keeps the last list and sets `error`. A directory the server says is not
  bound to GitLab sets `notBound` instead, because that is an answer, not a
  failure — a folder that is not a Git repository is answered that way too, so
  the board's tab says "not a GitLab project" rather than nothing. `error` is
  shown with a retry on the page and in the board's tab alike: with no list
  behind it, a tab that rendered nothing read as a load that never finished.
  `includeDone` adds the ledger's finished runs to the global answer
  for the automation session archive.
- `requestRunAction` is the only write. It posts the action as the bound account
  the caller names; that account may be the project's bot account, because the
  dispatcher tags its own notes with a hidden `<!-- openchamber-automation -->`
  marker instead of relying on author identity. The server decides what the
  action means in GitLab.
- `useRunAccounts` decides which bound accounts may act on a run, matched by
  host: the ledger stores a base URL, an identity may spell the same host
  without the scheme.

## Polling

The page polls every ten seconds while it is open. The board's per-item row asks
for `pollWhileActive`, which polls only while a run is still moving
(`polling.ts`, `shouldPollRuns`); an empty or finished answer waits for a manual
refresh or for the tab to become visible again. Both read once when the tab
returns.

## The runs page

The page is a split view. The left column is the scanning list, in work-state
order: what waits on the person, what is blocked, what is running, and the
finished history. Each row carries the issue title, the owning project's path
so two runs with similar titles stay apart in the global view, the phase with a
dot while its session is working, its age, and the issue's own state with a dot
per automation label. Selecting a row fills the right pane; the first row is
selected until then. The project is named the way the sidebar names it — its
label, else its folder name, never the directory path (`projectLabelOf`).

`RunDetail` is that pane. Its header names the run and the account acting on it
(the account badge sits beside the title, and is left out when the action will
ask which of several accounts to use), then one line of facts — the kind, the
issue, the merge request, and the branch right-aligned with its icon, clipped
visually while `title` keeps the whole name. The blocked explanation gets its
own line there instead of competing with the facts for width. Below come the
section nav and the report sections: requirements and design, execution plan,
changed files, review, impact, verification. `useRunFiles` reads
the sessions' message histories and collects file-change tools by path, so the
file list shows what the run produced before the audit trail explains how. One
unreadable session leaves the other sessions' files in place. `FlowAudit` draws
the stops, the events at each stop and one "open session" action per session;
that action opens the session's chat view, where its tools and output are
readable. The ledger only records event summaries, so the chat view is the log
detail and the trail is its index. `SessionTrail` stays the in-card version for
the board's per-item status, and `RunRail` stays the one-line version where
there is no room for names.

Which stops show is `railOf(run)`; a blocked run marks the stop it was blocked
from instead of adding one, because `blocked` is a state of the run and not a
place in its sequence. A run whose ledger has no events (one recorded before the
trail existed) says so, and shows nothing invented.

`addressing` — a comment-driven fix round on an open merge request — is a loop
off `mr-open`, not a stop of its own, so the rail keeps its fixed stops and
`railStopOf` draws an addressing run and its sessions at `mr-open`, where the
loop started; how many rounds it has been through rides on the run as
`feedbackRounds` and shows beside the review round. Both fields are
optional-read, so a server older than them still lists.

`sessionTrailOf` is the one source the compact trail and the file collector
read: `SessionTrail` draws the one-line list on a folded card, and
`useRunFiles` uses it to decide which sessions' messages to inspect. The folded
card keeps the trail visible because the sessions a fix and its reviews opened
are the run's work — a card that shows only the live session hides everything
that already happened, and each session's chat view is a click away.

A stop's clock comes from the first event that entered it *and* carries a time:
a stop is entered by the move and, when it starts a session, by the session start
right after it, and a ledger written before moves carried times has only the
second one. Where no event in the stop has a time the clock stays empty rather
than showing a guess; the dispatcher stamps every event since. Event lines carry
their own clock for the same reason.

The issue and merge-request links are anchors, not text-styled buttons: they open
a page outside the app, and a link that only underlines on hover reads as text.
The external-link mark beside them says the same thing before the pointer moves.
When `recordPath` and `projectDirectory` are both set, `RunDetail` shows a
delivery note action beside those links. It opens the note through
`useUIStore.getState().openContextFile(projectDirectory, recordPath)`, the same
local file path the app uses for any other file, so it works in web, desktop,
VS Code and mobile. The action is absent when the note was never written or the
project entry is gone. The note is a separate document, not a section inside the
panel, so the section nav does not change.

A session is a link under the stop it served — the fix, and one per review round
— because that is the question it answers: what did the run do here, and where
can I read it. Its own clock tells the rounds apart, and only the session the run
is polling right now carries the status dot. A ledger without `sessions` still
offers the session in progress through `sessionId`. The blocked block prints the
reason, its guide, and the server's own message (`lastError`) underneath: the
guide says what to do, that line says what failed.

The confirmation before an action names the labels it moves (`+ ai-ready`,
`− ai-blocked`) and the account as `@username`, because the whole identity string
of an account is longer than the dialog and says less than the address that will
appear on the issue.

## The automation session archive

`AutomationSessionsView.tsx` is a separate page, reached from the sidebar. It
asks for every project's runs with `includeDone` so finished runs stay
reachable, then flattens each run's `sessions` into one row per session through
`sessionsOf`. Rows group by the project that owns their run. Automation
sessions are hidden from the global session list, so the ledger is the only
index that names them; opening a row passes the run's `worktreePath` to
`setCurrentSession`, which is what lets a hidden session be admitted and read
by ID. "View run" moves to the runs page for the row's project.

### Why the archive reads the ledger instead of the session list

Hidden sessions are removed from `session.list`, so no session-list query can
show them without undoing the hiding. The ledger already carries the session
ID, stage and time under each run, plus the project and worktree needed to open
it, so the archive needs no new route and stays consistent with the runs page.

### Deleting a session

Each session row has a delete action (`automationSessionRemoval.ts`, after the
confirm dialog). It removes the session on this machine only: the ledger keeps
its record, so the row stays until the ledger's retention drops it and says the
session is gone. An automation session never reached the client's session list,
so the deletion registers the run's `worktreePath` as the session's folder
first; otherwise the request would be answered in whichever folder happens to
be open. Every stage of a run works in one worktree, so it is removed only once
no session of that run still needs it (`worktreeFreedBy`) and no other run
points at the same directory; a worktree that fails to go leaves the deletion
intact and reports the failure.

## The board's row

`sourceBoard/SourceBoardGitlabRun.tsx` picks its run by number within the folder
the item was listed from: an issue by `iid`, a change request by `mrIid`. It
shows only a run that has not finished, and offers canceling, resetting and
taking over — the three things a person does because this item is stuck.
Approving or rejecting a plan stays on the page, where the whole list is in
view.
