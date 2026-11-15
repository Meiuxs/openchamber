# 本地 GitLab 12.7 联调实例

## 用途

这个目录在开发机上起一个 GitLab CE 12.7.9 容器，用于联调 source-control 的 GitLab provider 和 issue 自动化。

12.7 是 `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md` 声明的版本下限。新版 GitLab 用 `GET /merge_requests/:iid/diffs` 读改动文件，15.7 以下没有这个接口，`packages/web/server/lib/gitlab/resources.js` 会 404 回退到 `/changes`。只有在 12.7 上跑，这条回退分支才会真正执行。

## 目录内容

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | GitLab 12.7.9 服务定义，端口 8929 与 2224，命名卷 |
| `bootstrap-wsl.sh` | 装 Docker 与 compose 插件，可选配置 daemon 代理 |
| `init-env.sh` | 生成 `.env`，写入随机 root 口令 |
| `create-token.rb` | 在容器内用 rails runner 创建 root 的 API token |
| `seed.sh` | 用 token 验证 API 并建一个 `root/hello-demo` 演示项目 |
| `.env.example` | `.env` 的模板，说明哪些值需要自己填 |

## 前置条件

- 一个 WSL2 发行版，虚拟磁盘放在数据盘上。本机是 `D:\WSL\Ubuntu`。
- 发行版内启用 systemd，`/etc/wsl.conf` 里要有 `[boot]` 段的 `systemd=true`。
- 机器走代理上网时记下代理地址，Docker daemon 拉镜像要用到它。

## 首次安装

在 PowerShell 里执行，四步。

1. 装 Docker 与 compose 插件。有代理时传 `PROXY_URL`，直连就省掉这个变量。

```powershell
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && PROXY_URL=http://127.0.0.1:7897 bash bootstrap-wsl.sh"
```

2. 生成 `.env` 与 root 口令。

```powershell
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && bash init-env.sh"
```

3. 启动容器。首次启动要跑数据库迁移，健康检查从 `starting` 变成 `healthy` 大约 3 到 8 分钟。

```powershell
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && docker compose up -d"
wsl -d Ubuntu -u root -- bash -c "docker ps --filter name=gitlab-12-7"
```

4. 建一个 API token，把输出的 `TOKEN=` 值追加到 `.env` 的 `GITLAB_TOKEN`。

```powershell
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && docker cp create-token.rb gitlab-12-7:/tmp/create-token.rb && docker exec gitlab-12-7 gitlab-rails runner /tmp/create-token.rb"
```

## 日常启停

容器设了 `restart: unless-stopped`，Docker daemon 活着时它自己会起来。WSL 关掉后需要手动启动。

```powershell
# 启动
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && docker compose up -d"

# 状态与日志
wsl -d Ubuntu -u root -- bash -c "docker ps --filter name=gitlab-12-7"
wsl -d Ubuntu -u root -- bash -c "docker logs -f gitlab-12-7"

# 停止
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && docker compose down"

# 停止并删除数据卷
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && docker compose down -v"
```

compose 顶层写了 `name: gitlab`，所以无论从哪个目录执行，卷名都是 `gitlab_gitlab-data` 这一组，重复 `up` 不会丢数据。

### 已经在 WSL 里

人已经在 Ubuntu shell 里时，去掉 `wsl -d Ubuntu -u root --` 前缀直接执行。Docker daemon 只有 root 能连，普通用户直接跑 `docker` 会报 `permission denied ... docker.sock`，所以要先 `sudo -i` 切到 root，或每条命令加 `sudo`：

```bash
# 启动（先 sudo -i 切 root，则去掉下面的 sudo）
cd /mnt/d/Code/openchamber/docs/local-gitlab && sudo docker compose up -d

# 状态
sudo docker ps --filter name=gitlab-12-7

# 等健康检查变 healthy（每 10 秒刷新一次）
while true; do sudo docker inspect --format '{{.State.Health.Status}}' gitlab-12-7; sleep 10; done
```

API 通了就可以 `Ctrl+C` 退出上面的循环。验证接口时加 `--noproxy '*'`：

```bash
curl --noproxy '*' -s http://localhost:8929/-/health
```

### 让 WSL 保持运行

WSL 在最后一条命令结束约两分钟后整机断电，容器跟着停，服务端探测拿到的就是 `ECONNREFUSED`。日志里能看到这两行：

