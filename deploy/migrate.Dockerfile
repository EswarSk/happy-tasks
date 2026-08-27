# syntax=docker/dockerfile:1.7

FROM golang:1.25.7-alpine AS build

RUN --mount=type=cache,target=/go/pkg/mod \
    GOBIN=/out go install github.com/pressly/goose/v3/cmd/goose@v3.27.3

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/goose /usr/local/bin/goose

ENTRYPOINT ["/usr/local/bin/goose"]
