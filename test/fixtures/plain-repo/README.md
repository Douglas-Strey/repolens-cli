# plain-repo

Small Python utility that normalizes CSV exports before they are loaded into the warehouse.

## Usage

```sh
make install
python -m app.main data/export.csv
```

## Development

```sh
make test   # run the test suite
make lint   # run ruff
```

Deployment and backups are handled by the scripts in `scripts/`. See [docs/operations.md](docs/operations.md).
