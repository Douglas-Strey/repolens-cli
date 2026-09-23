/**
 * Hand-built scan results for renderer and doctor tests. `sampleScanResult()`
 * mirrors a realistic monorepo so renderers can be tested without scanning.
 */
import { emptySections } from '../src/core/empty.ts'
import type { Diagnostic, DoctorResult, ScanResult, Sections } from '../src/types.ts'
import { SCHEMA_VERSION } from '../src/types.ts'

export function emptyDoctor(): DoctorResult {
  return {
    checks: [],
    diagnostics: [],
    summary: { passed: 0, failed: 0, skipped: 0, disabled: 0, errors: 0, warnings: 0, infos: 0 },
  }
}

/** Sections with every field empty, plus overrides. */
export function makeSections(overrides: Partial<Sections> = {}, directory = 'project'): Sections {
  return { ...emptySections(directory), ...overrides }
}

/** A complete ScanResult with empty sections, plus overrides. */
export function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'repolens', version: '0.0.0-test' },
    ...makeSections({}, 'project'),
    doctor: emptyDoctor(),
    meta: { files: 0, truncated: false, warnings: [], config: { sources: [], settings: {} } },
    ...overrides,
  }
}

function doctorFrom(diagnostics: Diagnostic[], passed: number): DoctorResult {
  const failedCodes = new Set(diagnostics.map((d) => d.code))
  return {
    checks: [
      ...[...failedCodes].map((code) => {
        const d = diagnostics.find((x) => x.code === code) as Diagnostic
        return { code, title: code, category: d.category, status: 'failed' as const }
      }),
      ...Array.from({ length: passed }, (_, i) => ({
        code: `PASSING_CHECK_${i}`,
        title: `Passing check ${i}`,
        category: 'tooling' as const,
        status: 'passed' as const,
      })),
    ],
    diagnostics,
    summary: {
      passed,
      failed: failedCodes.size,
      skipped: 0,
      disabled: 0,
      errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length,
      infos: diagnostics.filter((d) => d.severity === 'info').length,
    },
  }
}

