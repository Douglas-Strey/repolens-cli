import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfigFile, loadProjectConfig, loadUserConfig, tildePath, userConfigPath } from '../../src/config/load.ts'
import { isProvided, matchWildcard, NO_CONFIG, resolveConfig } from '../../src/config/resolve.ts'
import { MAX_CONFIG_LIST, quoted, validateConfig } from '../../src/config/validate.ts'
import { RepoLensError } from '../../src/core/errors.ts'
import { doctorRules } from '../../src/doctor/rules/index.ts'
import type { ConfigSource, LoadedConfig } from '../../src/types.ts'
import { canSymlink, makeProject, makeTempDir, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

const PROJECT: ConfigSource = { kind: 'project', file: 'repolens.config.json' }
const USER: ConfigSource = { kind: 'user' }
const posixOnly = process.platform === 'win32' ? it.skip : it
const symlinkOnly = process.platform !== 'win32' && canSymlink ? it : it.skip

function validate(raw: unknown, source: ConfigSource = PROJECT): LoadedConfig {
  return validateConfig(raw, source, source.kind === 'user' ? 'your user config' : 'repolens.config.json')
}

function messages(loaded: { warnings: { message: string }[] }): string[] {
  return loaded.warnings.map((warning) => warning.message)
}

describe('validateConfig', () => {
  it('keeps every valid setting', () => {
    const loaded = validate(
      {
        $schema: 'https://unpkg.com/repolens-cli/schema/config.schema.json',
        ignore: ['legacy/', 'examples/**'],
        maxFiles: 5000,
        doctor: { failOn: 'warning', rules: { ENV_UNUSED: 'off', LOCKFILE_MISSING: 'error' } },
        environment: { provided: ['FLY_*', 'RENDER_EXTERNAL_URL'] },
        output: { color: 'never', ascii: true },
      },
      USER,
    )
    expect(loaded.warnings).toEqual([])
    expect(loaded.config).toEqual({
      ignore: ['legacy/', 'examples/**'],
      maxFiles: 5000,
      doctor: { failOn: 'warning', rules: { ENV_UNUSED: 'off', LOCKFILE_MISSING: 'error' } },
      environment: { provided: ['FLY_*', 'RENDER_EXTERNAL_URL'] },
      output: { color: 'never', ascii: true },
    })
  })

  it('suggests the setting a typo meant, at any level', () => {
    const loaded = validate({ ignroe: [], doctor: { failon: 'error' }, environment: { provide: [] } })
    expect(messages(loaded)).toEqual([
      'Unknown setting "ignroe" in repolens.config.json (did you mean "ignore"?)',
      'Unknown setting "doctor.failon" in repolens.config.json (did you mean "failOn"?)',
      'Unknown setting "environment.provide" in repolens.config.json (did you mean "provided"?)',
    ])
    expect(validate({ something: true }).warnings[0]?.message).toBe(
      'Unknown setting "something" in repolens.config.json',
    )
  })

  it('drops values of the wrong type or out of range, with the reason', () => {
    const loaded = validate({
      ignore: 'legacy/',
      maxFiles: 0,
      doctor: { failOn: 'fatal', rules: ['ENV_UNUSED'] },
      environment: 'CI',
    })
    expect(loaded.config).toEqual({ doctor: {} })
    expect(messages(loaded)).toEqual([
      '"ignore" in repolens.config.json must be a list of strings; the setting was ignored',
      '"maxFiles" in repolens.config.json must be a whole number from 1 to 1000000; the setting was ignored',
      '"doctor.failOn" in repolens.config.json must be one of: error, warning, info, never; the setting was ignored',
      '"doctor.rules" in repolens.config.json must be an object that maps check codes to a setting; the setting was ignored',
      '"environment" in repolens.config.json must be an object; the setting was ignored',
    ])
    for (const maxFiles of [1.5, -1, 1_000_001, '100', Number.NaN]) {
      expect(validate({ maxFiles }).config.maxFiles).toBeUndefined()
    }
  })

  it('rejects a file that is not an object', () => {
    for (const raw of [[], 'x', 42, null]) {
      const loaded = validate(raw)
      expect(loaded.config).toEqual({})
      expect(messages(loaded)).toEqual(['repolens.config.json must contain a JSON object; it was ignored'])
    }
  })

  it('keeps valid rule entries and reports the others', () => {
    const loaded = validate({
      doctor: { rules: { ENV_UNUSED: 'off', env_unused: 'off', RUNTIME_EOL: 'critical', __proto__: 'off' } },
    })
    expect(loaded.config.doctor?.rules).toEqual({ ENV_UNUSED: 'off' })
    expect(Object.getPrototypeOf(loaded.config.doctor?.rules)).toBe(Object.prototype)
    expect(messages(loaded)).toEqual([
      'Ignored "env_unused" in "doctor.rules" of repolens.config.json: it is not a check code like ENV_UNUSED',
      'Ignored "doctor.rules.RUNTIME_EOL" in repolens.config.json: it must be one of: off, info, warning, error',
    ])
  })

  it('reads a JSON "__proto__" key as data, never as a prototype', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "doctor": {"rules": {"__proto__": "off"}}}')
    const loaded = validate(raw)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(loaded.config).toEqual({ doctor: { rules: {} } })
    expect(messages(loaded)).toContain('Unknown setting "__proto__" in repolens.config.json')
  })

  it('only reads output preferences from the user config', () => {
    const loaded = validate({ output: { color: 'always' } })
    expect(loaded.config.output).toBeUndefined()
    expect(messages(loaded)).toEqual([
      '"output" is only read from your user config; the one in repolens.config.json was ignored',
    ])
    const user = validate({ output: { color: 'sometimes', ascii: 'yes' } }, USER)
    expect(user.config.output).toEqual({})
    expect(messages(user)).toHaveLength(2)
  })

  it('filters ignore patterns RepoLens cannot use safely', () => {
    const loaded = validate({
      ignore: ['ok/', '', '# comment', 'a\nb', `x${String.fromCharCode(27)}[31m`, 'a/**/b/**/c/**/d/**/e', 7, 'ok/'],
    })
    expect(loaded.config.ignore).toEqual(['ok/'])
    expect(messages(loaded)).toHaveLength(6)
    expect(messages(loaded).join('\n')).not.toContain(String.fromCharCode(27))
  })

  it('caps the number and the matching cost of ignore patterns', () => {
    const many = validate({ ignore: Array.from({ length: MAX_CONFIG_LIST + 5 }, (_, i) => `dir${i}/`) })
    expect(many.config.ignore).toHaveLength(MAX_CONFIG_LIST)
    expect(messages(many)).toEqual([
      '"ignore" in repolens.config.json has more than 1000 entries; the rest were ignored',
    ])
    // Three "**" segments cost 120 each: the per-path budget (2000) holds 16 of them.
    const costly = validate({ ignore: Array.from({ length: 30 }, (_, i) => `a${i}/**/b/**/c/**/d`) })
    expect(costly.config.ignore?.length).toBe(16)
  })

  it('accepts variable names with * wildcards in environment.provided', () => {
    const loaded = validate({ environment: { provided: ['FLY_*', '*_URL', 'bad-name', 'A B', 'x'.repeat(129)] } })
    expect(loaded.config.environment?.provided).toEqual(['FLY_*', '*_URL'])
    expect(messages(loaded)).toHaveLength(3)
  })

  it('never echoes a value from the file', () => {
    const secret = `${SECRET_SENTINEL}_${'a'.repeat(36)}`
    const loaded = validate({
      ignore: [`${secret}\n`, 42],
      environment: { provided: [`${secret}-x`] },
      doctor: { rules: { ENV_UNUSED: secret } },
    })
    expect(messages(loaded)).toEqual([
      'Ignored entry 1 of "ignore" in repolens.config.json: patterns must be one line of printable text',
      'Ignored entry 2 of "ignore" in repolens.config.json: entries must be strings',
      'Ignored "doctor.rules.ENV_UNUSED" in repolens.config.json: it must be one of: off, info, warning, error',
      'Ignored entry 1 of "environment.provided" in repolens.config.json: use variable names, with * as a wildcard',
    ])
    expect(JSON.stringify(loaded)).not.toContain(SECRET_SENTINEL)
  })

  it('quotes keys short, printable and never credential-shaped', () => {
    expect(quoted(`ghp_${'a'.repeat(36)}`)).toBe('(a key that looks like a credential)')
    expect(quoted('x'.repeat(100))).toHaveLength(50)
    expect(quoted(`a${String.fromCharCode(27)}[2Jb`)).not.toContain(String.fromCharCode(27))
  })
})

