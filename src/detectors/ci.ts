import { getString, isRecord } from '../core/parse.ts'
import type { CiJob, CiProvider, CiTask, CiWorkflow, Detector, FileIndex, ProjectContext } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { matchGlob } from '../utils/glob.ts'
import { depthOf } from '../utils/paths.ts'
import { redactCommand } from '../utils/redact.ts'

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

type WorkflowFormat = 'github' | 'gitlab' | 'circleci'

interface ProviderDef {
  id: string
  name: string
  /** Globs matched against indexed .yml/.yaml files. */
  yaml: readonly string[]
  /** Exact paths of non-YAML files. */
  files?: readonly string[]
  /** Formats RepoLens parses into workflows; other providers are only listed. */
  format?: WorkflowFormat
}

/** Catalog order is the output order of `providers`. */
const PROVIDERS: readonly ProviderDef[] = [
  { id: 'github-actions', name: 'GitHub Actions', yaml: ['.github/workflows/*.{yml,yaml}'], format: 'github' },
  { id: 'gitlab-ci', name: 'GitLab CI', yaml: ['.gitlab-ci.{yml,yaml}'], format: 'gitlab' },
  { id: 'circleci', name: 'CircleCI', yaml: ['.circleci/config.{yml,yaml}'], format: 'circleci' },
  {
    id: 'azure-pipelines',
    name: 'Azure Pipelines',
    yaml: ['azure-pipelines.{yml,yaml}', '.azure-pipelines/*.{yml,yaml}'],
  },
  { id: 'jenkins', name: 'Jenkins', yaml: [], files: ['Jenkinsfile'] },
  { id: 'travis-ci', name: 'Travis CI', yaml: ['.travis.{yml,yaml}'] },
  { id: 'bitbucket-pipelines', name: 'Bitbucket Pipelines', yaml: ['bitbucket-pipelines.{yml,yaml}'] },
  { id: 'buildkite', name: 'Buildkite', yaml: ['.buildkite/pipeline.{yml,yaml}', 'buildkite.{yml,yaml}'] },
  { id: 'drone', name: 'Drone', yaml: ['.drone.{yml,yaml}'] },
  { id: 'woodpecker', name: 'Woodpecker', yaml: ['.woodpecker.{yml,yaml}', '.woodpecker/*.{yml,yaml}'] },
  { id: 'forgejo-actions', name: 'Forgejo Actions', yaml: ['.forgejo/workflows/*.{yml,yaml}'], format: 'github' },
  { id: 'gitea-actions', name: 'Gitea Actions', yaml: ['.gitea/workflows/*.{yml,yaml}'], format: 'github' },
]

/** CI files live at most two directories deep (".github/workflows/ci.yml"). */
function shallowYamlFiles(index: FileIndex): string[] {
  return index.byExtension('.yml', '.yaml').filter((file) => depthOf(file) <= 2)
}

function providerFiles(def: ProviderDef, yamlFiles: readonly string[], index: FileIndex): string[] {
  const found = yamlFiles.filter((file) => def.yaml.some((pattern) => matchGlob(pattern, file)))
  for (const file of def.files ?? []) if (index.has(file)) found.push(file)
  return found.sort(compareText)
}

/**
 * Workflow files in the GitHub Actions format (GitHub, Forgejo, Gitea), sorted,
 * with the provider id of each. Shared with the runtimes detector.
 */
export function githubStyleWorkflows(index: FileIndex): Array<{ provider: string; file: string }> {
  const yamlFiles = shallowYamlFiles(index)
  const out: Array<{ provider: string; file: string }> = []
  for (const def of PROVIDERS) {
    if (def.format !== 'github') continue
    for (const file of providerFiles(def, yamlFiles, index)) out.push({ provider: def.id, file })
  }
  return out.sort((a, b) => compareText(a.file, b.file))
}

// ---------------------------------------------------------------------------
// Task inference
// ---------------------------------------------------------------------------

export const CI_TASK_ORDER: readonly CiTask[] = [
  'lint',
  'format',
  'typecheck',
  'test',
  'e2e',
  'build',
  'deploy',
  'release',
  'security',
  'docs',
]

/**
 * Patterns are matched against lowercased text after long flags and URLs are
 * removed, so "cargo build --release", "--out-format=json" or a download from
 * ".../releases/download/..." do not count as tasks. Install commands
 * ("npm ci", "npm install") intentionally match nothing.
 */
