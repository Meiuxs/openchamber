#Requires -Version 5.1
<#
.SYNOPSIS
  OpenChamber 内网安装 / 更新脚本（Windows）。

.DESCRIPTION
  安装与本脚本同目录的两个 npm tarball，准备配置文件，打印更新内容
  （RELEASE-NOTES.md）和服务启动命令。全程以当前用户身份运行，不需要管理员权限。
  对已有安装重复执行即为原地更新，首次安装和更新走同一条路径。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Registry http://npm.internal:4873
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Organization Contoso -NpmRegistry http://npm.internal:4873
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -UiPassword s3cret -Port 3000
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
param(
  # 托管两个包的内部 npm registry；省略则用随包 tarball 离线安装。
  [string]$Registry,
  # 把组织提供的 policy.json 复制到策略路径（默认写入用户数据目录，无需管理员权限）。
  [string]$PolicyFile,
  # 往策略文件写入最小企业策略（enterpriseMode + organization）。
  [string]$Organization,
  # 内网 npm 镜像；通过策略文件和 OPENCHAMBER_NPM_REGISTRY 用户变量固定。
  [string]$NpmRegistry,
  # 持久化用户环境变量：OPENCHAMBER_PORT。
  [int]$Port,
  # 持久化用户环境变量：OPENCHAMBER_UI_PASSWORD（以明文存在当前 Windows 账户下）。
  [string]$UiPassword,
  # 持久化用户环境变量：OPENCODE_HOST / OPENCODE_PORT（外部 OpenCode 服务）。
  [string]$OpenCodeHost,
  [int]$OpenCodePort,
  # 安装完成后在新窗口拉起服务。
  [switch]$Start,
  # 只打印将要发生的动作，不做任何修改。
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 版本号取自随包的 SDK tarball，所以新版本 zip 不需要改脚本。
# 预发布版本（2.7.0-canary.1）[version] 解析不了，排序只看数字主体，
# 完整版本号仍从文件名原样取。
function Get-VersionCore([string]$Name) {
  $raw = $Name -replace '^openchamber-sdk-', ''
  $parsed = $null
  if ([version]::TryParse(($raw -split '-')[0], [ref]$parsed)) { return $parsed }
  return $null
}
$sdkCandidates = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'openchamber-sdk-*.tgz' |
  Where-Object { Get-VersionCore $_.BaseName } |
  Sort-Object { Get-VersionCore $_.BaseName } -Descending)
