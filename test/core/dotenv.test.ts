// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings test literal ${...} interpolation syntax.
import { describe, expect, it } from 'vitest'
import {
  classifyEnvFile,
  type EnvFileEntry,
  envTextHasCredential,
  isEnvFileName,
  isLocalHost,
  isPlausibleEnvName,
  parseEndpoint,
  parseEnvFile,
  pemBodyLines,
} from '../../src/core/dotenv.ts'
import { SECRET_SENTINEL, timeBudget } from '../helpers.ts'

// PEM markers are assembled at runtime so no credential-shaped text is committed.
const BEGIN_KEY = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const END_KEY = ['-----END', 'PRIVATE KEY-----'].join(' ')

const parse = (text: string, checkCredentials = false): EnvFileEntry[] =>
  parseEnvFile(text, '.env', { checkCredentials })
const names = (text: string): string[] => parse(text).map((entry) => entry.name)
const entry = (text: string, name: string): EnvFileEntry | undefined => parse(text).find((e) => e.name === name)

// Credential-shaped strings are assembled at runtime so no real-looking token is committed.
const STRIPE_LIVE = `sk_${'live_'}${'a'.repeat(24)}`
const GITHUB_TOKEN = `ghp_${'x'.repeat(36)}`

describe('parseEnvFile', () => {
  it('reads names, skipping comments, blank lines and lines without "="', () => {
    const text = ['# comment', '', 'A=1', '   # indented comment', 'B=2', 'NOT_AN_ASSIGNMENT', 'export', 'C=3'].join(
      '\n',
    )
    expect(names(text)).toEqual(['A', 'B', 'C'])
  })

  it('reports 1-based line numbers of the first definition', () => {
    const entries = parse('# header\n\nFIRST=1\nSECOND=2\nFIRST=3\n')
    expect(entries).toEqual([
      expect.objectContaining({ name: 'FIRST', line: 3 }),
      expect.objectContaining({ name: 'SECOND', line: 4 }),
    ])
  })

  it('supports export prefixes and spaces around "="', () => {
    const text = 'export EXPORTED=1\nexport\tTABBED=2\nSPACED = 3\n  INDENTED=4\nexport=5'
    expect(names(text)).toEqual(['EXPORTED', 'TABBED', 'SPACED', 'INDENTED', 'export'])
  })

  it('accepts dots and dashes in keys and reports them as written, but rejects invalid keys', () => {
    const text = 'my.dotted.key=1\nmy-dashed-key=2\n1INVALID=3\n-INVALID=4\nIN VALID=5\n$INVALID=6\n_UNDERSCORE=7'
    expect(names(text)).toEqual(['my.dotted.key', 'my-dashed-key', '_UNDERSCORE'])
  })

  it('handles quoted values and derives emptiness after removing quotes', () => {
    const text = [
      'DOUBLE="value"',
      "SINGLE='value'",
      'BACKTICK=`value`',
      'EMPTY=',
      'EMPTY_DOUBLE=""',
      "EMPTY_SINGLE=''",
      'BLANK_QUOTED="   "',
      'SPACES=   ',
      'ESCAPED="say \\"hi\\""',
    ].join('\n')
    const byName = Object.fromEntries(parse(text).map((e) => [e.name, e.empty]))
    expect(byName).toEqual({
      DOUBLE: false,
      SINGLE: false,
      BACKTICK: false,
      EMPTY: true,
      EMPTY_DOUBLE: true,
      EMPTY_SINGLE: true,
      BLANK_QUOTED: true,
      SPACES: true,
      ESCAPED: false,
    })
  })

  it('treats " #" after an unquoted value as a comment, but keeps "#" inside values and quotes', () => {
    expect(entry('ONLY_COMMENT= # nothing here', 'ONLY_COMMENT')?.empty).toBe(true)
    expect(entry('HASH_START=#comment', 'HASH_START')?.empty).toBe(true)
    expect(entry('URL=http://localhost:3000/#/home # the app', 'URL')?.endpoint).toEqual({
      file: '.env',
      scheme: 'http',
      port: 3000,
      local: true,
    })
    expect(entry('QUOTED="# not a comment"', 'QUOTED')?.empty).toBe(false)
    expect(entry('AFTER_QUOTE="" # comment', 'AFTER_QUOTE')?.empty).toBe(true)
  })

  it('does not parse lines inside multi-line quoted values as keys', () => {
    const text = [
      `PRIVATE_KEY="${BEGIN_KEY}`,
      'FAKE_KEY=should-not-be-a-key',
      'ANOTHER_FAKE=1',
      `${END_KEY}"`,
      "SINGLE='line one",
      "SINGLE_FAKE=2'",
      'TICK=`first',
      'TICK_FAKE=3`',
      'AFTER=ok',
    ].join('\n')
    expect(names(text)).toEqual(['PRIVATE_KEY', 'SINGLE', 'TICK', 'AFTER'])
    expect(entry(text, 'AFTER')?.line).toBe(9)
  })

  it('reads an unterminated quote as a plain value instead of swallowing the rest of the file', () => {
    const text = 'BROKEN="no closing quote\nNEXT=1\nLAST=2'
    expect(names(text)).toEqual(['BROKEN', 'NEXT', 'LAST'])
    expect(entry(text, 'BROKEN')?.empty).toBe(false)
  })

  it('keeps unquoted PEM bodies from being read as keys', () => {
    const text = [
      `SIGNING_KEY=${BEGIN_KEY}`,
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
      'Qm9vN2xLa3pQ=',
      'abc=',
      END_KEY,
      'NEXT=1',
    ].join('\n')
    expect(names(text)).toEqual(['SIGNING_KEY', 'NEXT'])
    expect(entry(text, 'NEXT')?.line).toBe(6)
  })

  it('skips a PEM block that starts on the line after an empty assignment', () => {
    const text = ['CERT_KEY=', BEGIN_KEY, 'Qm9vN2xLa3pQ=', END_KEY, 'NEXT=1'].join('\n')
    expect(names(text)).toEqual(['CERT_KEY', 'NEXT'])
  })

  it('handles CRLF line endings, lone CR and a byte order mark', () => {
    const crlf = '\uFEFFFIRST=1\r\n# comment\r\nSECOND="two"\r\nMULTI="a\r\nFAKE=1\r\n"\r\nLAST=\r\n'
    expect(parse(crlf).map((e) => [e.name, e.line, e.empty])).toEqual([
      ['FIRST', 1, false],
      ['SECOND', 3, false],
      ['MULTI', 4, false],
      ['LAST', 7, true],
    ])
    expect(names('A=1\rB=2')).toEqual(['A', 'B'])
  })

  it('dedupes duplicate keys: first line wins, the last value describes the entry', () => {
    const entries = parse('PORT_URL=http://localhost:3000\nOTHER=1\nPORT_URL=\n')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: 'PORT_URL', line: 1, empty: true, endpoint: null, credentialPattern: null })
  })

  it('returns an empty list for empty or garbage input', () => {
    expect(parse('')).toEqual([])
    expect(parse('\n\n\n')).toEqual([])
    expect(parse('{"json": true}\n<xml/>\n[section]\n= no key\n')).toEqual([])
  })

  it('drops "names" that look like secret material', () => {
    const text = [
      `${GITHUB_TOKEN}=1`,
      'Kx9fY2o3Pq8Lm4Zt7Wb1=', // base64-looking line from an unquoted blob
      'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH=',
      'REAL_NAME=1',
    ].join('\n')
    expect(names(text)).toEqual(['REAL_NAME'])
  })

  it('stays linear on hostile input where delimiters never close', () => {
    // Each PEM header looks for an "-----END" line, and the opening quote searches for an
    // unescaped closing quote; none exists, so a naive parser would rescan the file per line.
    const lines = ['OPEN="never closed']
    for (let i = 0; i < 20_000; i++) lines.push(`P${i}=-----BEGIN KEY-----`, `Q${i}=escaped \\" quote`)
    const started = performance.now()
    const entries = parse(lines.join('\n'))
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
    expect(entries).toHaveLength(40_001)
  })

  // dotenv itself would read A and B as one-line values here. Pairing the quotes
  // instead drops B but guarantees no line inside a real multi-line value becomes a key.
  it('pairs quotes across lines: a later opening quote closes an earlier unterminated one', () => {
    expect(names('A="one\nB="two\nC=3')).toEqual(['A', 'C'])
  })
})