const TASK_PATTERNS: Readonly<Record<CiTask, RegExp>> = {
  lint: /(?<!no-)lint|\bbiome (?:check|ci)\b|\bgo vet\b|\bshellcheck\b|\bruff\b(?! format)|\bflake8\b|\brubocop\b|\bclippy\b|\bstaticcheck\b|\bpre-commit\b/,
  format:
    /\bprettier\b|(?<!\w)(?:format(?:ting|ter)?|fmt)\b|\bgofmt\b|\bgofumpt\b|\bdprint\b|\bblack\b|\bisort\b|\bbiome format\b/,
  typecheck:
    /\btype-?check|\btypes?[:-]check\b|\bcheck[:-]types\b|\btsc\b|\bmypy\b|\bpyright\b|\bsvelte-check\b|\bastro check\b|\bdeno check\b|\bflow check\b/,
  test: /\btest(?:s|ing)?\b|\bvitest\b|\bjest\b|\bmocha\b|\bpytest\b|\bunittest\b|\bcodecov\b|\bcoveralls\b|\bcoverage\b|\btox\b|\bnox\b|\brspec\b|\bphpunit\b|\bctest\b|\bgotestsum\b/,
  e2e: /\be2e\b|\bend-to-end\b|\bplaywright\b|\bcypress\b|\bwdio\b|\bwebdriverio\b|\bselenium\b|\bdetox\b/,
  build:
    /\bbuild\b|\bcompile\b|\bxcodebuild\b|\bgradlew?\b.{0,80}?\bassemble|\bmvnw?\b.{0,80}?\b(?:package|verify)\b|\bwebpack\b|\brollup\b/,
  deploy:
    /\bdeploy|\bvercel\b(?!\/)|\bnetlify\b|\bwrangler\b|\bheroku\b|\bgh-pages\b|\bpages-action\b|\bkubectl (?:apply|rollout|set image)\b|\bhelm (?:upgrade|install)\b|\bterraform apply\b|\brailway up\b|\bargocd\b|\bflyctl\b|\baws s3 sync\b/,
  release:
    /\breleases?\b|\bpublish(?:es|ing)?\b|\bgoreleaser\b|\bchangesets\/action\b|\bchangeset (?:publish|version)\b|\bnpm version\b/,
  security:
    /\bcodeql\b|\baudit\b|\btrivy\b|\bsnyk\b|\bgitleaks\b|\bdependency-review\b|\bsemgrep\b|\bgosec\b|\bgovulncheck\b|\bosv-scanner\b|\bscorecard\b|\btrufflehog\b|\bgrype\b|\bbandit\b|\bsecurity\b|\bzizmor\b/,
  docs: /\bdocs?\b|\btypedoc\b|\bmkdocs\b|\bdocusaurus\b|\bsphinx\b|\bjsdoc\b|\bgodoc\b|\bvitepress\b|\bdocumentation\b/,
}

/** Lines longer than this are cut before matching, which keeps every pattern linear in the input size. */
const MAX_LINE_LENGTH = 1000

/**
 * Test directories given as paths ("tests/unit", "./test", "src/tests") are arguments, not a test run.
 * A singular "x/test" is left alone: it is as likely an orb job or action ("node/test").
 */
const TEST_DIRECTORY = /(?<![\w-])tests?\/|\.\/tests?(?![\w-])|\/tests(?![\w-])/g
/** A bare "tests" after a linter, formatter or type checker is the directory it checks ("ruff check src tests"). */
const TESTS_ARGUMENT = /(?<![\w-])tests(?![\w-])/g

