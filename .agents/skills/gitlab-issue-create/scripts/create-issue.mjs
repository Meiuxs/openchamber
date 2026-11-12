/**
 * Create a GitLab issue for OpenChamber's GitLab issue automation.
 *
 * The body starts with the two machine-readable lines the dispatcher parses:
 *
 *   类型: bug|feature
 *   目标分支: `release/2.8`   (empty backticks mean the project default)
 *
 * The token is read from GITLAB_TOKEN and never printed. Use --dry-run to
 * inspect the exact body and requests without calling the API.
 */

import { readFile } from 'node:fs/promises';

const USAGE = `Usage:
  GITLAB_TOKEN=<pat> node create-issue.mjs \\
    --instance https://gitlab.example.com --project group/repo \\
    --kind bug|feature --title "..." \\
    [--target-branch release/2.8] [--body-file issue.md] \\
    [--label need-triage] [--ai-ready] [--dry-run] [--json]

Environment:
  GITLAB_TOKEN   personal access token with the api scope (required unless --dry-run)
  GITLAB_URL     default for --instance

Options:
  --ai-ready     after creating the issue, add the ai-ready label so the
                 token's account becomes the automation triggerer
  --label NAME   label to apply at creation; repeatable
  --dry-run      print the body and planned requests, send nothing
  --json         print one JSON object instead of a sentence`;

const KINDS = new Set(['bug', 'feature']);

const SECTIONS = {
  bug: ['现象', '复现步骤', '期望结果', '实际结果', '环境', '证据', '影响范围', '可能根因（可选）'],
  feature: ['背景', '期望行为', '验收标准', '不做的范围', '依赖与风险'],
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const parsed = { labels: [], aiReady: false, dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === '--instance') parsed.instance = value();
    else if (arg === '--project') parsed.project = value();
    else if (arg === '--kind') parsed.kind = value();
    else if (arg === '--title') parsed.title = value();
    else if (arg === '--target-branch') parsed.targetBranch = value();
    else if (arg === '--body-file') parsed.bodyFile = value();
    else if (arg === '--label') parsed.labels.push(value());
    else if (arg === '--ai-ready') parsed.aiReady = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else fail(`Unknown option: ${arg}`);
  }
  return parsed;
};

const normalizeInstance = (raw) => {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('--instance must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || !url.hostname) {
    fail('--instance must be a plain http(s) URL without credentials, query, or fragment');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
};

const singleLine = (name, value) => {
  const text = String(value ?? '').trim();
  if (!text) fail(`${name} is required`);
  if (/[\r\n]/.test(text)) fail(`${name} must be a single line`);
  return text;
};

const validateTargetBranch = (branch) => {
  const text = String(branch ?? '').trim();
  if (!text) return '';
  if (/[\s`~^:?*[\\]/.test(text) || text.startsWith('-') || text.endsWith('/') || text.includes('..')) {
    fail('--target-branch is not a valid Git branch name');
  }
  return text;
};

const buildBody = ({ kind, targetBranch, body }) => {
  const header = [
    '<!-- OpenChamber 自动化读取下面两行，请保留格式；目标分支留空表示项目默认分支。 -->',
    '',
    `类型: ${kind}`,
    '',
    `目标分支: ${targetBranch ? `\`${targetBranch}\`` : '``'}`,
  ].join('\n');
  const content = String(body ?? '').trim();
  if (content) return `${header}\n\n${content}\n`;
  const skeleton = SECTIONS[kind].map((title) => `## ${title}\n`).join('\n');
  return `${header}\n\n${skeleton}`;
};

const request = async ({ api, token, path, method, payload }) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      'PRIVATE-TOKEN': token,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data?.message
      ? (typeof data.message === 'string' ? data.message : JSON.stringify(data.message))
      : text.slice(0, 300);
    fail(`${method} ${path} failed with ${response.status}: ${detail}`);
  }
  return data;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const kind = String(args.kind ?? '').trim();
  if (!KINDS.has(kind)) fail('--kind must be bug or feature');
  const title = singleLine('--title', args.title);
  const targetBranch = validateTargetBranch(args.targetBranch);
  const project = String(args.project ?? '').trim();
  if (!project) fail('--project is required (group/repo or numeric id)');
  const instance = normalizeInstance(args.instance ?? process.env.GITLAB_URL);
  const labels = [...new Set(args.labels.map((label) => singleLine('--label', label)))];

  let body = '';
  if (args.bodyFile) {
    try {
      body = await readFile(args.bodyFile, 'utf8');
    } catch (error) {
      fail(`Cannot read --body-file: ${error?.message || error}`);
    }
  }
  const description = buildBody({ kind, targetBranch, body });
  const projectPath = /^\d+$/.test(project) ? project : encodeURIComponent(project);
  const createPath = `/projects/${projectPath}/issues`;
  const createPayload = {
    title,
    description,
    ...(labels.length ? { labels: labels.join(',') } : {}),
  };

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({
      instance,
      create: { method: 'POST', path: createPath, payload: createPayload },
      addAiReady: args.aiReady ? { method: 'PUT', path: `${createPath}/<iid>`, payload: { add_labels: 'ai-ready' } } : null,
    }, null, 2)}\n`);
    return;
  }

  const token = process.env.GITLAB_TOKEN;
  if (!token) fail('GITLAB_TOKEN is not set');
  const api = `${instance}/api/v4`;
  const issue = await request({ api, token, path: createPath, method: 'POST', payload: createPayload });
  if (!Number.isInteger(issue?.iid)) fail('GitLab did not return an issue iid');

  let aiReady = false;
  if (args.aiReady) {
    try {
      await request({
        api,
        token,
        path: `${createPath}/${issue.iid}`,
        method: 'PUT',
        payload: { add_labels: 'ai-ready' },
      });
      aiReady = true;
    } catch {
      process.stderr.write(
        `issue #${issue.iid} was created but ai-ready could not be added; open ${issue.web_url} and add the label by hand\n`,
      );
      process.exit(2);
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      iid: issue.iid,
      web_url: issue.web_url,
      aiReady,
      labels: [...labels, ...(aiReady ? ['ai-ready'] : [])],
    })}\n`);
    return;
  }
  process.stdout.write(`created #${issue.iid} ${issue.web_url}${aiReady ? ' (ai-ready)' : ''}\n`);
};

main().catch((error) => fail(`Unexpected failure: ${error?.message || error}`));
