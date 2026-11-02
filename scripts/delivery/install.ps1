#Requires -Version 5.1
<#
.SYNOPSIS
  OpenChamber 2.5.3 intranet installer / updater.

.DESCRIPTION
  Installs the two npm tarballs shipped next to this script, prepares the
  configuration files, prints the 2.5.3 release notes and the service start
  commands. Re-running this script over an existing installation updates it
  in place (same flow for first install and update).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Registry http://npm.internal:4873
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Organization Contoso -NpmRegistry http://npm.internal:4873
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -UiPassword s3cret -Port 3000
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
param(
  # Internal npm registry hosting both packages; omit to install offline from the bundled tarballs.
  [string]$Registry,
  # Organization-provided policy.json copied into C:\ProgramData\OpenChamber\policy.json (admin needed).
  [string]$PolicyFile,
  # Writes a minimal enterprise policy (enterpriseMode + organization) into the machine policy file.
  [string]$Organization,
  # Intranet npm mirror; pinned via the policy file and the OPENCHAMBER_NPM_REGISTRY user variable.
  [string]$NpmRegistry,
  # Persistent user environment: OPENCHAMBER_PORT.
  [int]$Port,
  # Persistent user environment: OPENCHAMBER_UI_PASSWORD (stored as plain text for this Windows account).
  [string]$UiPassword,
  # Persistent user environment: OPENCODE_HOST / OPENCODE_PORT (external OpenCode server).
  [string]$OpenCodeHost,
  [int]$OpenCodePort,
  # Launch the server in a new window after installing.
  [switch]$Start,
  # Print what would happen without changing anything.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# The version comes from the bundled SDK tarball, so a new release zip needs no script edit.
$sdkTgzFile = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'openchamber-sdk-*.tgz' | Select-Object -First 1
if (-not $sdkTgzFile) { throw '找不到 openchamber-sdk-*.tgz，请确认脚本与 tgz 在同一目录。' }
$Version = $sdkTgzFile.Name -replace '^openchamber-sdk-', '' -replace '\.tgz$', ''
$SdkTgz = $sdkTgzFile.FullName
$WebTgz = Join-Path $PSScriptRoot "openchamber-web-$Version.tgz"
$PolicyDir = 'C:\ProgramData\OpenChamber'
$PolicyPath = Join-Path $PolicyDir 'policy.json'

function Write-Title([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Invoke-Npm {
  param([string[]]$NpmArgs, [string]$Label)
  $cmd = "npm " + ($NpmArgs -join ' ')
  if ($DryRun) { Write-Host "  [dry-run] $cmd"; return }
  Write-Host "  > $cmd"
  & npm @NpmArgs
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (npm exit $LASTEXITCODE)" }
}
function Set-UserEnv([string]$Name, [string]$Value) {
  if ($DryRun) { Write-Host "  [dry-run] setx $Name (user)"; return }
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  Set-Item -LiteralPath "env:$Name" -Value $Value
  Write-Host "  $Name = $Value 已写入用户环境变量"
}

Write-Title "OpenChamber $Version 内网安装/更新"

# --- Prerequisites ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未找到 Node.js，请先安装 Node.js 24.14.0 或更高版本。' }
$nodeVersion = [version]((& node -v) -replace '^v', '')
if ($nodeVersion -lt [version]'24.14.0') { throw "需要 Node.js >= 24.14.0，当前为 $nodeVersion。" }
Write-Host "Node.js $nodeVersion 检查通过"

foreach ($tgz in @($SdkTgz, $WebTgz)) {
  if (-not (Test-Path -LiteralPath $tgz)) { throw "缺少安装包：$tgz（请确认脚本与 tgz 在同一目录）" }
}
$existing = Get-Command openchamber -ErrorAction SilentlyContinue
if ($existing) { Write-Host "检测到已安装的 OpenChamber，本脚本将原地更新到 $Version" }
else { Write-Host '未检测到已有安装，执行全新安装' }

# --- Install / update the packages ----------------------------------------
Write-Title '安装 npm 包'
if ($Registry) {
  Invoke-Npm @('install', '-g', '--registry', $Registry, $SdkTgz, $WebTgz) '从内部 registry 安装'
}
else {
  # The SDK tarball install seeds the npm cache, so the web package resolves
  # its exact "@openchamber/sdk": "2.5.3" from cache first; --prefer-offline
  # still reaches the registry for dependencies the cache does not hold
  # (--offline would die with ENOTCACHED on any machine without a mirror).
  Invoke-Npm @('install', '-g', $SdkTgz) '安装 SDK 包（写入 npm 缓存）'
  try {
    Invoke-Npm @('install', '-g', '--prefer-offline', $WebTgz) '安装 OpenChamber（缓存优先）'
  }
  catch {
    Write-Warning '缓存优先安装失败，改用常规 npm 安装（需要可用的 registry）...'
    Invoke-Npm @('install', '-g', $WebTgz) '常规安装 OpenChamber'
  }
}

# --- SDK hygiene ------------------------------------------------------------
# A stale SDK copy nested inside the web package (an old cached tarball npm
# resolved earlier) shadows the fresh global one and breaks its imports.
Write-Title 'SDK 校验'
$globalRoot = if ($DryRun) { '<npm-global-root>' } else { (& npm root -g) }
$nestedSdk = Join-Path $globalRoot '@openchamber\web\node_modules\@openchamber\sdk'
if ($DryRun) {
  Write-Host "  [dry-run] 检查 $nestedSdk，存在则删除"
}
elseif (Test-Path -LiteralPath $nestedSdk) {
  Remove-Item -Recurse -Force -LiteralPath $nestedSdk
  Write-Host '  已删除 web 包内嵌套的旧版 @openchamber/sdk（它会遮蔽全局新版）'
}
else {
  Write-Host '  无嵌套旧版 SDK'
}
if (-not $DryRun) {
  $sdkPackageJson = Join-Path $globalRoot '@openchamber\sdk\package.json'
  if (Test-Path -LiteralPath $sdkPackageJson) {
    $installedVersion = (Get-Content -LiteralPath $sdkPackageJson -Raw | ConvertFrom-Json).version
    if ($installedVersion -ne $Version) {
      Write-Warning "全局 @openchamber/sdk 版本为 $installedVersion，预期 $Version；请删除 $globalRoot\@openchamber 后重跑本脚本。"
    }
    else {
      Write-Host "  全局 SDK 版本 $installedVersion 正确"
    }
  }
}

# --- Data directory --------------------------------------------------------
Write-Title '数据目录'
$dataDir = if ($env:OPENCHAMBER_DATA_DIR) { $env:OPENCHAMBER_DATA_DIR } else { Join-Path $env:USERPROFILE '.config\openchamber' }
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
Write-Host "数据目录：$dataDir"
Write-Host '  settings.json（应用设置）由服务首次启动时自动写入，无需手工创建；'
Write-Host '  extensions\（已安装插件）、secrets\、remote-clients.json 由服务按需创建。'

# --- Machine policy file (intranet / enterprise lockdown) ------------------
Write-Title '策略文件 policy.json'
$writePolicy = $null
if ($PolicyFile) {
  if (-not (Test-Path -LiteralPath $PolicyFile)) { throw "找不到策略文件：$PolicyFile" }
  $writePolicy = Get-Content -LiteralPath $PolicyFile -Raw
  Write-Host "使用指定策略文件：$PolicyFile"
}
elseif ($Organization -or $NpmRegistry) {
  $policy = [ordered]@{}
  if ($Organization) { $policy.enterpriseMode = $true; $policy.organization = $Organization }
  if ($NpmRegistry) { $policy.npmRegistry = $NpmRegistry }
  $writePolicy = ($policy | ConvertTo-Json)
}
if ($writePolicy) {
  if ($DryRun) {
    Write-Host "  [dry-run] 写入 $PolicyPath ："
    Write-Host $writePolicy
  }
  else {
    try {
      New-Item -ItemType Directory -Force -Path $PolicyDir | Out-Null
      Set-Content -LiteralPath $PolicyPath -Value $writePolicy -Encoding UTF8
      Write-Host "策略文件已写入：$PolicyPath"
      Write-Host '  策略文件每次使用时重新读取，修改后无需重启；内容损坏时按"全部关闭"处理。'
    }
    catch {
      Write-Warning "写入 $PolicyPath 失败（需要管理员权限）。请手工放置该文件后重跑本脚本。"
      Write-Host $writePolicy
    }
  }
}
else {
  Write-Host "未指定 -Organization / -NpmRegistry / -PolicyFile，跳过。当前策略文件：$PolicyPath"
}

# --- Persistent environment variables --------------------------------------
if ($Port -or $UiPassword -or $OpenCodeHost -or $OpenCodePort -or $NpmRegistry) {
  Write-Title '环境变量（用户级持久化）'
  if ($Port) { Set-UserEnv 'OPENCHAMBER_PORT' "$Port" }
  if ($NpmRegistry) { Set-UserEnv 'OPENCHAMBER_NPM_REGISTRY' $NpmRegistry }
  if ($OpenCodeHost) { Set-UserEnv 'OPENCODE_HOST' $OpenCodeHost }
  if ($OpenCodePort) { Set-UserEnv 'OPENCODE_PORT' "$OpenCodePort" }
  if ($UiPassword) {
    Write-Host '  注意：OPENCHAMBER_UI_PASSWORD 以明文保存在当前 Windows 账户的环境变量中。'
    Write-Host '  如不希望落盘，请去掉 -UiPassword，改在启动命令里使用 --ui-password。'
    Set-UserEnv 'OPENCHAMBER_UI_PASSWORD' $UiPassword
  }
}

# --- Release notes ---------------------------------------------------------
$releaseNotes = Join-Path $PSScriptRoot 'RELEASE-NOTES.md'
if (Test-Path -LiteralPath $releaseNotes) {
  Write-Title "更新内容（$($(Get-Date -Format 'yyyy-MM-dd')) 打包）"
  Get-Content -LiteralPath $releaseNotes -Encoding UTF8 | Write-Host
}

# --- Start commands --------------------------------------------------------
Write-Title '启动命令'
Write-Host '  openchamber                                                   # 默认 3000 端口，仅本机访问'
Write-Host '  openchamber serve --lan --port 3000 --ui-password <密码>      # 局域网访问（必须设密码）'
Write-Host '  OPENCODE_HOST=https://host:4096 OPENCODE_SKIP_START=true openchamber   # 连接外部 OpenCode'
Write-Host '  openchamber --help                                            # 全部选项'
Write-Host ''
Write-Host '  后续更新：新版本 zip 解开后重跑本 install.ps1 即可原地更新；'
Write-Host '  配好内部 registry 后也可直接执行 openchamber update。'
Write-Host ''
Write-Host '  重要：更新后必须重启 OpenChamber 服务，旧进程仍运行旧代码' 
Write-Host '  （否则新功能如本地议题会"消失"，重启即恢复）。'

if ($Start) {
  if ($DryRun) { Write-Host '[dry-run] 将在新窗口启动 openchamber'; return }
  $startArgs = @('/k', 'openchamber')
  if ($Port) { $startArgs += @('--port', "$Port") }
  Start-Process -FilePath 'cmd.exe' -ArgumentList $startArgs
  $listenPort = if ($Port) { $Port } else { 3000 }
  Write-Host "已在新的命令行窗口启动 OpenChamber（端口 $listenPort）。"
}