function normalizeTaskText(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/\S+/g, ' ')
      // Build configurations named "Release" ("-c Release", "--config Release", "-DCMAKE_BUILD_TYPE=Release").
      .replace(
        /(?:(?<![\w-])-c|(?<![\w-])-{1,2}(?:config(?:uration)?|profile)|build_type|\/p:configuration)[=:\s]+["']?release\b/g,
        ' ',
      )
      // Long flags, except the few that name a task themselves ("node --test", "tsc --build").
      .replace(/(?<![\w-])--(?!(?:test|build)(?![\w-]))[\w-]+(?:=\S*)?/g, ' ')
      // Setup steps that only mention a task word: the shell's `test -f …`, `NODE_ENV=test`, `prisma migrate deploy`.
      .replace(/(?:^\s*|[(!{]\s*|\b(?:if|then|elif|else|while|until|do)\s+)test\s+-[a-z]\b/g, ' ')
      .replace(/\b[a-z0-9_]*env=["']?test\b/g, ' ')
      .replace(/\bmigrate deploy\b/g, ' ')
      .replace(/\bbuild-essential\b/g, ' ')
  )
}

/** Tasks named by one shell command. */
function commandTasks(command: string): CiTask[] {
  const text = normalizeTaskText(command)
  const tasks = CI_TASK_ORDER.filter((task) => task !== 'test' && TASK_PATTERNS[task].test(text))
  // "playwright test" or "e2e-tests" are end-to-end tests, not unit tests.
  if (tasks.includes('e2e')) return tasks
  let testText = text.replace(TEST_DIRECTORY, ' ')
  if (tasks.includes('lint') || tasks.includes('format') || tasks.includes('typecheck')) {
    testText = testText.replace(TESTS_ARGUMENT, ' ')
  }
  if (TASK_PATTERNS.test.test(testText)) tasks.push('test')
  return tasks
}

/**
 * Infer what a CI job does from its id, name, step names, commands and
 * actions. Each command of a line ("a && b; c | d") is judged on its own.
 * Returns tasks in canonical order (see CI_TASK_ORDER).
 */
export function inferTasks(texts: readonly string[]): CiTask[] {
  const found = new Set<CiTask>()
  for (const raw of texts) {
    for (const line of raw.split('\n')) {
      for (const command of line.slice(0, MAX_LINE_LENGTH).split(/&&|\|\||[;|]/)) {
        if (command.trim() === '') continue
        for (const task of commandTasks(command)) found.add(task)
      }
    }
  }
  return CI_TASK_ORDER.filter((task) => found.has(task))
}

// ---------------------------------------------------------------------------
// GitHub Actions expressions
// ---------------------------------------------------------------------------

export interface ExpressionScope {
  /** The job's `strategy.matrix`. */
  matrix?: unknown
  /** `env` maps, innermost first (step, job, workflow). */
  env?: readonly unknown[]
}

const MAX_EXPANSIONS = 32
/** Longer values are never expanded (and never worth showing). */
const MAX_EXPRESSION_LENGTH = 256

function literal(value: unknown): string | null {
  if (typeof value === 'string') return value.includes('${{') ? null : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function pathValue(value: unknown, segments: readonly string[]): unknown {
  let current = value
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** Literal values a matrix key can take (its list plus `include` entries), in declaration order. */
export function matrixValues(matrix: unknown, key: string): string[] | null {
  if (!isRecord(matrix)) return null
  const [head, ...rest] = key.split('.')
  if (!head) return null
  const values = new Set<string>()
  const add = (candidate: unknown) => {
    const value = literal(pathValue(candidate, rest))
    if (value !== null) values.add(value)
  }
  const list = Object.hasOwn(matrix, head) ? matrix[head] : undefined
  if (Array.isArray(list)) for (const item of list) add(item)
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) if (isRecord(entry) && Object.hasOwn(entry, head)) add(entry[head])
  }
  return values.size > 0 ? [...values] : null
}

function resolveContext(expression: string, scope: ExpressionScope): string[] | null {
  const matrix = /^matrix\.([A-Za-z0-9_.-]+)$/.exec(expression)
  if (matrix?.[1]) return matrixValues(scope.matrix, matrix[1])
  const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression)
  if (env?.[1]) {
    for (const map of scope.env ?? []) {
      if (!isRecord(map) || !Object.hasOwn(map, env[1])) continue
      const value = literal(map[env[1]])
      return value === null ? null : [value]
    }
    return null
  }
  const quoted = /^'([^']*)'$/.exec(expression)
  return quoted ? [quoted[1] ?? ''] : null
}

/**
 * Expand `${{ matrix.x }}` / `${{ env.X }}` expressions to their literal
 * values: "${{ matrix.node }}" with node [20, 22] gives ["20", "22"]. Returns
 * null when any expression cannot be resolved statically.
 */
