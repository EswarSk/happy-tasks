#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

[ -f .env ] || cp .env.example .env

make stack-up

cat <<'EOF'

Ready: http://localhost:3000
Empty database — sign up for a new account to get a private starter project.
EOF
