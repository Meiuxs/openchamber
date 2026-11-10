import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runGit } from './git.js';
import { installSkillsFromRepository } from './install.js';

const GIT_ENV_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
const savedEnv = {};
let root;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, stdio: 'pipe' });

const writeSkill = (repoDir, skillDir) => {
  const dir = path.join(repoDir, ...skillDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.posix.basename(skillDir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'extra file\n');
};

// A local bare repository stands in for github.com/acme/skills, the same way
// scan.test.js does: Git rewrites the clone URL through the environment and a
// partial clone fetches its blobs from it.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-install-fixture-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q');
  for (const skillDir of ['skills/alpha', 'skills/beta']) writeSkill(work, skillDir);
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

describe('installSkillsFromRepository on Git 2.20', () => {
  it('installs the selected skill after sparse-checkout is unavailable', async () => {
    const userSkillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-install-target-'));
    const calls = [];
    // Git 2.20 answers `sparse-checkout` with "not a git command"; every other
    // command runs against the real local repository.
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
      return runGit(args, options);
    };

    try {
      const result = await installSkillsFromRepository({
        source: 'acme/skills',
        scope: 'user',
        userSkillDir,
        selections: [{ skillDir: 'skills/alpha' }],
        gitRunner: legacyGit,
      });

      expect(result.ok).toBe(true);
      expect(result.installed.map((entry) => entry.skillName)).toEqual(['alpha']);
      expect(fs.readFileSync(path.join(userSkillDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
      expect(fs.readFileSync(path.join(userSkillDir, 'alpha', 'notes.md'), 'utf8')).toContain('extra file');
      expect(calls.some((args) => args.includes('core.sparseCheckout=false') && args.includes('checkout'))).toBe(true);
    } finally {
      fs.rmSync(userSkillDir, { recursive: true, force: true });
    }
  });

  it('clears a sparse checkout that init enabled but set could not finish', async () => {
    const userSkillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-install-target-'));
    const calls = [];
    // init really enables sparse checkout; only set fails. Without the -c on
    // the checkout below, the enabled sparse rules hide the selected skill.
    const partialSparseGit = (args, options) => {
      calls.push(args);
      if (args.includes('sparse-checkout') && args.includes('set')) {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: 'fatal: unable to write sparse-checkout',
          message: 'Command failed',
        });
      }
      return runGit(args, options);
    };

    try {
      const result = await installSkillsFromRepository({
        source: 'acme/skills',
        scope: 'user',
        userSkillDir,
        selections: [{ skillDir: 'skills/alpha' }],
        gitRunner: partialSparseGit,
      });

      expect(result.ok).toBe(true);
      expect(result.installed.map((entry) => entry.skillName)).toEqual(['alpha']);
      expect(fs.readFileSync(path.join(userSkillDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
      expect(calls.some((args) => args.includes('core.sparseCheckout=false') && args.includes('checkout'))).toBe(true);
    } finally {
      fs.rmSync(userSkillDir, { recursive: true, force: true });
    }
  });
});