```
systemd-logind: The system will power off now!
systemd: Stopping docker.service
```

保持一个常驻会话，虚拟机就不会关机，GitLab 也一直在：

```powershell
Start-Process wsl.exe -ArgumentList '-d','Ubuntu','-u','root','--','sleep','infinity' -WindowStyle Hidden
```

这个进程跟着 Windows 重启消失，开机后重新执行一次。一个开着不关的交互式 WSL 窗口同样能保活，效果一样。也可以在 `%USERPROFILE%\.wslconfig` 的 `[wsl2]` 段调大 `vmIdleTimeout`，那个文件在 C 盘。

## 连接 OpenChamber

| 项 | 值 |
|---|---|
| 实例地址 | `http://localhost:8929` |
| 认证方式 | 个人访问令牌，填 `.env` 里的 `GITLAB_TOKEN` |
| 演示项目 | `root/hello-demo`，私有 |
| SSH 克隆 | `ssh://git@localhost:2224/root/hello-demo.git` |

实例地址是回环地址，GitLab 描述符里 `allowLoopbackHttp: true`，provider 直接放行，不需要改 `policy.json` 的 `allowedInsecureGitOrigins`。

自建实例没有 OpenChamber 的 OAuth 应用，device flow 在能力探测里显示 `device.available: false`，原因 `invalid-client`。这是预期结果，用 PAT 连接。

## 验证

`seed.sh` 会读 `.env` 里的 token，打印账号、项目路径和版本号。

```powershell
wsl -d Ubuntu -u root -- bash -c "cd /mnt/d/Code/openchamber/docs/local-gitlab && bash seed.sh"
```

正常输出：

```
--- user
"username":"root"
--- project
"path_with_namespace":"root/hello-demo"
--- version
{"version":"12.7.9","revision":"3284b2b060d"}
```

## 资源占用与磁盘位置

实测数据，容器跑起来后空载：

| 项 | 值 |
|---|---|
| 内存 | 1.74 GiB |
| CPU | 18%，空闲时接近 0 |
| 建议可用内存 | 4 GiB 以上，低于 3 GiB 会 OOM |
| 虚拟磁盘 | 22.8 GB（含 Ubuntu 基础镜像与 Docker 层） |

数据都在 WSL 发行版的虚拟磁盘里，本机即 `D:\WSL\Ubuntu\ext4.vhdx`。三个命名卷 `gitlab-config`、`gitlab-data`、`gitlab-logs` 也在这个文件内，不会往 C 盘写。

## 排障

| 现象 | 原因与处理 |
|---|---|
| `curl` 对 `127.0.0.1:8929` 返回 502 | 请求被 Windows 侧的 HTTP 代理接管。脚本会先 `unset` 代理变量，手写命令时加 `--noproxy '*'` |
| API 返回 401，且取到的 token 长度是 41 | `.env` 是 CRLF 行尾，token 尾部带了一个 `\r`。用 `init-env.sh` 生成，或在脚本里 `tr -d '\r'` |
| 容器反复重启，日志停在 recipes 阶段 | 卷的属主不对。GitLab 要求 uid 998，把 `D:\` 下的目录 bind mount 进 `/var/opt/gitlab` 会失败，只能用命名卷 |
| 浏览器第一次打开很慢 | 首次请求要编译 Rails 资源，之后正常 |
| WSL 重启后容器不见了 | Docker 服务随 systemd 启动，需要重新 `docker compose up -d` |
| 实例过一阵子变成 `unreachable` | WSL 空闲断电，见“让 WSL 保持运行” |
| 添加实例报 `GitLab token is invalid` | 12.7 不认 `Bearer` 传的 PAT。`verify.js` 会回退到 `PRIVATE-TOKEN`，服务端是旧代码时重启一次即可 |

## 已知限制

- Docker Hub 上 12.7 系列最后一个是 `12.7.9-ce.0`，12.7.10 及以上没有镜像。内网若跑更高补丁，本地测不到那部分差异。
- 镜像基于 Debian stretch，早已 EOL。这个实例只用于联调，不放进任何生产链路。
- 端口 8929 与 2224 写死。改端口要同时改 `GITLAB_OMNIBUS_CONFIG` 里的 `external_url`，否则 GitLab 生成的链接会指回旧端口。
- `root@gitlab.local` 是占位邮箱，实例没有外发邮件通道，所有通知邮件都发不出去。
