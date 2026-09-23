import { describe, expect, it } from 'vitest'
import { makeProject, runCli } from '../helpers.ts'

const FILES: Record<string, string> = {
  'package.json':
    '{\n  "name": "crlf",\n  "packageManager": "pnpm@10.17.1",\n  "scripts": { "dev": "vite" },\n  "dependencies": { "vue": "^3.5.0" }\n}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  '.env.example': '# comment\nAPI_URL=\nDATABASE_URL="postgres://localhost:5433/app"\n',
  '.nvmrc': '22\n',
  'docker-compose.yml': 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n',
  Makefile: '.PHONY: build\nbuild:\n\tvite build\n',
  'go.mod': 'module example.test/crlf\n\ngo 1.25\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.11.0\n)\n',
  '.github/workflows/ci.yml':
    'on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n',
  'src/main.ts': 'console.log(import.meta.env.VITE_API_URL, process.env.API_URL)\n',
}

function withCrlf(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content.replaceAll('\n', '\r\n')]))
}

describe('CRLF line endings (Windows checkouts)', () => {
  it('produce the same result as LF', async () => {
    const lf = JSON.parse((await runCli(['--json', await makeProject(FILES)])).stdout)
    const crlf = JSON.parse((await runCli(['--json', await makeProject(withCrlf(FILES))])).stdout)
    // The directory name differs between the two temp projects; everything else must match.
    for (const result of [lf, crlf]) result.project.directory = 'project'
    expect(crlf).toEqual(lf)
    expect(lf.runtimes.find((r: { id: string }) => r.id === 'node')?.version).toBe('22')
    expect(lf.environment.variables.map((v: { name: string }) => v.name)).toEqual([
      'API_URL',
      'DATABASE_URL',
      'VITE_API_URL',
    ])
  })
})