describe('parseEnvFile PEM blocks', () => {
  // Base64 tails of a pasted key: short enough to pass isPlausibleEnvName, so only
  // the PEM tracking keeps them from being printed as variable names.
  const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'Qm9v=', 'xY_z-1=']

  it('never reads PEM body lines as keys when an earlier unterminated quote swallows the header', () => {
    const text = ['A="never closed', `KEY="${BEGIN_KEY}`, ...body, `${END_KEY}"`, 'NEXT=1'].join('\n')
    expect(names(text)).toEqual(['A', 'NEXT'])
  })

  it('never reads PEM body lines as keys when the value quote is never closed', () => {
    const text = [`KEY='${BEGIN_KEY}`, ...body, END_KEY, 'NEXT=1'].join('\n')
    expect(names(text)).toEqual(['KEY', 'NEXT'])
    expect(parse(text, true)[0]?.credentialPattern).toBe('private-key')
  })

  it('does not let a truncated header or a commented header hide the rest of the file', () => {
    // No END line at all: the header was a truncated one-line value.
    expect(names('PUB=-----BEGIN PUBLIC KEY-----\nOTHER=1\nLAST=2')).toEqual(['PUB', 'OTHER', 'LAST'])
    // A truncated header followed by a complete block: only the complete block is skipped.
    const text = ['PUB=-----BEGIN PUBLIC KEY-----', 'OTHER=1', `PRIV=${BEGIN_KEY}`, ...body, END_KEY, 'NEXT=1'].join(
      '\n',
    )
    expect(names(text)).toEqual(['PUB', 'OTHER', 'PRIV', 'NEXT'])
    // Banner comments are not PEM headers.
    expect(names('# -----BEGIN CONFIG-----\nA=1\n# -----END CONFIG-----\nB=2')).toEqual(['A', 'B'])
    // A one-line value with escaped newlines holds a complete block.
    expect(names('ONE="-----BEGIN KEY-----\\nabc\\n-----END KEY-----"\nB=2')).toEqual(['ONE', 'B'])
  })

  it('marks the lines after a header up to and including its END line', () => {
    const lines = ['A=1', 'K=-----BEGIN X-----', 'body=', '-----END X-----', 'B=2', 'T=-----BEGIN Y-----', 'C=3']
    expect(pemBodyLines(lines)).toEqual([false, false, true, true, false, false, false])
  })
})

