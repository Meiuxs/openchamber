#!/usr/bin/env bash
# OpenChamber 内网安装 / 更新脚本（Linux / macOS）。
# 与 install.ps1 一一对应：安装随包的 npm tarball、准备配置文件、打印更新内容和
# 启动命令。对已有安装重复执行本脚本即为原地更新。
#
# 注意：本文件必须保持 LF 换行。CRLF 会让 bash 在第一行就报 "bad interpreter"。
#
# 用法:
#   bash install.sh
#   bash install.sh --registry http://npm.internal:4873
#   bash install.sh --organization Contoso --npm-registry http://npm.internal:4873
#   bash install.sh --ui-password s3cret --port 3000
#   bash install.sh --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 版本号取自随包的 SDK tarball，所以新版本 zip 不需要改脚本。
# nullglob：目录里没有 tgz 时通配符展开为空，而不是让 ls 的失败码把脚本带走。
shopt -s nullglob
sdk_candidates=("$SCRIPT_DIR"/openchamber-sdk-*.tgz)
shopt -u nullglob
if (( ${#sdk_candidates[@]} == 0 )); then
  echo "找不到 openchamber-sdk-*.tgz，请确认脚本与 tgz 在同一目录。" >&2
  exit 1
fi
# 取版本号最大的一个：目录里同时留着上个版本的包时，不能拿错。
VERSION="$(printf '%s\n' "${sdk_candidates[@]}" | sed 's|.*/openchamber-sdk-||; s|\.tgz$||' | sort -V | tail -n 1)"
SDK_TGZ="$SCRIPT_DIR/openchamber-sdk-$VERSION.tgz"
WEB_TGZ="$SCRIPT_DIR/openchamber-web-$VERSION.tgz"

REGISTRY="" POLICY_FILE="" ORGANIZATION="" NPM_REGISTRY=""
PORT="" UI_PASSWORD="" OPENCODE_HOST="" OPENCODE_PORT=""
START=0 DRY_RUN=0

usage() {
  cat <<'USAGE'
用法: bash install.sh [选项]
  --registry <url>        通过内部 npm registry 安装（默认离线安装）
  --policy-file <path>    把组织提供的 policy.json 放到策略路径（默认写入用户数据目录，无需 root）
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

# 缺少取值的参数（如末尾只写 --registry）直接报用法，而不是让 $2 触发 set -u。
need_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "参数 $1 缺少取值" >&2
    usage
    exit 1
  fi
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) need_value "$@"; REGISTRY="$2"; shift 2 ;;
    --policy-file) need_value "$@"; POLICY_FILE="$2"; shift 2 ;;
    --organization) need_value "$@"; ORGANIZATION="$2"; shift 2 ;;
    --npm-registry) need_value "$@"; NPM_REGISTRY="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --ui-password) need_value "$@"; UI_PASSWORD="$2"; shift 2 ;;
    --opencode-host) need_value "$@"; OPENCODE_HOST="$2"; shift 2 ;;
    --opencode-port) need_value "$@"; OPENCODE_PORT="$2"; shift 2 ;;
    --start) START=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

title() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }

run_npm() { # $1=label, rest=npm args. 返回 npm 的退出码，调用方决定是否回退。
  local label="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then echo "  [dry-run] npm $*"; return 0; fi
  echo "  > npm $*"
  local rc=0
  npm "$@" || rc=$?
  if [[ $rc -ne 0 ]]; then echo "$label 失败 (npm exit $rc)" >&2; fi
  return $rc
}

pkg_version() { # 读 package.json 的 version，读不到则输出空
  node -p "require(process.argv[1]).version" "$1" 2>/dev/null || true
}

