import { describe, expect, it } from 'vitest'
import { renderAgentContext, renderAgentFiles } from '../../src/agent/index.ts'
import { workspaceRunCommand } from '../../src/detectors/scripts.ts'
import {
  commandLine,
  envSetup,
  exampleTarget,
  isDestructiveCommand,
  keyCommands,
  quickStart,
  servicesCommand,
  verifyCommands,
  workspaceScriptExample,
} from '../../src/output/commands.ts'
import { renderMarkdown } from '../../src/output/markdown.ts'
import { createStyle, defaultRenderOptions, stripAnsi } from '../../src/output/style.ts'
import { renderScan } from '../../src/output/terminal.ts'
import type { EnvFile, ScanResult, Script, Service } from '../../src/types.ts'
import { makeResult, sampleScanResult } from '../factories.ts'

function script(overrides: Partial<Script> & Pick<Script, 'name'>): Script {
  return {
    command: `run ${overrides.name}`,
    run: `pnpm ${overrides.name}`,
    source: 'package.json',
    package: '.',
    category: 'other',
    ...overrides,
  }
}

function withScripts(scripts: Script[], overrides: Partial<ScanResult> = {}): ScanResult {
  return makeResult({ scripts: { runner: 'pnpm', scripts }, ...overrides })
}

function service(name: string, overrides: Partial<Service> = {}): Service {
  return {
    name,
    source: 'compose.yaml',
    kind: 'other',
    ports: [],
    expose: [],
    dependsOn: [],
    volumes: [],
    environment: [],
    envFiles: [],
    profiles: [],
    healthcheck: false,
    ...overrides,
  }
}

function envFile(path: string, kind: EnvFile['kind']): EnvFile {
  return { path, kind, variables: 1, ignored: kind !== 'example', tracked: kind === 'example' }
}

function withEnvFiles(...files: EnvFile[]): ScanResult {
  return makeResult({ environment: { files, variables: [], usageTruncated: false } })
}

const NPM = {
  primary: { id: 'npm', name: 'npm', lockfiles: ['package-lock.json'], declared: false, evidence: [] },
  detected: [],
}

/**
 * The words of a command line as a POSIX shell reads them, or null when any
 * character outside single quotes could make the shell do something else
 * (substitution, redirection, globbing, another command).
 */
function shellWords(command: string): string[] | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    if (char === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return null
      word += command.slice(i + 1, close)
      inWord = true
      i = close
    } else if (char === '\\') {
      if (i + 1 >= command.length) return null
      word += command[i + 1]
      inWord = true
      i++
    } else if (char === ' ') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else if (char === '&' && command[i + 1] === '&' && !inWord) {
      words.push('&&')
      i++
    } else if (/[\w@%+=:,./-]/.test(char)) {
      word += char
      inWord = true
    } else return null
  }
  if (inWord) words.push(word)
  return words
}

// ---------------------------------------------------------------------------
// Everyday tasks (moved here with the engine from markdown/facts.ts)
// ---------------------------------------------------------------------------

