#!/bin/sh
# Deploys the app to Cloud Run: api + web as autoscaled Services, relay +
# description-compactor as autoscaled Worker Pools (background, non-HTTP), and
# migrate as a Job run once per deploy. Postgres is a self-run Cloud SQL instance
# and attachments are a Cloud Storage bucket accessed natively (no S3 shim, no key
# material) — both provisioned by this script, both GCP-managed infra rather than
# a BaaS. Redis/Kafka are expected to already be managed elsewhere (Upstash Redis /
# Redpanda Serverless).
#
# Usage:
#   cp deploy/cloudrun/env.example deploy/cloudrun/env
#   $EDITOR deploy/cloudrun/env
#   set -a; . deploy/cloudrun/env; set +a
#   ./deploy/cloudrun/deploy.sh
#
# Requires: gcloud (authenticated, billing enabled on GCP_PROJECT), docker.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_dir"

: "${GCP_PROJECT:?set GCP_PROJECT (see deploy/cloudrun/env.example)}"
: "${GCP_REGION:=us-central1}"
: "${CLOUDSQL_INSTANCE:=happy-task-management-db}"
: "${CLOUDSQL_TIER:=db-g1-small}"
: "${CLOUDSQL_DB_NAME:=taskapp}"
: "${CLOUDSQL_DB_USER:=taskapp}"
: "${CLOUDSQL_DB_PASSWORD:?set CLOUDSQL_DB_PASSWORD}"
: "${REDIS_URL:?set REDIS_URL}"
: "${REDPANDA_BROKERS:?set REDPANDA_BROKERS}"
: "${S3_BUCKET:=$GCP_PROJECT-attachments}"
: "${KAFKA_SASL_USERNAME:=}"
: "${KAFKA_SASL_PASSWORD:=}"
: "${CORS_ALLOWED_ORIGINS:=}"
: "${AR_REPO:=happy-task-management}"
: "${TAG:=$(git rev-parse --short HEAD)}"
: "${API_MIN_INSTANCES:=0}"
: "${WEB_MIN_INSTANCES:=0}"

registry="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$AR_REPO"

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com iam.googleapis.com

gcloud artifacts repositories describe "$AR_REPO" --location="$GCP_REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$GCP_REGION"
gcloud auth configure-docker "$GCP_REGION-docker.pkg.dev" --quiet

# --- Cloud SQL for PostgreSQL: self-run instance (not a BaaS), reached over the
# Unix-socket connector every Postgres-touching Cloud Run resource below mounts
# via --*-cloudsql-instances. ZONAL keeps this cheap; switch to
# --availability-type=REGIONAL for real failover once this isn't just a demo.
if ! gcloud sql instances describe "$CLOUDSQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$CLOUDSQL_INSTANCE" \
    --database-version=POSTGRES_17 --tier="$CLOUDSQL_TIER" --region="$GCP_REGION" \
    --storage-auto-increase --availability-type=ZONAL
fi
gcloud sql databases describe "$CLOUDSQL_DB_NAME" --instance="$CLOUDSQL_INSTANCE" >/dev/null 2>&1 \
  || gcloud sql databases create "$CLOUDSQL_DB_NAME" --instance="$CLOUDSQL_INSTANCE"
gcloud sql users create "$CLOUDSQL_DB_USER" --instance="$CLOUDSQL_INSTANCE" --password="$CLOUDSQL_DB_PASSWORD" >/dev/null 2>&1 \
  || gcloud sql users set-password "$CLOUDSQL_DB_USER" --instance="$CLOUDSQL_INSTANCE" --password="$CLOUDSQL_DB_PASSWORD"
cloudsql_connection=$(gcloud sql instances describe "$CLOUDSQL_INSTANCE" --format='value(connectionName)')
DATABASE_URL="postgres://$CLOUDSQL_DB_USER:$CLOUDSQL_DB_PASSWORD@/$CLOUDSQL_DB_NAME?host=/cloudsql/$cloudsql_connection&sslmode=disable"

put_secret() {
  name=$1; value=$2
  [ -n "$value" ] || return 0
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=-
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
  fi
}
put_secret database-url "$DATABASE_URL"
put_secret redis-url "$REDIS_URL"
put_secret kafka-sasl-password "$KAFKA_SASL_PASSWORD"

# --- attachments bucket: Cloud Storage, accessed natively via Application Default
# Credentials (internal/platform/objectstorage.Open routes to the GCS backend
# whenever AWS_ACCESS_KEY_ID isn't set). The api service runs as its own dedicated
# service account so no key material is ever generated, stored, or rotated — just
# an IAM grant on the bucket.
api_sa="happy-task-api@$GCP_PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$api_sa" >/dev/null 2>&1 \
  || gcloud iam service-accounts create happy-task-api --display-name="Happy Task Management api runtime identity"
gcloud storage buckets describe "gs://$S3_BUCKET" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$S3_BUCKET" --location="$GCP_REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://$S3_BUCKET" \
  --member="serviceAccount:$api_sa" --role=roles/storage.objectAdmin >/dev/null

