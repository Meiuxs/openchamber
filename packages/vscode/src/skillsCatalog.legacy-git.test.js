import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// The extension host imports `vscode` at module load; a stub keeps this in a
// plain Bun process. Every Git command but sparse-checkout runs for real.
mock.module('vscode', () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));

const { installSkillsFromRepository } = await import('./skillsCatalog');

const execFileAsync = promisify(execFile);
const GIT_ENV_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
const savedEnv = {};
let root;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, stdio: 'pipe' });

const realGit = async (args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: options?.timeoutMs ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      message: error.message,
    };
  }
};

const writeSkill = (repoDir, skillDir) => {
  const dir = path.join(repoDir, ...skillDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.posix.basename(skillDir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-skills-install-fixture-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q');
  writeSkill(work, 'skills/alpha');
  writeSkill(work, 'skills/beta');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'skills');
  const bare = path.join(root, 'remote', 'acme', 'skills.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');

  for (const key of GIT_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${new URL(`file://${path.join(root, 'remote')}/`).href}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
});

afterAll(() => {
  for (const key of GIT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VS Code skills install on Git 2.20', () => {
  test('installs the selected skill when sparse-checkout is unavailable', async () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-skills-install-target-'));
    const calls = [];
    const legacyGit = (args, options) => {
      calls.push(args);
      if (args.includes('sparse-checkout')) {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: "git: 'sparse-checkout' is not a git command.",
          message: 'Command failed',
        });
      }
      return realGit(args, options);
    };

    try {
      const result = await installSkillsFromRepository({
        source: 'acme/skills',
        scope: 'project',
        workingDirectory,
        selections: [{ skillDir: 'skills/alpha' }],
        gitRunner: legacyGit,
      });

      expect(result.ok).toBe(true);
      expect(result.installed.map((entry) => entry.skillName)).toEqual(['alpha']);
      expect(fs.readFileSync(path.join(workingDirectory, '.opencode', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
      expect(calls.some((args) => args.includes('core.sparseCheckout=false') && args.includes('checkout'))).toBe(true);
    } finally {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
