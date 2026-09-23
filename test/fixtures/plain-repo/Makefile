# Makefile for plain-repo
PYTHON ?= python3
VENV   := .venv

.PHONY: install test lint clean

# Create a virtualenv and install dependencies
install:
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install -r requirements.txt

# Run the unit tests
test:
	$(VENV)/bin/python -m pytest -q tests

# Static checks
lint:
	$(VENV)/bin/ruff check app tests

# Remove build artifacts and caches
clean:
	rm -rf $(VENV) .pytest_cache .ruff_cache
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