describe('parseEnvFile credential checks', () => {
  it('reports the credential pattern id when checkCredentials is on', () => {
    const text = `STRIPE_SECRET_KEY=${STRIPE_LIVE}\nGITHUB_TOKEN="${GITHUB_TOKEN}"\nPLAIN=changeme\nEMPTY=\n`
    const entries = parse(text, true)
    expect(entries.map((e) => [e.name, e.credentialPattern])).toEqual([
      ['STRIPE_SECRET_KEY', 'stripe-live-key'],
      ['GITHUB_TOKEN', 'github-token'],
      ['PLAIN', null],
      ['EMPTY', null],
    ])
    const json = JSON.stringify(entries)
    expect(json).not.toContain(STRIPE_LIVE)
    expect(json).not.toContain(GITHUB_TOKEN)
  })

  it('never checks credentials when checkCredentials is off', () => {
    expect(parse(`STRIPE_SECRET_KEY=${STRIPE_LIVE}`, false)[0]?.credentialPattern).toBeNull()
  })

  it('finds private keys in multi-line values', () => {
    const text = `KEY="-----BEGIN ${'RSA '}PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"`
    expect(parse(text, true)[0]?.credentialPattern).toBe('private-key')
  })

  it('keeps the first credential match when a later duplicate is clean', () => {
    expect(parse(`TOKEN=${GITHUB_TOKEN}\nTOKEN=placeholder`, true)[0]?.credentialPattern).toBe('github-token')
  })
})

