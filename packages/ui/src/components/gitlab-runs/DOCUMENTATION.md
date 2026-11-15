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
- `useGitlabRuns(directory, { pollWhileActive })` reads
  `/api/gitlab-issues/runs`; a `null` directory asks for every project. A failed
  read keeps the last list and sets `error`. A directory the server says is not
  bound to GitLab sets `notBound` instead, because that is an answer, not a
  failure.
- `requestRunAction` is the only write. It posts the action as the bound account
  and never as the bot; the server decides what the action means in GitLab.
- `useRunAccounts` decides which bound accounts may act on a run, matched by
  host: the ledger stores a base URL, an identity may spell the same host
  without the scheme.

## Polling

The page polls every ten seconds while it is open. The board's per-item row asks
for `pollWhileActive`, which polls only while a run is still moving
(`polling.ts`, `shouldPollRuns`); an empty or finished answer waits for a manual
refresh or for the tab to become visible again. Both read once when the tab
returns.

## The runs page's card

One card per run, closed until it is asked to open. Closed, it carries only what
a person scanning the list needs: the issue title (no `#`, the issue number lives
with the state on the right), the phase the run is in with a dot while its
session is working, its age, and the issue's own state with a dot per automation
label. Approving or rejecting a plan is the
one action that stays outside, because `waiting-approval` is the only phase where
the list is waiting on the person rather than the server.

Open, a card adds the steps, the branch and merge-request links, the blocked
explanation and every other action. `RunSteps` draws that list: one line per stop
with its name, the time the run entered it, the sessions the run opened there,
and the events that happened while it was there. `RunRail` stays the one-line
version for the board's row, where there is no room for names.

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

`sessionTrailOf` is the one source both trail views read: the full per-stop
list in `RunSteps`, and the compact one-line `SessionTrail` on a folded card.
The folded card keeps the trail visible because the sessions a fix and its
reviews opened are the run's work — a card that shows only the live session
hides everything that already happened, and the step view is a click further
away than the card itself.

A stop's clock comes from the first event that entered it *and* carries a time:
a stop is entered by the move and, when it starts a session, by the session start
right after it, and a ledger written before moves carried times has only the
second one. Where no event in the stop has a time the clock stays empty rather
than showing a guess; the dispatcher stamps every event since. Event lines carry
their own clock for the same reason.

The issue and merge-request links are anchors, not text-styled buttons: they open
a page outside the app, and a link that only underlines on hover reads as text.
The external-link mark beside them says the same thing before the pointer moves.

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

## The board's row

`sourceBoard/SourceBoardGitlabRun.tsx` picks its run by number within the folder
the item was listed from: an issue by `iid`, a change request by `mrIid`. It
shows only a run that has not finished, and offers canceling, resetting and
taking over — the three things a person does because this item is stuck.
Approving or rejecting a plan stays on the page, where the whole list is in
view.
