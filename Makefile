# KeepSync Cross-Platform Makefile
# Supports Windows (PowerShell), Linux, and macOS

# Variables
BINARY_NAME := keepsync-server
SERVER_DIR := server
EXTENSION_DIR := extension
DIST_DIR := dist
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "v1.0.0-dev")

# Detect OS
ifeq ($(OS),Windows_NT)
    DETECTED_OS := Windows
    BINARY_EXT := .exe
    RM := Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    MKDIR := New-Item -ItemType Directory -Force
    COPY := Copy-Item -Recurse
else
    DETECTED_OS := $(shell uname -s)
    BINARY_EXT :=
    RM := rm -rf
    MKDIR := mkdir -p
    COPY := cp -r
endif

# Default target
.PHONY: help
help:
	@echo "KeepSync Build System"
	@echo "========================"
	@echo ""
	@echo "Available commands:"
	@echo "  make build           - Build server and extension"
	@echo "  make server          - Build Go server only"
	@echo "  make extension       - Build browser extension"
	@echo "  make test            - Run all tests"
	@echo "  make test-server     - Run Go server tests"
	@echo "  make test-integration - Run integration tests"
	@echo "  make clean           - Clean build artifacts"
	@echo "  make docker          - Build Docker image"
	@echo "  make docker-run      - Run with Docker Compose"
	@echo "  make deploy          - Deploy to production"
	@echo "  make dev             - Start development environment"
	@echo "  make lint            - Run linters"
	@echo "  make format          - Format code"
	@echo ""
	@echo "Extension specific:"
	@echo "  make extension-chrome  - Build for Chrome"
	@echo "  make extension-firefox - Build for Firefox"
	@echo "  make extension-package - Create distribution packages"
	@echo ""
	@echo "OS detected: $(DETECTED_OS)"

# Build targets
.PHONY: build
build: server extension

.PHONY: server
server:
	@echo "Building Go server..."
	cd $(SERVER_DIR) && CGO_ENABLED=1 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY_NAME)$(BINARY_EXT) ./cmd

.PHONY: extension
extension:
	@echo "Building browser extension (release / minified)..."
	@echo "NOTE: For local development you do NOT need this step —"
	@echo "      load the ./extension folder directly as an unpacked extension."
	cd $(EXTENSION_DIR) && npm install && npm run build

.PHONY: extension-chrome
extension-chrome:
	@echo "Building Chrome extension (release / minified)..."
	cd $(EXTENSION_DIR) && npm install && npm run build:chrome

.PHONY: extension-firefox
extension-firefox:
	@echo "Building Firefox extension (release / minified)..."
	cd $(EXTENSION_DIR) && npm install && npm run build:firefox

.PHONY: extension-package
extension-package: extension-chrome extension-firefox
	@echo "Creating extension packages..."
ifeq ($(DETECTED_OS),Windows)
	cd $(EXTENSION_DIR) && Compress-Archive -Path dist\* -DestinationPath ..\$(DIST_DIR)\chrome-extension.zip -Force
	cd $(EXTENSION_DIR) && Compress-Archive -Path dist\* -DestinationPath ..\$(DIST_DIR)\firefox-extension.zip -Force
else
	$(MKDIR) $(DIST_DIR)
	cd $(EXTENSION_DIR)/dist && zip -r ../../$(DIST_DIR)/chrome-extension.zip .
	cd $(EXTENSION_DIR)/dist && zip -r ../../$(DIST_DIR)/firefox-extension.zip .
endif

# Test targets
.PHONY: test
test: test-server test-integration

.PHONY: test-server
test-server:
	@echo "Running Go server tests..."
	cd $(SERVER_DIR) && go test -v ./...

.PHONY: test-integration
test-integration:
	@echo "Running integration tests..."
	cd $(SERVER_DIR)/tests && go test -v .

.PHONY: test-extension
test-extension:
	@echo "Extension has no automated tests yet — load ./extension unpacked and test manually."
	@echo "See the top-level README's 'Testing the Features' section for the manual test plan."

.PHONY: benchmark
benchmark:
	@echo "Running benchmarks..."
	cd $(SERVER_DIR) && go test -bench=. ./...
	cd $(SERVER_DIR)/tests && go test -bench=. .

# Development targets
.PHONY: dev
dev:
	@echo "Starting development environment..."
	docker-compose -f docker-compose.dev.yml up --build

.PHONY: dev-server
dev-server:
	@echo "Starting development server..."
	cd $(SERVER_DIR) && go run ./cmd

.PHONY: dev-extension
dev-extension:
	@echo "Extension does not need a watch/build process for development."
	@echo "Load the ./extension folder unpacked in your browser and click"
	@echo "Reload on the extension card after each edit."

# Docker targets
.PHONY: docker
docker:
	@echo "Building Docker image..."
	docker build -t keepsync-server:$(VERSION) ./$(SERVER_DIR)
	docker tag keepsync-server:$(VERSION) keepsync-server:latest

.PHONY: docker-run
docker-run:
	@echo "Running with Docker Compose..."
	docker-compose up -d

.PHONY: docker-stop
docker-stop:
	@echo "Stopping Docker containers..."
	docker-compose down

.PHONY: docker-logs
docker-logs:
	@echo "Viewing Docker logs..."
	docker-compose logs -f