json_escape() { # 转义反斜杠和双引号，组织名或 URL 里带引号也不会写坏 policy.json
  local s="${1//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}

dir_writable() { # 目录可写；尚不存在时看最近的已存在祖先能否创建它
  local p="$1" parent
  while [[ ! -d "$p" ]]; do
    parent="$(dirname "$p")"
    [[ "$parent" == "$p" ]] && return 1
    p="$parent"
  done
  [[ -w "$p" ]]
}

title "OpenChamber $VERSION 内网安装/更新"

# --- 前置检查 --------------------------------------------------------------
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
# --- 全局前缀：只复用已有的用户级 npm 目录，不改任何 npm 配置 -----------------
# 目标机器本来就有用户级 npm 全局目录。即使 npm 默认前缀指向不可写的系统目录，
# 也只用 NPM_CONFIG_PREFIX 在本次会话临时指过去：不写 ~/.npmrc、不重建已有目录、
# 不需要 sudo；后续安装与 SDK 校验都落在用户目录。
USER_PREFIX=""
NEED_PATH_PERSIST=0
if [[ $DRY_RUN -eq 0 ]]; then
  GLOBAL_ROOT="$(npm root -g)"
  if ! dir_writable "$GLOBAL_ROOT"; then
    USER_PREFIX="$HOME/.npm-global"
    if [[ ! -d "$USER_PREFIX" ]]; then
      mkdir -p "$USER_PREFIX" || { echo "无法创建用户级 npm 目录：$USER_PREFIX" >&2; exit 1; }
      echo "用户级 npm 目录不存在，已创建空目录：$USER_PREFIX"
    fi
    export NPM_CONFIG_PREFIX="$USER_PREFIX"
    GLOBAL_ROOT="$(npm root -g)"
    echo "npm 全局目录不可写，本次安装复用已有的用户级 npm 目录：$USER_PREFIX（无需 root，不修改 npm 配置）"
    case ":$PATH:" in
      *":$USER_PREFIX/bin:"*)
        echo "  $USER_PREFIX/bin 已在 PATH，未改动任何配置文件。"
        ;;
      *)
        export PATH="$USER_PREFIX/bin:$PATH"
        NEED_PATH_PERSIST=1
        echo "  $USER_PREFIX/bin 不在 PATH，已加入本次会话并写入 ~/.bashrc。"
        ;;
    esac
  fi
else
  GLOBAL_ROOT='<npm-global-root>'
fi

# --- 安装 / 更新 ----------------------------------------------------------
title "安装 npm 包"
if [[ -n "$REGISTRY" ]]; then
  run_npm "从内部 registry 安装" install -g --registry "$REGISTRY" "$SDK_TGZ" "$WEB_TGZ"
else
  # 先装 SDK tarball 作为兜底（web 包自带 SDK，npm 会优先用包内那份），
  # --prefer-offline 对缓存里没有的其他依赖仍会走 registry
  # （直接 --offline 在任何没有镜像的机器上都会 ENOTCACHED 失败）。
  # 兜底装不上不阻断：web 包内的副本仍然可用。
  run_npm "安装 SDK 包" install -g "$SDK_TGZ" || echo "警告: SDK 包安装失败，继续安装 OpenChamber（使用 web 包内副本）。" >&2
  if ! run_npm "安装 OpenChamber（缓存优先）" install -g --prefer-offline "$WEB_TGZ"; then
    echo "缓存优先安装失败，改用常规 npm 安装（需要可用的 registry）..." >&2
    run_npm "常规安装 OpenChamber" install -g "$WEB_TGZ"
  fi
fi

# --- SDK 校验 ---------------------------------------------------------------
# web tarball 现在把 SDK 一起打进了 package/node_modules/@openchamber/sdk。
# 这份嵌套副本是内网机器上最可靠的来源：内部 registry 未必收录 @openchamber/sdk，
# 删掉它反而会让服务启动时报 "Cannot find package '@openchamber/sdk'"。
# 因此只在版本不匹配（上一次安装残留的旧副本）时删除，并交给重装修复。
title "SDK 校验"
NESTED_SDK="$GLOBAL_ROOT/@openchamber/web/node_modules/@openchamber/sdk"
nested_version=""
[[ $DRY_RUN -eq 0 && -f "$NESTED_SDK/package.json" ]] && nested_version="$(pkg_version "$NESTED_SDK/package.json")"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] 检查 $NESTED_SDK：版本等于 $VERSION 则保留，否则删除"
elif [[ -n "$nested_version" && "$nested_version" == "$VERSION" ]]; then
  echo "  web 包内自带 @openchamber/sdk $nested_version，保留（离线可用）"