describe('keyCommands', () => {
  it('prefers exact script names and skips hooks and watch/fix variants', () => {
    const result = withScripts(
      [
        script({ name: 'prebuild', category: 'build' }),
        script({ name: 'preview', category: 'start' }),
        script({ name: 'build:watch', category: 'build' }),
        script({ name: 'build:prod', category: 'build' }),
        script({ name: 'lint:fix', category: 'lint' }),
        script({ name: 'lint', category: 'lint' }),
        script({ name: 'test:watch', category: 'test' }),
        script({ name: 'test:unit', category: 'test' }),
        script({ name: 'start', category: 'start' }),
        script({ name: 'check-types', category: 'typecheck' }),
      ],
      {
        packageManagers: {
          primary: { id: 'pnpm', name: 'pnpm', lockfiles: [], declared: true, evidence: [] },
          detected: [],
        },
      },
    )
    expect(keyCommands(result).map((c) => [c.task, c.command])).toEqual([
      ['install', 'pnpm install'],
      ['dev', 'pnpm start'],
      ['test', 'pnpm test:unit'],
      ['lint', 'pnpm lint'],
      ['typecheck', 'pnpm check-types'],
      ['build', 'pnpm build:prod'],
    ])
    expect(verifyCommands(result).map((c) => c.task)).toEqual(['lint', 'typecheck', 'test'])
  })

  it('falls back to Makefile targets and to the setup target when no package manager is known', () => {
    const result = withScripts([
      script({ name: 'install', source: 'Makefile', run: 'make install', category: 'setup' }),
      script({ name: 'test', source: 'Makefile', run: 'make test', category: 'test' }),
    ])
    expect(keyCommands(result).map((c) => [c.task, c.command, c.source, c.fromFile])).toEqual([
      ['install', 'make install', 'Makefile', true],
      ['test', 'make test', 'Makefile', true],
    ])
  })

  it('uses standard Go commands only for a Go module at the root', () => {
    const goRoot = makeResult({
      project: { ...makeResult().project, manifests: ['go.mod'] },
      languages: [{ name: 'Go', kind: 'programming', files: 3, share: 1 }],
      packageManagers: {
        primary: { id: 'go', name: 'Go modules', lockfiles: [], declared: true, evidence: [] },
        detected: [],
      },
    })
    expect(keyCommands(goRoot).map((c) => c.command)).toEqual(['go mod download', 'go test ./...', 'go build ./...'])
    expect(keyCommands(makeResult())).toEqual([])
  })

  it('does not suggest go test for a go.mod without Go code', () => {
    // e.g. a stray or unparsable go.mod in a JavaScript project
    const result = makeResult({
      project: { ...makeResult().project, manifests: ['package.json', 'go.mod'] },
      languages: [{ name: 'TypeScript', kind: 'programming', files: 3, share: 1 }],
    })
    expect(keyCommands(result)).toEqual([])
  })

  it('never picks the npm placeholder test script', () => {
    const result = withScripts(
      [
        script({
          name: 'test',
          command: 'echo "Error: no test specified" && exit 1',
          run: 'npm test',
          category: 'test',
        }),
      ],
      {
        packageManagers: {
          primary: { id: 'npm', name: 'npm', lockfiles: ['package-lock.json'], declared: false, evidence: [] },
          detected: [],
        },
      },
    )
    expect(keyCommands(result).map((c) => c.task)).toEqual(['install'])
    expect(verifyCommands(result)).toEqual([])
  })

  it('never offers a watch script as a check, but accepts one for dev', () => {
    const result = withScripts([
      script({ name: 'test:watch', category: 'test' }),
      script({ name: 'watch-lint', category: 'lint' }),
      script({ name: 'dev:watch', category: 'dev' }),
    ])
    expect(keyCommands(result).map((c) => [c.task, c.command])).toEqual([['dev', 'pnpm dev:watch']])
    expect(verifyCommands(result)).toEqual([])
  })
})

