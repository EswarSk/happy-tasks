#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

task_count=${TASK_COUNT:-10000}
comment_count=${COMMENT_COUNT:-12000}

case "$task_count" in
    ''|*[!0-9]*) echo "TASK_COUNT must be a positive integer" >&2; exit 2 ;;
esac
case "$comment_count" in
    ''|*[!0-9]*) echo "COMMENT_COUNT must be a non-negative integer" >&2; exit 2 ;;
esac
if [ "$task_count" -lt 100 ]; then
    echo "TASK_COUNT must be at least 100 so every named scenario can be generated" >&2
    exit 2
fi

docker compose up -d --wait db
docker compose run --rm --build migrate
docker compose exec -T db sh -c \
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1' \
    -v task_count="$task_count" \
    -v comment_count="$comment_count" \
    < db/seed/scenarios.sql
docker compose exec -T db sh -c \
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1' \
    -v task_count="$task_count" \
    -v comment_count="$comment_count" \
    < db/checks/verify-scenarios.sql
