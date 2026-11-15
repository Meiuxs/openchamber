#!/usr/bin/env bash
# Writes .env with a generated root password. Run inside WSL from this folder.
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  echo '.env already exists, left untouched'
  exit 0
fi

password=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
printf 'GITLAB_ROOT_PASSWORD=%s\n' "$password" > .env
chmod 600 .env
echo 'wrote .env with a generated root password'
