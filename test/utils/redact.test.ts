import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_PATTERNS,
  findCredentialPattern,
  isSensitiveName,
  REDACTED,
  redactCommand,
  sanitizeUrl,
} from '../../src/utils/redact.ts'
import { timeBudget } from '../helpers.ts'

// Credential-shaped strings are built at runtime so the repository never contains one.
const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`
const GITHUB_PAT = `github_pat_${'B'.repeat(40)}`
const AWS_KEY = `AKIA${'Z'.repeat(16)}`
const STRIPE_LIVE = `sk_live_${'1'.repeat(24)}`
const SLACK = `xoxb-${'1'.repeat(12)}-abcdef`
const NPM_TOKEN = `npm_${'c'.repeat(36)}`
const GITLAB = `glpat-${'d'.repeat(20)}`
const OPENAI = `sk-proj-${'e'.repeat(40)}`
const ANTHROPIC = `sk-ant-${'f'.repeat(40)}`
const GOOGLE = `AIza${'g'.repeat(35)}`
const SENDGRID = `SG.${'h'.repeat(22)}.${'i'.repeat(43)}`
const PRIVATE_KEY = `-----BEGIN RSA ${'PRIVATE'} KEY-----`

describe('isSensitiveName', () => {
  it.each([
    'API_TOKEN',
    'GITHUB_TOKEN',
    'STRIPE_SECRET_KEY',
    'DB_PASSWORD',
    'PGPASSWORD',
    'MYSQL_PWD',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'SSH_PRIVATE_KEY',
    'JWT_SECRET',
    'AUTH',
    'NEXTAUTH_SECRET',
    'SESSION_SALT',
    'GOOGLE_CREDENTIALS',
    'apiKey',
    'accessToken',
    'dbPassword',
    'client_secret',
    'SECRETS',
    'passphrase',
  ])('%s is sensitive', (name) => {
    expect(isSensitiveName(name)).toBe(true)
  })

  it.each([
    'PORT',
    'NODE_ENV',
    'DATABASE_URL',
    'MONKEY',
    'KEYBOARD_LAYOUT',
    'BYPASS_CACHE',
    'AUTHOR',
    'PUBLIC_URL',
    '',
  ])('%s is not sensitive', (name) => {
    expect(isSensitiveName(name)).toBe(false)
  })
})

describe('findCredentialPattern', () => {
  it.each([
    [GITHUB_TOKEN, 'github-token'],
    [GITHUB_PAT, 'github-fine-grained-token'],
    [AWS_KEY, 'aws-access-key'],
    [STRIPE_LIVE, 'stripe-live-key'],
    [SLACK, 'slack-token'],
    [NPM_TOKEN, 'npm-token'],
    [GITLAB, 'gitlab-token'],
    [OPENAI, 'openai-key'],
    [GOOGLE, 'google-api-key'],
    [SENDGRID, 'sendgrid-key'],
    [PRIVATE_KEY, 'private-key'],
  ])('recognizes %s', (value, id) => {
    expect(findCredentialPattern(`prefix ${value} suffix`)).toBe(id)
  })

  it('recognizes Anthropic keys (reported under the first matching id)', () => {
    expect(findCredentialPattern(ANTHROPIC)).not.toBeNull()
  })

  it('ignores ordinary values and placeholders', () => {
    for (const value of ['changeme', 'sk_test_123', 'ghp_short', 'your-api-key-here', 'postgres://localhost/db', '']) {
      expect(findCredentialPattern(value)).toBeNull()
    }
  })

  it('every pattern has an id and a name', () => {
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.id).toMatch(/^[a-z-]+$/)
      expect(pattern.name.length).toBeGreaterThan(0)
    }
  })
})

describe('redactCommand', () => {
  it.each([
    ['API_TOKEN=abc123 node x.js', 'API_TOKEN=*** node x.js'],
    ['DB_PASSWORD="p a s s" ./run', 'DB_PASSWORD=*** ./run'],
    ["SECRET_KEY='x y' ./run", 'SECRET_KEY=*** ./run'],
    ['export AWS_SECRET_ACCESS_KEY=abc; deploy', 'export AWS_SECRET_ACCESS_KEY=***; deploy'],
    ['NODE_ENV=production PORT=3000 node .', 'NODE_ENV=production PORT=3000 node .'],
    ['pg_dump postgres://admin:pa55word@db.example.com/app', 'pg_dump postgres://***@db.example.com/app'],
    ['redis-cli -u redis://:hunter2@localhost:6379', 'redis-cli -u redis://***@localhost:6379'],
    ['psql postgres://admin:p/ss@db:5432/app', 'psql postgres://***@db:5432/app'],
    ['curl https://token@api.example.com/x', 'curl https://***@api.example.com/x'],
    ['deploy --token s3cr3tvalue', 'deploy --token ***'],
    ['deploy --token=s3cr3tvalue', 'deploy --token=***'],
    ['login --password "a b c" --user me', 'login --password *** --user me'],
    ['cli --auth-token abc123', 'cli --auth-token ***'],
    ['cli --client-secret=abc123', 'cli --client-secret=***'],
    ['cli --api-key abc --apikey def', 'cli --api-key *** --apikey ***'],
    ['gpg --passphrase hunter2 file', 'gpg --passphrase *** file'],
    ['curl -H "Authorization: Bearer abc.def.ghi" https://x', 'curl -H "Authorization: Bearer ***" https://x'],
    ['curl -H "X-API-Key: abc123" https://x', 'curl -H "X-API-Key: ***" https://x'],
    ["curl -H 'PRIVATE-TOKEN: abc123' https://x", "curl -H 'PRIVATE-TOKEN: ***' https://x"],
    [`fetch bearer ${'t'.repeat(20)}`, 'fetch bearer ***'],
    ['curl -u admin:hunter2 https://x', 'curl -u admin:*** https://x'],
    ['curl --user=admin:hunter2 https://x', 'curl --user=admin:*** https://x'],
    ['mysql -uroot -phunter2 app', 'mysql -uroot -p*** app'],
    ['mysqldump -u root -pSecret db > dump.sql', 'mysqldump -u root -p*** db > dump.sql'],
    ['docker login -u me -p hunter2 ghcr.io', 'docker login -u me -p *** ghcr.io'],
    ['sshpass -p hunter2 ssh host', 'sshpass -p *** ssh host'],
    ['mysql -uroot -p"my pw" app', 'mysql -uroot -p*** app'],
    ["mysqldump -u root -p'pw' db | gzip", 'mysqldump -u root -p*** db | gzip'],
    ['mysql -u root -p app && mysql -phunter2', 'mysql -u root -p app && mysql -p***'],
    ['mysql -pA; mysql -pB', 'mysql -p***; mysql -p***'],
    ["sshpass -p 'hunter2' ssh -p 22 host", 'sshpass -p *** ssh -p 22 host'],
    [`echo ${GITHUB_TOKEN}`, 'echo ***'],
    [`GIT_URL=https://x-access-token:${GITHUB_TOKEN}@github.com/o/r`, 'GIT_URL=https://***@github.com/o/r'],
    ['curl "https://api.example.com/?api_key=abc&x=1"', 'curl "https://api.example.com/?api_key=***&x=1"'],
  ])('%j → %j', (input, expected) => {
    expect(redactCommand(input)).toBe(expected)
  })

  it.each([
    'npm run build',
    'vitest run --coverage',
    'docker run -u 1000:1000 node:22 npm test',
    'mysql -p app',
    'echo -p x; ssh -p 22 host',
    'docker login --password-stdin ghcr.io',
    'tsx watch src/index.ts',
    'curl https://registry.npmjs.org/@scope/pkg',
    'curl http://localhost:3000/api/users/@me',
    'npm run generate-token src/x',
    'echo "Use bearer authentication"',
    'git clone git@github.com:org/repo.git',
    'node --inspect=0.0.0.0:9229 server.js',
    'go test ./... -run TestAuth',
  ])('leaves %j alone', (command) => {
    expect(redactCommand(command)).toBe(command)
  })

  it('redacts every well-known credential format anywhere in the text', () => {
    const all = [GITHUB_TOKEN, GITHUB_PAT, AWS_KEY, STRIPE_LIVE, SLACK, NPM_TOKEN, GITLAB, OPENAI, ANTHROPIC, GOOGLE]
    const redacted = redactCommand(all.join(' | '))
    for (const secret of all) expect(redacted).not.toContain(secret)
    expect(redacted).toContain(REDACTED)
  })

  it('stays fast on long hostile input', () => {
    const hostile = `${'--a-'.repeat(5000)} ${'mysql '.repeat(2000)} ${'x://'.repeat(3000)} ${'a.'.repeat(20000)} --${'a-'.repeat(20000)}`
    const started = performance.now()
    redactCommand(hostile)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })

  // Each of these took seconds at this size before (quadratic); a CI `run:` or a script can be 1 MB.
  it.each([
    ['URL schemes with a user and no "@"', 'x://u:p'.repeat(40_000)],
    ['URL schemes with a slash in the password', 'a://b:c/'.repeat(40_000)],
    ['a repeated mysql command word', 'mysql '.repeat(50_000)],
    ['repeated mysql -p with unclosed quotes', `mysql -p' -p"`.repeat(20_000)],
    ['a repeated docker login', 'docker login '.repeat(25_000)],
    ['a repeated sshpass', 'sshpass '.repeat(40_000)],
  ])('stays linear on %s', (_label, hostile) => {
    const started = performance.now()
    redactCommand(hostile)
    expect(performance.now() - started).toBeLessThan(timeBudget(1000))
  })
})