export function expandExpression(value: string, scope: ExpressionScope): string[] | null {
  if (!value.includes('${{')) return [value]
  if (value.length > MAX_EXPRESSION_LENGTH) return null
  const match = /\$\{\{([^}]*)\}\}/.exec(value)
  if (!match) return null
  const resolved = resolveContext((match[1] ?? '').trim(), scope)
  if (!resolved) return null
  const before = value.slice(0, match.index)
  const after = value.slice(match.index + match[0].length)
  const out: string[] = []
  for (const option of resolved) {
    const rest = expandExpression(after, scope)
    if (!rest) return null
    for (const tail of rest) {
      const expanded = `${before}${option}${tail}`
      if (!out.includes(expanded)) out.push(expanded)
      if (out.length >= MAX_EXPANSIONS) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Workflow parsing
// ---------------------------------------------------------------------------

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Names and labels are echoed into output: trim them and redact anything credential-shaped. */
function clean(text: string): string {
  return redactCommand(text.trim())
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  return []
}

/** Trigger names from a workflow's `on` value (string, list, or map), sorted. */
export function workflowTriggers(on: unknown): string[] {
  const names = isRecord(on) ? Object.keys(on) : stringsOf(on)
  return unique(names.map(clean).filter(Boolean)).sort(compareText)
}

function expandLabel(label: string, scope: ExpressionScope): string[] {
  if (label.length > MAX_EXPRESSION_LENGTH) return []
  return expandExpression(label, scope) ?? [label]
}

/** `runs-on` as a list of labels; matrix expressions are expanded when the matrix is literal. */
export function resolveRunsOn(runsOn: unknown, scope: ExpressionScope): string[] {
  let labels: string[]
  if (isRecord(runsOn)) {
    labels = stringsOf(runsOn.labels)
    if (labels.length === 0) labels = stringsOf(runsOn.group)
  } else {
    labels = stringsOf(runsOn)
  }
  return unique(
    labels
      .flatMap((label) => expandLabel(label, scope))
      .map(clean)
      .filter(Boolean),
  )
}

function makeJob(id: string, name: string | undefined, tasks: CiTask[], runsOn: string[]): CiJob {
  const safeId = clean(id)
  return name?.trim() ? { id: safeId, name: clean(name), tasks, runsOn } : { id: safeId, tasks, runsOn }
}

/** Parse a GitHub Actions (or Forgejo/Gitea) workflow. Returns null when it is not a mapping. */
export function parseGithubWorkflow(doc: unknown, file: string, provider = 'github-actions'): CiWorkflow | null {
  if (!isRecord(doc)) return null
  const name = getString(doc, 'name')
  const workflow: CiWorkflow = {
    provider,
    file,
    ...(name?.trim() ? { name: clean(name) } : {}),
    triggers: workflowTriggers(doc.on),
    jobs: [],
  }
  if (!isRecord(doc.jobs)) return workflow

  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isRecord(job)) continue
    const strategy = isRecord(job.strategy) ? job.strategy : {}
    const scope: ExpressionScope = { matrix: strategy.matrix, env: [job.env, doc.env] }
    const texts: string[] = [id, getString(job, 'name') ?? '', getString(job, 'uses') ?? '']
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        if (!isRecord(step)) continue
        texts.push(getString(step, 'name') ?? '', getString(step, 'uses') ?? '', getString(step, 'run') ?? '')
      }
    }
    workflow.jobs.push(makeJob(id, getString(job, 'name'), inferTasks(texts), resolveRunsOn(job['runs-on'], scope)))
  }
  return workflow
}

const GITLAB_RESERVED = new Set([
  'stages',
  'variables',
  'default',
  'include',
  'workflow',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
  'spec',
])

function gitlabImage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return getString(value, 'name')
}

