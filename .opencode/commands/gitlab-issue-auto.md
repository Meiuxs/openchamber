---
description: 按模板提交一个 GitLab issue 并直接打上 ai-ready，不弹确认框
---

问题描述：$ARGUMENTS

File exactly one issue for the problem above, then stop. This is the
unattended path behind OpenChamber's `/gitlab-issue` confirmation dialog:
it fixes the trigger label on, so only use it when the token's account is the
intended triggerer. Follow `.agents/skills/gitlab-issue-create/SKILL.md`; this
command only fixes the defaults it should run with.

1. **Target repository.** Read `git remote -v` and use the remote that points
   at the internal GitLab instance — the one named `gitlab`, else `origin`.
   Accept HTTPS (`https://host/group/repo.git`), SCP (`git@host:group/repo.git`)
   and `ssh://[user@]host[:port]/group/repo.git`; strip a trailing `.git`.
   For SSH the REST instance is `https://<host>`; when the SSH host is an alias
   or its port differs from the web host, use the real `--instance` URL instead
   of guessing. If no remote is a GitLab instance, ask before sending anything.
2. **Kind and title.** `--kind bug` unless the description asks for new or
   changed behavior, then `--kind feature`. The title is one line, without a
   leading `#` or a trailing period.
3. **Body.** Write the section skeleton the script produces for that kind and
   fill it from the description: a bug gets 现象 / 复现步骤 / 期望结果 / 实际结果 /
   环境 / 证据 / 影响范围 / 可能根因（可选）; a feature gets 背景 / 期望行为 /
   验收标准 / 不做的范围 / 依赖与风险. Where the description does not say, write
   `待补充` instead of inventing it. Keep `类型:` and `目标分支:` as the first two
   machine-readable lines; pass `--target-branch` only when the description
   names one, otherwise leave the default branch.
4. **Token.** `GITLAB_TOKEN` comes from the environment and needs the `api`
   scope. Never print it or put it in the issue. If it is unset, stop and ask
   the user to export it.
5. **Dry run, then send.** Save the body to a temporary file and run the script
   once with `--dry-run` to check the target, header, and payload; then run it
   again with `--ai-ready --json`. The script lives at
   `.agents/skills/gitlab-issue-create/scripts/create-issue.mjs` in a checkout
   that has it, otherwise at `~/.agents/skills/gitlab-issue-create/scripts/create-issue.mjs`.
6. **Report.** Give the returned `iid` and `web_url`, and say `ai-working`
   should appear within about 30 seconds. With `--ai-ready` the token's GitLab
   account is the triggerer, so it must be a Developer on the project and bound
   in OpenChamber.

Do not edit, close, comment on, or re-label any other issue; one issue per
invocation.