elif [[ -n "$nested_version" ]]; then
  rm -rf "$NESTED_SDK"
  echo "  已删除 web 包内版本不符的 @openchamber/sdk（$nested_version，应为 $VERSION）" >&2
  echo "  请重跑本脚本重装，让 npm 放回正确版本。" >&2
elif [[ -f "$GLOBAL_ROOT/@openchamber/sdk/package.json" ]]; then
  global_sdk_version="$(pkg_version "$GLOBAL_ROOT/@openchamber/sdk/package.json")"
  if [[ "$global_sdk_version" == "$VERSION" ]]; then
    echo "  使用全局 @openchamber/sdk $global_sdk_version"
  else
    echo "警告: 全局 @openchamber/sdk 版本为 ${global_sdk_version:-unknown}，预期 $VERSION；请删除 $GLOBAL_ROOT/@openchamber 后重跑本脚本。" >&2
  fi
else
  echo "警告: 既没有 web 包内副本，也没有全局 @openchamber/sdk；服务无法启动。请重跑本脚本重装。" >&2
fi

# --- 数据目录 ---------------------------------------------------------------
title "数据目录"
DATA_DIR="${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"
[[ $DRY_RUN -eq 0 ]] && mkdir -p "$DATA_DIR"
echo "数据目录：$DATA_DIR"
echo "  settings.json（应用设置）由服务首次启动时自动写入，无需手工创建；"
echo "  extensions/（已安装插件）、secrets/、remote-clients.json 由服务按需创建。"

# --- 策略文件 policy.json（用户级内网 / 企业配置，无需 root 权限） -----------
title "策略文件 policy.json"
POLICY_PATH="$DATA_DIR/policy.json"
EXAMPLE_FILE="$SCRIPT_DIR/policy.example.json"
if [[ -f "$EXAMPLE_FILE" && $DRY_RUN -eq 0 ]]; then
  cp -f "$EXAMPLE_FILE" "$DATA_DIR/policy.example.json" 2>/dev/null || true
  echo "已更新策略样例参考文件：$DATA_DIR/policy.example.json"
fi

write_policy=""
is_default_created=0
if [[ -n "$POLICY_FILE" ]]; then
  [[ -f "$POLICY_FILE" ]] || { echo "找不到策略文件：$POLICY_FILE" >&2; exit 1; }
  write_policy="$(cat "$POLICY_FILE")"
  echo "使用指定策略文件：$POLICY_FILE"
elif [[ -n "$ORGANIZATION" || -n "$NPM_REGISTRY" ]]; then
  if [[ -f "$EXAMPLE_FILE" ]]; then
    write_policy="$(node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (process.argv[2]) { data.enterpriseMode = true; data.organization = process.argv[2]; }
      if (process.argv[3]) { data.npmRegistry = process.argv[3]; }
      process.stdout.write(JSON.stringify(data, null, 2));
    ' "$EXAMPLE_FILE" "$ORGANIZATION" "$NPM_REGISTRY")"
  else
    json="{"
    sep=""
    if [[ -n "$ORGANIZATION" ]]; then
      json="$json\"enterpriseMode\": true, \"organization\": \"$(json_escape "$ORGANIZATION")\""; sep=", "
    fi
    if [[ -n "$NPM_REGISTRY" ]]; then
      json="$json$sep\"npmRegistry\": \"$(json_escape "$NPM_REGISTRY")\""
    fi
    write_policy="$json}"
  fi
elif [[ ! -f "$POLICY_PATH" && -f "$EXAMPLE_FILE" ]]; then
  write_policy="$(cat "$EXAMPLE_FILE")"
  is_default_created=1
fi