describe('sanitizeUrl', () => {
  it.each([
    ['https://user:pw@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://token@github.com/org/repo', 'https://github.com/org/repo'],
    [`https://x-access-token:${GITHUB_TOKEN}@github.com/o/r.git`, 'https://github.com/o/r.git'],
    ['https://example.com/path?token=abc#frag', 'https://example.com/path'],
    ['https://example.com?token=abc', 'https://example.com'],
    ['postgres://admin:p/ss@db:5432/app?sslmode=require', 'postgres://db:5432/app'],
    ['postgres://admin:p?ss@db:5432/app', 'postgres://db:5432/app'],
    ['postgres://admin:p#ss@db/app', 'postgres://db/app'],
    ['https://host:8443/path/pkg@1.0.0', 'https://host:8443/path/pkg@1.0.0'],
    ['https://registry.npmjs.org/@scope/pkg', 'https://registry.npmjs.org/@scope/pkg'],
    ['http://[::1]:5432/db', 'http://[::1]:5432/db'],
    ['  https://example.com/x  ', 'https://example.com/x'],
    ['git+ssh://git@github.com/org/repo.git', 'git+ssh://github.com/org/repo.git'],
    ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
    ['git@github.com:org/repo.git?ref=main', 'git@github.com:org/repo.git'],
    ['user:hunter2@host.example.com:repo.git', 'host.example.com:repo.git'],
    [`${GITHUB_TOKEN}@github.com:org/repo.git`, 'github.com:org/repo.git'],
    ['../relative/path', '../relative/path'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected)
  })
})