describe('parseEnvFile never exposes values', () => {
  it('keeps sentinel values out of every field, whatever the quoting', () => {
    const value = `${SECRET_SENTINEL}_value`
    const text = [
      `PLAIN=${value}`,
      `DOUBLE="${value}"`,
      `SINGLE='${value}'`,
      `TICK=\`${value}\``,
      `URL=postgres://user:${value}@localhost:5432/${value}?sslmode=${value}`,
      `MULTI="${value}`,
      `${value}`,
      `"`,
      `INLINE=${value} # ${value}`,
      `# COMMENTED=${value}`,
      `WEIRD=http://${value}:${value}@[::1]:${value}`,
      `BARE=localhost:${value}`,
    ].join('\n')
    const json = JSON.stringify(parse(text, true))
    expect(json).not.toContain(SECRET_SENTINEL)
  })

  it('never leaks values across a deterministic fuzz of quoting and URL shapes', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const pieces = [
      SECRET_SENTINEL,
      '"',
      "'",
      '`',
      '#',
      ' ',
      '://',
      '@',
      ':',
      '/',
      '5432',
      'localhost',
      '${X}',
      '\\',
      '=',
    ]
    for (let round = 0; round < 200; round++) {
      const lines: string[] = []
      for (let i = 0; i < 20; i++) {
        let value = SECRET_SENTINEL
        for (let j = 0; j < 6; j++) value += pick(pieces)
        lines.push(
          `${pick(['', 'export ', '  '])}NAME_${i}${pick(['=', ' = ', '='])}${pick(['', 'http://', '"', "'"])}${value}`,
        )
      }
      const json = JSON.stringify(parse(lines.join(pick(['\n', '\r\n'])), true))
      expect(json).not.toContain(SECRET_SENTINEL)
    }
  })
})

describe('parseEndpoint', () => {
  it('extracts scheme, explicit port and locality', () => {
    expect(parseEndpoint('postgres://u:p@localhost:5433/db', '.env')).toEqual({
      file: '.env',
      scheme: 'postgres',
      port: 5433,
      local: true,
    })
    expect(parseEndpoint('redis://cache:6379', '.env')).toEqual({
      file: '.env',
      scheme: 'redis',
      port: 6379,
      local: false,
    })
    expect(parseEndpoint('https://example.test', '.env')).toEqual({
      file: '.env',
      scheme: 'https',
      port: null,
      local: false,
    })
  })

  it('recognizes bare local host:port values as tcp endpoints', () => {
    expect(parseEndpoint('localhost:6379', 'f')).toEqual({ file: 'f', scheme: 'tcp', port: 6379, local: true })
    expect(parseEndpoint('127.0.0.1:5432', 'f')).toEqual({ file: 'f', scheme: 'tcp', port: 5432, local: true })
    expect(parseEndpoint('0.0.0.0:8080', 'f')?.local).toBe(true)
    expect(parseEndpoint('[::1]:5432', 'f')?.port).toBe(5432)
  })

  it('ignores bare host:port pairs that could be credentials', () => {
    expect(parseEndpoint('admin:12345', 'f')).toBeNull()
    expect(parseEndpoint('db:5432', 'f')).toBeNull()
    expect(parseEndpoint('localhost', 'f')).toBeNull()
    expect(parseEndpoint('12:30', 'f')).toBeNull()
  })

  it('handles IPv6, multi-host, uppercase, jdbc and file-style URLs', () => {
    expect(parseEndpoint('http://[::1]:3000/x', 'f')).toEqual({ file: 'f', scheme: 'http', port: 3000, local: true })
    expect(parseEndpoint('mongodb://a:27017,b:27018/db', 'f')?.port).toBe(27017)
    expect(parseEndpoint('mongodb+srv://u:p@cluster0.example.net/db?retryWrites=true', 'f')).toEqual({
      file: 'f',
      scheme: 'mongodb+srv',
      port: null,
      local: false,
    })
    expect(parseEndpoint('HTTP://LOCALHOST:80', 'f')).toEqual({ file: 'f', scheme: 'http', port: 80, local: true })
    expect(parseEndpoint('jdbc:postgresql://localhost:5432/db', 'f')?.scheme).toBe('postgresql')
    expect(parseEndpoint('jdbc:sqlserver://localhost:1433;databaseName=app', 'f')).toEqual({
      file: 'f',
      scheme: 'sqlserver',
      port: 1433,
      local: true,
    })
    expect(parseEndpoint('file:./dev.db', 'f')).toEqual({ file: 'f', scheme: 'file', port: null, local: true })
    expect(parseEndpoint('sqlite:///data/app.db', 'f')).toEqual({
      file: 'f',
      scheme: 'sqlite',
      port: null,
      local: true,
    })
    expect(parseEndpoint('http://api.localhost:4000', 'f')?.local).toBe(true)
    expect(parseEndpoint('prisma+postgres://localhost:51213/?api_key=x', 'f')).toEqual({
      file: 'f',
      scheme: 'prisma+postgres',
      port: 51213,
      local: true,
    })
  })

  it('returns null for interpolation, invalid ports, whitespace and unknown schemes', () => {
    expect(parseEndpoint('postgres://${DB_HOST}:5432/db', 'f')).toBeNull()
    expect(parseEndpoint('http://localhost:${PORT}', 'f')).toBeNull()
    expect(parseEndpoint('http://localhost:$PORT', 'f')).toBeNull()
    expect(parseEndpoint('http://localhost:99999', 'f')).toBeNull()
    expect(parseEndpoint('http://localhost:abc', 'f')).toBeNull()
    expect(parseEndpoint('http://local host', 'f')).toBeNull()
    expect(parseEndpoint('hunter2://whatever:1234', 'f')).toBeNull()
    expect(parseEndpoint('not a url', 'f')).toBeNull()
    expect(parseEndpoint('', 'f')).toBeNull()
  })

  it('never reads digits of an unencoded password as a port', () => {
    // "u:1234/x@db" would be host "u", port 1234 if the authority ended at the first "/".
    expect(parseEndpoint('postgres://u:1234/x@db:5432/app', 'f')?.port).toBe(5432)
    expect(parseEndpoint('postgres://u:12?34@db/app', 'f')?.port).toBeNull()
    expect(parseEndpoint('postgres://u:p@ss@localhost:6543/app', 'f')).toEqual({
      file: 'f',
      scheme: 'postgres',
      port: 6543,
      local: true,
    })
  })
})