describe('resolveConfig', () => {
  const layer = (raw: unknown, source: ConfigSource = PROJECT) => validate(raw, source)

  it('is empty without files', () => {
    expect(resolveConfig([], doctorRules)).toEqual({ config: NO_CONFIG, warnings: [] })
  })

  it('lets later files override values and accumulate lists', () => {
    const { config, warnings } = resolveConfig(
      [
        layer({ ignore: ['a/'], maxFiles: 10, doctor: { failOn: 'error', rules: { ENV_UNUSED: 'off' } } }, USER),
        layer({ ignore: ['b/', 'a/'], doctor: { rules: { ENV_UNUSED: 'warning', RUNTIME_EOL: 'info' } } }),
      ],
      doctorRules,
    )
    expect(warnings).toEqual([])
    expect(config).toEqual({
      sources: [USER, PROJECT],
      settings: {
        ignore: ['a/', 'b/'],
        maxFiles: 10,
        doctor: { failOn: 'error', rules: { ENV_UNUSED: 'warning', RUNTIME_EOL: 'info' } },
      },
    })
  })

  it('writes settings in a fixed order whatever the files look like', () => {
    const settings = resolveConfig(
      [
        layer({
          environment: { provided: ['X'] },
          doctor: { rules: { RUNTIME_EOL: 'off', ENV_UNUSED: 'off' } },
          ignore: ['a'],
        }),
      ],
      doctorRules,
    ).config.settings
    expect(Object.keys(settings)).toEqual(['ignore', 'doctor', 'environment'])
    expect(Object.keys(settings.doctor?.rules ?? {})).toEqual(['ENV_UNUSED', 'RUNTIME_EOL'])
  })

  it('drops settings for checks that do not exist, with a suggestion', () => {
    const { config, warnings } = resolveConfig([layer({ doctor: { rules: { ENV_UNDOCUMNTED: 'off' } } })], doctorRules)
    expect(config.settings).toEqual({})
    expect(warnings.map((w) => w.message)).toEqual([
      'Unknown check "ENV_UNDOCUMNTED" in repolens.config.json (did you mean ENV_UNDOCUMENTED?); the setting was ignored',
    ])
    expect(warnings[0]).toMatchObject({ kind: 'config', file: 'repolens.config.json' })
  })

  it("doesn't let a project's own file turn off or lower security checks", () => {
    const rules = { TRACKED_ENV_FILE: 'off', ENV_PUBLIC_SECRET: 'warning', ENV_FILE_NOT_IGNORED: 'error' }
    const project = resolveConfig([layer({ doctor: { rules } })], doctorRules)
    expect(project.config.settings.doctor?.rules).toEqual({ ENV_FILE_NOT_IGNORED: 'error' })
    expect(project.warnings.map((w) => w.message)).toEqual([
      'repolens.config.json can only raise the security check TRACKED_ENV_FILE to "error"; turning it off or changing its severity takes your user config or a file passed with --config',
      'repolens.config.json can only raise the security check ENV_PUBLIC_SECRET to "error"; turning it off or changing its severity takes your user config or a file passed with --config',
    ])
    for (const source of [USER, { kind: 'file' } as const]) {
      expect(resolveConfig([layer({ doctor: { rules } }, source)], doctorRules).config.settings.doctor?.rules).toEqual(
        rules,
      )
    }
  })
})

