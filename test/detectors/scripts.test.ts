import { describe, expect, it } from 'vitest'
import { packageManagersDetector } from '../../src/detectors/package-managers.ts'
import {
  classifyScript,
  clipCommand,
  MAX_COMMAND_LENGTH,
  nestedRunCommand,
  nxRunCommand,
  packageRunCommand,
  parseDenoTasks,
  parseJustfile,
  parseMakefile,
  parseNxProject,
  parseTaskfile,
  scriptsDetector,
  workspaceRunCommand,
} from '../../src/detectors/scripts.ts'
import type { Script, ScriptsSection } from '../../src/types.ts'
import { shellQuote } from '../../src/utils/commands.ts'
import { contextFor, fixtureContext, makeProject, timeBudget } from '../helpers.ts'

async function detectFiles(files: Record<string, string>): Promise<ScriptsSection> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(scriptsDetector)
}

const brief = (scripts: Script[]) => scripts.map((s) => [s.source, s.name, s.run])

describe('classifyScript', () => {
  it.each([
    ['dev', 'dev'],
    ['develop', 'dev'],
    ['watch', 'dev'],
    ['start:dev', 'dev'],
    ['api:dev', 'dev'],
    ['start', 'start'],
    ['serve', 'start'],
    ['preview', 'start'],
    ['start:prod', 'start'],
    ['build', 'build'],
    ['build:prod', 'build'],
    ['compile', 'build'],
    ['bundle', 'build'],
    ['docker-build', 'build'],
    ['test', 'test'],
    ['test:e2e', 'test'],
    ['test:watch', 'test'],
    ['coverage', 'test'],
    ['e2e', 'test'],
    ['spec', 'test'],
    ['pretest', 'test'],
    ['lint', 'lint'],
    ['lint:fix', 'lint'],
    ['eslint', 'lint'],
    ['format', 'format'],
    ['fmt', 'format'],
    ['prettier', 'format'],
    ['typecheck', 'typecheck'],
    ['type-check', 'typecheck'],
    ['tsc', 'typecheck'],
    ['check-types', 'typecheck'],
    ['types', 'typecheck'],
    ['db', 'database'],
    ['db:up', 'database'],
    ['db:migrate', 'database'],
    ['migrate', 'database'],
    ['seed', 'database'],
    ['prisma', 'database'],
    ['drizzle', 'database'],
    ['deploy', 'deploy'],
    ['deploy:staging', 'deploy'],
    ['release', 'release'],
    ['publish', 'release'],
    ['version', 'release'],
    ['changeset', 'release'],
    ['postinstall', 'setup'],
    ['prepare', 'setup'],
    ['preinstall', 'setup'],
    ['install', 'setup'],
    ['setup', 'setup'],
    ['bootstrap', 'setup'],
    ['clean', 'other'],
  ])('%s → %s', (name, category) => {
    expect(classifyScript(name, '')).toBe(category)
  })

  it('lets the name win over the command', () => {
    expect(classifyScript('test', 'echo "Error: no test specified" && exit 1')).toBe('test')
    expect(classifyScript('lint', 'tsc --noEmit')).toBe('lint')
  })

  it('falls back to the command when the name is not recognized', () => {
    expect(classifyScript('check', 'tsc --noEmit')).toBe('typecheck')
    expect(classifyScript('ci', 'vitest run --coverage')).toBe('test')
    expect(classifyScript('compile-ts', 'tsc -p tsconfig.build.json')).toBe('build')
    expect(classifyScript('generate', 'nuxt generate')).toBe('build')
    expect(classifyScript('go', 'nodemon src/index.js')).toBe('dev')
    expect(classifyScript('ship', 'vercel --prod')).toBe('deploy')
    expect(classifyScript('worker', 'node worker.js')).toBe('other')
  })

  it('only treats tsc as a typecheck when --noEmit belongs to the same command', () => {
    expect(classifyScript('check', 'tsc -p . --noEmit && echo ok')).toBe('typecheck')
    expect(classifyScript('check', 'tsc -p tsconfig.json; echo --noEmit')).toBe('build')
    expect(classifyScript('check', 'eslint . && tsc --noEmit')).toBe('lint')
  })

  it('stays fast on hostile commands (no catastrophic backtracking)', () => {
    const started = performance.now()
    expect(classifyScript('x', 'tsc '.repeat(250_000))).toBe('build')
    expect(classifyScript('x', `${'a.'.repeat(250_000)}--noemit`)).toBe('other')
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('clipCommand', () => {
  it('leaves commands within the limit alone', () => {
    const command = 'x'.repeat(MAX_COMMAND_LENGTH)
    expect(clipCommand(command)).toBe(command)
  })

  it('cuts at a token boundary and drops the token the cut would split', () => {
    const secret = `ghp_${'A'.repeat(36)}`
    const clipped = clipCommand(`${'run '.repeat(248)}${secret} tail`)
    expect(clipped.endsWith('run …')).toBe(true)
    expect(clipped).not.toContain('ghp_')
    expect(clipped.length).toBeLessThanOrEqual(MAX_COMMAND_LENGTH + 2)
  })

  it('drops a quoted value that the cut leaves unclosed', () => {
    const clipped = clipCommand(`deploy API_TOKEN="first-half second-half ${'x '.repeat(20)}"`, 30)
    expect(clipped).toBe('deploy API_TOKEN= …')
  })

  it('shows only an ellipsis when there is no token boundary', () => {
    expect(clipCommand('a'.repeat(5000))).toBe('…')
  })
})

describe('shellQuote and run commands', () => {
  it('quotes only when needed', () => {
    expect(shellQuote('@acme/web')).toBe('@acme/web')
    expect(shellQuote('test:e2e')).toBe('test:e2e')
    expect(shellQuote('build all')).toBe("'build all'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('x; rm -rf /')).toBe("'x; rm -rf /'")
  })

  it('builds workspace commands per package manager', () => {
    const pkg = { name: '@acme/web', dir: 'apps/web' }
    expect(workspaceRunCommand('pnpm', pkg, 'dev')).toBe('pnpm --filter @acme/web dev')
    expect(workspaceRunCommand('yarn', pkg, 'dev')).toBe('yarn workspace @acme/web dev')
    expect(workspaceRunCommand('npm', pkg, 'dev')).toBe('npm run dev -w apps/web')
    expect(workspaceRunCommand('bun', pkg, 'dev')).toBe('bun run --filter @acme/web dev')
  })

  it('falls back to the directory when the package has no usable name', () => {
    const pkg = { dir: 'apps/web' }
    expect(workspaceRunCommand('pnpm', pkg, 'dev')).toBe('pnpm --filter ./apps/web dev')
    expect(workspaceRunCommand('yarn', pkg, 'dev')).toBe('cd apps/web && yarn dev')
    expect(workspaceRunCommand('bun', pkg, 'dev')).toBe('bun run --filter ./apps/web dev')
    expect(workspaceRunCommand('pnpm', { name: 'bad name; rm -rf ~', dir: 'x' }, 'dev')).toBe('pnpm --filter ./x dev')
  })

  it('changes directory for packages outside a workspace', () => {
    expect(nestedRunCommand('npm', 'web', 'build')).toBe('cd web && npm run build')
    expect(nestedRunCommand('pnpm', 'web', 'test')).toBe('cd web && pnpm test')
  })

  it('adds "run" when pnpm or Yarn would run a built-in command of the same name', () => {
    expect(packageRunCommand('pnpm', 'dev')).toBe('pnpm dev')
    expect(packageRunCommand('pnpm', 'test')).toBe('pnpm test')
    expect(packageRunCommand('pnpm', 'deploy')).toBe('pnpm run deploy')
    expect(packageRunCommand('pnpm', 'setup')).toBe('pnpm run setup')
    expect(packageRunCommand('pnpm', 'docs')).toBe('pnpm run docs')
    expect(packageRunCommand('pnpm', 'up')).toBe('pnpm run up')
    expect(packageRunCommand('yarn', 'start')).toBe('yarn start')
    expect(packageRunCommand('yarn', 'version')).toBe('yarn run version')
    expect(packageRunCommand('yarn', 'check')).toBe('yarn run check')
    expect(packageRunCommand('npm', 'deploy')).toBe('npm run deploy')
    expect(packageRunCommand('npm', 'test')).toBe('npm test')
    expect(packageRunCommand('bun', 'install')).toBe('bun run install')
    expect(packageRunCommand(null, 'build all')).toBe("npm run 'build all'")
  })

  it('adds "run" for built-in names in workspace and nested packages too', () => {
    const pkg = { name: '@acme/web', dir: 'apps/web' }
    expect(workspaceRunCommand('pnpm', pkg, 'deploy')).toBe('pnpm --filter @acme/web run deploy')
    expect(workspaceRunCommand('yarn', pkg, 'publish')).toBe('yarn workspace @acme/web run publish')
    expect(workspaceRunCommand('npm', pkg, 'publish')).toBe('npm run publish -w apps/web')
    expect(workspaceRunCommand('bun', pkg, 'install')).toBe('bun run --filter @acme/web install')
    expect(nestedRunCommand('pnpm', 'web', 'setup')).toBe('cd web && pnpm run setup')
  })
})

describe('parseMakefile', () => {
  it('lists runnable targets with their first recipe line', () => {
    const makefile = [
      '# Build helpers',
      'BINARY := bin/app',
      'IMAGE ?= acme/app:dev',
      'URL = http://localhost:8080',
      'FLAGS += -v',
      'SIMPLE ::= x',
      'VERSION != git describe',
      '.PHONY: build test',
      '.DEFAULT_GOAL := build',
      '',
      '## build: compile',
      'build: deps',
      '\t@echo building',
      '\tgo build -o $(BINARY) .',
      '',
      'test lint: build',
      '\t-go test ./...',
      '',
      'quick: ; go vet ./...',
      '',
      '%.o: %.c',
      '\tcc -c $<',
      '$(BINARY): main.go',
      '\tgo build',
      'debug: CFLAGS += -g',
      'install:: ',
      '\t# comment inside the recipe',
      '\tcp bin/app /usr/local/bin',
      'define HELP',
      'usage: make build',
      'endef',
      'export PATH := $(PWD)/bin:$(PATH)',
      'build: extra',
      '.c.o:',
      '\tcc -c $<',
      'docker-build:',
      '',
      '\tdocker build -t $(IMAGE) .',
      'empty:',
    ].join('\n')
    expect(parseMakefile(makefile)).toEqual([
      { name: 'build', command: 'echo building' },
      { name: 'test', command: 'go test ./...' },
      { name: 'lint', command: 'go test ./...' },
      { name: 'quick', command: 'go vet ./...' },
      { name: 'install', command: 'cp bin/app /usr/local/bin' },
      { name: 'docker-build', command: 'docker build -t $(IMAGE) .' },
      { name: 'empty', command: '' },
    ])
  })

  it('handles CRLF line endings and empty input', () => {
    expect(parseMakefile('run:\r\n\tgo run .\r\n')).toEqual([{ name: 'run', command: 'go run .' }])
    expect(parseMakefile('')).toEqual([])
  })

  it('strips recipe prefixes from inline recipes too', () => {
    expect(parseMakefile('fmt: ; @gofmt -w .\nvet: ; -go vet ./...\n')).toEqual([
      { name: 'fmt', command: 'gofmt -w .' },
      { name: 'vet', command: 'go vet ./...' },
    ])
  })
})

describe('parseJustfile', () => {
  it('lists public recipes and skips settings, aliases, assignments and private recipes', () => {
    const justfile = [
      'set dotenv-load',
      'set shell := ["bash", "-c"]',
      'alias b := build',
      "export RUST_LOG := 'debug'",
      "import 'common.just'",
      'mod deploy',
      "version := '1.0.0'",
      '',
      '# Build the project',
      'build:',
      '    cargo build --release',
      '',
      '@test *args:',
      '    @cargo test {{args}}',
      '',
      'serve host="localhost:8080" port=\'3000\': build',
      '  ./serve --addr {{host}}',
      '',
      '_helper:',
      '    echo hidden',
      '',
      '[private]',
      'secret-helper:',
      '    echo hidden',
      '',
      "[group('ci')]",
      'script:',
      '    #!/usr/bin/env bash',
      '    set -euo pipefail',
      '',
      'setup:',
      '    ./scripts/setup.sh',
      'build:',
      '    duplicate',
    ].join('\n')
    expect(parseJustfile(justfile)).toEqual([
      { name: 'build', command: 'cargo build --release' },
      { name: 'test', command: 'cargo test {{args}}' },
      { name: 'serve', command: './serve --addr {{host}}' },
      { name: 'script', command: 'set -euo pipefail' },
      { name: 'setup', command: './scripts/setup.sh' },
    ])
  })
})

describe('parseTaskfile', () => {
  it('reads tasks in order with their first command or description', () => {
    const doc = {
      version: '3',
      tasks: {
        build: { desc: 'Build it', cmds: ['go build ./...', 'echo done'] },
        test: { cmds: [{ cmd: 'go test ./...' }] },
        lint: { cmd: 'golangci-lint run' },
        docs: { desc: 'Generate docs' },
        ci: { cmds: [{ task: 'lint' }, { task: 'test' }] },
        short: 'echo short',
        list: ['echo one', 'echo two'],
        bare: null,
        helper: { internal: true, cmds: ['echo hidden'] },
        'start:*': { cmds: ['echo {{.MATCH}}'] },
      },
    }
    expect(parseTaskfile(doc)).toEqual([
      { name: 'build', command: 'go build ./...' },
      { name: 'test', command: 'go test ./...' },
      { name: 'lint', command: 'golangci-lint run' },
      { name: 'docs', command: 'Generate docs' },
      { name: 'ci', command: 'task lint' },
      { name: 'short', command: 'echo short' },
      { name: 'list', command: 'echo one' },
      { name: 'bare', command: '' },
    ])
  })

  it('returns nothing for malformed documents', () => {
    expect(parseTaskfile(null)).toEqual([])
    expect(parseTaskfile({ tasks: ['a'] })).toEqual([])
    expect(parseTaskfile('tasks')).toEqual([])
  })
})

describe('parseDenoTasks', () => {
  it('reads string and object tasks', () => {
    expect(
      parseDenoTasks({
        tasks: { dev: 'deno run -A --watch main.ts', build: { command: 'deno compile main.ts' }, x: 1 },
      }),
    ).toEqual([
      { name: 'dev', command: 'deno run -A --watch main.ts' },
      { name: 'build', command: 'deno compile main.ts' },
      { name: 'x', command: '' },
    ])
    expect(parseDenoTasks({})).toEqual([])
  })
})

describe('scriptsDetector on fixtures', () => {
  it('monorepo: root scripts first, then workspace packages by path, with pnpm filters', async () => {
    const ctx = await fixtureContext('monorepo')
    const section = await ctx.use(scriptsDetector)
    expect(section.runner).toBe('pnpm')
    const root = section.scripts.filter((s) => s.source === 'package.json')
    expect(root.map((s) => s.name)).toEqual(['dev', 'build', 'test', 'lint', 'typecheck', 'db:up'])
    expect(root[5]).toEqual({
      name: 'db:up',
      command: 'docker compose up -d',
      run: 'pnpm db:up',
      source: 'package.json',
      package: '.',
      category: 'database',
    })
    expect(section.scripts.find((s) => s.package === 'apps/web' && s.name === 'dev')).toEqual({
      name: 'dev',
      command: 'nuxt dev --port 3000',
      run: 'pnpm --filter @acme/web dev',
      source: 'apps/web/package.json',
      package: 'apps/web',
      category: 'dev',
    })
    const packages = section.scripts.map((s) => s.package)
    expect([...new Set(packages)]).toEqual(['.', 'apps/api', 'apps/web', 'packages/shared', 'packages/ui'])
    expect(section.scripts.filter((s) => s.package === 'apps/api').map((s) => s.name)).toEqual([
      'dev',
      'build',
      'start',
      'test',
      'lint',
      'typecheck',
      'db:migrate',
      'db:generate',
    ])
  })

  it('next-app: npm shortcuts', async () => {
    const ctx = await fixtureContext('next-app')
    const section = await ctx.use(scriptsDetector)
    expect(section.runner).toBe('npm run')
    expect(section.scripts.map((s) => s.run)).toEqual([
      'npm run dev',
      'npm run build',
      'npm start',
      'npm run lint',
      'npm test',
    ])
  })

  it('fastify-api and bun-app use their package manager', async () => {
    const fastify = await (await fixtureContext('fastify-api')).use(scriptsDetector)
    expect(fastify.runner).toBe('yarn')
    expect(fastify.scripts.find((s) => s.name === 'format')).toMatchObject({ run: 'yarn format', category: 'format' })
    const bun = await (await fixtureContext('bun-app')).use(scriptsDetector)
    expect(bun.runner).toBe('bun run')
    expect(brief(bun.scripts)).toEqual([
      ['package.json', 'dev', 'bun run dev'],
      ['package.json', 'test', 'bun run test'],
    ])
  })

  it('go-api: Makefile targets without a JS runner', async () => {
    const ctx = await fixtureContext('go-api')
    const section = await ctx.use(scriptsDetector)
    expect(section.runner).toBeNull()
    expect(section.scripts).toEqual([
      {
        name: 'build',
        command: 'go build -o $(BINARY) ./cmd/api',
        run: 'make build',
        source: 'Makefile',
        category: 'build',
      },
      { name: 'test', command: 'go test -race ./...', run: 'make test', source: 'Makefile', category: 'test' },
      { name: 'lint', command: 'golangci-lint run ./...', run: 'make lint', source: 'Makefile', category: 'lint' },
      { name: 'run', command: 'go run ./cmd/api', run: 'make run', source: 'Makefile', category: 'start' },
      {
        name: 'docker-build',
        command: 'docker build -t $(IMAGE) .',
        run: 'make docker-build',
        source: 'Makefile',
        category: 'build',
      },
    ])
  })

  it('plain-repo: Makefile targets only', async () => {
    const ctx = await fixtureContext('plain-repo')
    const section = await ctx.use(scriptsDetector)
    expect(section.runner).toBeNull()
    expect(section.scripts.map((s) => [s.name, s.category])).toEqual([
      ['install', 'setup'],
      ['test', 'test'],
      ['lint', 'lint'],
      ['clean', 'other'],
    ])
  })

  it('broken-manifest: no scripts, no crash', async () => {
    const ctx = await fixtureContext('broken-manifest')
    expect(await ctx.use(scriptsDetector)).toEqual({ runner: 'npm run', scripts: [] })
  })
})

describe('scriptsDetector on inline projects', () => {
  it('redacts inline secrets from commands', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        scripts: {
          seed: 'API_TOKEN=abc123 node x.js',
          dump: 'pg_dump postgres://admin:pa55word@db.example.com/app',
          push: 'deploy --token s3cr3tvalue',
        },
      }),
      Makefile: `deploy:\n\tGITHUB_TOKEN=ghp_${'1234567890'.repeat(3)}123456 ./deploy.sh\n`,
    })
    expect(section.scripts.map((s) => s.command)).toEqual([
      'API_TOKEN=*** node x.js',
      'pg_dump postgres://***@db.example.com/app',
      'deploy --token ***',
      'GITHUB_TOKEN=*** ./deploy.sh',
    ])
    const json = JSON.stringify(section)
    for (const secret of ['abc123', 'pa55word', 's3cr3tvalue', 'ghp_1234']) expect(json).not.toContain(secret)
  })

  it('uses npm -w for npm workspaces and yarn workspace for Yarn', async () => {
    const npm = await detectFiles({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
    })
    expect(brief(npm.scripts)).toEqual([['packages/a/package.json', 'build', 'npm run build -w packages/a']])
    const yarn = await detectFiles({
      'package.json': JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@4.10.3' }),
      'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { test: 'vitest' } }),
    })
    expect(yarn.runner).toBe('yarn')
    expect(brief(yarn.scripts)).toEqual([['packages/a/package.json', 'test', 'yarn workspace @x/a test']])
  })

  it('changes directory for nested packages that are not workspace members', async () => {
    const section = await detectFiles({
      'frontend/package.json': JSON.stringify({ name: 'frontend', scripts: { dev: 'vite' } }),
    })
    expect(section.runner).toBeNull()
    expect(section.scripts).toEqual([
      {
        name: 'dev',
        command: 'vite',
        run: 'cd frontend && npm run dev',
        source: 'frontend/package.json',
        package: 'frontend',
        category: 'dev',
      },
    ])
  })

  it('combines package.json, deno.json, Makefile, justfile and Taskfile in a fixed order', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ scripts: { start: 'node .' } }),
      'deno.jsonc': '{\n  // tasks\n  "tasks": { "fmt": "deno fmt" }\n}',
      makefile: 'all:\n\techo all\n',
      Justfile: 'default:\n  just --list\n',
      'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds:\n      - go test ./...\n',
    })
    expect(section.scripts.map((s) => [s.source, s.name, s.run, s.category])).toEqual([
      ['package.json', 'start', 'npm start', 'start'],
      ['deno.jsonc', 'fmt', 'deno task fmt', 'format'],
      ['makefile', 'all', 'make all', 'other'],
      ['Justfile', 'default', 'just default', 'other'],
      ['Taskfile.yml', 'test', 'task test', 'test'],
    ])
    expect(section.scripts.slice(1).every((s) => s.package === undefined)).toBe(true)
  })

  it('quotes script names that need it', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ scripts: { 'build all': 'tsc' } }),
      'pnpm-lock.yaml': '',
    })
    expect(section.scripts[0]?.run).toBe("pnpm 'build all'")
  })

  it('uses "pnpm run" for scripts that share a name with a pnpm command', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ scripts: { dev: 'vite', deploy: 'wrangler deploy', up: 'docker compose up' } }),
      'pnpm-lock.yaml': '',
    })
    expect(section.scripts.map((s) => s.run)).toEqual(['pnpm dev', 'pnpm run deploy', 'pnpm run up'])
  })

  it('clips over-long commands without leaking a secret cut in half', async () => {
    const secret = `ghp_${'B'.repeat(36)}`
    const section = await detectFiles({
      'package.json': JSON.stringify({
        scripts: {
          long: `${'echo step && '.repeat(76)}curl -H ${secret} https://example.com`,
          blob: 'a.'.repeat(200_000),
        },
      }),
      Makefile: `all:\n\t${'b.'.repeat(100_000)}\n`,
    })
    const [long, blob, make] = section.scripts
    expect(long?.command.length).toBeLessThanOrEqual(MAX_COMMAND_LENGTH + 2)
    expect(long?.command.endsWith('…')).toBe(true)
    expect(JSON.stringify(section)).not.toContain('ghp_')
    expect(blob?.command).toBe('…')
    expect(make).toMatchObject({ name: 'all', command: '…', run: 'make all' })
  })

  it('survives a malformed Taskfile and records a warning', async () => {
    const dir = await makeProject({ 'Taskfile.yml': 'tasks:\n\t- broken: [\n' })
    const ctx = await contextFor(dir)
    expect(await ctx.use(scriptsDetector)).toEqual({ runner: null, scripts: [] })
    expect(ctx.warnings.some((w) => w.file === 'Taskfile.yml')).toBe(true)
  })

  it('keeps the scripts when the package managers detector fails', async () => {
    const original = packageManagersDetector.run
    packageManagersDetector.run = async () => {
      throw new Error('boom')
    }
    try {
      const section = await detectFiles({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })
      expect(brief(section.scripts)).toEqual([['package.json', 'dev', 'npm run dev']])
    } finally {
      packageManagersDetector.run = original
    }
  })
})

