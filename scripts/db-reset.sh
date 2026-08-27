#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

if [ "${ALLOW_LOCAL_DB_RESET:-}" != "1" ]; then
    echo "Refusing reset. Set ALLOW_LOCAL_DB_RESET=1 for the disposable Compose database." >&2
    exit 2
fi

database_name=${POSTGRES_DB:-}
if [ "$database_name" != "taskapp" ]; then
    echo "Refusing reset: POSTGRES_DB must be explicitly set to the local 'taskapp' database." >&2
    exit 2
fi

echo "Removing only the happy-task-management Compose stack and its named local volume."
docker compose down --volumes --remove-orphans
docker compose up -d --wait db
docker compose run --rm --build migrate
"$repo_dir/scripts/seed-demo.sh"