describe('servicesCommand', () => {
  const services = sampleScanResult().services

  it('prefers a root script that starts the services', () => {
    expect(servicesCommand(sampleScanResult())?.command).toBe('pnpm db:up')
  })

  it('falls back to docker compose, naming a non-default file quoted', () => {
    expect(servicesCommand(makeResult({ services }))?.command).toBe('docker compose up -d')
    const nested = { ...services, composeFiles: ['docker/dev.yml'] }
    nested.services = nested.services.map((s) => ({ ...s, source: 'docker/dev.yml' }))
    expect(servicesCommand(makeResult({ services: nested }))?.command).toBe('docker compose -f docker/dev.yml up -d')
    expect(servicesCommand(makeResult())).toBeNull()
  })

  it('starts only the backing services when Compose also builds the app (ACC-H4)', () => {
    // `docker compose up -d` would also start the app container on :3000, and `npm run dev` then fails.
    const result = makeResult({
      services: {
        composeFiles: ['compose.yaml', 'docker-compose.override.yml'],
        dockerfiles: [],
        services: [
          service('app', {
            build: '.',
            kind: 'app',
            ports: [{ host: 3000, container: 3000, protocol: 'tcp', raw: '' }],
          }),
          service('cache', { image: 'redis:8', kind: 'cache' }),
          service('db', { image: 'postgres:17', kind: 'database' }),
          service('worker', { build: '.', kind: 'app', profiles: ['workers'] }),
          service('admin', { image: 'dpage/pgadmin4', kind: 'other', profiles: ['tools'] }),
        ],
      },
      packageManagers: NPM,
    })
    const start = servicesCommand(result)
    expect(start).toMatchObject({ command: 'docker compose up -d cache db', services: ['cache', 'db'], backing: true })
    expect(quickStart(result).map((step) => step.command)).toEqual(['docker compose up -d cache db', 'npm install'])
    expect(renderMarkdown(result)).toContain('Start the backing services with `docker compose up -d cache db`.')
    expect(renderAgentContext(result)).toContain('Start: `docker compose up -d cache db`')
  })

  it('quotes service names and a hostile Compose file path', () => {
    const file = 'deploy/$(touch pwned)/compose.yaml'
    const result = makeResult({
      services: {
        composeFiles: [file],
        dockerfiles: [],
        services: [
          service('app', { source: file, build: '.', kind: 'app' }),
          service('db;reboot', { source: file, image: 'postgres:17', kind: 'database' }),
        ],
      },
    })
    expect(servicesCommand(result)?.command).toBe(
      "docker compose -f 'deploy/$(touch pwned)/compose.yaml' up -d 'db;reboot'",
    )
  })
})

describe('envSetup', () => {
  it('copies the example to .env when no local file exists', () => {
    const setup = envSetup(withEnvFiles(envFile('.env.example', 'example')))
    expect(setup).toMatchObject({ example: '.env.example', target: '.env', exists: false })
    expect(setup?.command?.command).toBe('cp .env.example .env')
  })

  it('recognizes .env.local as the local env file (UX-12)', () => {
    const result = withEnvFiles(envFile('.env.example', 'example'), envFile('.env.local', 'local'))
    expect(envSetup(result)).toEqual({ example: '.env.example', target: '.env.local', exists: true })
    expect(quickStart(result)).toEqual([])
    const environment = renderAgentFiles(result).find((file) => file.name === 'environment.md')?.content ?? ''
    expect(environment).toContain('A local `.env.local` exists. Compare it with `.env.example`')
    expect(environment).not.toContain('Fill in the values in `.env`')
  })

  it('copies a named example to the file it documents (ACC-L6)', () => {
    expect(envSetup(withEnvFiles(envFile('.env.local.example', 'example')))?.command?.command).toBe(
      'cp .env.local.example .env.local',
    )
    expect(envSetup(withEnvFiles(envFile('.env.development.example', 'example')))?.command?.command).toBe(
      'cp .env.development.example .env.development',
    )
    const environment =
      renderAgentFiles(withEnvFiles(envFile('.env.local.example', 'example'))).find(
        (file) => file.name === 'environment.md',
      )?.content ?? ''
    expect(environment).toContain('Fill in the values in `.env.local`. Never commit it.')
  })

  it('prefers the example for .env and ignores examples in subdirectories', () => {
    const result = withEnvFiles(
      envFile('.env.test.example', 'example'),
      envFile('.env.example', 'example'),
      envFile('apps/web/.env.example', 'example'),
    )
    expect(envSetup(result)?.command?.command).toBe('cp .env.example .env')
    expect(envSetup(withEnvFiles(envFile('apps/web/.env.example', 'example')))).toBeNull()
  })

  it('works out the target of every example naming style', () => {
    expect(exampleTarget('.env.example')).toBe('.env')
    expect(exampleTarget('.env.sample')).toBe('.env')
    expect(exampleTarget('.env.dist')).toBe('.env')
    expect(exampleTarget('example.env')).toBe('.env')
    expect(exampleTarget('.env.local.example')).toBe('.env.local')
    expect(exampleTarget('.env.production.template')).toBe('.env.production')
    expect(exampleTarget('db.example.env')).toBe('db.env')
    expect(exampleTarget('.env.example$(id)')).toBe('.env')
  })
})