describe('matchWildcard', () => {
  it('matches * against any run of characters', () => {
    expect(matchWildcard('FLY_*', 'FLY_APP_NAME')).toBe(true)
    expect(matchWildcard('FLY_*', 'FLY_')).toBe(true)
    expect(matchWildcard('FLY_*', 'XFLY_A')).toBe(false)
    expect(matchWildcard('*_URL', 'DATABASE_URL')).toBe(true)
    expect(matchWildcard('*_URL', 'DATABASE_URLS')).toBe(false)
    expect(matchWildcard('A*B*C', 'AxxBxxC')).toBe(true)
    expect(matchWildcard('A*B*C', 'AxxCxxB')).toBe(false)
    expect(matchWildcard('CI', 'CI')).toBe(true)
    expect(matchWildcard('CI', 'CIX')).toBe(false)
    expect(matchWildcard('*', '')).toBe(true)
    expect(isProvided('RENDER_URL', ['FLY_*', 'RENDER_*'])).toBe(true)
    expect(isProvided('RENDER_URL', [])).toBe(false)
  })

  it('stays fast on hostile patterns', () => {
    const pattern = `${'*A'.repeat(60)}B`
    const started = performance.now()
    for (let i = 0; i < 100; i++) expect(matchWildcard(pattern, 'A'.repeat(128))).toBe(false)
    expect(performance.now() - started).toBeLessThan(timeBudget(500))
  })
})

