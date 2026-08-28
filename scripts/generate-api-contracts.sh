#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openapi_spec="$repo_root/api/openapi.yaml"
mkdir -p "$repo_root/apps/web/lib/api/generated" "$repo_root/internal/transport/httpapi/generated"

npx --yes openapi-typescript@7.9.1 "$openapi_spec" -o "$repo_root/apps/web/lib/api/generated/openapi.ts"
go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.4.1 \
  -generate types -package generated "$openapi_spec" | sed '1{/^WARNING:/d;}' > "$repo_root/internal/transport/httpapi/generated/openapi.gen.go"

gofmt -w "$repo_root/internal/transport/httpapi/generated/openapi.gen.go"
