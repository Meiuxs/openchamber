#!/usr/bin/env node
// 离线交付包一体化脚本：构建 sdk + web → 打两个 npm tarball → 组装交付 zip
// （含各平台安装脚本与 RELEASE-NOTES.md），可选地装到本机全局并拉起服务，
// 走的是内网机器上 install.ps1 / install.sh 的同一套流程。
//
// 用法:
//   node scripts/offline-package.mjs                    # 构建 + 打包 + 组 zip
//   node scripts/offline-package.mjs --skip-build       # 跳过构建，用当前产物打包
//   node scripts/offline-package.mjs --install          # 再把 tarball 装到全局
//   node scripts/offline-package.mjs --install --start --port 3001
//
// zip 落在仓库根目录 openchamber-intranet-<version>.zip（与其它交付 zip 一样被
// gitignore）。zip 内容:
//   openchamber-sdk-<version>.tgz   @openchamber/sdk，web 的精确依赖
//   openchamber-web-<version>.tgz   @openchamber/web，服务端 + CLI（内含打包好的 SDK）
//   install.ps1 / install.sh        各平台安装脚本（scripts/delivery）
//   INSTALL.txt                     手工安装、配置与启动说明
//   skills/<name>/                  随包安装到 ~/.agents/skills 的 agent skills
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deliveryDir = path.join(repoRoot, 'scripts', 'delivery');
// Agent skills that ship with the offline package. The install scripts copy
// each of these into the user's ~/.agents/skills, where OpenChamber and
// OpenCode discover user-level skills.
const deliveredSkills = ['gitlab-issue-create'];
const skillsRoot = path.join(repoRoot, '.agents', 'skills');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  // 末位缺值，或下一个参数还是选项时，不能把它当成本选项的值。
  return next === undefined || next.startsWith('-') ? fallback : next;
};

const skipBuild = has('--skip-build');
const install = has('--install');
const start = has('--start');
const port = value('--port', null);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// 每步一条 shell 字符串：spawnSync 传 args 数组加 shell:true 只是把它们拼接
// (DEP0190)，而且各平台的命令本来就不一样。
const run = (command, { cwd = repoRoot } = {}) => {
  console.log(`> ${command}`);
  const result = spawnSync(command, { stdio: 'inherit', shell: true, cwd });
  if (result.status !== 0) {
    fail(`命令执行失败，退出码 ${result.status ?? `信号 ${result.signal}`}: ${command}`);
  }
};

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/web/package.json'), 'utf8')).version;
const sdkTgz = path.join(repoRoot, 'packages', 'sdk', `openchamber-sdk-${version}.tgz`);
const webTgz = path.join(repoRoot, 'packages', 'web', `openchamber-web-${version}.tgz`);
console.log(`OpenChamber ${version} 离线交付包`);

if (!skipBuild) {
  // SDK 必须先构建：web 的 prepack 会重建内置扩展，而扩展要对着 SDK 自己的产物校验。
  run('bun run --cwd packages/sdk build');
  run('bun run build:web');
}

// 清掉旧版本的 tarball：tgz 与 zip 同放一个目录，安装脚本靠通配符读版本号，
// 留下上一版本的包会让它取到旧版本并报“缺少安装包”。
const keep = new Map([[sdkTgz, 'openchamber-sdk-'], [webTgz, 'openchamber-web-']]);
for (const [target, prefix] of keep) {
  const dir = path.dirname(target);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix) && name.endsWith('.tgz') && path.join(dir, name) !== target) {
      fs.rmSync(path.join(dir, name));
      console.log(`清理旧交付物: ${path.relative(repoRoot, path.join(dir, name))}`);
    }
  }
}