describe('loadProjectConfig', () => {
  it('returns null when the project has no configuration', async () => {
    expect(await loadProjectConfig(await makeProject({ 'package.json': '{"name":"x"}' }))).toBeNull()
  })

  it('reads repolens.config.json with comments and trailing commas', async () => {
    const root = await makeProject({
      'repolens.config.json': '{\n  // legacy code\n  "ignore": ["legacy/",],\n}\n',
    })
    const loaded = await loadProjectConfig(root)
    expect(loaded).toMatchObject({ source: PROJECT, label: 'repolens.config.json', config: { ignore: ['legacy/'] } })
    expect(loaded?.warnings).toEqual([])
  })

  it('falls back to the "repolens" key of package.json', async () => {
    const root = await makeProject({ 'package.json': JSON.stringify({ name: 'x', repolens: { maxFiles: 50 } }) })
    expect(await loadProjectConfig(root)).toMatchObject({
      source: { kind: 'project', file: 'package.json' },
      config: { maxFiles: 50 },
      warnings: [],
    })
  })

  it('prefers repolens.config.json and says the package.json key was ignored', async () => {
    const root = await makeProject({
      'repolens.config.json': '{"maxFiles": 10}',
      'package.json': JSON.stringify({ repolens: { maxFiles: 50 } }),
    })
    const loaded = await loadProjectConfig(root)
    expect(loaded?.config).toEqual({ maxFiles: 10 })
    expect(messages(loaded ?? { warnings: [] })).toEqual([
      'The "repolens" key in package.json was ignored: repolens.config.json takes precedence',
    ])
  })

  it('ignores a malformed file with a warning instead of failing', async () => {
    const root = await makeProject({ 'repolens.config.json': '{"ignore": [' })
    const loaded = await loadProjectConfig(root)
    expect(loaded?.config).toEqual({})
    expect(loaded?.warnings).toEqual([
      expect.objectContaining({
        kind: 'config',
        file: 'repolens.config.json',
        message: "Couldn't parse repolens.config.json; its settings were ignored",
      }),
    ])
  })

  it('refuses a file that is too large, binary or not a file', async () => {
    const big = await makeProject({ 'repolens.config.json': `{"x": "${'a'.repeat(300 * 1024)}"}` })
    expect(messages((await loadProjectConfig(big)) ?? { warnings: [] })).toEqual([
      'repolens.config.json is larger than 256 KB; it was ignored',
    ])
    const binary = await makeProject({ 'repolens.config.json': `{}${String.fromCharCode(0)}` })
    expect(messages((await loadProjectConfig(binary)) ?? { warnings: [] })).toEqual([
      'repolens.config.json is not a text file; it was ignored',
    ])
    const dir = await makeProject({ 'repolens.config.json/x': '' })
    expect(messages((await loadProjectConfig(dir)) ?? { warnings: [] })).toEqual([
      'repolens.config.json is not a regular file; it was ignored',
    ])
  })

  symlinkOnly('never follows a symlink out of the project', async () => {
    const outside = await makeProject({ 'config.json': '{"maxFiles": 1}' })
    const root = await makeProject({})
    await fs.symlink(path.join(outside, 'config.json'), path.join(root, 'repolens.config.json'))
    const loaded = await loadProjectConfig(await fs.realpath(root))
    expect(loaded?.config).toEqual({})
    expect(messages(loaded ?? { warnings: [] })).toEqual([
      'repolens.config.json is a symbolic link to a file outside the scanned directory; it was ignored',
    ])
  })

  posixOnly('does not hang on a FIFO', async () => {
    const root = await makeProject({})
    execFileSync('mkfifo', [path.join(root, 'repolens.config.json')])
    const loaded = await loadProjectConfig(await fs.realpath(root))
    expect(loaded?.config).toEqual({})
  })
})

