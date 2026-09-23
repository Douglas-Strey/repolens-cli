# Acme monorepo

pnpm workspaces + Turborepo.

| Path               | What                                  |
| ------------------ | ------------------------------------- |
| `apps/web`         | Nuxt 4 storefront (port 3000)         |
| `apps/api`         | Fastify + Prisma API (port 4000)      |
| `packages/ui`      | Shared Vue components                 |
| `packages/shared`  | Shared TypeScript types and helpers   |
| `services/billing` | Go billing service (port 8081)        |

## Setup

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm db:up
pnpm dev
```

The billing service is not part of the pnpm workspace; run it with `go run ./services/billing`.