build_push() {
  name=$1; dockerfile=$2; context=$3; shift 3
  docker build -f "$dockerfile" -t "$registry/$name:$TAG" "$@" "$context"
  docker push "$registry/$name:$TAG"
}

build_push migrate deploy/migrate.Dockerfile .
build_push api deploy/api.Dockerfile .
build_push relay deploy/relay.Dockerfile .
build_push description-compactor deploy/description-compactor.Dockerfile .

# --- migrate: run once, wait for completion ---
gcloud run jobs deploy migrate \
  --image="$registry/migrate:$TAG" --region="$GCP_REGION" \
  --command=/bin/sh --args='-c,exec goose -dir=/migrations postgres "$DATABASE_URL" up' \
  --set-secrets=DATABASE_URL=database-url:latest \
  --set-cloudsql-instances="$cloudsql_connection" --max-retries=0
gcloud run jobs execute migrate --region="$GCP_REGION" --wait

# --- api: autoscaled Service ---
gcloud run deploy api \
  --image="$registry/api:$TAG" --region="$GCP_REGION" \
  --service-account="$api_sa" \
  --allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi --concurrency=80 \
  --min-instances="$API_MIN_INSTANCES" --max-instances="${API_MAX_INSTANCES:-20}" \
  --add-cloudsql-instances="$cloudsql_connection" \
  --set-env-vars="^##^HTTP_ADDR=:8080##PORT=8080##AUTH_REQUIRED=true##AUTH_COOKIE_SECURE=true##LOG_LEVEL=info##S3_BUCKET=$S3_BUCKET##S3_CREATE_BUCKET=false##REDPANDA_BROKERS=$REDPANDA_BROKERS##KAFKA_SASL_USERNAME=$KAFKA_SASL_USERNAME##CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS:-*}" \
  --set-secrets="DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,KAFKA_SASL_PASSWORD=kafka-sasl-password:latest"
api_url=$(gcloud run services describe api --region="$GCP_REGION" --format='value(status.url)')

# --- web: built with the api URL baked in, then deployed as an autoscaled Service ---
build_push web deploy/web.Dockerfile ./apps/web \
  --build-arg NEXT_PUBLIC_API_BASE_URL="$api_url" --build-arg NEXT_PUBLIC_DATA_SOURCE=api
gcloud run deploy web \
  --image="$registry/web:$TAG" --region="$GCP_REGION" \
  --allow-unauthenticated --port=3000 --cpu=1 --memory=512Mi --concurrency=80 \
  --min-instances="$WEB_MIN_INSTANCES" --max-instances="${WEB_MAX_INSTANCES:-20}" \
  --set-env-vars="API_BASE_URL=$api_url,NEXT_PUBLIC_API_BASE_URL=$api_url,NEXT_PUBLIC_DATA_SOURCE=api"
web_url=$(gcloud run services describe web --region="$GCP_REGION" --format='value(status.url)')

# api's CORS list wasn't known until web existed; add it now.
final_cors="${CORS_ALLOWED_ORIGINS:+$CORS_ALLOWED_ORIGINS,}$web_url"
gcloud run services update api --region="$GCP_REGION" \
  --update-env-vars="^##^CORS_ALLOWED_ORIGINS=$final_cors"

# --- relay + description-compactor: Worker Pools (no HTTP port, pull-based).
# Worker pools run a FIXED instance count (--instances=N), not min/max autoscaling
# — that's a real Cloud Run limitation, not a config choice. Both are cheap/idle-most
# -of-the-time here, so a small fixed count covers the load-test scale in docs/. Real
# autoscaling needs the separate Kafka Autoscaler add-on watching consumer lag; see
# https://docs.cloud.google.com/run/docs/configuring/workerpools/kafka-autoscaler
gcloud run worker-pools deploy relay \
  --image="$registry/relay:$TAG" --region="$GCP_REGION" --cpu=1 --memory=256Mi \
  --instances="${RELAY_INSTANCES:-2}" \
  --set-cloudsql-instances="$cloudsql_connection" \
  --set-env-vars="^##^REDPANDA_BROKERS=$REDPANDA_BROKERS##KAFKA_SASL_USERNAME=$KAFKA_SASL_USERNAME" \
  --set-secrets="DATABASE_URL=database-url:latest,REDIS_URL=redis-url:latest,KAFKA_SASL_PASSWORD=kafka-sasl-password:latest"

gcloud run worker-pools deploy description-compactor \
  --image="$registry/description-compactor:$TAG" --region="$GCP_REGION" --cpu=1 --memory=256Mi \
  --instances="${COMPACTOR_INSTANCES:-1}" \
  --set-cloudsql-instances="$cloudsql_connection" \
  --set-env-vars="^##^COMPACTION_THRESHOLD=500##COMPACTION_INTERVAL_MS=5000" \
  --set-secrets="DATABASE_URL=database-url:latest"

echo "api: $api_url"
echo "web: $web_url"
