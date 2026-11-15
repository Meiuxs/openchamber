#!/usr/bin/env bash
# Prepares the WSL distro that runs Docker: engine, compose plugin, and the proxy
# the daemon needs to reach the registry when the machine sits behind one.
#
#   PROXY_URL=http://127.0.0.1:7897 bash bootstrap-wsl.sh
#
# PROXY_URL is optional. Leave it out on a machine with direct internet access.
set -euo pipefail

PROXY_URL=${PROXY_URL:-}

if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io
  systemctl enable --now docker
fi

if [ -n "$PROXY_URL" ]; then
  mkdir -p /etc/systemd/system/docker.service.d
  cat > /etc/systemd/system/docker.service.d/proxy.conf <<CONF
[Service]
Environment="HTTP_PROXY=$PROXY_URL"
Environment="HTTPS_PROXY=$PROXY_URL"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
CONF
  systemctl daemon-reload
  systemctl restart docker
fi

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose >/dev/null 2>&1 || true

docker info 2>/dev/null | grep -i proxy || echo 'no daemon proxy configured'
docker compose version 2>/dev/null || docker-compose version
