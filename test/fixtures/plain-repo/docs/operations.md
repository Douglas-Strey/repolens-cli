# Operations

## Deploying

```sh
./scripts/deploy.sh app-01.internal
```

Releases are kept under `/srv/plain-repo/releases`; `current` is a symlink to the active one.

## Backups

`./scripts/backup.sh` archives the `output/` directory into `backups/`. It runs nightly via cron on the batch host.
