SHELL := /bin/sh

COMPOSE ?= docker compose
TASK_COUNT ?= 10000
COMMENT_COUNT ?= 12000
POSTGRES_DB ?= taskapp
POSTGRES_USER ?= taskapp
POSTGRES_PASSWORD ?= taskapp
DB_CONTAINER_URL := postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@db:5432/$(POSTGRES_DB)?sslmode=disable

.DEFAULT_GOAL := help

.PHONY: help stack-up stack-down db-up db-down db-reset migrate-up migrate-down \
	migrate-status seed-demo seed-scale seed-scenarios db-verify dev test test-backend test-web test-workers test-e2e \
	lint build build-backend build-web load logs generate-contracts

help:
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "%-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

stack-up: ## Build and start the complete distributed local stack
	$(COMPOSE) up --build -d --wait db migrate redis redpanda minio relay description-compactor api web

stack-down: ## Stop the stack while preserving database data
	$(COMPOSE) down --remove-orphans

db-up: ## Start PostgreSQL and wait until it is healthy
	$(COMPOSE) up -d --wait db

db-down: ## Stop PostgreSQL while preserving its named volume
	$(COMPOSE) stop db

db-reset: ## Recreate only the disposable local Compose database, migrate, and seed it
	ALLOW_LOCAL_DB_RESET=1 POSTGRES_DB=taskapp ./scripts/db-reset.sh

migrate-up: db-up ## Apply every pending migration
	$(COMPOSE) run --rm --build migrate

migrate-down: db-up ## Roll back the most recent migration
	$(COMPOSE) run --rm --build migrate -dir=/migrations postgres '$(DB_CONTAINER_URL)' down

migrate-status: db-up ## Show migration status
	$(COMPOSE) run --rm --build migrate -dir=/migrations postgres '$(DB_CONTAINER_URL)' status

seed-demo: ## Migrate and load deterministic demo users/projects/tasks/comments
	./scripts/seed-demo.sh

seed-scale: ## Add TASK_COUNT tasks and COMMENT_COUNT comments to the scale project
	TASK_COUNT=$(TASK_COUNT) COMMENT_COUNT=$(COMMENT_COUNT) ./scripts/seed-scale.sh

seed-scenarios: ## Reset and load the deterministic 10k-task, 12k-comment scenario projects
	TASK_COUNT=$(TASK_COUNT) COMMENT_COUNT=$(COMMENT_COUNT) ./scripts/seed-scenarios.sh

db-verify: seed-demo ## Verify schema, isolation constraints, indexes, and query plan
	./scripts/db-verify.sh

dev: ## Build and run the complete local application in the foreground
	$(COMPOSE) up --build db migrate redis redpanda minio relay description-compactor api web

test: test-backend test-web test-workers ## Run backend, frontend, and worker test suites

test-backend: ## Run Go tests in the pinned build image
	docker run --rm -v "$(CURDIR):/src" -w /src golang:1.23-alpine go test ./cmd/... ./internal/...

test-web: ## Run frontend tests when present
	npm --prefix apps/web run test --if-present

test-workers: ## Run the description compactor worker tests
	npm --prefix workers/description-compactor ci
	npm --prefix workers/description-compactor test

test-e2e: ## Run the focused browser smoke tests
	npm --prefix apps/web run test:e2e

lint: ## Run Go vet and frontend lint/type checks
	docker run --rm -v "$(CURDIR):/src" -w /src golang:1.23-alpine go vet ./cmd/... ./internal/...
	npm --prefix apps/web run lint
	npm --prefix apps/web run typecheck --if-present

build: build-backend build-web ## Build both deployable applications

build-backend: ## Build the Go API container
	$(COMPOSE) build api

build-web: ## Build the Next.js container
	$(COMPOSE) build web

load: seed-scale ## Run the checked-in k6 task-list scenario
	$(COMPOSE) run --rm load

generate-contracts: ## Generate Go and TypeScript types from OpenAPI
	./scripts/generate-api-contracts.sh

logs: ## Follow application and collaboration infrastructure logs
	$(COMPOSE) logs -f db redis redpanda minio relay description-compactor api web
