import { describe, expect, it } from 'vitest'
import { makeProject, scanDir } from '../helpers.ts'

describe('ignored and generated directories', () => {
  it('never reads dependencies, vendored code, build output or VCS internals', async () => {
    const hidden = {
      'package.json': JSON.stringify({ name: 'hidden', dependencies: { express: '^5.0.0', nuxt: '^4.0.0' } }),
      'server.js':
        "const app = require('express')()\napp.get('/hidden', (q, s) => s.send(process.env.HIDDEN_SECRET_VAR))\n",
    }
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'visible', dependencies: { fastify: '^5.6.0' } }),
      '.gitignore': 'dist/\n.env\n',
      '.env': 'VISIBLE_VAR=value\n',
      'src/server.ts':
        "import Fastify from 'fastify'\nconst app = Fastify()\napp.get('/visible', async () => process.env.VISIBLE_VAR)\n",
    }
    for (const dir of ['node_modules/hidden', 'vendor/hidden', 'dist', '.next/server', 'coverage/lcov', '.git/hooks']) {
      for (const [name, content] of Object.entries(hidden)) files[`${dir}/${name}`] = content
    }
    const result = await scanDir(await makeProject(files))

    expect(result.frameworks.map((f) => f.id)).toEqual(['fastify'])
    expect(result.routes.routes.map((r) => r.path)).toEqual(['/visible'])
    const names = result.environment.variables.map((v) => v.name)
    expect(names).toContain('VISIBLE_VAR')
    expect(names).not.toContain('HIDDEN_SECRET_VAR')
    // The gitignored .env is still found, and flagged as ignored.
    expect(result.environment.files).toEqual([expect.objectContaining({ path: '.env', kind: 'local', ignored: true })])
    const indexedDirs = new Set(result.project.structure.map((s) => s.path))
    for (const dir of ['node_modules', 'vendor', 'dist', '.next', 'coverage', '.git']) {
      expect(indexedDirs.has(dir)).toBe(false)
    }
  })
})
