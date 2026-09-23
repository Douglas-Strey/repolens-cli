# Test fixtures

Small but realistic repositories that RepoLens is tested against. Tests copy a
fixture into a temporary directory before scanning it (see `test/helpers.ts`),
so fixtures never pick up this repository's own Git metadata.

Rules for fixtures:

- A fixture's ignore rules live in `_gitignore`, not `.gitignore`. A real
  `.gitignore` would hide fixture files (for example `monorepo/.env`) from this
  repository's own Git, so they would never be committed. `copyFixture()` renames
  `_gitignore` back to `.gitignore` in the temporary copy.

- Every value in a local env file (`.env`, `.env.local`) or Compose
  `environment:` block contains the sentinel `REPOLENS_FIXTURE_SECRET`. Tests
  assert that the sentinel never appears in any RepoLens output.
- Never commit strings in a real credential format (`sk_live_…`, `ghp_…`,
  `AKIA…`, private keys). Tests that need them build them at runtime.
- Keep fixtures minimal. Don't add files to an existing fixture without
  checking which tests rely on it; prefer a new fixture.

| Fixture | What it exercises |
| --- | --- |
| `nuxt-app` | Nuxt 4 (`app/` layout), pnpm. Pages `/`, `/about`, `/products`, `/products/:id`. Server routes GET `/api/products`, GET `/api/products/:id`, POST `/api/cart`, ANY `/api/health`, ANY `/sitemap.xml`; `server/middleware/log.ts` is not a route. `.nvmrc` 22. Clean. |
| `next-app` | Next.js App Router, npm, Prisma (PostgreSQL), Jest. Route group `(marketing)/pricing` → `/pricing`. API: GET+POST `/api/users`, GET+DELETE `/api/users/:id` (`export const GET =` form), Pages Router `/api/legacy`. **`AUTH_SECRET` used but undocumented.** `.node-version` 22.20.0, engines `>=20.9`. |
| `fastify-api` | Fastify 5, Yarn Berry, Drizzle (PostgreSQL), ioredis, Biome, Vitest, Dockerfile, GitHub Actions. Routes GET `/health`; GET/POST `/`, GET/DELETE `/:id` on a plugin registered with prefix `/users`; `route()` POST `/orders`, GET+HEAD `/orders/:id`. Clean. |
| `express-api` | Express 5, CommonJS, npm, Mongoose (MongoDB), `node --test`. Routes GET `/`; router GET/POST `/`, PUT/DELETE `/:id` mounted at `/api/items`; `router.route('/health').get().post()`. Clean. |
| `nest-api` | NestJS 11, pnpm, TypeORM (MySQL), Jest. `/users` (GET, POST), `/users/:id` (GET, PATCH, DELETE), GET `/health`. Clean. |
| `go-api` | Go 1.25.1 module with two `main` packages (`cmd/api`, `cmd/worker`). Gin: GET `/health`, GET+POST `/api/v1/users`, GET `/api/v1/users/:id` (group prefix). net/http: `GET /metrics`, ANY `/debug/vars`. Makefile, golangci-lint, multi-stage Dockerfile (EXPOSE 8080), GitHub Actions. |
| `monorepo` | pnpm workspaces + Turborepo 2 + pnpm catalog. `@acme/web` (Nuxt), `@acme/api` (Fastify + Prisma), `@acme/ui`, `@acme/shared`; `services/billing` Go module outside the JS workspace. Compose: postgres:17 (5432), redis:8 (6379), minio (9000/9001). **`STRIPE_SECRET_KEY` used but in neither `.env` nor `.env.example`.** |
| `docker-project` | Compose-centric. **Obsolete `version: "3.9"`.** **`.env.example` points `DATABASE_URL` at 5433 while Compose publishes 5432.** List- and map-form `environment`, long-form `depends_on`, profiles, long-syntax ports, `127.0.0.1` binding, `docker-compose.override.yml`, `ARG NPM_TOKEN`, `env_file: .env` without a `.env`. |
| `broken-env` | Vite + React. **Undocumented:** `VITE_SENTRY_DSN`, `VITE_FEATURE_FLAGS` (bracket access), `ANALYTICS_KEY` (destructuring), `LEGACY_TOKEN` (`process.env["…"]`). `MODE`/`DEV` are Vite built-ins. **Unused:** `LEGACY_FLAG`. **Defined but undocumented:** `SECRET_TOKEN`, `EXPORTED_VAR` (`export` line), `APP_TITLE` (quoted value); `OLD_KEY` is commented out. **`.gitignore` lacks `.env`.** npm placeholder `test` script. |
| `mixed-lockfiles` | **`package-lock.json` + `pnpm-lock.yaml`** with `packageManager: pnpm@9.15.9`. **Node conflict:** `.nvmrc` 20, `.node-version` 18.20.4, engines `>=22`. **Legacy `.eslintrc.json` with ESLint 9.** |
| `legacy-config` | **`workspaces` in package.json and `pnpm-workspace.yaml`.** **Pattern `tools/*` matches nothing.** **`turbo.json` uses `pipeline` with turbo ^2.** **Compose `version: '3.8'`.** **Two services publish host port 8080.** **Legacy `.eslintrc.cjs`.** |
| `broken-config` | Valid package.json; invalid `docker-compose.yml`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `turbo.json`, `tsconfig.json`, and a `go.mod` without a module line. RepoLens must not crash. |
| `broken-manifest` | Malformed root `package.json`. |
| `plain-repo` | Python project with no JS/Go: Makefile targets, shell scripts, CI running `make test`. Output must still be useful. |
| `bun-app` | Bun (`bun.lock` text lockfile, `bunfig.toml`), Hono routes GET `/`, POST `/webhooks/:id`. Uses `Bun.env.WEBHOOK_SECRET` and `process.env.PORT`; no `.env.example`. |
