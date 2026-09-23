import re

_WHITESPACE = re.compile(r"\s+")


def normalize_header(name: str) -> str:
    """Convert a CSV header into snake_case."""
    cleaned = _WHITESPACE.sub(" ", name).strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", cleaned).strip("_")


def parse_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "y"}
