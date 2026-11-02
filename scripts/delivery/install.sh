#!/usr/bin/env bash
# OpenChamber 2.5.3 intranet installer / updater (Linux / macOS).
# Mirrors install.ps1: installs the bundled npm tarballs, prepares the
# configuration files, prints the 2.5.3 release notes and start commands.
# Re-running over an existing installation updates it in place.
#
# Usage:
#   bash install.sh
#   bash install.sh --registry http://npm.internal:4873
#   bash install.sh --organization Contoso --npm-registry http://npm.internal:4873
#   bash install.sh --ui-password s3cret --port 3000
#   bash install.sh --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The version comes from the bundled SDK tarball, so a new release zip needs no script edit.
sdk_tgz_file="$(ls "$SCRIPT_DIR"/openchamber-sdk-*.tgz 2>/dev/null | head -n 1)"
if [[ -z "$sdk_tgz_file" ]]; then
  echo "找不到 openchamber-sdk-*.tgz，请确认脚本与 tgz 在同一目录。" >&2
  exit 1
fi
VERSION="${sdk_tgz_file##*openchamber-sdk-}"
VERSION="${VERSION%.tgz}"
SDK_TGZ="$sdk_tgz_file"
WEB_TGZ="$SCRIPT_DIR/openchamber-web-$VERSION.tgz"

REGISTRY="" POLICY_FILE="" ORGANIZATION="" NPM_REGISTRY=""
PORT="" UI_PASSWORD="" OPENCODE_HOST="" OPENCODE_PORT=""
START=0 DRY_RUN=0

usage() {
  cat <<'USAGE'
用法: bash install.sh [选项]
  --registry <url>        通过内部 npm registry 安装（默认离线安装）
  --policy-file <path>    把组织提供的 policy.json 放到系统策略路径（需要 root）
  --organization <name>   生成企业模式策略（enterpriseMode + organization）
  --npm-registry <url>    固定内网 npm 镜像（写入策略文件与 shell 环境）
  --port <n>              持久化 OPENCHAMBER_PORT
  --ui-password <pwd>     持久化 OPENCHAMBER_UI_PASSWORD（明文写入 ~/.bashrc）
  --opencode-host <url>   持久化 OPENCODE_HOST
  --opencode-port <n>     持久化 OPENCODE_PORT
  --start                 安装后在后台启动服务
  --dry-run               只打印将要执行的动作，不做任何修改
  -h, --help              显示本帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --policy-file) POLICY_FILE="$2"; shift 2 ;;
    --organization) ORGANIZATION="$2"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ui-password) UI_PASSWORD="$2"; shift 2 ;;
    --opencode-host) OPENCODE_HOST="$2"; shift 2 ;;
    --opencode-port) OPENCODE_PORT="$2"; shift 2 ;;
    --start) START=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

title() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }

run_npm() { # $1=label, rest=npm args
  local label="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then echo "  [dry-run] npm $*"; return 0; fi
  echo "  > npm $*"
  npm "$@"
  local rc=$?
  if [[ $rc -ne 0 ]]; then echo "$label 失败 (npm exit $rc)" >&2; exit $rc; fi
}

title "OpenChamber $VERSION 内网安装/更新"

# --- Prerequisites ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 24.14.0 或更高版本。" >&2; exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
NODE_MINOR="$(node -v | sed 's/^v//' | cut -d. -f2)"
if [[ "$NODE_MAJOR" -lt 24 || ( "$NODE_MAJOR" -eq 24 && "$NODE_MINOR" -lt 14 ) ]]; then
  echo "需要 Node.js >= 24.14.0，当前为 $(node -v)。" >&2; exit 1
fi
echo "Node.js $(node -v) 检查通过"

for tgz in "$SDK_TGZ" "$WEB_TGZ"; do
  [[ -f "$tgz" ]] || { echo "缺少安装包：$tgz（请确认脚本与 tgz 在同一目录）" >&2; exit 1; }
done
if command -v openchamber >/dev/null 2>&1; then
  echo "检测到已安装的 OpenChamber，本脚本将原地更新到 $VERSION"
else
  echo "未检测到已有安装，执行全新安装"
fi

# --- Install / update the packages ------------------------------------------
title "安装 npm 包"
if [[ -n "$REGISTRY" ]]; then
  run_npm "从内部 registry 安装" install -g --registry "$REGISTRY" "$SDK_TGZ" "$WEB_TGZ"