$sdkTgzFile = $sdkCandidates | Select-Object -First 1
if (-not $sdkTgzFile) { throw '找不到版本号可识别的 openchamber-sdk-*.tgz，请确认脚本与 tgz 在同一目录。' }
$Version = $sdkTgzFile.Name -replace '^openchamber-sdk-', '' -replace '\.tgz$', ''
$SdkTgz = $sdkTgzFile.FullName
$WebTgz = Join-Path $PSScriptRoot "openchamber-web-$Version.tgz"
$dataDir = if ($env:OPENCHAMBER_DATA_DIR) { $env:OPENCHAMBER_DATA_DIR } else { Join-Path $env:USERPROFILE '.config\openchamber' }
$PolicyDir = $dataDir
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
function Test-WritableDirectory([string]$Path) {
  # 目录尚不存在时 npm 会自行创建；判断最近的已存在祖先能不能写。
  $probe = $Path
  while ($probe -and -not (Test-Path -LiteralPath $probe)) {
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { return $false }
    $probe = $parent
  }
  if (-not $probe) { return $false }
  $tmp = Join-Path $probe ('.openchamber-write-test-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType File -Path $tmp -ErrorAction Stop | Out-Null
    Remove-Item -LiteralPath $tmp -Force -ErrorAction Stop
    return $true
  }
  catch { return $false }
}
function Add-UserPath([string]$Dir) {
  # 本会话先加上，保证本次 -Start 拉起服务时能找到 openchamber。
  if (@($env:PATH -split ';') -notcontains $Dir) { $env:PATH = $Dir + ';' + $env:PATH }
  # 只改当前用户的 PATH，保留原有条目和值的注册表类型（ExpandString 里可能含 %TOKEN%）。
  $current = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($current -and @($current -split ';') -contains $Dir) { return }
  $newPath = if ($current) { $Dir + ';' + $current.TrimEnd(';') } else { $Dir }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if ($null -ne $key) {
    try {
      try { $kind = $key.GetValueKind('PATH') }
      catch { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('PATH', $newPath, $kind)
    }
    finally { $key.Close() }
  }
  else {
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
  }
  Write-Host "  PATH 已加入 $Dir（用户级，无需管理员）"
}

Write-Title "OpenChamber $Version 内网安装/更新"

# --- 前置检查 ---------------------------------------------------------------
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

# --- npm 全局前缀：只复用已有的用户级 npm 目录，不改任何 npm 配置 -------------
# 目标机器本来就有用户级 npm 全局目录。即使 prefix 被指向 C:\Program Files\nodejs
# 这类系统目录，也只用 NPM_CONFIG_PREFIX 在本次会话临时指过去：不写 .npmrc、
# 不重建已有目录，不需要管理员。
if ($DryRun) {
  $globalRoot = '<npm-global-root>'
}
else {
  $globalRoot = (& npm root -g)
  if ($LASTEXITCODE -ne 0 -or -not $globalRoot) {
    throw "无法确定 npm 全局目录：npm root -g 失败（exit $LASTEXITCODE）。请确认 npm 可用后重跑本脚本。"
  }
  # npm 可能在前几行打印警告，全局目录是最后一行。
  $globalRoot = ($globalRoot | Select-Object -Last 1).Trim()
  if (-not (Test-WritableDirectory $globalRoot)) {
    $userPrefix = Join-Path $env:APPDATA 'npm'
    if (-not (Test-Path -LiteralPath $userPrefix)) {
      New-Item -ItemType Directory -Force -Path $userPrefix | Out-Null
      Write-Host "用户级 npm 目录不存在，已创建空目录：$userPrefix"
    }
    $env:NPM_CONFIG_PREFIX = $userPrefix
    $globalRoot = ((& npm root -g) | Select-Object -Last 1).Trim()
    Write-Host "npm 全局目录不可写，本次安装复用已有的用户级 npm 目录：$userPrefix（无需管理员，不修改 npm 配置）" -ForegroundColor Yellow
    # Windows 的全局命令直接放在 prefix 目录本身；只在 PATH 里确实缺失时才补写用户 PATH。
    if (@($env:PATH -split ';') -notcontains $userPrefix) {
      Add-UserPath $userPrefix
    }
    else {
      Write-Host "  $userPrefix 已在 PATH，未改动任何配置文件。"
    }
  }
}

# --- 安装 / 更新 -----------------------------------------------------------
Write-Title '安装 npm 包'
if ($Registry) {
  Invoke-Npm @('install', '-g', '--registry', $Registry, $SdkTgz, $WebTgz) '从内部 registry 安装'
}
else {
  # 先装 SDK tarball 把 npm 缓存喂上，web 包的精确 "@openchamber/sdk" 依赖
  # 就能先从缓存解析；--prefer-offline 对缓存里没有的其他依赖仍会走 registry
  # （直接 --offline 在任何没有镜像的机器上都会 ENOTCACHED 失败）。
  Invoke-Npm @('install', '-g', $SdkTgz) '安装 SDK 包（写入 npm 缓存）'
  try {
    Invoke-Npm @('install', '-g', '--prefer-offline', $WebTgz) '安装 OpenChamber（缓存优先）'
  }
  catch {
    Write-Warning '缓存优先安装失败，改用常规 npm 安装（需要可用的 registry）...'
    Invoke-Npm @('install', '-g', $WebTgz) '常规安装 OpenChamber'
  }
}

# --- SDK 校验 --------------------------------------------------------------
# web tarball 现在把 SDK 一起打进了 package/node_modules/@openchamber/sdk。
# 这份嵌套副本是内网机器上最可靠的来源：内部 registry 未必收录 @openchamber/sdk，
# 删掉它反而会让服务启动时报 "Cannot find package '@openchamber/sdk'"。
# 因此只在版本不匹配（上一次安装残留的旧副本）时删除，并交给重装修复。
Write-Title 'SDK 校验'
$nestedSdk = Join-Path $globalRoot '@openchamber\web\node_modules\@openchamber\sdk'
$nestedPackageJson = Join-Path $nestedSdk 'package.json'
$nestedVersion = if (-not $DryRun -and (Test-Path -LiteralPath $nestedPackageJson)) {
  (Get-Content -LiteralPath $nestedPackageJson -Raw | ConvertFrom-Json).version
} else { $null }
if ($DryRun) {
  Write-Host "  [dry-run] 检查 $nestedSdk：版本等于 $Version 则保留，否则删除"
}
elseif ($nestedVersion -eq $Version) {
  Write-Host "  web 包内自带 @openchamber/sdk $nestedVersion，保留（离线可用）"
}
elseif ($nestedVersion) {
  Remove-Item -Recurse -Force -LiteralPath $nestedSdk
  Write-Warning "已删除 web 包内版本不符的 @openchamber/sdk（$nestedVersion，应为 $Version）；请重跑本脚本重装，让 npm 放回正确版本。"
}
else {
  $sdkPackageJson = Join-Path $globalRoot '@openchamber\sdk\package.json'
  if (Test-Path -LiteralPath $sdkPackageJson) {
    $installedVersion = (Get-Content -LiteralPath $sdkPackageJson -Raw | ConvertFrom-Json).version
    if ($installedVersion -eq $Version) {
      Write-Host "  使用全局 @openchamber/sdk $installedVersion"
    }
    else {
      Write-Warning "全局 @openchamber/sdk 版本为 $installedVersion，预期 $Version；请删除 $globalRoot\@openchamber 后重跑本脚本。"
    }
  }
  else {
    Write-Warning '既没有 web 包内副本，也没有全局 @openchamber/sdk；服务无法启动。请重跑本脚本重装。'
  }
}

# --- 数据目录 --------------------------------------------------------------
Write-Title '数据目录'
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
Write-Host "数据目录：$dataDir"
Write-Host '  settings.json（应用设置）由服务首次启动时自动写入，无需手工创建；'
Write-Host '  extensions\（已安装插件）、secrets\、remote-clients.json 由服务按需创建。'

# --- 策略文件 policy.json（用户级内网 / 企业配置，无需管理员权限） ----------
Write-Title '策略文件 policy.json'
$exampleFile = Join-Path $PSScriptRoot 'policy.example.json'
if ((Test-Path -LiteralPath $exampleFile) -and (-not $DryRun)) {
  try {
    Copy-Item -LiteralPath $exampleFile -Destination (Join-Path $PolicyDir 'policy.example.json') -Force
    Write-Host "已更新策略样例参考文件：$(Join-Path $PolicyDir 'policy.example.json')"
  }
  catch {
    Write-Warning "复制 policy.example.json 失败：$($_.Exception.Message)"
  }
}

$writePolicy = $null
$isDefaultCreated = $false

if ($PolicyFile) {
  if (-not (Test-Path -LiteralPath $PolicyFile)) { throw "找不到策略文件：$PolicyFile" }
  $writePolicy = Get-Content -LiteralPath $PolicyFile -Raw
  Write-Host "使用指定策略文件：$PolicyFile"
}
elseif ($Organization -or $NpmRegistry) {
  if (Test-Path -LiteralPath $exampleFile) {
    $policyObj = Get-Content -LiteralPath $exampleFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Organization) { $policyObj.enterpriseMode = $true; $policyObj.organization = $Organization }
    if ($NpmRegistry) { $policyObj.npmRegistry = $NpmRegistry }
    $writePolicy = ($policyObj | ConvertTo-Json -Depth 10)
  }
  else {
    $policy = [ordered]@{}
    if ($Organization) { $policy.enterpriseMode = $true; $policy.organization = $Organization }
    if ($NpmRegistry) { $policy.npmRegistry = $NpmRegistry }
    $writePolicy = ($policy | ConvertTo-Json)
  }
}
elseif (-not (Test-Path -LiteralPath $PolicyPath)) {
  if (Test-Path -LiteralPath $exampleFile) {
    $writePolicy = Get-Content -LiteralPath $exampleFile -Raw -Encoding UTF8
    $isDefaultCreated = $true
  }
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
      if ($isDefaultCreated) {
        Write-Host "已自动创建默认内网策略文件（带完整字段注释）：$PolicyPath" -ForegroundColor Yellow
        Write-Host '  >> 提示：当前默认已开启【企业模式】。文件内已预留内网 npm、Git、模型元数据等配置项说明，请根据实际内网环境修改。' -ForegroundColor Yellow
      }
      else {
        Write-Host "策略文件已写入：$PolicyPath"
      }
      Write-Host '  策略文件每次使用时重新读取，修改后无需重启；内容损坏时按"全部关闭"处理。'
    }
    catch {
      Write-Warning "写入 $PolicyPath 失败：$($_.Exception.Message)。请手工放置该文件后重跑本脚本。"
      Write-Host $writePolicy
    }
  }
}
else {
  Write-Host "策略文件已存在（保持原有配置不覆盖）：$PolicyPath" -ForegroundColor Green
  Write-Host "  如需参考最新完整字段与说明，可查阅：$(Join-Path $PolicyDir 'policy.example.json')"
}