# Deployment targets
.PHONY: deploy
deploy: test build
	@echo "Deploying to production..."
	@echo "Make sure to set your environment variables first!"
	docker-compose -f docker-compose.prod.yml up -d --build

.PHONY: deploy-server
deploy-server: test-server server
	@echo "Deploying server binary..."
	# Copy binary to deployment location
	# Add your deployment commands here

# Code quality targets
.PHONY: lint
lint: lint-server lint-extension

.PHONY: lint-server
lint-server:
	@echo "Linting Go code..."
	cd $(SERVER_DIR) && go vet ./...
	cd $(SERVER_DIR) && golangci-lint run || echo "golangci-lint not installed, skipping"

.PHONY: lint-extension
lint-extension:
	@echo "Extension linter is not configured. Skipping."

.PHONY: format
format: format-server format-extension

.PHONY: format-server
format-server:
	@echo "Formatting Go code..."
	cd $(SERVER_DIR) && go fmt ./...

.PHONY: format-extension
format-extension:
	@echo "Extension formatter is not configured. Skipping."

# Database targets
.PHONY: db-migrate
db-migrate:
	@echo "Running database migrations..."
	cd $(SERVER_DIR) && go run ./cmd migrate

.PHONY: db-reset
db-reset:
	@echo "Resetting database..."
	$(RM) $(SERVER_DIR)/data/keepsync.db*
	$(MAKE) db-migrate

# Cleanup targets
.PHONY: clean
clean: clean-server clean-extension clean-docker

.PHONY: clean-server
clean-server:
	@echo "Cleaning server artifacts..."
	$(RM) $(SERVER_DIR)/$(BINARY_NAME)$(BINARY_EXT)
	$(RM) $(SERVER_DIR)/data

.PHONY: clean-extension
clean-extension:
	@echo "Cleaning extension artifacts..."
	$(RM) $(EXTENSION_DIR)/dist
	$(RM) $(EXTENSION_DIR)/node_modules

.PHONY: clean-docker
clean-docker:
	@echo "Cleaning Docker artifacts..."
	docker-compose down -v --remove-orphans || true
	docker image prune -f || true

.PHONY: clean-all
clean-all: clean
	@echo "Deep cleaning..."
	$(RM) $(DIST_DIR)
	docker system prune -f || true

# Utility targets
.PHONY: deps
deps: deps-server
	@echo "Extension has no runtime dependencies; npm is only needed for release packaging."

.PHONY: deps-server
deps-server:
	@echo "Installing Go dependencies..."
	cd $(SERVER_DIR) && go mod download && go mod tidy

.PHONY: deps-extension
deps-extension:
	@echo "Installing extension packaging dependencies (for release builds)..."
	cd $(EXTENSION_DIR) && npm install

.PHONY: update-deps
update-deps: update-deps-server

.PHONY: update-deps-server
update-deps-server:
	@echo "Updating Go dependencies..."
	cd $(SERVER_DIR) && go get -u ./... && go mod tidy

# Security targets
.PHONY: security-check
security-check:
	@echo "Running security checks..."
	cd $(SERVER_DIR) && gosec ./... || echo "gosec not installed, skipping"
	cd $(EXTENSION_DIR) && npm audit || echo "skip — extension has no runtime npm deps"

.PHONY: generate-secrets
generate-secrets:
	@echo "Generating secure secrets..."
	@echo "JWT_SECRET=$$(openssl rand -hex 32)" > .env.secrets
	@echo "Database password: $$(openssl rand -hex 16)"
	@echo "Secrets written to .env.secrets"

# Documentation targets
.PHONY: docs
docs:
	@echo "Generating documentation..."
	cd $(SERVER_DIR) && godoc -http=:6060 &
	@echo "Go docs available at http://localhost:6060"

# Release targets
.PHONY: release
release: clean test build extension-package
	@echo "Creating release $(VERSION)..."
	$(MKDIR) $(DIST_DIR)
	$(COPY) $(SERVER_DIR)/$(BINARY_NAME)$(BINARY_EXT) $(DIST_DIR)/
	$(COPY) README.md $(DIST_DIR)/
	$(COPY) DEPLOYMENT.md $(DIST_DIR)/
	$(COPY) docker-compose.yml $(DIST_DIR)/
	$(COPY) .env.example $(DIST_DIR)/
	@echo "Release $(VERSION) created in $(DIST_DIR)/"

.PHONY: version
version:
	@echo $(VERSION)

# Health check targets
.PHONY: health-check
health-check:
	@echo "Running health checks..."
	curl -f http://localhost:8787/healthz || echo "Server not responding"

.PHONY: metrics
metrics:
	@echo "Fetching metrics..."
	curl http://localhost:8787/metrics || echo "Metrics not available"

# Development environment setup
.PHONY: setup-dev
setup-dev:
	@echo "Setting up development environment..."
	$(MAKE) deps
	$(MAKE) generate-secrets
	@echo "Development environment ready!"
	@echo "1. Copy .env.example to .env and configure"
	@echo "2. Run 'make dev' to start development servers"

# CI/CD targets
.PHONY: ci
ci: deps lint test build

.PHONY: pre-commit
pre-commit: format lint test

# Install git hooks
.PHONY: install-hooks
install-hooks:
	@echo "Installing git hooks..."
	echo "#!/bin/sh" > .git/hooks/pre-commit
	echo "make pre-commit" >> .git/hooks/pre-commit
	chmod +x .git/hooks/pre-commit
	@echo "Git hooks installed"