if [[ -n "$write_policy" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] 写入 $POLICY_PATH ："
    echo "$write_policy"
  else
    policy_dir="$(dirname "$POLICY_PATH")"
    if mkdir -p "$policy_dir" 2>/dev/null && printf '%s\n' "$write_policy" > "$POLICY_PATH" 2>/dev/null; then
      if [[ $is_default_created -eq 1 ]]; then
        echo -e "\033[33m已自动创建默认内网策略文件（带完整字段注释）：$POLICY_PATH\033[0m"
        echo -e "\033[33m  >> 提示：当前默认已开启【企业模式】。文件内已预留内网 npm、Git、模型元数据等配置项说明，请根据实际内网环境修改。\033[0m"
      else
        echo "策略文件已写入：$POLICY_PATH"
      fi
      echo '  策略文件每次使用时重新读取，修改后无需重启；内容损坏时按"全部关闭"处理。'
    else
      echo "警告: 写入 $POLICY_PATH 失败。请检查目录权限后重跑本脚本：" >&2
      echo "  mkdir -p $policy_dir && tee $POLICY_PATH > /dev/null <<'EOF'" >&2
      echo "$write_policy" >&2
      echo "EOF" >&2
    fi
  fi
else
  echo -e "\033[32m策略文件已存在（保持原有配置不覆盖）：$POLICY_PATH\033[0m"
  echo "  如需参考最新完整字段与说明，可查阅：$DATA_DIR/policy.example.json"
fi

# --- 持久化环境变量 ------------------------------------------------------------
# %q 生成能原样回读的 shell 转义：密码和 URL 里的空格、$()、#、单引号都不会
# 打断 export，也不会在 source 时被求值。
sh_quote() { printf '%q' "$1"; }
if [[ -n "$PORT$UI_PASSWORD$OPENCODE_HOST$OPENCODE_PORT$NPM_REGISTRY" || $NEED_PATH_PERSIST -eq 1 ]]; then
  title "环境变量（写入 ~/.bashrc）"
  echo "  只用 zsh 的机器请把这块搬到 ~/.zshrc（bashrc 不会被 zsh 读取）。"
  exports=()
  # 只在 PATH 确实缺这个目录时补写；幂等，重复 source 不会反复追加。
  [[ $NEED_PATH_PERSIST -eq 1 ]] && exports+=("[[ \":\$PATH:\" == *\":$USER_PREFIX/bin:\"* ]] || export PATH=\"$USER_PREFIX/bin:\$PATH\"")
  [[ -n "$PORT" ]] && exports+=("export OPENCHAMBER_PORT=$(sh_quote "$PORT")")
  [[ -n "$NPM_REGISTRY" ]] && exports+=("export OPENCHAMBER_NPM_REGISTRY=$(sh_quote "$NPM_REGISTRY")")
  [[ -n "$OPENCODE_HOST" ]] && exports+=("export OPENCODE_HOST=$(sh_quote "$OPENCODE_HOST")")
  [[ -n "$OPENCODE_PORT" ]] && exports+=("export OPENCODE_PORT=$(sh_quote "$OPENCODE_PORT")")
  if [[ -n "$UI_PASSWORD" ]]; then
    echo "  注意：OPENCHAMBER_UI_PASSWORD 以明文保存在 ~/.bashrc 中。"
    echo "  如不希望落盘，请去掉 --ui-password，改在启动命令里使用 --ui-password。"
    exports+=("export OPENCHAMBER_UI_PASSWORD=$(sh_quote "$UI_PASSWORD")")
  fi
  # 标记不带版本号：删除时才能把上个版本写下的块一起清掉。
  block_begin="# >>> openchamber env >>>"
  block_end="# <<< openchamber env <<<"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] 写入 %s\n' "$HOME/.bashrc"
    printf '  %s\n' "${exports[@]}"
  else
    rc_file="$HOME/.bashrc"
    touch "$rc_file" 2>/dev/null || { echo "无法写入 $rc_file" >&2; exit 1; }
    # 用 awk 就地替换（BSD sed 没有 sed -i，macOS 上会生成 .bak 并失败）。
    # 只要行内出现标记就跳过整块，含旧版带版本号的标记，重跑不残留。
    awk '
      />>> openchamber/ { skip = 1 }
      !skip { print }
      /<<< openchamber/ { skip = 0 }
    ' "$rc_file" > "$rc_file.openchamber.tmp"
    # 用 cat 覆盖而不是 mv：~/.bashrc 是软链接时保留链接，不会换成普通文件。
    cat "$rc_file.openchamber.tmp" > "$rc_file"
    rm -f "$rc_file.openchamber.tmp"
    {
      echo "$block_begin"
      printf '%s\n' "${exports[@]}"
      echo "$block_end"
    } >> "$rc_file"
    chmod 600 "$rc_file" 2>/dev/null || true
    echo "  已写入 $rc_file（重开终端或 source ~/.bashrc 生效）"
  fi
