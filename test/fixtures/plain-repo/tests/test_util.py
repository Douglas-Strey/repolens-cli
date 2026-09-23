import pytest

from app.util import normalize_header, parse_bool


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("First Name", "first_name"),
        ("  Order  ID ", "order_id"),
        ("Total ($)", "total"),
    ],
)
def test_normalize_header(raw, expected):
    assert normalize_header(raw) == expected


def test_parse_bool():
    assert parse_bool("Yes")
    assert not parse_bool("no")