else
  # The SDK tarball install seeds the npm cache, so the web package resolves
  # its exact "@openchamber/sdk": "2.5.3" from cache first; --prefer-offline
  # still reaches the registry for dependencies the cache does not hold
  # (--offline would die with ENOTCACHED on any machine without a mirror).
  run_npm "安装 SDK 包（写入 npm 缓存）" install -g "$SDK_TGZ"
  if ! run_npm "安装 OpenChamber（缓存优先）" install -g --prefer-offline "$WEB_TGZ"; then
    echo "缓存优先安装失败，改用常规 npm 安装（需要可用的 registry）..." >&2
    run_npm "常规安装 OpenChamber" install -g "$WEB_TGZ"
  fi
fi

# --- SDK hygiene -------------------------------------------------------------
# A stale SDK copy nested inside the web package (an old cached tarball npm
# resolved earlier) shadows the fresh global one and breaks its imports.
title "SDK 校验"
GLOBAL_ROOT='<npm-global-root>'
[[ $DRY_RUN -eq 0 ]] && GLOBAL_ROOT="$(npm root -g)"
NESTED_SDK="$GLOBAL_ROOT/@openchamber/web/node_modules/@openchamber/sdk"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] 检查 $NESTED_SDK，存在则删除"
elif [[ -d "$NESTED_SDK" ]]; then
  rm -rf "$NESTED_SDK"
  echo "  已删除 web 包内嵌套的旧版 @openchamber/sdk（它会遮蔽全局新版）"
else
  echo "  无嵌套旧版 SDK"
fi
if [[ $DRY_RUN -eq 0 && -f "$GLOBAL_ROOT/@openchamber/sdk/package.json" ]]; then
  installed_version="$(node -p "require('$GLOBAL_ROOT/@openchamber/sdk/package.json').version" 2>/dev/null || true)"
  if [[ "$installed_version" != "$VERSION" ]]; then
    echo "警告: 全局 @openchamber/sdk 版本为 ${installed_version:-unknown}，预期 $VERSION；请删除 $GLOBAL_ROOT/@openchamber 后重跑本脚本。" >&2
  else
    echo "  全局 SDK 版本 $installed_version 正确"
  fi
fi

# --- Data directory ----------------------------------------------------------
title "数据目录"
DATA_DIR="${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"
[[ $DRY_RUN -eq 0 ]] && mkdir -p "$DATA_DIR"
echo "数据目录：$DATA_DIR"
echo "  settings.json（应用设置）由服务首次启动时自动写入，无需手工创建；"
echo "  extensions/（已安装插件）、secrets/、remote-clients.json 由服务按需创建。"

# --- Machine policy file (intranet / enterprise lockdown) --------------------
title "策略文件 policy.json"
if [[ "$(uname -s)" == "Darwin" ]]; then
  POLICY_PATH="/Library/Application Support/OpenChamber/policy.json"
else
  POLICY_PATH="/etc/openchamber/policy.json"
fi
write_policy=""
if [[ -n "$POLICY_FILE" ]]; then
  [[ -f "$POLICY_FILE" ]] || { echo "找不到策略文件：$POLICY_FILE" >&2; exit 1; }
  write_policy="$(cat "$POLICY_FILE")"
  echo "使用指定策略文件：$POLICY_FILE"
elif [[ -n "$ORGANIZATION" || -n "$NPM_REGISTRY" ]]; then
  json="{"
  sep=""
  if [[ -n "$ORGANIZATION" ]]; then
    json="$json\"enterpriseMode\": true, \"organization\": \"$ORGANIZATION\""; sep=", "
  fi
  if [[ -n "$NPM_REGISTRY" ]]; then
    json="$json$sep\"npmRegistry\": \"$NPM_REGISTRY\""
  fi
  write_policy="$json}"
