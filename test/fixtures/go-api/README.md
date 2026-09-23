# go-api

User service built with [Gin](https://gin-gonic.com) and PostgreSQL (pgx), plus a Redis-backed background worker.

## Getting started

```sh
cp .env.example .env
make run
```

The API listens on `:8080` by default; metrics are served on `:9090/metrics`.

## Commands

| Command             | Description                 |
| ------------------- | --------------------------- |
| `make build`        | Build `bin/api` and `bin/worker` |
| `make test`         | Run the test suite          |
| `make lint`         | Run golangci-lint           |
| `make docker-build` | Build the container image   |