/** Parse .gitlab-ci.yml: every top-level mapping that is not a reserved keyword or a hidden ".job". */
export function parseGitlabCi(doc: unknown, file: string): CiWorkflow | null {
  if (!isRecord(doc)) return null
  const defaultImage = gitlabImage(doc.image) ?? gitlabImage(isRecord(doc.default) ? doc.default.image : undefined)
  const jobs: CiJob[] = []
  for (const [id, job] of Object.entries(doc)) {
    if (GITLAB_RESERVED.has(id) || id.startsWith('.') || !isRecord(job)) continue
    const ownImage = gitlabImage(job.image)
    const image = ownImage ?? defaultImage
    // Only the job's own image says what it does; an inherited default would tag every job alike.
    const texts = [
      id,
      getString(job, 'stage') ?? '',
      ownImage ?? '',
      ...stringsOf(job.before_script),
      ...stringsOf(job.script),
      ...stringsOf(job.after_script),
    ]
    // GitLab publishes the artifacts of a job named "pages" as a static site.
    if (id === 'pages') texts.push('deploy')
    const runsOn = unique([...(image ? [image] : []), ...stringsOf(job.tags)].map(clean).filter(Boolean))
    jobs.push(makeJob(id, undefined, inferTasks(texts), runsOn))
  }
  return { provider: 'gitlab-ci', file, triggers: [], jobs }
}

function circleRunsOn(job: Record<string, unknown>): string[] {
  if (Array.isArray(job.docker)) {
    const image = getString(job.docker[0], 'image')
    return image ? [image] : []
  }
  if (job.machine !== undefined) return [getString(job.machine, 'image') ?? 'machine']
  if (job.macos !== undefined) return ['macos']
  if (typeof job.executor === 'string') return [job.executor]
  const executor = getString(job.executor, 'name')
  return executor ? [executor] : []
}

function circleStepTexts(step: unknown): string[] {
  if (typeof step === 'string') return [step]
  if (!isRecord(step)) return []
  const texts: string[] = []
  for (const [key, value] of Object.entries(step)) {
    texts.push(key)
    if (typeof value === 'string') texts.push(value)
    else if (isRecord(value)) texts.push(getString(value, 'name') ?? '', getString(value, 'command') ?? '')
  }
  return texts
}

/**
 * Parse .circleci/config.yml: jobs defined in `jobs`, then orb jobs (such as
 * "node/test") referenced by `workflows` but not defined locally.
 */
export function parseCircleCi(doc: unknown, file: string): CiWorkflow | null {
  if (!isRecord(doc)) return null
  const jobs: CiJob[] = []
  const defined = isRecord(doc.jobs) ? doc.jobs : {}
  for (const [id, job] of Object.entries(defined)) {
    if (!isRecord(job)) continue
    const texts = [id, ...(Array.isArray(job.steps) ? job.steps.flatMap(circleStepTexts) : [])]
    jobs.push(makeJob(id, undefined, inferTasks(texts), unique(circleRunsOn(job).map(clean))))
  }
  const seen = new Set(Object.keys(defined))
  if (isRecord(doc.workflows)) {
    for (const workflow of Object.values(doc.workflows)) {
      if (!isRecord(workflow) || !Array.isArray(workflow.jobs)) continue
      for (const ref of workflow.jobs) {
        const id = typeof ref === 'string' ? ref : isRecord(ref) ? Object.keys(ref)[0] : undefined
        if (!id || seen.has(id)) continue
        seen.add(id)
        jobs.push(makeJob(id, undefined, inferTasks([id]), []))
      }
    }
  }
  return { provider: 'circleci', file, triggers: [], jobs }
}

async function readWorkflow(ctx: ProjectContext, def: ProviderDef, file: string): Promise<CiWorkflow | null> {
  const doc = await ctx.readYaml(file)
  if (doc === null) return null
  switch (def.format) {
    case 'github':
      return parseGithubWorkflow(doc, file, def.id)
    case 'gitlab':
      return parseGitlabCi(doc, file)
    case 'circleci':
      return parseCircleCi(doc, file)
    default:
      return null
  }
}

export const ciDetector: Detector<'ci'> = {
  id: 'ci',
  title: 'CI',
  async run(ctx) {
    const yamlFiles = shallowYamlFiles(ctx.files)
    const providers: CiProvider[] = []
    const pending: Array<Promise<CiWorkflow | null>> = []
    for (const def of PROVIDERS) {
      const files = providerFiles(def, yamlFiles, ctx.files)
      if (files.length === 0) continue
      providers.push({ id: def.id, name: def.name, files })
      if (def.format) for (const file of files) pending.push(readWorkflow(ctx, def, file))
    }
    const workflows = (await Promise.all(pending))
      .filter((workflow): workflow is CiWorkflow => workflow !== null)
      .sort((a, b) => compareText(a.file, b.file) || compareText(a.provider, b.provider))
    return { providers, workflows }
  },
}
