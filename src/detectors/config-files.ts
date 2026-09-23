import type { ConfigCategory, ConfigFile, Detector } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { matchGlob } from '../utils/glob.ts'
import { baseName, joinPath } from '../utils/paths.ts'
import { type LocatedFile, type ProjectLayout, projectLayout } from './knowledge/layout.ts'
import { JS_EXTENSIONS } from './knowledge/tools.ts'

export interface ConfigFileSpec {
  /**
   * Glob relative to a package directory (or to the root for `rootOnly`).
   * Outside .github/ and .devcontainer/ the directory part must be literal.
   */
  pattern: string
  category: ConfigCategory
  description: string
  rootOnly?: boolean
}

const JS = JS_EXTENSIONS
const YAML = '{yml,yaml}'

function entries(category: ConfigCategory, list: ReadonlyArray<[string, string, boolean?]>): ConfigFileSpec[] {
  return list.map(([pattern, description, rootOnly]) =>
    rootOnly ? { pattern, category, description, rootOnly } : { pattern, category, description },
  )
}

/**
 * Known configuration files. The first matching entry wins. Local env files
 * (.env, .env.local, …) are deliberately absent: they hold real values.
 */
export const CONFIG_FILES: readonly ConfigFileSpec[] = [
  ...entries('package', [
    ['package.json', 'npm package manifest'],
    ['package-lock.json', 'npm lockfile'],
    ['npm-shrinkwrap.json', 'npm shrinkwrap lockfile'],
    ['pnpm-lock.yaml', 'pnpm lockfile'],
    ['yarn.lock', 'Yarn lockfile'],
    ['bun.lock', 'Bun lockfile'],
    ['bun.lockb', 'Bun lockfile (binary)'],
    ['deno.lock', 'Deno lockfile'],
    ['go.mod', 'Go module definition'],
    ['go.sum', 'Go module checksums'],
    ['pyproject.toml', 'Python project configuration'],
    ['requirements*.txt', 'Python requirements'],
    ['Pipfile', 'Pipenv dependencies'],
    ['Pipfile.lock', 'Pipenv lockfile'],
    ['poetry.lock', 'Poetry lockfile'],
    ['uv.lock', 'uv lockfile'],
  ]),
  ...entries('workspace', [
    ['pnpm-workspace.yaml', 'pnpm workspace'],
    ['turbo.json', 'Turborepo configuration'],
    ['turbo.jsonc', 'Turborepo configuration'],
    ['nx.json', 'Nx workspace configuration'],
    ['lerna.json', 'Lerna configuration'],
    ['rush.json', 'Rush monorepo configuration'],
    ['go.work', 'Go workspace'],
    ['go.work.sum', 'Go workspace checksums'],
  ]),
  ...entries('typescript', [
    ['tsconfig.json', 'TypeScript configuration'],
    ['tsconfig.*.json', 'TypeScript configuration'],
    ['jsconfig.json', 'JavaScript project configuration'],
  ]),
  ...entries('runtime', [
    ['.nvmrc', 'Node.js version (nvm)'],
    ['.node-version', 'Node.js version'],
    ['.tool-versions', 'asdf tool versions'],
    ['mise.toml', 'mise tool configuration'],
    ['.mise.toml', 'mise tool configuration'],
    ['.npmrc', 'npm configuration'],
    ['.yarnrc.yml', 'Yarn configuration'],
    ['.yarnrc', 'Yarn 1 configuration'],
    ['bunfig.toml', 'Bun configuration'],
    ['deno.json', 'Deno configuration'],
    ['deno.jsonc', 'Deno configuration'],
    ['.python-version', 'Python version'],
    ['.go-version', 'Go version'],
  ]),
  ...entries('framework', [
    [`nuxt.config.${JS}`, 'Nuxt configuration'],
    [`next.config.${JS}`, 'Next.js configuration'],
    [`svelte.config.${JS}`, 'Svelte configuration'],
    [`astro.config.${JS}`, 'Astro configuration'],
    ['angular.json', 'Angular workspace configuration'],
    ['nest-cli.json', 'NestJS CLI configuration'],
    [`remix.config.${JS}`, 'Remix configuration'],
    [`react-router.config.${JS}`, 'React Router configuration'],
    [`gatsby-config.${JS}`, 'Gatsby configuration'],
    [`docusaurus.config.${JS}`, 'Docusaurus configuration'],
    [`.vitepress/config.${JS}`, 'VitePress configuration'],
    [`docs/.vitepress/config.${JS}`, 'VitePress configuration'],
    [`tailwind.config.${JS}`, 'Tailwind CSS configuration'],
    [`postcss.config.${JS}`, 'PostCSS configuration'],
    ['.postcssrc', 'PostCSS configuration'],
    ['.postcssrc.{json,yml,yaml,js,cjs,mjs}', 'PostCSS configuration'],
    ['eas.json', 'Expo Application Services configuration'],
    ['adonisrc.ts', 'AdonisJS configuration'],
  ]),
  ...entries('build', [
    [`vite.config.${JS}`, 'Vite configuration'],
    [`webpack.config.${JS}`, 'webpack configuration'],
    [`rollup.config.${JS}`, 'Rollup configuration'],
    [`rolldown.config.${JS}`, 'Rolldown configuration'],
    [`rspack.config.${JS}`, 'Rspack configuration'],
    [`rsbuild.config.${JS}`, 'Rsbuild configuration'],
    [`tsup.config.${JS}`, 'tsup configuration'],
    [`tsdown.config.${JS}`, 'tsdown configuration'],
    ['.parcelrc', 'Parcel configuration'],
    ['.swcrc', 'SWC configuration'],
    [`babel.config.${JS}`, 'Babel configuration'],
    ['babel.config.json', 'Babel configuration'],
    ['.babelrc', 'Babel configuration'],
    ['.babelrc.{js,cjs,mjs,cts,json}', 'Babel configuration'],
    [`metro.config.${JS}`, 'Metro bundler configuration'],
    [`forge.config.${JS}`, 'Electron Forge configuration'],
    ['electron-builder.{json,json5,yml,yaml,toml}', 'electron-builder configuration'],
    ['Makefile', 'Make targets'],
    ['makefile', 'Make targets'],
    ['GNUmakefile', 'Make targets'],
    ['justfile', 'just recipes'],
    ['Justfile', 'just recipes'],
    ['.justfile', 'just recipes'],
    [`Taskfile.${YAML}`, 'Task configuration'],
    [`taskfile.${YAML}`, 'Task configuration'],
  ]),
  ...entries('test', [
    [`vitest.config.${JS}`, 'Vitest configuration'],
    [`vitest.workspace.${JS}`, 'Vitest workspace'],
    ['vitest.workspace.json', 'Vitest workspace'],
    [`jest.config.${JS}`, 'Jest configuration'],
    ['jest.config.json', 'Jest configuration'],
    ['.mocharc', 'Mocha configuration'],
    ['.mocharc.{js,cjs,mjs,json,jsonc,yml,yaml}', 'Mocha configuration'],
    [`ava.config.${JS}`, 'AVA configuration'],
    [`karma.conf.${JS}`, 'Karma configuration'],
    [`playwright.config.${JS}`, 'Playwright configuration'],
    [`cypress.config.${JS}`, 'Cypress configuration'],
    ['cypress.json', 'Cypress configuration (legacy)'],
    ['pytest.ini', 'pytest configuration'],
    ['conftest.py', 'pytest fixtures and hooks'],
    ['tox.ini', 'tox configuration'],
  ]),
  ...entries('lint', [
    [`eslint.config.${JS}`, 'ESLint flat config'],
    ['.eslintrc', 'ESLint legacy config'],
    ['.eslintrc.{js,cjs,json,yml,yaml}', 'ESLint legacy config'],
    ['.eslintignore', 'ESLint ignore file (legacy)'],
    ['biome.json', 'Biome configuration'],
    ['biome.jsonc', 'Biome configuration'],
    ['.oxlintrc.json', 'Oxlint configuration'],
    ['.stylelintrc', 'Stylelint configuration'],
    ['.stylelintrc.{json,yml,yaml,js,cjs,mjs}', 'Stylelint configuration'],
    [`stylelint.config.${JS}`, 'Stylelint configuration'],
    ['.markdownlint.{json,jsonc,yaml,yml}', 'markdownlint configuration'],
    ['.markdownlint-cli2.{jsonc,yaml,cjs,mjs}', 'markdownlint configuration'],
    ['.golangci.{yml,yaml,toml,json}', 'golangci-lint configuration'],
    ['staticcheck.conf', 'Staticcheck configuration'],
    ['ruff.toml', 'Ruff configuration'],
    ['.ruff.toml', 'Ruff configuration'],
    ['.flake8', 'Flake8 configuration'],
    ['mypy.ini', 'mypy configuration'],
    ['.lintstagedrc', 'lint-staged configuration'],
    ['.lintstagedrc.{json,yaml,yml,js,cjs,mjs}', 'lint-staged configuration'],
    [`lint-staged.config.${JS}`, 'lint-staged configuration'],
    [`commitlint.config.${JS}`, 'commitlint configuration'],
    ['.commitlintrc', 'commitlint configuration'],
    ['.commitlintrc.*', 'commitlint configuration'],
  ]),
  ...entries('format', [
    ['.prettierrc', 'Prettier configuration'],
    ['.prettierrc.{json,json5,yaml,yml,toml,js,cjs,mjs,ts,cts,mts}', 'Prettier configuration'],
    [`prettier.config.${JS}`, 'Prettier configuration'],
    ['.prettierignore', 'Prettier ignore file'],
    ['dprint.json', 'dprint configuration'],
    ['.dprint.json', 'dprint configuration'],
    ['dprint.jsonc', 'dprint configuration'],
  ]),
  ...entries('docker', [
    ['Dockerfile', 'Docker image build'],
    ['Dockerfile.*', 'Docker image build'],
    ['Dockerfile-*', 'Docker image build'],
    ['*.Dockerfile', 'Docker image build'],
    ['*.dockerfile', 'Docker image build'],
    ['Containerfile', 'Container image build'],
    [`compose.${YAML}`, 'Docker Compose services'],
    [`compose.*.${YAML}`, 'Docker Compose services'],
    [`docker-compose.${YAML}`, 'Docker Compose services'],
    [`docker-compose.*.${YAML}`, 'Docker Compose services'],
    ['.dockerignore', 'Docker build context exclusions'],
  ]),
  ...entries('ci', [
    [`.github/workflows/*.${YAML}`, 'GitHub Actions workflow', true],
    [`.github/actions/**/action.${YAML}`, 'GitHub Actions composite action', true],
    ['.gitlab-ci.yml', 'GitLab CI pipeline', true],
    [`.circleci/config.${YAML}`, 'CircleCI configuration', true],
    [`azure-pipelines.${YAML}`, 'Azure Pipelines configuration', true],
    ['bitbucket-pipelines.yml', 'Bitbucket Pipelines configuration', true],
    ['Jenkinsfile', 'Jenkins pipeline', true],
    ['.travis.yml', 'Travis CI configuration', true],
    [`.buildkite/pipeline.${YAML}`, 'Buildkite pipeline', true],
    ['.drone.yml', 'Drone CI pipeline', true],
    [`.woodpecker.${YAML}`, 'Woodpecker CI pipeline', true],
    [`.woodpecker/*.${YAML}`, 'Woodpecker CI pipeline', true],
    [`codecov.${YAML}`, 'Codecov configuration', true],
    [`.codecov.${YAML}`, 'Codecov configuration', true],
  ]),
  ...entries('environment', [
    ['.env.{example,sample,template,dist}', 'Environment variable template'],
    ['.env.*.{example,sample,template,dist}', 'Environment variable template'],
  ]),
  ...entries('git', [
    ['.gitignore', 'Git ignore rules'],
    ['.gitattributes', 'Git attributes'],
    ['.gitmodules', 'Git submodules', true],
    ['.git-blame-ignore-revs', 'Git blame ignore list', true],
    ['.mailmap', 'Git author mapping', true],
    ['CODEOWNERS', 'Code owners', true],
    ['.github/CODEOWNERS', 'Code owners', true],
    ['docs/CODEOWNERS', 'Code owners', true],
    [`.github/dependabot.${YAML}`, 'Dependabot configuration', true],
    ['renovate.json', 'Renovate configuration', true],
    ['renovate.json5', 'Renovate configuration', true],
    ['.renovaterc', 'Renovate configuration', true],
    ['.renovaterc.json', 'Renovate configuration', true],
    ['.github/renovate.json', 'Renovate configuration', true],
    ['.github/renovate.json5', 'Renovate configuration', true],
    ['repolens.config.json', 'RepoLens configuration', true],
    [`.pre-commit-config.${YAML}`, 'pre-commit hooks'],
    [`lefthook.${YAML}`, 'Lefthook git hooks'],
    [`.lefthook.${YAML}`, 'Lefthook git hooks'],
  ]),
  ...entries('editor', [
    ['.editorconfig', 'EditorConfig'],
    ['.vscode/extensions.json', 'Recommended VS Code extensions', true],
    ['.vscode/settings.json', 'VS Code workspace settings', true],
    ['.vscode/launch.json', 'VS Code debug configurations', true],
    ['.vscode/tasks.json', 'VS Code tasks', true],
    ['.devcontainer.json', 'Dev container', true],
    ['.devcontainer/devcontainer.json', 'Dev container', true],
    ['.devcontainer/*/devcontainer.json', 'Dev container', true],
    ['.devcontainer/**/{Dockerfile,Dockerfile.*,*.Dockerfile}', 'Dev container image build', true],
    [`.devcontainer/**/{compose,docker-compose}*.${YAML}`, 'Dev container services', true],
  ]),
  ...entries('deploy', [
    ['vercel.json', 'Vercel deployment'],
    ['netlify.toml', 'Netlify deployment'],
    ['fly.toml', 'Fly.io deployment'],
    [`render.${YAML}`, 'Render deployment'],
    ['railway.json', 'Railway deployment'],
    ['railway.toml', 'Railway deployment'],
    ['wrangler.toml', 'Cloudflare Workers configuration'],
    ['wrangler.json', 'Cloudflare Workers configuration'],
    ['wrangler.jsonc', 'Cloudflare Workers configuration'],
    [`app.${YAML}`, 'Google App Engine configuration'],
    ['Procfile', 'Process types (Heroku-style)'],
    [`serverless.${YAML}`, 'Serverless Framework configuration'],
    ['firebase.json', 'Firebase configuration'],
    ['amplify.yml', 'AWS Amplify build settings'],
    ['heroku.yml', 'Heroku container build'],
  ]),
  ...entries('database', [
    ['schema.prisma', 'Prisma schema'],
    ['prisma/schema.prisma', 'Prisma schema'],
    ['prisma/schema/*.prisma', 'Prisma schema'],
    [`drizzle.config.${JS}`, 'Drizzle Kit configuration'],
    [`knexfile.${JS}`, 'Knex configuration'],
    ['ormconfig.{json,js,ts,yml,yaml}', 'TypeORM configuration'],
    [`mikro-orm.config.${JS}`, 'MikroORM configuration'],
    ['sqlc.{yaml,yml,json}', 'sqlc configuration'],
    ['atlas.hcl', 'Atlas schema configuration'],
    ['alembic.ini', 'Alembic migrations configuration'],
    ['supabase/config.toml', 'Supabase configuration'],
  ]),
  ...entries('other', [
    [`.goreleaser.${YAML}`, 'GoReleaser configuration'],
    ['.changeset/config.json', 'Changesets configuration'],
    ['.releaserc', 'semantic-release configuration'],
    ['.releaserc.{json,yaml,yml,js,cjs,mjs}', 'semantic-release configuration'],
    ['release-please-config.json', 'release-please configuration'],
    ['.browserslistrc', 'Browserslist targets'],
  ]),
]