describe('redactCommand: more credential shapes', () => {
  // Built at runtime so no credential-shaped string is committed.
  const token = `tok${'Z'.repeat(20)}`

  it.each([
    [`redis-cli -a ${token} ping`, token],
    [`npm config set //registry.npmjs.org/:_authToken ${token}`, token],
    [`yarn config set npmAuthToken ${token}`, token],
    [`aws configure set aws_secret_access_key ${token}`, token],
    [`curl https://hooks.slack.com/services/T000/B000/${token}`, token],
    [`curl https://discord.com/api/webhooks/123/${token}`, token],
    [`curl -H 'X-Custom-Key: ${token}' https://api.invalid`, token],
    [`gh auth login --with-token <<< ${token}`, token],
    [`curl "https://api.invalid/v1?api_key=${token}&x=1"`, token],
  ])('%s', (command, secret) => {
    const redacted = redactCommand(command)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain('***')
  })

  it('keeps ordinary config and headers', () => {
    expect(redactCommand('npm config set registry https://registry.npmjs.org/')).toBe(
      'npm config set registry https://registry.npmjs.org/',
    )
    expect(redactCommand("curl -H 'Content-Type: application/json' https://x.invalid")).toBe(
      "curl -H 'Content-Type: application/json' https://x.invalid",
    )
    expect(redactCommand('redis-cli -h localhost ping')).toBe('redis-cli -h localhost ping')
  })
})
