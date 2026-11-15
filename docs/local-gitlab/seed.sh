#!/usr/bin/env bash
# Checks the API with the stored token and creates one demo project.
# Reads GITLAB_TOKEN from .env next to this script. Run inside WSL.
set -euo pipefail

cd "$(dirname "$0")"

# The machine's proxy must not see loopback traffic.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

TOKEN=$(grep '^GITLAB_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
BASE=${GITLAB_BASE_URL:-http://127.0.0.1:8929}
API="$BASE/api/v4"
PROJECT=hello-demo

echo "--- user"
curl -sf -H "PRIVATE-TOKEN: $TOKEN" "$API/user" | grep -o '"username":"[^"]*"'

echo "--- project"
if curl -sf -o /dev/null -H "PRIVATE-TOKEN: $TOKEN" "$API/projects/root%2F$PROJECT"; then
  echo "root/$PROJECT already exists"
else
  curl -s -X POST -H "PRIVATE-TOKEN: $TOKEN" "$API/projects" \
    -d "name=$PROJECT" -d "path=$PROJECT" -d "visibility=private" \
    | grep -o '"path_with_namespace":"[^"]*"'
fi

echo "--- version"
curl -sf -H "PRIVATE-TOKEN: $TOKEN" "$API/version"