/** Root directories whose whole tree is searched (their patterns may use globs in directory parts). */
const DEEP_ROOT_DIRS = ['.github', '.devcontainer']

/** Literal subdirectories named by patterns (".vscode", "prisma/schema", …), searched in every package directory. */
function literalSubdirs(specs: readonly ConfigFileSpec[]): string[] {
  const dirs = new Set<string>()
  for (const spec of specs) {
    const slash = spec.pattern.lastIndexOf('/')
    if (slash === -1) continue
    const dir = spec.pattern.slice(0, slash)
    if (!/[*?{]/.test(dir) && !DEEP_ROOT_DIRS.some((root) => dir === root || dir.startsWith(`${root}/`))) dirs.add(dir)
  }
  return [...dirs].sort(compareText)
}

export interface ConfigCandidate {
  path: string
  /** Every way to read the file as (package directory, path relative to it), deepest package first. */
  readings: Array<Pick<LocatedFile, 'package' | 'rel'>>
}

function depthOfDir(dir: string): number {
  return dir === '.' ? 0 : dir.split('/').length
}

/**
 * Files that may be config files: package directories, fixed subdirectories
 * of them, and .github/.devcontainer. A file can be reachable in several
 * ways: docs/package.json is "package.json" of the docs package but also
 * "docs/package.json" from the root, because docs/CODEOWNERS is a root entry.
 */
export function configCandidates(
  layout: ProjectLayout,
  specs: readonly ConfigFileSpec[] = CONFIG_FILES,
): ConfigCandidate[] {
  const found = new Map<string, ConfigCandidate>()
  const add = (path: string, pkg: string, rel: string) => {
    const existing = found.get(path)
    if (existing) existing.readings.push({ package: pkg, rel })
    else found.set(path, { path, readings: [{ package: pkg, rel }] })
  }
  const dirs = [...layout.packageDirs].sort((a, b) => depthOfDir(b) - depthOfDir(a) || compareText(a, b))
  const subdirs = ['', ...literalSubdirs(specs)]
  for (const dir of dirs) {
    for (const sub of subdirs) {
      for (const file of layout.filesByDir.get(joinPath(dir, sub)) ?? []) {
        add(file, dir, sub ? `${sub}/${baseName(file)}` : baseName(file))
      }
    }
  }
  for (const [dir, files] of layout.filesByDir) {
    if (!DEEP_ROOT_DIRS.some((root) => dir === root || dir.startsWith(`${root}/`))) continue
    for (const file of files) add(file, '.', file)
  }
  return [...found.values()]
}

/** The first spec matching a candidate, honoring `rootOnly`. */
export function classifyConfigFile(
  candidate: Pick<LocatedFile, 'package' | 'rel'>,
  specs: readonly ConfigFileSpec[] = CONFIG_FILES,
): ConfigFileSpec | undefined {
  for (const spec of specs) {
    if (spec.rootOnly && candidate.package !== '.') continue
    if (matchGlob(spec.pattern, candidate.rel)) return spec
  }
  return undefined
}

/** Known config files in the root, package directories, .github/ and .devcontainer/, sorted by path. */
export function collectConfigFiles(
  layout: ProjectLayout,
  specs: readonly ConfigFileSpec[] = CONFIG_FILES,
): ConfigFile[] {
  const out: ConfigFile[] = []
  for (const candidate of configCandidates(layout, specs)) {
    for (const reading of candidate.readings) {
      const spec = classifyConfigFile(reading, specs)
      if (!spec) continue
      out.push({ path: candidate.path, category: spec.category, description: spec.description })
      break
    }
  }
  return out.sort((a, b) => compareText(a.path, b.path))
}

export const configFilesDetector: Detector<'configFiles'> = {
  id: 'configFiles',
  title: 'Configuration files',
  async run(ctx) {
    return collectConfigFiles(await ctx.use(projectLayout))
  },
}
