#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

[ -f .env ] || cp .env.example .env

make seed-demo
make stack-up

cat <<'EOF'

Ready: http://localhost:3000
Log in with maya@example.test / password to see the seeded demo project.

For the full 10k-task/12k-comment scenario pack, run: make seed-scenarios
EOF