// bun pm pack 会把 `workspace:*` 依赖改写成 @openchamber/sdk 的精确版本；
// npm pack 会保留 workspace 链接，打出的 tarball 装不上。
// --ignore-scripts 跳过 web 的 prepack：build:web 已经构建过内置扩展，
// 打包阶段不应该再依赖一次重建。
//
// 内网机器上内部 registry 未必收录 @openchamber/sdk，所以打包时显式给 web 声明
// bundledDependencies，让 SDK 以 package/node_modules/@openchamber/sdk 的形式
// 进包（只有声明了才会打进去；不声明时产物取决于源 package.json 的历史状态）。
// 打包后再把两个源 manifest 还原，工作区保持干净。
const webManifestPath = path.join(repoRoot, 'packages/web/package.json');
const packTargets = [path.join(repoRoot, 'packages/sdk/package.json'), webManifestPath];
const beforePack = new Map(packTargets.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const restoreManifests = () => {
  for (const [file, text] of beforePack) {
    if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
};
const restoreAndExit = (code) => {
  restoreManifests();
  process.exit(code);
};
process.on('exit', restoreManifests);
process.once('SIGINT', () => restoreAndExit(130));
process.once('SIGTERM', () => restoreAndExit(143));
const webManifest = JSON.parse(beforePack.get(webManifestPath));
const bundled = Array.isArray(webManifest.bundledDependencies) ? webManifest.bundledDependencies : [];
if (!bundled.includes('@openchamber/sdk')) {
  webManifest.bundledDependencies = [...bundled, '@openchamber/sdk'];
  fs.writeFileSync(webManifestPath, `${JSON.stringify(webManifest, null, 2)}\n`);
}
run('bun pm pack --ignore-scripts --cwd packages/sdk');
run('bun pm pack --ignore-scripts --cwd packages/web');
process.removeListener('exit', restoreManifests);
restoreManifests();
for (const file of [sdkTgz, webTgz]) {
  if (!fs.existsSync(file)) fail(`缺少 tarball：${file}`);
}
// 安装脚本和 INSTALL.txt 都按“web 包自带 SDK”来写，这里验一下，免得产物退回
// 依赖 registry 解析 SDK 的状态却没人发现。
// Windows 上不能把 D:\... 直接交给 tar：盘符里的冒号会被当成远程主机名。
// 在 tarball 所在目录下用文件名调用，两个平台都能用。
const webTarballList = spawnSync('tar', ['-tzf', path.basename(webTgz)], {
  cwd: path.dirname(webTgz), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (webTarballList.status !== 0) {
  fail(`无法列出 web tarball 内容（需要 tar）：${webTarballList.error?.message ?? webTarballList.stderr}`);
}
if (!webTarballList.stdout.includes('package/node_modules/@openchamber/sdk/package.json')) {
  fail('web tarball 里没有 @openchamber/sdk，离线安装会去 registry 解析 SDK；请检查 packages/web/package.json 的 bundledDependencies。');
}

const zipPath = path.join(repoRoot, `openchamber-intranet-${version}.zip`);
// 先写到临时名，最后一步才替换目标文件：目标 zip 若正被归档工具打开，
// Windows 上删不掉也覆盖不了，此时已完成的包仍留在临时名里，不会白跑一遍。
// Compress-Archive 只接受 .zip 后缀，临时名同样要用 .zip。
const tmpZipPath = path.join(repoRoot, `openchamber-intranet-${version}-tmp.zip`);
if (fs.existsSync(tmpZipPath)) fs.rmSync(tmpZipPath);

for (const name of deliveredSkills) {
  if (!fs.existsSync(path.join(skillsRoot, name, 'SKILL.md'))) {
    fail(`缺少随包 skill：.agents/skills/${name}/SKILL.md`);
  }
}
// 组装目录：zip 要同时收文件和 skills 目录，flat 的 -j / 逐个 Path 列不够用。
const stagingDir = path.join(repoRoot, `openchamber-intranet-${version}-staging`);
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stagingDir, 'skills'), { recursive: true });
const deliveryFiles = ['install.ps1', 'install.sh', 'INSTALL.txt', 'RELEASE-NOTES.md', 'policy.example.json'];
for (const name of deliveryFiles) {
  fs.copyFileSync(path.join(deliveryDir, name), path.join(stagingDir, name));
}
for (const tgz of [sdkTgz, webTgz]) {
  fs.copyFileSync(tgz, path.join(stagingDir, path.basename(tgz)));
}
for (const name of deliveredSkills) {
  fs.cpSync(path.join(skillsRoot, name), path.join(stagingDir, 'skills', name), { recursive: true });
}
// 安装脚本只按这份清单装 skill；仓库 .agents/skills 下的其它开发技能不会进包，
// 也不会因为将来有人往 skills/ 里多放目录而被顺手装到用户机器上。
fs.writeFileSync(
  path.join(stagingDir, 'skills', 'manifest.json'),
  `${JSON.stringify({ skills: deliveredSkills }, null, 2)}\n`,
);
try {
  if (process.platform === 'win32') {
    run(`powershell -NoProfile -Command "Compress-Archive -Path '${path.join(stagingDir, '*')}' -DestinationPath '${tmpZipPath}' -Force"`);
  } else {
    if (!toolExists('zip')) fail('未找到 zip 命令，无法组装交付包；请先安装（Debian/UOS: apt install zip）后重跑。');
    const inputs = fs.readdirSync(stagingDir);
    run(`zip -r ${quote(tmpZipPath)} ${inputs.map(quote).join(' ')}`, { cwd: stagingDir });
  }
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  fs.renameSync(tmpZipPath, zipPath);
} catch (error) {
  if (error.code === 'EBUSY' || error.code === 'EPERM') {
    fail([
      `交付包已完成，但旧 zip 被其他程序占用，无法替换（${error.code}）：${zipPath}`,
      `新的交付包在：${tmpZipPath}`,
      '请关闭正在预览该压缩包的窗口（归档工具、文件管理器等），重跑本脚本，或手工把上面的 .tmp 改名为 .zip。',
    ].join('\n'));
  }
  throw error;
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
console.log(`交付 zip：${zipPath}（${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB）`);

if (install) {
  // 与 install.ps1 / install.sh 同样的顺序。web tarball 自带 SDK，npm 会用包内
  // 那份；先装 SDK 只是让内部 registry 缺 @openchamber/sdk 时也有兜底，
  // --prefer-offline 对缓存里旧 packument 缺新版本（ETARGET）时回退常规安装。
  run(`npm install -g ${quote(sdkTgz)}`);
  const preferOffline = spawnSync(`npm install -g --prefer-offline ${quote(webTgz)}`, {
    stdio: 'inherit', shell: true, cwd: repoRoot,
  });
  if (preferOffline.status !== 0) {
    console.warn('缓存优先安装失败，改用常规 npm 安装...');
    run(`npm install -g ${quote(webTgz)}`);
  }
  // 与 install.ps1 / install.sh 一样，把随包 skill 放到用户级 skill 目录。
  const skillsTarget = path.join(os.homedir(), '.agents', 'skills');
  for (const name of deliveredSkills) {
    const dest = path.join(skillsTarget, name);
    fs.mkdirSync(skillsTarget, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(skillsRoot, name), dest, { recursive: true });
    console.log(`已安装 skill：${dest}`);
  }
}

if (start) {
  const cmd = port ? `openchamber --port ${port}` : 'openchamber';
  const child = spawn(cmd, { detached: true, stdio: 'ignore', shell: true });
  child.unref();
  console.log(`已在后台启动 OpenChamber（pid ${child.pid}，端口 ${port ?? '3000'}）；打开 http://localhost:${port ?? '3000'}`);
} else if (install) {
  console.log('安装完成。启动：openchamber（或加 --start --port 3001 由本脚本拉起）');
}

function toolExists(name) {
  const probe = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  return spawnSync(probe, { shell: true, stdio: 'ignore' }).status === 0;
}

// 交给 shell 的路径统一加引号，仓库路径含空格时不会被打散。
// Windows 走 cmd.exe，单引号不算引号，必须用双引号。
function quote(input) {
  return process.platform === 'win32' ? `"${input}"` : `'${input}'`;
}