# --- 持久化环境变量 ----------------------------------------------------------
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

# --- 更新内容 --------------------------------------------------------------
$releaseNotes = Join-Path $PSScriptRoot 'RELEASE-NOTES.md'
if (Test-Path -LiteralPath $releaseNotes) {
  Write-Title "更新内容（$(Get-Date -Format 'yyyy-MM-dd') 打包）"
  Get-Content -LiteralPath $releaseNotes -Encoding UTF8 | Write-Host
}

# --- 启动命令 --------------------------------------------------------------
Write-Title '启动命令'
Write-Host '  openchamber                                                   # 默认 3000 端口，仅本机访问'
Write-Host '  openchamber serve --lan --port 3000 --ui-password <密码>      # 局域网访问（必须设密码）'
Write-Host '  OPENCODE_HOST=http://host:4096 OPENCODE_SKIP_START=true openchamber   # 连接外部 OpenCode'
Write-Host '  openchamber --help                                            # 全部选项'
Write-Host ''
Write-Host '  开机自启（注册当前用户的登录任务，无需管理员）：openchamber startup enable --port 3000'
Write-Host ''
Write-Host '  后续更新：新版本 zip 解开后重跑本 install.ps1 即可原地更新；'
Write-Host '  配好内部 registry 后也可直接执行 openchamber update。'
Write-Host ''
Write-Host '  重要：更新后必须重启 OpenChamber 服务（openchamber restart），旧进程仍运行旧代码'
Write-Host '  （否则新功能如本地议题会"消失"，重启即恢复）。'

if ($Start) {
  if ($DryRun) { Write-Host '[dry-run] 将在新窗口启动 openchamber'; return }
  $startArgs = @('/k', 'openchamber')
  if ($Port) { $startArgs += @('--port', "$Port") }
  Start-Process -FilePath 'cmd.exe' -ArgumentList $startArgs
  # openchamber 默认自己转后台；status 无论是否在运行都返回 0，只能看 --quiet 的输出。
  Start-Sleep -Seconds 3
  $startStatus = (& openchamber status --quiet 2>$null) -join "`n"
  if (-not $startStatus.Trim() -or $startStatus.Trim() -eq 'stopped') {
    Write-Warning "启动失败（status: $($startStatus.Trim())）。请在新窗口里看输出，或运行 openchamber serve --foreground --port 3000 定位问题。"
    exit 1
  }
  Write-Host "OpenChamber 已在运行（status: $($startStatus.Trim())）。"
}
