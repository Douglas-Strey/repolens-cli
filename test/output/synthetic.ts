/**
 * A very large scan result for testing that renderers stay bounded, well
 * formed and fast whatever the repository size.
 */
import type { Diagnostic, EnvVariable, Route, ScanResult, Script, Service } from '../../src/types.ts'
import { sampleScanResult } from '../factories.ts'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export function largeScanResult(counts = { routes: 500, variables: 200 }): ScanResult {
  const base = sampleScanResult()
  const packages = Array.from({ length: 60 }, (_, i) => ({
    name: `@big/pkg-${String(i).padStart(2, '0')}`,
    path: `packages/pkg-${String(i).padStart(2, '0')}`,
    ecosystem: 'node' as const,
  }))

  const routes: Route[] = Array.from({ length: counts.routes }, (_, i) => {
    const pkg = packages[i % packages.length]?.path ?? '.'
    const route: Route = {
      method: METHODS[i % METHODS.length] ?? 'GET',
      path: `/api/resource-${i}/:id`,
      kind: i % 5 === 0 ? 'page' : 'api',
      framework: 'fastify',
      file: `${pkg}/src/routes/r${i}.ts`,
      line: (i % 90) + 1,
      confidence: i % 7 === 0 ? 'medium' : 'high',
      package: pkg,
    }
    if (i % 7 === 0) route.note = 'mounted with a prefix | that could not be resolved'
    return route
  })

  const variables: EnvVariable[] = Array.from({ length: counts.variables }, (_, i) => ({
    name: `VAR_${String(i).padStart(3, '0')}`,
    defined: i % 2 === 0,
    documented: i % 3 !== 0,
    used: i % 4 !== 0,
    definedIn: i % 2 === 0 ? ['.env'] : [],
    documentedIn: i % 3 !== 0 ? ['.env.example'] : [],
    usedIn: i % 4 !== 0 ? [`packages/pkg-${String(i % 60).padStart(2, '0')}/src/config.ts`] : [],
    fallback: false,
    testOnly: false,
    public: i % 10 === 0,
    sensitive: i % 6 === 0,
    endpoints: i % 8 === 0 ? [{ file: '.env.example', scheme: 'postgres', port: 5432, local: true }] : [],
    suspiciousValueIn: [],
  }))

  const services: Service[] = Array.from({ length: 30 }, (_, i) => ({
    name: `svc-${i}`,
    source: 'docker-compose.yml',
    image: `example/svc-${i}:latest`,
    kind: 'app',
    ports: [{ host: 7000 + i, container: 80, protocol: 'tcp', raw: `${7000 + i}:80` }],
    expose: [],
    dependsOn: i > 0 ? [`svc-${i - 1}`] : [],
    volumes: [],
    environment: [],
    envFiles: [],
    profiles: [],
    healthcheck: false,
  }))

  const scripts: Script[] = [
    ...base.scripts.scripts,
    ...packages.flatMap((pkg) =>
      ['dev', 'build', 'test', 'lint', 'typecheck'].map((name) => ({
        name,
        command: `tsx ${name}.ts | tee ${name}.log`,
        run: `pnpm --filter ${pkg.name} ${name}`,
        source: `${pkg.path}/package.json`,
        package: pkg.path,
        category: name === 'typecheck' ? ('typecheck' as const) : (name as Script['category']),
      })),
    ),
  ]

  const diagnostics: Diagnostic[] = Array.from({ length: 40 }, (_, i) => ({
    code: `SYNTHETIC_${i}`,
    severity: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info',
    category: 'environment',
    message: `Synthetic problem number ${i} with a | pipe`,
    hint: `Fix it with \`repolens --fix ${i}\``,
  }))

  return {
    ...base,
    project: {
      ...base.project,
      structure: Array.from({ length: 15 }, (_, i) => ({ path: `dir-${i}`, files: 1000 - i })),
    },
    workspace: { ...(base.workspace ?? { tools: [], patterns: [], packages: [] }), packages },
    frameworks: [
      ...base.frameworks,
      ...packages.slice(0, 20).map((pkg, i) => ({
        id: `fw-${i}`,
        name: `Framework ${i}`,
        category: 'backend' as const,
        ecosystem: 'node' as const,
        packages: [pkg.path],
        confidence: 'high' as const,
        evidence: [`dependency fw-${i} in ${pkg.path}/package.json`],
      })),
    ],
    routes: { routes, truncated: true },
    environment: { ...base.environment, variables, usageTruncated: true },
    services: { ...base.services, services },
    scripts: { runner: 'pnpm', scripts },
    doctor: { ...base.doctor, diagnostics },
    ci: {
      providers: base.ci.providers,
      workflows: Array.from({ length: 12 }, (_, i) => ({
        provider: 'github-actions',
        file: `.github/workflows/w${String(i).padStart(2, '0')}.yml`,
        name: `Workflow ${i}`,
        triggers: ['push'],
        jobs: [{ id: 'check', tasks: ['lint', 'test'], runsOn: ['ubuntu-latest'] }],
      })),
    },
    meta: {
      files: 100_000,
      config: { sources: [], settings: {} },
      truncated: true,
      warnings: Array.from({ length: 30 }, (_, i) => ({
        kind: 'parse' as const,
        file: `bad-${i}.json`,
        message: `Couldn't parse bad-${i}.json`,
      })),
    },
  }
}
