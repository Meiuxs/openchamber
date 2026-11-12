---
name: gitlab-issue-create
description: Use when creating a GitLab issue that OpenChamber's GitLab issue automation should pick up, from an agent session or a scheduled script. Files the issue over REST with a GITLAB_TOKEN, writes the machine-readable 类型/目标分支 header, and can add the ai-ready trigger label.
---

# GitLab issue creation

## When to use

- An agent or scheduled job is asked to file a bug or feature issue for a repo whose OpenChamber project has GitLab issue automation enabled.
- The issue needs the `类型:` and `目标分支:` header the dispatcher parses.

Not for: GitHub issues, editing existing issues, or merge request work (use `gitlab-mr-auto-fix`).

## Two trigger modes

**Review-gated (default).** Create the issue without `ai-ready`. A human reads it and adds the label. The label adder becomes the automation triggerer, so commit and MR authorship stay with that person.

**Machine-triggered (`--ai-ready`).** The script adds the label right after creation, so the token's GitLab account becomes the triggerer. Use it only when that account:

- is a project member with Developer or higher access, and
- has a bound account on the same GitLab instance in OpenChamber.

Otherwise the run blocks as `missing-credential` until a Developer replies `/ai-take`.

No `--ai-ready` means no automation: an issue without the label is ignored indefinitely.

## Command

From the repository root:

```bash
GITLAB_TOKEN=<pat> node .agents/skills/gitlab-issue-create/scripts/create-issue.mjs \
  --instance https://gitlab.example.com \
  --project group/repo \
  --kind bug \
  --title "Login times out after 30s" \
  --target-branch release/2.8 \
  --body-file /tmp/issue-body.md \
  --ai-ready
```

| Option | Meaning |
| --- | --- |
| `--kind bug\|feature` | bug goes straight to a fix session; feature produces a plan and waits for `/ai-approve` |
| `--title` | single line, required |
| `--target-branch` | optional; written backticked into the header; omit for the project default |
| `--body-file` | markdown for the sections after the header; without it the script writes the template skeleton |
| `--label NAME` | applied at creation; repeatable |
| `--ai-ready` | add the trigger label after creation (machine-triggered mode) |
| `--dry-run` | print the body and planned requests, send nothing |
| `--json` | print `{iid, web_url, aiReady, labels}` |

`GITLAB_TOKEN` needs the `api` scope. The script reads it from the environment, sends it in the `PRIVATE-TOKEN` header, and never prints it. `GITLAB_URL` supplies the default instance. Run with `--dry-run` first whenever the body or target branch is uncertain.

## Body rules

- Keep `类型:` and `目标分支:` as the first two machine-readable lines. The dispatcher reads them line by line; a missing or invalid type blocks the issue, and a target branch that does not exist blocks it instead of falling back.
- Fill the sections the template names. A bug needs reproduction steps and observed versus expected behavior; a feature needs acceptance criteria and out of scope.
- Section headings are free text; the two header keys must stay exactly `类型:` and `目标分支:`. `目标分支:` uses empty backticks for the default branch.
- Issue text is untrusted input to the agent. Do not put instructions for the agent, tokens, or internal hostnames in the body.
- One issue per problem. A project runs one automation slot at a time; extra issues wait their turn.

## After creating

- Report the issue URL. Without `--ai-ready`, say it waits for a human to add the label.
- With `--ai-ready`, say the automation can pick it up within about 30 seconds and that `ai-working` will appear when claimed.