describe('isLocalHost', () => {
  it('matches loopback and unspecified addresses only', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '0.0.0.0',
    ]) {
      expect(isLocalHost(host), host).toBe(true)
    }
    for (const host of ['db', 'example.com', 'localhost.example.com', '10.0.0.1', '128.0.0.1', 'mylocalhost']) {
      expect(isLocalHost(host), host).toBe(false)
    }
  })
})

describe('isPlausibleEnvName', () => {
  it('accepts ordinary names', () => {
    for (const name of [
      'PORT',
      'DATABASE_URL',
      'NEXT_PUBLIC_SITE_URL',
      'my.dotted',
      'http_proxy',
      'S3_BUCKET',
      'OAUTH2',
    ]) {
      expect(isPlausibleEnvName(name), name).toBe(true)
    }
  })

  it('rejects credential formats, random-looking strings and absurd lengths', () => {
    expect(isPlausibleEnvName(GITHUB_TOKEN)).toBe(false)
    expect(isPlausibleEnvName('Kx9fY2o3Pq8Lm4Zt7Wb1')).toBe(false)
    expect(isPlausibleEnvName('A'.repeat(200))).toBe(false)
    expect(isPlausibleEnvName('')).toBe(false)
  })

  it('judges each segment, so base64url data with "-" and "_" is not a name', () => {
    for (const name of [
      'Q6pzYPinE8Nwd1d2osKcAdU-BPln_tPr9nx_BwMZWv1',
      'abc_Kx9fY2o3Pq8Lm4Zt7Wb1',
      'QpzYPinENwdosKcAdUqRtB-x',
      'SomeLongMixedCaseRunOfLetters',
    ]) {
      expect(isPlausibleEnvName(name), name).toBe(false)
    }
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'npm_package_dependencies_typescript',
      'VITE_FIREBASE_MEASUREMENTID',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'myFeatureFlag',
    ]) {
      expect(isPlausibleEnvName(name), name).toBe(true)
    }
  })

  it('never reports a wrapped base64url value line as a variable name', () => {
    const text = ['SIGNING_KEY=aGVsbG8td29ybGQ', 'Q6pzYPinE8Nwd1d2osKcAdU-BPln_tPr9nx_BwMZWv1=', 'NEXT=1'].join('\n')
    expect(names(text)).toEqual(['SIGNING_KEY', 'NEXT'])
  })
})