fi
if [[ -n "$write_policy" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] 写入 $POLICY_PATH ："
    echo "$write_policy"
  else
    policy_dir="$(dirname "$POLICY_PATH")"
    if mkdir -p "$policy_dir" 2>/dev/null && printf '%s\n' "$write_policy" > "$POLICY_PATH" 2>/dev/null; then
      echo "策略文件已写入：$POLICY_PATH"
      echo '  策略文件每次使用时重新读取，修改后无需重启；内容损坏时按"全部关闭"处理。'
    else
      echo "警告: 写入 $POLICY_PATH 失败（需要 root）。请手工放置该文件后重跑本脚本：" >&2
      echo "  sudo mkdir -p $policy_dir && sudo tee $POLICY_PATH > /dev/null <<'EOF'" >&2
      echo "$write_policy" >&2
      echo "EOF" >&2
    fi
  fi
else
  echo "未指定 --organization / --npm-registry / --policy-file，跳过。当前策略文件：$POLICY_PATH"
fi

# --- Persistent environment variables ----------------------------------------
if [[ -n "$PORT$UI_PASSWORD$OPENCODE_HOST$OPENCODE_PORT$NPM_REGISTRY" ]]; then
  title "环境变量（写入 ~/.bashrc）"
  exports=()
  [[ -n "$PORT" ]] && exports+=("export OPENCHAMBER_PORT=$PORT")
  [[ -n "$NPM_REGISTRY" ]] && exports+=("export OPENCHAMBER_NPM_REGISTRY=$NPM_REGISTRY")
  [[ -n "$OPENCODE_HOST" ]] && exports+=("export OPENCODE_HOST=$OPENCODE_HOST")
  [[ -n "$OPENCODE_PORT" ]] && exports+=("export OPENCODE_PORT=$OPENCODE_PORT")
  if [[ -n "$UI_PASSWORD" ]]; then
    echo "  注意：OPENCHAMBER_UI_PASSWORD 以明文保存在 ~/.bashrc 中。"
    echo "  如不希望落盘，请去掉 --ui-password，改在启动命令里使用 --ui-password。"
    exports+=("export OPENCHAMBER_UI_PASSWORD=$UI_PASSWORD")
  fi
  block_begin="# >>> openchamber-$VERSION >>>"
  block_end="# <<< openchamber-$VERSION <<<"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] 写入 %s\n' "$HOME/.bashrc"
    printf '  %s\n' "${exports[@]}"
  else
    # Replace the previous marked block so reruns stay idempotent.
    sed -i.bak "/^# >>> openchamber-/,/^# <<< openchamber-/d" "$HOME/.bashrc" 2>/dev/null || true
    {
      echo "$block_begin"
      printf '%s\n' "${exports[@]}"
      echo "$block_end"
    } >> "$HOME/.bashrc"
    for line in "${exports[@]}"; do eval "$line"; done
    echo "  已写入 $HOME/.bashrc（重开终端或 source ~/.bashrc 生效）"
  fi
fi

# --- Release notes ------------------------------------------------------------
title "$VERSION 更新内容（$(date +%F) 打包）"
if [[ -f "$SCRIPT_DIR/RELEASE-NOTES.md" ]]; then
  cat "$SCRIPT_DIR/RELEASE-NOTES.md"
fi

# --- Start commands -----------------------------------------------------------
title "启动命令"
cat <<'CMD'
  openchamber                                                  # 默认 3000 端口，仅本机访问
  openchamber serve --lan --port 3000 --ui-password <密码>     # 局域网访问（必须设密码）
  OPENCODE_HOST=https://host:4096 OPENCODE_SKIP_START=true openchamber  # 连接外部 OpenCode
  openchamber --help                                           # 全部选项

  长期运行建议用 systemd：
  sudo tee /etc/systemd/system/openchamber.service > /dev/null <<'UNIT'
  [Unit]
  Description=OpenChamber
  After=network.target
  [Service]
  User=%i
  ExecStart=%h/.npm-global/bin/openchamber
  Restart=on-failure
  [Install]
  WantedBy=multi-user.target
  UNIT
  （ExecStart 用 `which openchamber` 的实际路径替换）

  后续更新：新版本包解开后重跑本 install.sh 即可原地更新；
  配好内部 registry 后也可直接执行 openchamber update。

  重要：更新后必须重启 OpenChamber 服务（systemctl restart openchamber），
  旧进程仍运行旧代码，否则新功能如本地议题会"消失"，重启即恢复。
CMD

if [[ $START -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] 将后台启动 openchamber"; exit 0; fi
  port_args=()
  [[ -n "$PORT" ]] && port_args+=(--port "$PORT")
  nohup openchamber "${port_args[@]}" >>"$DATA_DIR/openchamber.log" 2>&1 &
  echo "已在后台启动 OpenChamber（PID $!，日志 $DATA_DIR/openchamber.log）。"
fi