describe('Nx project.json targets', () => {
  it('parses targets with their command or executor', () => {
    expect(
      parseNxProject(
        {
          name: 'web',
          targets: {
            serve: { executor: '@nx/vite:dev-server', options: { buildTarget: 'web:build' } },
            deploy: { executor: 'nx:run-commands', options: { command: 'wrangler deploy' } },
            seed: { command: 'tsx seed.ts' },
            lint: { options: { commands: [{ command: 'eslint .' }] } },
          },
        },
        'apps/web',
      ),
    ).toEqual({
      name: 'web',
      targets: [
        { name: 'serve', command: '@nx/vite:dev-server' },
        { name: 'deploy', command: 'wrangler deploy' },
        { name: 'seed', command: 'tsx seed.ts' },
        { name: 'lint', command: 'eslint .' },
      ],
    })
    expect(parseNxProject({ targets: { build: {} } }, 'libs/ui')?.name).toBe('ui')
    expect(parseNxProject({ name: 'x' }, 'apps/x')).toBeNull()
    expect(parseNxProject({ targets: { build: {} } }, '.')).toBeNull()
  })

  it('builds nx commands, falling back to `nx run` for names Nx would take as its own commands', () => {
    expect(nxRunCommand('pnpm', 'web', 'serve')).toBe('pnpm nx serve web')
    expect(nxRunCommand('npm', 'web', 'serve')).toBe('npx nx serve web')
    expect(nxRunCommand('yarn', '@acme/web', 'build')).toBe('yarn nx build @acme/web')
    expect(nxRunCommand('bun', 'web', 'test')).toBe('bunx nx test web')
    expect(nxRunCommand('npm', 'web', 'graph')).toBe('npx nx run web:graph')
    expect(nxRunCommand('npm', 'web', 'build:prod')).toBe('npx nx run web:build:prod')
    expect(nxRunCommand('npm', 'we b;x', 'serve')).toBe("npx nx serve 'we b;x'")
  })

  it('lists targets of an Nx integrated repository as scripts', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ name: 'acme', private: true }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'nx.json': '{}',
      'apps/web/project.json': JSON.stringify({
        name: 'web',
        targets: { serve: { executor: '@nx/vite:dev-server' }, build: { executor: '@nx/vite:build' } },
      }),
      'libs/ui/project.json': JSON.stringify({ targets: { test: { executor: '@nx/vite:test' } } }),
      'examples/demo/project.json': JSON.stringify({ name: 'demo', targets: { serve: {} } }),
    })
    expect(section.scripts.map((s) => [s.source, s.name, s.run, s.category, s.package])).toEqual([
      ['apps/web/project.json', 'serve', 'pnpm nx serve web', 'start', 'apps/web'],
      ['apps/web/project.json', 'build', 'pnpm nx build web', 'build', 'apps/web'],
      ['libs/ui/project.json', 'test', 'pnpm nx test ui', 'test', 'libs/ui'],
    ])
  })

  it('ignores project.json files outside an Nx workspace', async () => {
    const section = await detectFiles({
      'package.json': '{}',
      'apps/web/project.json': JSON.stringify({ name: 'web', targets: { serve: {} } }),
    })
    expect(section.scripts).toEqual([])
  })
})
