/**
 * Benchmark `scan()` wall-clock time.
 *
 *   node scripts/bench.ts [path] [--runs N]         Scan a directory (default: this repository)
 *   node scripts/bench.ts --generate 500 [--runs N] Scan a synthetic monorepo with 500 packages
 *
 * Runs one warm-up scan (which also warms the file system cache), then N
 * measured scans, and prints min / median / p95 / max. Results depend on the
 * machine, the disk, the OS cache and the Node.js version, so only compare
 * numbers taken on the same machine.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { scan } from '../src/index.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  console.error(message)
  console.error('Usage: node scripts/bench.ts [path] [--runs N] [--generate PACKAGES]')
  process.exit(2)
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value) || Number(value) < 1) fail(`${name} must be a positive integer`)
  return Number(value)
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number
}

async function writeFile(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

/** A pnpm monorepo with `count` packages, each with routes, env usage, a test and a tsconfig. */
async function generateMonorepo(count: number): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-bench-'))
  await writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'bench-monorepo',
        private: true,
        packageManager: 'pnpm@10.17.1',
        scripts: { build: 'turbo build', test: 'turbo test', lint: 'biome check .' },
        devDependencies: { turbo: '^2.5.8', typescript: 'catalog:', '@biomejs/biome': '^2.2.4' },
      },
      null,
      2,
    ),
  )
  await writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  typescript: ^5.9.2\n")
  await writeFile(root, '.gitignore', 'node_modules\n.env\ndist\ncoverage\n')
  await writeFile(root, '.env.example', 'DATABASE_URL=postgres://localhost:5432/app\nPORT=3000\n')
  await writeFile(
    root,
    'docker-compose.yml',
    'services:\n  db:\n    image: postgres:17\n    ports: ["5432:5432"]\n  cache:\n    image: redis:8\n',
  )
  for (let i = 0; i < count; i++) {
    const dir = `packages/pkg-${i}`
    const env = `PKG_${i}_API_KEY`
    await Promise.all([
      writeFile(
        root,
        `${dir}/package.json`,
        JSON.stringify(
          {
            name: `@bench/pkg-${i}`,
            version: '1.0.0',
            type: 'module',
            scripts: { build: 'tsc', test: 'vitest run', dev: 'tsx watch src/index.ts' },
            dependencies: { express: '^5.1.0', zod: '^4.0.0' },
            devDependencies: { typescript: 'catalog:', vitest: '^4.0.3' },
          },
          null,
          2,
        ),
      ),
      writeFile(root, `${dir}/tsconfig.json`, '{\n  // bench\n  "compilerOptions": { "strict": true, },\n}\n'),
      writeFile(
        root,
        `${dir}/src/index.ts`,
        [
          "import express from 'express'",
          "import { router } from './routes.ts'",
          'const app = express()',
          `const port = Number(process.env.PORT ?? 3000)`,
          `app.get('/health', (_req, res) => res.send('ok'))`,
          `app.use('/api/items-${i}', router)`,
          `if (!process.env.${env}) throw new Error('missing key')`,
          'app.listen(port)',
          '',
        ].join('\n'),
      ),
      writeFile(
        root,
        `${dir}/src/routes.ts`,
        [
          "import { Router } from 'express'",
          'export const router = Router()',
          "router.get('/', (_req, res) => res.json([]))",
          "router.post('/', (_req, res) => res.status(201).end())",
          "router.get('/:id', (req, res) => res.json({ id: req.params.id }))",
          "router.delete('/:id', (_req, res) => res.status(204).end())",
          '',
        ].join('\n'),
      ),
      writeFile(
        root,
        `${dir}/src/util.ts`,
        `export const name = 'pkg-${i}'\nexport const url = process.env.DATABASE_URL\n`,
      ),
      writeFile(
        root,
        `${dir}/test/index.test.ts`,
        "import { expect, it } from 'vitest'\nit('works', () => expect(1).toBe(1))\n",
      ),
    ])
  }
  return root
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { runs: { type: 'string' }, generate: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 1) fail(`Unexpected argument "${positionals[1]}"`)
  if (positionals.length === 1 && values.generate !== undefined) fail('Pass either a path or --generate, not both')
  const runs = positiveInteger(values.runs, '--runs', 10)

  let target = path.resolve(positionals[0] ?? REPO_ROOT)
  let label = target
  let cleanup: string | undefined
  if (values.generate !== undefined) {
    const count = positiveInteger(values.generate, '--generate', 1)
    const started = performance.now()
    target = await generateMonorepo(count)
    cleanup = target
    label = `synthetic monorepo, ${count} packages (${target})`
    console.log(`Generated ${count} packages in ${Math.round(performance.now() - started)} ms`)
  }

  try {
    const warmup = await scan({ cwd: target })
    const times: number[] = []
    for (let i = 0; i < runs; i++) {
      const started = performance.now()
      await scan({ cwd: target })
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const ms = (value: number) => `${value.toFixed(1)} ms`
    console.log('RepoLens scan benchmark')
    console.log(`  target   ${label}`)
    console.log(
      `  files    ${warmup.meta.files} indexed${warmup.meta.truncated ? ' (truncated)' : ''}, ${warmup.meta.warnings.length} warnings`,
    )
    console.log(`  runs     ${runs} measured after 1 warm-up`)
    console.log(`  node     ${process.version} on ${process.platform}-${process.arch}`)
    console.log(
      `  time     min ${ms(times[0] as number)} · median ${ms(percentile(times, 0.5))} · p95 ${ms(percentile(times, 0.95))} · max ${ms(times[times.length - 1] as number)}`,
    )
  } finally {
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true })
  }
}

await main()
