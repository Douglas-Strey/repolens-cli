import csv
import sys
from pathlib import Path

from app.util import normalize_header


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m app.main <file.csv>", file=sys.stderr)
        return 2

    source = Path(argv[1])
    with source.open(newline="") as fh:
        reader = csv.reader(fh)
        header = [normalize_header(h) for h in next(reader)]
        writer = csv.writer(sys.stdout)
        writer.writerow(header)
        writer.writerows(reader)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
