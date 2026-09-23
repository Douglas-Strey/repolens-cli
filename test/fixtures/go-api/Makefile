BINARY := bin/api
WORKER := bin/worker
IMAGE  ?= acme/go-api:dev

.PHONY: build test lint run docker-build

## build: compile the api and worker binaries
build:
	go build -o $(BINARY) ./cmd/api
	go build -o $(WORKER) ./cmd/worker

## test: run unit tests with the race detector
test:
	go test -race ./...

## lint: run golangci-lint
lint:
	golangci-lint run ./...

## run: run the api locally
run:
	go run ./cmd/api

## docker-build: build the container image
docker-build:
	docker build -t $(IMAGE) .
