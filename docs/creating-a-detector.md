# Creating a detector

**English** | [Português (Brasil)](pt-BR/creating-a-detector.md)

Most contributions fall into one of three sizes. Start with the smallest one that fits.

| You want RepoLens to… | Change |
| --- | --- |
| recognize another framework, test runner, linter, build tool or ORM | add an entry to a table ([1](#1-add-a-table-entry)) |
| catch another setup problem | add a doctor rule ([2](#2-add-a-doctor-rule)) |
| understand a new kind of file or produce a new section | write a detector ([3](#3-write-a-detector)) |

Whatever you change, the [ground rules](../CONTRIBUTING.md#ground-rules) apply: read
files only through `ctx`, never execute anything, never output secret values, and
report honest confidence.

## 1. Add a table entry

Framework, tool and database knowledge lives in data tables, so recognizing a new
technology is usually a few lines.

**Frameworks**: `FRAMEWORKS` in [`src/detectors/frameworks.ts`](../src/detectors/frameworks.ts):

```ts
{
  id: 'sveltekit',                 // stable id, also used by Route.framework
  name: 'SvelteKit',               // display name
  category: 'fullstack',           // frontend | backend | fullstack | static-site | mobile | desktop | library
  ecosystem: 'node',               // node | go
  dependencies: ['@sveltejs/kit'], // npm packages or Go module paths
  configs: [`svelte.config.${JS}`],
},
```

Confidence follows from where the signal is found: a runtime dependency (with or without
its config file) is `high`, a devDependency only or a config file without the dependency is
`medium`, a peer dependency only is `low`. Order in the table is display order within a
category.

**Test runners, linters, formatters, build tools**: `TEST_TOOLS` in
`src/detectors/testing.ts`, `LINT_TOOLS` in `src/detectors/linting.ts` and `BUILD_TOOLS`
in `src/detectors/build.ts`, all using `ToolSpec` from
[`src/detectors/knowledge/tools.ts`](../src/detectors/knowledge/tools.ts):

```ts
{
  id: 'vitest',
  name: 'Vitest',
  kind: 'test',
  dependencies: ['vitest'],
  bins: ['vitest'],               // lets `vitest --config x.ts` in a script point at its config
  configs: [`vitest.config.${JS}`, `vitest.workspace.${JS}`],
},
```

`ToolSpec` also supports `dependencyPrefixes` (`@testing-library/`), `packageJsonFields`
(`"prettier": {…}`), `scripts` matchers (`node --test`), and Python signals
(`pythonPackages`, `pyprojectTables`).

**Databases, drivers, ORMs and Docker images**:
[`src/detectors/knowledge/databases.ts`](../src/detectors/knowledge/databases.ts) (`NODE_DRIVERS`,
`GO_DRIVERS`, `ORMS`, and the Prisma/Drizzle/sqlc/TypeORM value maps) and
[`src/detectors/knowledge/images.ts`](../src/detectors/knowledge/images.ts) (`IMAGE_RULES`:
Compose image → technology and service kind).

**Config files** shown in the "Key files" list: `CONFIG_FILES` in
`src/detectors/config-files.ts`.

Then add a test. The existing test file for that detector shows the pattern: build a tiny
project inline and assert what the detector reports.

```ts
it('detects SvelteKit from its dependency and config', async () => {
  const ctx = await contextFor(
    await makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@sveltejs/kit': '^2.8.0' } }),
      'svelte.config.js': 'export default {}',
    }),
  )
  const frameworks = await ctx.use(frameworksDetector)
  expect(frameworks.find((f) => f.id === 'sveltekit')).toMatchObject({ confidence: 'high', version: '2.8.0' })
})
```

Finally, add the technology to the supported-technologies table in the README.

## 2. Add a doctor rule

Doctor rules live in [`src/doctor/rules/`](../src/doctor/rules/), grouped by category. A
rule is small: it reads the detected sections (and, if needed, cached files through `ctx`)
and returns diagnostics.

```ts
import { manifests } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule } from '../../types.ts'

/** Pure logic: easy to unit-test with hand-built input. */
export function findTestPlaceholder(scripts: Readonly<Record<string, string>>): Diagnostic[] {
  const test = scripts.test
  if (test === undefined || !/no test specified/.test(test)) return []
  return [
    {
      code: 'SCRIPT_TEST_PLACEHOLDER',  // stable, UPPER_SNAKE, never renamed once released
      severity: 'info',                 // error | warning | info
      category: 'scripts',
      message: 'The "test" script in package.json is the npm placeholder that always fails',
      hint: 'Replace it with a real test command or remove it',
      files: ['package.json'],
      subject: 'test',
    },
  ]
}

export const scriptTestPlaceholder: DoctorRule = {
  code: 'SCRIPT_TEST_PLACEHOLDER',
  category: 'scripts',
  title: 'The test script runs real tests', // phrased as the passing state
  applies: (scan) => scan.project.manifests.includes('package.json'), // false → "skipped"
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    return project.root ? findTestPlaceholder(project.root.scripts) : []
  },
}
```

Then:

1. Add it to its category's rule list (e.g. `scriptRules` in `src/doctor/rules/scripts.ts`),
   which `src/doctor/rules/index.ts` combines into `doctorRules`. Output is grouped by
   category; within a category, list order is display order. A rule that reads
   `ctx.warnings` sets `final: true` so it runs after the others.
2. Document it in [`docs/diagnostics.md`](diagnostics.md): a row in the summary table and
   a `### \`CODE\`` section. A test fails if a code is missing from the docs. Add the same
   section to the translation in `docs/pt-BR/diagnostics.md`.
3. Test both directions: a project that triggers it and one that doesn't. `makeSections()`
   in `test/factories.ts` builds input without scanning anything.

Guidelines:

- **False positives are worse than misses.** When a rule can't be sure, use `info` or
  don't report.
- One diagnostic per subject (per variable, per file, per port), with `subject` set.
- Messages name the files and values involved but **never secret values**, and hints give a
  concrete fix. Quote repository paths inside suggested commands (`shellQuote`).

## 3. Write a detector

A detector produces one section of the scan result (`Sections` in
[`src/types.ts`](../src/types.ts)). Detectors are `Analyzer`s: `ctx.use(detector)` runs one
at most once per scan, so a detector can depend on another just by awaiting it.

```ts
import type { Detector } from '../types.ts'

export const exampleDetector: Detector<'example'> = {
  id: 'example',
  title: 'Example',
  async run(ctx) {
    // 1. Find candidate files through the index (no directory walking of your own).
    const files = ctx.files.byName('example.config.json')
    // 2. Read through ctx: root containment, symlink checks, size limits, caching and
    //    parse-error warnings are handled for you. Malformed input returns null.
    const configs = await Promise.all(files.map((file) => ctx.readJson(file)))
    // 3. Put the logic in pure, exported functions and unit-test them.
    return inferExample(configs)
  },
}
```

Useful building blocks:

| | |
| --- | --- |
| `ctx.files` | `has`, `byName`, `byExtension`, `glob`, `isIgnored`; `ignoredFiles` holds gitignored files such as `.env` |
| `ctx.readText` / `readJson` / `readJsonc` / `readYaml` | safe, cached reads; pass `{ cache: false }` when scanning many source files |
| `ctx.use(manifests)` | parsed package.json files (root, workspace, nested), workspace declarations, Go modules |
| `ctx.use(dependencies)` | every declared dependency: `has`, `get`, `withPrefix`, `inPackage`, `version`, `packagesWith` |
| `ctx.use(sourceFiles)` | source files worth reading for content analysis, each with its owning package |
| `ctx.warn` / `ctx.debug` | non-fatal problems (shown in verbose output and `meta.warnings`) and debug logging |
| `src/utils/redact.ts` | `redactCommand`, `sanitizeUrl`, `isSensitiveName` for anything echoed from files |

To add a **new section**, add its type to `Sections` in `src/types.ts` (an additive,
non-breaking change), its empty value to `src/core/empty.ts`, and the detector to the
registry in `src/detectors/index.ts`. The compiler then tells you every place that needs
to know about it. Render it in `src/output/terminal/`, `src/output/markdown.ts` and, if
agents benefit, `src/agent/`, and document it in [json-schema.md](json-schema.md).

### Testing a detector

- Unit-test the pure functions with plain data.
- Test the detector end to end on an inline project (`makeProject` + `contextFor`) or on a
  copy of a fixture (`fixtureContext('nuxt-app')`). Never scan `test/fixtures/` in place.
- Include malformed input: invalid JSON/YAML, wrong types (`"scripts": []`), empty files.
- If your detector reads anything that could hold secrets, assert that the fixture sentinel
  `SECRET_SENTINEL` never appears in its output.
- If you add a fixture, document it in `test/fixtures/README.md` and follow the rules at
  the top of that file.

Run `pnpm check` before opening the pull request. Thanks for contributing!