describe('quickStart', () => {
  it('suggests no install for a package.json that does not parse (UX-19)', () => {
    const result = makeResult({
      packageManagers: NPM,
      meta: {
        files: 2,
        config: { sources: [], settings: {} },
        truncated: false,
        warnings: [{ kind: 'parse', file: 'package.json', message: "Couldn't parse package.json" }],
      },
    })
    expect(quickStart(result)).toEqual([])
    expect(keyCommands(result)).toEqual([])
  })

  it("runs the first app package's dev script in a monorepo without a root one (ACC-L8)", () => {
    const pkg = (name: string, path: string) => ({ name, path, ecosystem: 'node' as const })
    const dev = (path: string, name: string) =>
      script({
        name: 'dev',
        run: workspaceRunCommand('pnpm', { name, dir: path }, 'dev'),
        source: `${path}/package.json`,
        package: path,
        category: 'dev',
      })
    const result = makeResult({
      project: { ...makeResult().project, type: 'monorepo' },
      packageManagers: {
        primary: { id: 'pnpm', name: 'pnpm', lockfiles: [], declared: true, evidence: [] },
        detected: [],
      },
      workspace: {
        tools: [],
        patterns: ['apps/*', 'packages/*'],
        packages: [pkg('@acme/ui', 'packages/ui'), pkg('@acme/web', 'apps/web')],
      },
      scripts: { runner: 'pnpm', scripts: [dev('packages/ui', '@acme/ui'), dev('apps/web', '@acme/web')] },
    })
    expect(quickStart(result).map((step) => [step.command, step.reason])).toEqual([
      ['pnpm install', 'install dependencies'],
      ['pnpm --filter @acme/web dev', 'start the development server (apps/web)'],
    ])
  })

  it('says a CLI project runs from source rather than starting a server (UX-26)', () => {
    const result = withScripts([script({ name: 'dev', category: 'dev' })], {
      project: { ...makeResult().project, type: 'cli' },
    })
    expect(quickStart(result).at(-1)?.reason).toBe('run the CLI from source')
  })

  it('runs a single Go main package, quoted', () => {
    const result = makeResult({
      project: { ...makeResult().project, entrypoints: [{ kind: 'go-main', path: 'cmd/my api' }] },
    })
    expect(quickStart(result).map((step) => step.command)).toEqual(["go run './cmd/my api'"])
  })
})

describe('workspaceScriptExample', () => {
  it('never offers a destructive or catch-all script as the example to run (ACC-L2)', () => {
    const member = (name: string, command: string, category: Script['category']) =>
      script({
        name,
        command,
        run: `pnpm --filter web ${name}`,
        source: 'apps/web/package.json',
        package: 'apps/web',
        category,
      })
    const result = makeResult({
      workspace: { tools: [], patterns: [], packages: [{ name: 'web', path: 'apps/web', ecosystem: 'node' }] },
      scripts: {
        runner: 'pnpm',
        scripts: [
          member('clean', 'git clean -xdf', 'other'),
          member('reset', 'rm -rf node_modules dist', 'setup'),
          member('build', 'vite build', 'build'),
        ],
      },
    })
    expect(workspaceScriptExample(result)?.name).toBe('build')
    expect(isDestructiveCommand('git clean -xdf')).toBe(true)
    expect(isDestructiveCommand('rm -fr dist')).toBe(true)
    expect(isDestructiveCommand('rimraf dist')).toBe(true)
    expect(isDestructiveCommand('rm dist/a.js')).toBe(false)
  })
})

