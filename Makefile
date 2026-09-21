.PHONY: help setup dev up down test e2e lint format coverage audit hooks build run
.DEFAULT_GOAL := help

help: ## list these targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk -F':.*?## ' '{printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

setup: ## build dev images and install deps exactly as the lockfile says
	docker compose build
	docker compose run --rm backend npm ci

dev: ## backend :8080 + vite :5173 with hot reload
	docker compose up

up: ## same as dev, but detached
	docker compose up -d
	@echo
	@echo "  app: http://localhost:$${VK_FRONTEND_PORT:-5173}"
	@echo "  api: http://localhost:$${VK_BACKEND_PORT:-8080}/api/health"
	@echo

down: ## stop the dev stack
	docker compose down

test: ## vitest, backend and frontend
	docker compose run --rm backend npm test

e2e: ## smoke the built app in a real browser (builds the frontend first)
	docker compose run --rm backend sh -c "npx vite build frontend && npx vitest run --config e2e/vitest.config.ts"

lint: ## tsc --noEmit across workspaces, then eslint, shellcheck, prettier
	docker compose run --rm backend npm run lint

format: ## prettier --write over the repo, and eslint's fixable findings
	docker compose run --rm backend sh -c "npx prettier --write . && npx eslint --fix ."

coverage: ## vitest with coverage, report-only (floors on paths.ts and origin.ts); html in */coverage
	docker compose run --rm backend npm run coverage --workspaces

audit: ## npm audit of what ships (dev tooling excluded), high and above
	docker compose run --rm backend npm audit --omit=dev --audit-level=high

hooks: ## opt in to the repo's git hooks (a prettier check on what is staged)
	git config core.hooksPath .githooks

build: ## production image for this machine's arch; VK_PLATFORM=linux/amd64 for the cluster's
	docker build $${VK_PLATFORM:+--platform $$VK_PLATFORM} --target runtime -t verksted .

run: ## run the production image locally (needs .env, see .env.example); VK_PORT overrides 8080
	docker run --rm -it -p $${VK_BIND:-127.0.0.1}:$${VK_PORT:-8080}:8080 --env-file .env -v verksted-data:/data verksted