/** A realistic full-stack monorepo result (pnpm + Turborepo, Nuxt + Fastify + Go, Docker services). */
export function sampleScanResult(): ScanResult {
  const diagnostics: Diagnostic[] = [
    {
      code: 'TRACKED_ENV_FILE',
      severity: 'error',
      category: 'security',
      message: '.env is tracked by Git',
      hint: 'Run `git rm --cached .env` and add .env to .gitignore',
      files: ['.env'],
      subject: '.env',
    },
    {
      code: 'ENV_UNDOCUMENTED',
      severity: 'warning',
      category: 'environment',
      message: 'STRIPE_SECRET_KEY is used in code but missing from .env.example',
      hint: 'Add STRIPE_SECRET_KEY= to .env.example',
      files: ['apps/api/src/billing.ts'],
      subject: 'STRIPE_SECRET_KEY',
    },
    {
      code: 'NODE_VERSION_CONFLICT',
      severity: 'warning',
      category: 'runtime',
      message: 'Node.js versions disagree: .nvmrc pins 22, Dockerfile uses 20',
      hint: 'Use the same major version everywhere (22)',
      files: ['.nvmrc', 'apps/api/Dockerfile'],
    },
    {
      code: 'ENV_UNUSED',
      severity: 'info',
      category: 'environment',
      message: 'LEGACY_FLAG is documented in .env.example but never referenced',
      files: ['.env.example'],
      subject: 'LEGACY_FLAG',
    },
  ]

  return makeResult({
    tool: { name: 'repolens', version: '1.2.3' },
    project: {
      name: 'acme-api',
      directory: 'acme-api',
      description: 'Acme storefront and API',
      type: 'monorepo',
      private: true,
      license: 'MIT',
      repository: 'https://github.com/acme/acme-api',
      manifests: ['package.json', 'go.work'],
      entrypoints: [
        { kind: 'go-main', path: 'services/billing' },
        { kind: 'bin', path: 'packages/cli/bin/acme.js', name: 'acme' },
      ],
      structure: [
        { path: 'apps', files: 84 },
        { path: 'packages', files: 41 },
        { path: 'services', files: 12 },
        { path: '.github', files: 3 },
      ],
    },
    languages: [
      { name: 'TypeScript', kind: 'programming', files: 96, share: 0.738 },
      { name: 'Vue', kind: 'markup', files: 18, share: 0.138 },
      { name: 'Go', kind: 'programming', files: 12, share: 0.092 },
      { name: 'CSS', kind: 'style', files: 4, share: 0.031 },
    ],
    runtimes: [
      {
        id: 'node',
        name: 'Node.js',
        version: '22',
        sources: [
          { file: '.nvmrc', raw: '22', version: '22', kind: 'exact' },
          { file: 'package.json', field: 'engines.node', raw: '>=22', version: '>=22', kind: 'range' },
          { file: 'apps/api/Dockerfile', field: 'FROM', raw: 'node:20-alpine', version: '20', kind: 'exact' },
        ],
      },
      {
        id: 'go',
        name: 'Go',
        version: '1.25',
        sources: [
          { file: 'services/billing/go.mod', field: 'go directive', raw: 'go 1.25', version: '1.25', kind: 'exact' },
        ],
      },
    ],
    packageManagers: {
      primary: {
        id: 'pnpm',
        name: 'pnpm',
        version: '10.17.1',
        lockfiles: ['pnpm-lock.yaml'],
        declared: true,
        evidence: ['packageManager field in package.json', 'pnpm-lock.yaml'],
      },
      detected: [
        {
          id: 'pnpm',
          name: 'pnpm',
          version: '10.17.1',
          lockfiles: ['pnpm-lock.yaml'],
          declared: true,
          evidence: ['packageManager field in package.json', 'pnpm-lock.yaml'],
        },
        { id: 'go', name: 'Go modules', lockfiles: ['services/billing/go.sum'], declared: true, evidence: ['go.mod'] },
      ],
    },
    workspace: {
      tools: [
        { id: 'pnpm', name: 'pnpm workspaces', configFile: 'pnpm-workspace.yaml' },
        { id: 'turbo', name: 'Turborepo', configFile: 'turbo.json' },
      ],
      patterns: ['apps/*', 'packages/*'],
      packages: [
        { name: '@acme/api', path: 'apps/api', private: true, ecosystem: 'node' },
        { name: '@acme/web', path: 'apps/web', private: true, ecosystem: 'node' },
        { name: '@acme/ui', path: 'packages/ui', version: '0.3.0', ecosystem: 'node' },
        { name: 'github.com/acme/billing', path: 'services/billing', ecosystem: 'go' },
      ],
    },
    dependencies: {
      total: 9,
      packages: [
        {
          path: '.',
          name: 'acme',
          ecosystem: 'node',
          dependencies: [
            { name: 'turbo', version: '^2.5.8', kind: 'dev' },
            { name: 'typescript', version: '^5.9.2', kind: 'dev' },
          ],
        },
        {
          path: 'apps/api',
          name: '@acme/api',
          ecosystem: 'node',
          dependencies: [
            { name: 'fastify', version: '^5.6.1', kind: 'prod' },
            { name: '@prisma/client', version: '^6.16.2', kind: 'prod' },
            { name: 'prisma', version: '^6.16.2', kind: 'dev' },
          ],
        },
        {
          path: 'apps/web',
          name: '@acme/web',
          ecosystem: 'node',
          dependencies: [
            { name: 'nuxt', version: '^4.1.2', kind: 'prod' },
            { name: 'vue', version: '^3.5.22', kind: 'prod' },
          ],
        },
        {
          path: 'services/billing',
          name: 'github.com/acme/billing',
          ecosystem: 'go',
          dependencies: [
            { name: 'github.com/jackc/pgx/v5', version: 'v5.7.6', kind: 'prod' },
            { name: 'golang.org/x/text', version: 'v0.29.0', kind: 'indirect' },
          ],
        },
      ],
    },
    frameworks: [
      {
        id: 'nuxt',
        name: 'Nuxt',
        version: '4.1.2',
        category: 'fullstack',
        ecosystem: 'node',
        packages: ['apps/web'],
        confidence: 'high',
        evidence: ['dependency nuxt@^4.1.2 in apps/web/package.json', 'config file apps/web/nuxt.config.ts'],
      },
      {
        id: 'vue',
        name: 'Vue',
        version: '3.5.22',
        category: 'frontend',
        ecosystem: 'node',
        packages: ['apps/web', 'packages/ui'],
        confidence: 'high',
        evidence: ['dependency vue@^3.5.22 in apps/web/package.json'],
      },
      {
        id: 'fastify',
        name: 'Fastify',
        version: '5.6.1',
        category: 'backend',
        ecosystem: 'node',
        packages: ['apps/api'],
        confidence: 'high',
        evidence: ['dependency fastify@^5.6.1 in apps/api/package.json'],
      },
      {
        id: 'go-net-http',
        name: 'net/http',
        category: 'backend',
        ecosystem: 'go',
        packages: ['services/billing'],
        confidence: 'medium',
        evidence: ['net/http handlers in services/billing/main.go'],
      },
    ],
    build: {
      tools: [
        {
          id: 'turbo',
          name: 'Turborepo',
          kind: 'task-runner',
          version: '2.5.8',
          configFiles: ['turbo.json'],
          packages: ['.'],
          confidence: 'high',
          evidence: ['turbo.json'],
        },
        {
          id: 'vite',
          name: 'Vite',
          kind: 'bundler',
          configFiles: [],
          packages: ['apps/web'],
          confidence: 'medium',
          evidence: ['bundled by Nuxt'],
        },
      ],
    },
    testing: {
      testFiles: 23,
      tools: [
        {
          id: 'vitest',
          name: 'Vitest',
          kind: 'test',
          version: '3.2.4',
          configFiles: ['apps/api/vitest.config.ts'],
          packages: ['apps/api', 'apps/web'],
          confidence: 'high',
          evidence: ['dependency vitest in apps/api/package.json'],
        },
        {
          id: 'playwright',
          name: 'Playwright',
          kind: 'e2e',
          configFiles: ['apps/web/playwright.config.ts'],
          packages: ['apps/web'],
          confidence: 'high',
          evidence: ['config file apps/web/playwright.config.ts'],
        },
      ],
    },
    linting: {
      tools: [
        {
          id: 'biome',
          name: 'Biome',
          kind: 'linter',
          version: '2.2.4',
          configFiles: ['biome.json'],
          packages: ['.'],
          confidence: 'high',
          evidence: ['biome.json'],
        },
        {
          id: 'typescript',
          name: 'TypeScript',
          kind: 'typechecker',
          version: '5.9.2',
          configFiles: ['tsconfig.json'],
          packages: ['.'],
          confidence: 'high',
          evidence: ['tsconfig.json'],
        },
      ],
    },
    scripts: {
      runner: 'pnpm',
      scripts: [
        { name: 'dev', command: 'turbo dev', run: 'pnpm dev', source: 'package.json', package: '.', category: 'dev' },
        {
          name: 'build',
          command: 'turbo build',
          run: 'pnpm build',
          source: 'package.json',
          package: '.',
          category: 'build',
        },
        {
          name: 'test',
          command: 'turbo test',
          run: 'pnpm test',
          source: 'package.json',
          package: '.',
          category: 'test',
        },
        {
          name: 'lint',
          command: 'biome check .',
          run: 'pnpm lint',
          source: 'package.json',
          package: '.',
          category: 'lint',
        },
        {
          name: 'db:up',
          command: 'docker compose up -d',
          run: 'pnpm db:up',
          source: 'package.json',
          package: '.',
          category: 'database',
        },
        {
          name: 'dev',
          command: 'nuxt dev',
          run: 'pnpm --filter @acme/web dev',
          source: 'apps/web/package.json',
          package: 'apps/web',
          category: 'dev',
        },
      ],
    },
    environment: {
      usageTruncated: false,
      files: [
        { path: '.env', kind: 'local', variables: 3, ignored: false, tracked: true },
        { path: '.env.example', kind: 'example', variables: 4, ignored: false, tracked: true },
      ],
      variables: [
        {
          name: 'API_URL',
          defined: true,
          documented: true,
          used: true,
          definedIn: ['.env'],
          documentedIn: ['.env.example'],
          usedIn: ['apps/web/nuxt.config.ts'],
          fallback: false,
          testOnly: false,
          public: false,
          sensitive: false,
          endpoints: [{ file: '.env.example', scheme: 'http', port: 4000, local: true }],
          suspiciousValueIn: [],
        },
        {
          name: 'DATABASE_URL',
          defined: true,
          documented: true,
          used: true,
          definedIn: ['.env'],
          documentedIn: ['.env.example'],
          usedIn: ['apps/api/prisma/schema.prisma', 'apps/api/src/db.ts'],
          fallback: false,
          testOnly: false,
          public: false,
          sensitive: false,
          endpoints: [{ file: '.env.example', scheme: 'postgres', port: 5432, local: true }],
          suspiciousValueIn: [],
        },
        {
          name: 'LEGACY_FLAG',
          defined: false,
          documented: true,
          used: false,
          definedIn: [],
          documentedIn: ['.env.example'],
          usedIn: [],
          fallback: false,
          testOnly: false,
          public: false,
          sensitive: false,
          endpoints: [],
          suspiciousValueIn: [],
        },
        {
          name: 'REDIS_URL',
          defined: true,
          documented: true,
          used: true,
          definedIn: ['.env'],
          documentedIn: ['.env.example'],
          usedIn: ['apps/api/src/cache.ts'],
          fallback: false,
          testOnly: false,
          public: false,
          sensitive: false,
          endpoints: [{ file: '.env.example', scheme: 'redis', port: 6379, local: true }],
          suspiciousValueIn: [],
        },
        {
          name: 'STRIPE_SECRET_KEY',
          defined: false,
          documented: false,
          used: true,
          definedIn: [],
          documentedIn: [],
          usedIn: ['apps/api/src/billing.ts'],
          fallback: false,
          testOnly: false,
          public: false,
          sensitive: true,
          endpoints: [],
          suspiciousValueIn: [],
        },
      ],
    },
    services: {
      composeFiles: ['docker-compose.yml'],
      dockerfiles: [
        { path: 'apps/api/Dockerfile', baseImages: ['node:20-alpine'], stages: 1, exposes: ['4000'], args: [] },
      ],
      services: [
        {
          name: 'postgres',
          source: 'docker-compose.yml',
          image: 'postgres:17',
          technology: { id: 'postgresql', name: 'PostgreSQL' },
          kind: 'database',
          ports: [{ host: 5432, container: 5432, protocol: 'tcp', raw: '5432:5432' }],
          expose: [],
          dependsOn: [],
          volumes: ['pgdata:/var/lib/postgresql/data'],
          environment: ['POSTGRES_PASSWORD', 'POSTGRES_USER'],
          envFiles: [],
          profiles: [],
          healthcheck: true,
        },
        {
          name: 'redis',
          source: 'docker-compose.yml',
          image: 'redis:8',
          technology: { id: 'redis', name: 'Redis' },
          kind: 'cache',
          ports: [{ host: 6379, container: 6379, protocol: 'tcp', raw: '6379:6379' }],
          expose: [],
          dependsOn: [],
          volumes: [],
          environment: [],
          envFiles: [],
          profiles: [],
          healthcheck: false,
        },
        {
          name: 'minio',
          source: 'docker-compose.yml',
          image: 'minio/minio',
          technology: { id: 'minio', name: 'MinIO' },
          kind: 'storage',
          ports: [
            { host: 9000, container: 9000, protocol: 'tcp', raw: '9000:9000' },
            { host: 9001, container: 9001, protocol: 'tcp', raw: '9001:9001' },
          ],
          expose: [],
          dependsOn: [],
          volumes: ['minio:/data'],
          environment: ['MINIO_ROOT_PASSWORD', 'MINIO_ROOT_USER'],
          envFiles: [],
          profiles: [],
          healthcheck: false,
        },
      ],
    },
    databases: {
      databases: [
        {
          id: 'postgresql',
          name: 'PostgreSQL',
          kind: 'relational',
          sources: ['docker', 'config', 'env'],
          confidence: 'high',
          evidence: ['postgres service (postgres:17) in docker-compose.yml', 'Prisma provider "postgresql"'],
        },
        {
          id: 'redis',
          name: 'Redis',
          kind: 'key-value',
          sources: ['docker', 'env'],
          confidence: 'high',
          evidence: ['redis service (redis:8) in docker-compose.yml'],
        },
      ],
      orms: [
        {
          id: 'prisma',
          name: 'Prisma',
          kind: 'orm',
          version: '6.16.2',
          configFiles: ['apps/api/prisma/schema.prisma'],
          packages: ['apps/api'],
          confidence: 'high',
          evidence: ['dependency @prisma/client in apps/api/package.json'],
        },
      ],
    },
    routes: {
      truncated: false,
      routes: [
        {
          method: 'GET',
          path: '/api/users',
          kind: 'api',
          framework: 'fastify',
          file: 'apps/api/src/routes/users.ts',
          line: 12,
          confidence: 'high',
          package: 'apps/api',
        },
        {
          method: 'POST',
          path: '/api/auth/login',
          kind: 'api',
          framework: 'fastify',
          file: 'apps/api/src/routes/auth.ts',
          line: 8,
          confidence: 'high',
          package: 'apps/api',
        },
        {
          method: 'POST',
          path: '/api/orders',
          kind: 'api',
          framework: 'fastify',
          file: 'apps/api/src/routes/orders.ts',
          line: 21,
          confidence: 'medium',
          package: 'apps/api',
          note: 'registered inside a plugin; a prefix may apply',
        },
        {
          method: 'GET',
          path: '/api/stats',
          kind: 'api',
          framework: 'nuxt',
          file: 'apps/web/server/api/stats.get.ts',
          confidence: 'high',
          package: 'apps/web',
        },
        {
          method: 'GET',
          path: '/',
          kind: 'page',
          framework: 'nuxt',
          file: 'apps/web/app/pages/index.vue',
          confidence: 'high',
          package: 'apps/web',
        },
        {
          method: 'GET',
          path: '/products/:id',
          kind: 'page',
          framework: 'nuxt',
          file: 'apps/web/app/pages/products/[id].vue',
          confidence: 'high',
          package: 'apps/web',
        },
        {
          method: 'ANY',
          path: '/invoices',
          kind: 'api',
          framework: 'go-net-http',
          file: 'services/billing/main.go',
          line: 14,
          confidence: 'high',
          package: 'services/billing',
        },
        {
          method: 'GET',
          path: '/internal/debug',
          kind: 'api',
          framework: 'express',
          file: 'scripts/debug-server.js',
          line: 3,
          confidence: 'low',
          package: '.',
        },
      ],
    },
    ci: {
      providers: [{ id: 'github-actions', name: 'GitHub Actions', files: ['.github/workflows/ci.yml'] }],
      workflows: [
        {
          provider: 'github-actions',
          file: '.github/workflows/ci.yml',
          name: 'CI',
          triggers: ['push', 'pull_request'],
          jobs: [
            { id: 'lint', name: 'Lint', tasks: ['lint', 'typecheck'], runsOn: ['ubuntu-latest'] },
            { id: 'test', name: 'Test', tasks: ['test'], runsOn: ['ubuntu-latest', 'windows-latest'] },
            { id: 'build', tasks: ['build'], runsOn: ['ubuntu-latest'] },
          ],
        },
      ],
    },
    git: {
      branch: 'main',
      head: '3f2a1c9',
      remotes: [{ name: 'origin', url: 'https://github.com/acme/acme-api.git', host: 'github' }],
      submodules: [],
      lfs: false,
      trackedFiles: 162,
      linkedWorktree: false,
    },
    configFiles: [
      { path: '.env.example', category: 'environment', description: 'Environment variable template' },
      { path: '.github/workflows/ci.yml', category: 'ci', description: 'GitHub Actions workflow' },
      { path: '.nvmrc', category: 'runtime', description: 'Node.js version (nvm)' },
      { path: 'apps/web/nuxt.config.ts', category: 'framework', description: 'Nuxt configuration' },
      { path: 'biome.json', category: 'lint', description: 'Biome configuration' },
      { path: 'docker-compose.yml', category: 'docker', description: 'Docker Compose services' },
      { path: 'package.json', category: 'package', description: 'npm package manifest' },
      { path: 'pnpm-workspace.yaml', category: 'workspace', description: 'pnpm workspace' },
      { path: 'turbo.json', category: 'workspace', description: 'Turborepo configuration' },
    ],
    doctor: doctorFrom(diagnostics, 18),
    meta: {
      files: 162,
      config: { sources: [], settings: {} },
      truncated: false,
      warnings: [
        {
          kind: 'parse',
          file: 'apps/legacy/docker-compose.yml',
          message: "Couldn't parse apps/legacy/docker-compose.yml",
          detail: 'Nested mappings are not allowed in compact mappings at line 4, column 8',
        },
      ],
    },
  })
}
