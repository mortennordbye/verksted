.PHONY: help setup dev up down test e2e lint build run
.DEFAULT_GOAL := help

help: ## list these targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk -F':.*?## ' '{printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

setup: ## build dev images and install deps (writes package-lock.json back to the host)
	docker compose build
	docker compose run --rm backend npm install

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

lint: ## tsc --noEmit across workspaces, then eslint
	docker compose run --rm backend npm run lint

build: ## production image
	docker build --target runtime -t verksted .

run: ## run the production image locally (needs .env, see .env.example); VK_PORT overrides 8080
	docker run --rm -it -p $${VK_PORT:-8080}:8080 --env-file .env -v verksted-data:/data verksted