describe('loadConfigFile', () => {
  it('reads a file anywhere and follows symlinks', async () => {
    const dir = await makeProject({ 'real.json': '{"doctor": {"failOn": "never"}}' })
    const file = path.join(dir, 'real.json')
    expect((await loadConfigFile(file, { kind: 'file' }, 'real.json')).config).toEqual({ doctor: { failOn: 'never' } })
    if (canSymlink && process.platform !== 'win32') {
      await fs.symlink(file, path.join(dir, 'link.json'))
      const linked = await loadConfigFile(path.join(dir, 'link.json'), { kind: 'file' }, 'link.json')
      expect(linked.config).toEqual({ doctor: { failOn: 'never' } })
    }
  })

  it('throws INVALID_CONFIG for a missing, unreadable or malformed file', async () => {
    const dir = await makeProject({ 'bad.json': '{"maxFiles": }', 'bin.json': `{${String.fromCharCode(0)}}` })
    const attempt = (name: string) => loadConfigFile(path.join(dir, name), { kind: 'file' }, name)
    await expect(attempt('missing.json')).rejects.toThrow('Config file not found: missing.json')
    await expect(attempt('bad.json')).rejects.toThrow(/^Couldn't parse config file bad\.json: /)
    await expect(attempt('bin.json')).rejects.toThrow('Config file bin.json is not a text file')
    await expect(attempt('.')).rejects.toThrow('Config file . is not a regular file')
    await expect(attempt('missing.json')).rejects.toBeInstanceOf(RepoLensError)
    await expect(attempt('missing.json')).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })
})

describe('user config', () => {
  const cwd = path.resolve('/work')

  it('is found through REPOLENS_CONFIG, XDG_CONFIG_HOME, APPDATA or HOME', () => {
    const home = path.resolve('/home/me')
    expect(userConfigPath({ REPOLENS_CONFIG: 'my.json', HOME: home }, 'linux', cwd)).toBe(path.join(cwd, 'my.json'))
    expect(userConfigPath({ XDG_CONFIG_HOME: path.resolve('/xdg'), HOME: home }, 'linux', cwd)).toBe(
      path.join(path.resolve('/xdg'), 'repolens', 'config.json'),
    )
    // A relative XDG_CONFIG_HOME is invalid per the spec and ignored.
    expect(userConfigPath({ XDG_CONFIG_HOME: 'xdg', HOME: home }, 'linux', cwd)).toBe(
      path.join(home, '.config', 'repolens', 'config.json'),
    )
    expect(userConfigPath({ APPDATA: path.resolve('/appdata'), HOME: home }, 'win32', cwd)).toBe(
      path.join(path.resolve('/appdata'), 'repolens', 'config.json'),
    )
    expect(userConfigPath({ USERPROFILE: home }, 'win32', cwd)).toBe(
      path.join(home, '.config', 'repolens', 'config.json'),
    )
    expect(userConfigPath({}, 'linux', cwd)).toBeUndefined()
  })

  it('shows paths under the home directory with ~', () => {
    const home = path.resolve('/home/me')
    expect(tildePath(path.join(home, '.config', 'x.json'), { HOME: home })).toBe(
      `~${path.sep}${path.join('.config', 'x.json')}`,
    )
    expect(tildePath(path.resolve('/etc/x.json'), { HOME: home })).toBe(path.resolve('/etc/x.json'))
  })

  it('is optional at the default location but required when named', async () => {
    const home = await makeTempDir()
    expect(await loadUserConfig({ HOME: home }, 'linux', home)).toBeNull()
    await expect(loadUserConfig({ REPOLENS_CONFIG: 'nope.json', HOME: home }, 'linux', home)).rejects.toThrow(
      'Config file not found: ~',
    )
    await fs.mkdir(path.join(home, '.config', 'repolens'), { recursive: true })
    await fs.writeFile(path.join(home, '.config', 'repolens', 'config.json'), '{"output": {"ascii": true}, "nope": 1}')
    const loaded = await loadUserConfig({ HOME: home }, 'linux', home)
    expect(loaded).toMatchObject({
      source: { kind: 'user' },
      label: 'your user config',
      config: { output: { ascii: true } },
    })
    // Messages name it without its path: warnings end up in JSON output.
    expect(messages(loaded ?? { warnings: [] })).toEqual(['Unknown setting "nope" in your user config'])
    expect(loaded?.warnings[0]?.file).toBeUndefined()
  })
})

describe('config.schema.json', () => {
  it('describes exactly the settings RepoLens reads', async () => {
    const schemaPath = path.join(import.meta.dirname, '../../schema/config.schema.json')
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
    const keys = (node: { properties?: Record<string, unknown> }) => Object.keys(node.properties ?? {}).sort()
    expect(keys(schema)).toEqual(['$schema', 'doctor', 'environment', 'ignore', 'maxFiles', 'output'])
    expect(keys(schema.properties.doctor)).toEqual(['failOn', 'rules'])
    expect(keys(schema.properties.environment)).toEqual(['provided'])
    expect(keys(schema.properties.output)).toEqual(['ascii', 'color'])
    expect(schema.properties.doctor.properties.failOn.enum).toEqual(['error', 'warning', 'info', 'never'])
    expect(schema.properties.doctor.properties.rules.additionalProperties.enum).toEqual([
      'off',
      'info',
      'warning',
      'error',
    ])
    // Every property the schema allows validates cleanly.
    const example = {
      $schema: schema.$id,
      ignore: ['a/'],
      maxFiles: schema.properties.maxFiles.maximum,
      doctor: { failOn: 'never', rules: { ENV_UNUSED: 'off' } },
      environment: { provided: ['X_*'] },
      output: { color: 'auto', ascii: false },
    }
    expect(validate(example, USER).warnings).toEqual([])
  })
})