describe('commented-out entries', () => {
  const commented = (text: string, checkCredentials = true) =>
    parseEnvFile(text, '.env.example', { checkCredentials, commentedEntries: true })

  it('reads "# NAME=" lines as documented names without endpoints', () => {
    const entries = commented(
      [
        '# OPTIONAL_FLAG=',
        '#REDIS_URL=redis://localhost:6380',
        '# Explain things here',
        '# see docs=later',
        'A=1',
      ].join('\n'),
    )
    expect(entries.map((e) => [e.name, e.commented ?? false, e.endpoint])).toEqual([
      ['OPTIONAL_FLAG', true, null],
      ['REDIS_URL', true, null],
      ['A', false, null],
    ])
    // Only with the option: local files never contribute commented-out names.
    expect(names('# OPTIONAL_FLAG=\nA=1')).toEqual(['A'])
  })

  it('lets an active assignment win and still flags a commented-out credential', () => {
    const entries = commented([`# STRIPE_KEY=${STRIPE_LIVE}`, 'PORT=3000', '# PORT=4000'].join('\n'))
    expect(entries.map((e) => [e.name, e.commented ?? false, e.credentialPattern])).toEqual([
      ['STRIPE_KEY', true, 'stripe-live-key'],
      ['PORT', false, null],
    ])
    const later = commented('# PORT=\nPORT=3000')
    expect(later).toEqual([{ name: 'PORT', line: 1, empty: false, endpoint: null, credentialPattern: null }])
  })

  it('answers whether any value holds a credential, without returning values', () => {
    expect(envTextHasCredential(`AUTH_SECRET=test-secret-not-real\nTOKEN=${GITHUB_TOKEN}`)).toBe(true)
    expect(envTextHasCredential(`# OLD=${STRIPE_LIVE}`)).toBe(true)
    expect(envTextHasCredential('AUTH_SECRET=test-secret-not-real\nDATABASE_URL=postgres://localhost/db')).toBe(false)
  })
})

describe('env file names', () => {
  it('recognizes env file basenames', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.example',
      '.env.production.local',
      'app.env',
      '.envrc',
      '.env.vault',
    ]) {
      expect(isEnvFileName(name), name).toBe(true)
    }
    for (const name of [
      '.env.ts',
      '.env.d.ts',
      '.env.json',
      '.env.yaml',
      'vite.env.ts',
      'env',
      'environment.ts',
      '.envoy',
    ]) {
      expect(isEnvFileName(name), name).toBe(false)
    }
  })

  it('classifies env files', () => {
    for (const path of ['.env', 'apps/web/.env.local', '.env.development.local', 'local.env', '.envrc']) {
      expect(classifyEnvFile(path), path).toBe('local')
    }
    for (const path of ['.env.production', '.env.development', '.env.test', '.env.ci', '.env.staging', 'prod.env']) {
      expect(classifyEnvFile(path), path).toBe('mode')
    }
    for (const path of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', '.env.schema']) {
      expect(classifyEnvFile(path), path).toBe('example')
    }
    expect(classifyEnvFile('.env.local.example')).toBe('example')
    expect(classifyEnvFile('example.env')).toBe('example')
    expect(classifyEnvFile('env.example')).toBe('example')
    expect(classifyEnvFile('docker/env.sample')).toBe('example')
    expect(classifyEnvFile('.env.vault')).toBe('other')
    expect(classifyEnvFile('.env.backup')).toBe('other')
  })

  it('classifies env files a Compose service loads as service files, unless they are local or mode files', () => {
    const services = new Set(['.env.db', 'docker/app.env', '.env', '.env.production'])
    expect(classifyEnvFile('.env.db', services)).toBe('service')
    expect(classifyEnvFile('docker/app.env', services)).toBe('service')
    expect(classifyEnvFile('.env', services)).toBe('local')
    expect(classifyEnvFile('.env.production', services)).toBe('mode')
    expect(classifyEnvFile('.env.db')).toBe('other')
  })

  it('recognizes undotted templates', () => {
    expect(isEnvFileName('env.example')).toBe(true)
    expect(isEnvFileName('env.sample')).toBe(true)
    expect(isEnvFileName('env.ts')).toBe(false)
  })
})
