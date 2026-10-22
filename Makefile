.PHONY: install lint typecheck test build run docker-build docker-run
install:
	python -m pip install -e ".[dev]"
	npm ci
lint:
	python -m ruff check src tests
	python -m bandit -r src -q
	npm run lint
typecheck:
	python -m mypy src
	npm run typecheck
test: build
	python -m pytest
	npm run test:e2e
build:
	npm run build
run: build
	python -m kuro
docker-build:
	docker build -t mayberry4477/kurontp:latest .
docker-run:
	docker compose up -d