FROM golang:1.23-alpine AS build

WORKDIR /src
RUN apk add --no-cache ca-certificates git

COPY go.* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S app \
    && adduser -S -G app -u 10001 app

COPY --from=build /out/relay /usr/local/bin/relay
USER app
ENTRYPOINT ["/usr/local/bin/relay"]