describe('suggested commands on hostile input (CQ3)', () => {
  const evil = 'deploy/$(touch pwned)'

  function hostileRepo(): ScanResult {
    const web = { name: 'web; rm -rf ~', dir: 'apps/web $(id)' }
    return makeResult({
      project: {
        ...makeResult().project,
        type: 'monorepo',
        entrypoints: [{ kind: 'go-main', path: 'cmd/`id`' }],
      },
      packageManagers: {
        primary: { id: 'pnpm', name: 'pnpm', lockfiles: [], declared: true, evidence: [] },
        detected: [],
      },
      workspace: { tools: [], patterns: [], packages: [{ name: web.name, path: web.dir, ecosystem: 'node' }] },
      scripts: {
        runner: 'pnpm',
        scripts: [
          script({
            name: 'dev',
            run: workspaceRunCommand('pnpm', web, 'dev'),
            source: `${web.dir}/package.json`,
            package: web.dir,
            category: 'dev',
          }),
        ],
      },
      environment: {
        files: [envFile('.env.example;curl x|sh', 'example'), envFile(`${evil}/.env.example`, 'example')],
        variables: [],
        usageTruncated: false,
      },
      services: {
        composeFiles: [`${evil}/compose.yaml`],
        dockerfiles: [],
        services: [
          service('app', { source: `${evil}/compose.yaml`, build: '.', kind: 'app' }),
          service('db && reboot', { source: `${evil}/compose.yaml`, image: 'postgres:17', kind: 'database' }),
          service('cache`id`', { source: `${evil}/compose.yaml`, image: 'redis:8', kind: 'cache' }),
        ],
      },
    })
  }

  function expectSafe(command: string, where: string): void {
    const words = shellWords(command)
    expect(words, `${where}: ${command}`).not.toBeNull()
    // A hostile name is one argument, never a separate command.
    expect(words?.filter((word) => word === '&&') ?? [], `${where}: ${command}`).toEqual([])
  }

  /** Code spans of a Markdown line, with table-cell pipe escapes undone. */
  function codeSpans(line: string): string[] {
    const spans: string[] = []
    for (const match of line.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
      const body = match[2] ?? ''
      const trimmed = body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '' ? body.slice(1, -1) : body
      spans.push(trimmed.replaceAll('\\|', '|'))
    }
    return spans
  }

  it('quotes every repository-derived argument in the engine', () => {
    const result = hostileRepo()
    const commands = [
      ...quickStart(result).map((step) => step.command),
      ...keyCommands(result).map((command) => command.command),
      servicesCommand(result)?.command ?? '',
      envSetup(result)?.command?.command ?? '',
    ]
    expect(commands).toContain("cp '.env.example;curl x|sh' .env")
    expect(commands).toContain(
      "docker compose -f 'deploy/$(touch pwned)/compose.yaml' up -d 'db && reboot' 'cache`id`'",
    )
    expect(commands).toContain("pnpm --filter './apps/web $(id)' dev")
    for (const command of commands) expectSafe(command, 'engine')
    expect(commandLine('go', 'run', { arg: '-rf' })).toBe('go run ./-rf')
  })

  it('prints only quoted, copyable commands in the terminal', () => {
    const output = stripAnsi(
      renderScan(hostileRepo(), defaultRenderOptions({ style: createStyle({ color: false, unicode: true }) })),
    )
    const lines = output.split('\n')
    const start = lines.indexOf('Quick start')
    const steps = lines.slice(start + 1, lines.indexOf('', start))
    expect(steps.length).toBeGreaterThanOrEqual(3)
    for (const step of steps) {
      const command = step.replace(/^ {2}\d+\. /, '').split(/ {2,}/)[0] ?? ''
      expectSafe(command, 'terminal')
    }
  })

  it('prints only quoted commands in the report and the agent files', () => {
    const result = hostileRepo()
    const documents = [
      ['report.md', renderMarkdown(result)],
      ...renderAgentFiles(result).map((file) => [file.name, file.content]),
    ] as const
    let checked = 0
    for (const [name, content] of documents) {
      for (const line of content.split('\n')) {
        // Suggested commands: numbered steps, "Start … with", "Start:", "Create … with", command bullets and tables.
        if (
          !/^\d+\. `|Start (?:the (?:backing )?services )?(?:with|:)|Create the local env file|^- \w+: `|^\| (?:Install|Dev|Test|Lint|Build) \|/.test(
            line,
          )
        ) {
          continue
        }
        for (const span of codeSpans(line)) {
          if (!/^(?:cp|docker|pnpm|npm|go|make) /.test(span)) continue
          expectSafe(span, name)
          checked++
        }
      }
      expect(content, name).not.toMatch(/-f deploy\/\$\(touch pwned\)/)
      expect(content, name).not.toMatch(/cp \.env\.example;curl/)
    }
    expect(checked).toBeGreaterThanOrEqual(8)
  })
})
