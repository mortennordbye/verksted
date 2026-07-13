.PHONY: setup dev up down test lint build run

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

test:
	docker compose run --rm backend npm test

lint:
	docker compose run --rm backend npm run lint

build: ## production image
	docker build --target runtime -t verksted .

run: ## run the production image locally (needs .env, see .env.example); VK_PORT overrides 8080
	docker run --rm -it -p $${VK_PORT:-8080}:8080 --env-file .env -v verksted-data:/data verksted