fi

# --- 更新内容 ------------------------------------------------------------------
title "$VERSION 更新内容（$(date +%F) 打包）"
if [[ -f "$SCRIPT_DIR/RELEASE-NOTES.md" ]]; then
  cat "$SCRIPT_DIR/RELEASE-NOTES.md"
fi

# --- 启动命令 -----------------------------------------------------------
title "启动命令"
cat <<'CMD'
  openchamber                                                    # 默认 3000 端口，仅本机访问
  openchamber serve --lan --port 3000 --ui-password <密码>       # 局域网访问（必须设密码）
  OPENCODE_HOST=http://host:4096 OPENCODE_SKIP_START=true openchamber   # 连接外部 OpenCode
  openchamber --help                                             # 全部选项

  常驻运行优先用自带命令（Linux 生成 systemd 用户服务，macOS 生成 LaunchAgent，
  都写在当前用户目录下，无需 root）：
  openchamber startup enable --port 3000
  openchamber startup status

  自建服务单元时（含 systemd 用户服务）必须用 serve --foreground 启动：默认模式下
  CLI 会 fork 后台进程后退出，配合 Restart=always 会不停拉起新实例。

  后续更新：新版本包解开后重跑本 install.sh 即可原地更新；
  配好内部 registry 后也可直接执行 openchamber update。

  重要：更新后必须重启 OpenChamber 服务（openchamber restart），旧进程仍运行
  旧代码，否则新功能如本地议题会"消失"，重启即恢复。
CMD

# --- 后台启动 -----------------------------------------------------------
if [[ $START -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] 将后台启动 openchamber"; exit 0; fi
  start_args=()
  [[ -n "$PORT" ]] && start_args+=(--port "$PORT")
  # .bashrc 里的 export 只对之后的 shell 生效，本次拉起的进程继承不到；
  # 在这里显式导出，--ui-password 等参数才能真正传给后台服务。
  [[ -n "$PORT" ]] && export OPENCHAMBER_PORT="$PORT"
  [[ -n "$NPM_REGISTRY" ]] && export OPENCHAMBER_NPM_REGISTRY="$NPM_REGISTRY"
  [[ -n "$OPENCODE_HOST" ]] && export OPENCODE_HOST="$OPENCODE_HOST"
  [[ -n "$OPENCODE_PORT" ]] && export OPENCODE_PORT="$OPENCODE_PORT"
  [[ -n "$UI_PASSWORD" ]] && export OPENCHAMBER_UI_PASSWORD="$UI_PASSWORD"
  # openchamber 默认自己转后台，stdout 不进这里的日志；外层 nohup 只是为了
  # 让本脚本立即返回。status 无论是否在运行都返回 0，只能看 --quiet 的输出。
  nohup openchamber ${start_args[@]+"${start_args[@]}"} >>"$DATA_DIR/openchamber-install.log" 2>&1 || true
  sleep 3
  start_status="$(openchamber status --quiet 2>/dev/null || true)"
  if [[ -z "$start_status" || "$start_status" == "stopped" ]]; then
    echo "启动失败（status: ${start_status:-无输出}），请前台运行定位问题：" >&2
    echo "  openchamber serve --foreground --port ${PORT:-3000}" >&2
    echo "  安装过程输出：$DATA_DIR/openchamber-install.log" >&2
    exit 1
  fi
  echo "OpenChamber 已在运行（status: $start_status）。"
  echo "  安装过程输出：$DATA_DIR/openchamber-install.log"
fi
