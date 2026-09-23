import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dependenciesDetector } from '../../src/detectors/dependencies.ts'
import { packageManagersDetector } from '../../src/detectors/package-managers.ts'
import {
  binEntrypoints,
  goMainCandidates,
  goModuleName,
  goPackageName,
  identifyLicense,
  inferProjectType,
  isLibraryShaped,
  manifestLicense,
  normalizeRepositoryUrl,
  projectDetector,
  serverFramework,
  summarizeStructure,
} from '../../src/detectors/project.ts'
import { scriptsDetector } from '../../src/detectors/scripts.ts'
import { workspaceDetector } from '../../src/detectors/workspace.ts'
import type { PackageManifest } from '../../src/facts/manifests.ts'
import type { ProjectSection } from '../../src/types.ts'
import {
  contextFor,
  copyFixture,
  expectNoPath,
  fixtureContext,
  makeProject,
  SECRET_SENTINEL,
  timeBudget,
} from '../helpers.ts'

async function detectFixture(name: string): Promise<{ section: ProjectSection; root: string }> {
  const ctx = await fixtureContext(name)
  return { section: await ctx.use(projectDetector), root: ctx.root }
}

async function detectFiles(files: Record<string, string>): Promise<ProjectSection> {
  const ctx = await contextFor(await makeProject(files))
  return ctx.use(projectDetector)
}

function manifest(raw: Record<string, unknown>, overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    dir: '.',
    file: 'package.json',
    role: 'root',
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    engines: {},
    workspaces: [],
    hasBin: typeof raw.bin === 'string' || (typeof raw.bin === 'object' && raw.bin !== null),
    raw,
    ...overrides,
  }
}

const MIT = `MIT License

Copyright (c) 2026 Example

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.`

const APACHE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
`

const BSD_2 = `Copyright (c) 2026 Example
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.`

const BSD_3 = `${BSD_2}
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this software.`

const ISC = `ISC License

Copyright (c) 2026 Example

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.`

describe('identifyLicense', () => {
  it.each([
    ['MIT', MIT],
    ['Apache-2.0', APACHE],
    ['BSD-2-Clause', BSD_2],
    ['BSD-3-Clause', BSD_3],
    ['ISC', ISC],
    ['GPL-3.0', '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n'],
    ['GPL-2.0', '                    GNU GENERAL PUBLIC LICENSE\n                       Version 2, June 1991\n'],
    [
      'AGPL-3.0',
      '                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007\n',
    ],
    [
      'LGPL-3.0',
      '                   GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n',
    ],
    ['MPL-2.0', 'Mozilla Public License Version 2.0\n==================================\n'],
    ['Unlicense', 'This is free and unencumbered software released into the public domain.\n'],
  ])('recognizes %s', (id, text) => {
    expect(identifyLicense(text)).toBe(id)
  })

  it('reads a single SPDX identifier', () => {
    expect(identifyLicense('SPDX-License-Identifier: GPL-2.0-only\n')).toBe('GPL-2.0')
    expect(identifyLicense('// SPDX-License-Identifier: mit\n')).toBe('MIT')
  })

  it('does not guess for dual licenses, SPDX expressions, BSD-4-Clause or unknown text', () => {
    expect(identifyLicense(`${MIT}\n\n${APACHE}`)).toBeUndefined()
    expect(identifyLicense('SPDX-License-Identifier: MIT OR Apache-2.0\n')).toBeUndefined()
    expect(
      identifyLicense(`${BSD_3}\n4. All advertising materials mentioning features or use of this software`),
    ).toBeUndefined()
    expect(identifyLicense('All rights reserved. Proprietary and confidential.')).toBeUndefined()
    expect(identifyLicense('')).toBeUndefined()
  })

  it('does not mistake the GPL-3.0 text (which mentions the AGPL) for the AGPL', () => {
    const gpl = `GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n${'x '.repeat(400)}\nGNU Affero General Public License version 3`
    expect(identifyLicense(gpl)).toBe('GPL-3.0')
  })
})

describe('normalizeRepositoryUrl', () => {
  it.each([
    ['github:acme/repo', 'https://github.com/acme/repo'],
    ['gitlab:acme/repo', 'https://gitlab.com/acme/repo'],
    ['bitbucket:acme/repo', 'https://bitbucket.org/acme/repo'],
    ['acme/repo', 'https://github.com/acme/repo'],
    ['git+https://github.com/acme/repo.git', 'https://github.com/acme/repo'],
    ['git@github.com:acme/repo.git', 'https://github.com/acme/repo'],
    ['git+ssh://git@github.com/acme/repo.git', 'https://github.com/acme/repo'],
    ['git://github.com/acme/repo.git', 'https://github.com/acme/repo'],
    ['https://github.com/acme/repo/', 'https://github.com/acme/repo'],
    ['https://github.com/acme/repo#readme', 'https://github.com/acme/repo'],
    ['github.com/acme/repo', 'https://github.com/acme/repo'],
    ['https://gitlab.example.com/group/sub/repo', 'https://gitlab.example.com/group/sub/repo'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRepositoryUrl(input)).toBe(expected)
  })

  it('reads the object form', () => {
    expect(normalizeRepositoryUrl({ type: 'git', url: 'git+https://github.com/acme/repo.git', directory: 'x' })).toBe(
      'https://github.com/acme/repo',
    )
  })

  it('strips credentials', () => {
    expect(normalizeRepositoryUrl('git+https://bob:hunter2@github.com/acme/repo.git')).toBe(
      'https://github.com/acme/repo',
    )
    expect(normalizeRepositoryUrl(`https://oauth2:glpat-${'abcdefghijklm'.repeat(2)}@gitlab.com/a/b.git?x=1`)).toBe(
      'https://gitlab.com/a/b',
    )
  })

  it('rejects values that are not URLs', () => {
    expect(normalizeRepositoryUrl(undefined)).toBeUndefined()
    expect(normalizeRepositoryUrl('')).toBeUndefined()
    expect(normalizeRepositoryUrl('see README')).toBeUndefined()
    expect(normalizeRepositoryUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeRepositoryUrl({ url: 42 })).toBeUndefined()
  })

  it('handles scp-style paths inside ssh URLs, which npm accepts', () => {
    expect(normalizeRepositoryUrl('ssh://git@github.com:acme/repo.git')).toBe('https://github.com/acme/repo')
    expect(normalizeRepositoryUrl('git+ssh://git@github.com:acme/repo.git')).toBe('https://github.com/acme/repo')
    expect(normalizeRepositoryUrl('ssh://git@git.example.com:2222/acme/repo.git')).toBe(
      'https://git.example.com:2222/acme/repo',
    )
  })

  it('never turns ssh userinfo into a visible path', () => {
    const url = normalizeRepositoryUrl('ssh://deploy:hunter2@git.example.com/acme/repo.git')
    expect(url).toBe('https://git.example.com/acme/repo')
    expect(normalizeRepositoryUrl('ssh://deploy:hunter2@git.example.com:acme/repo.git')).toBe(
      'https://git.example.com/acme/repo',
    )
  })

  it('only expands owner/repo shorthand when the owner can be a GitHub user', () => {
    expect(normalizeRepositoryUrl('gitlab.com/group')).toBe('https://gitlab.com/group')
    expect(normalizeRepositoryUrl('example.org/repo')).toBeUndefined()
  })

  it('ignores over-long values quickly', () => {
    const started = performance.now()
    expect(normalizeRepositoryUrl('.'.repeat(500_000))).toBeUndefined()
    expect(normalizeRepositoryUrl(`https://github.com/acme/${'a'.repeat(3000)}`)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(timeBudget(500))
  })
})

describe('small helpers', () => {
  it('goModuleName uses the last path element and skips major-version suffixes', () => {
    expect(goModuleName('github.com/acme/go-api')).toBe('go-api')
    expect(goModuleName('github.com/acme/api/v2')).toBe('api')
    expect(goModuleName('example')).toBe('example')
  })

  it('manifestLicense supports legacy forms', () => {
    expect(manifestLicense({ license: 'MIT' })).toBe('MIT')
    expect(manifestLicense({ license: { type: 'ISC', url: 'x' } })).toBe('ISC')
    expect(manifestLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(manifestLicense({ license: 42 })).toBeUndefined()
  })

  it('goPackageName skips comments and honors //go:build ignore', () => {
    expect(goPackageName('// Copyright\n/* block\n comment */\n\npackage main\n')).toBe('main')
    expect(goPackageName('/* one line */ package handlers\n')).toBe('handlers')
    expect(goPackageName('//go:build ignore\n\npackage main\n')).toBeNull()
    expect(goPackageName('//go:build linux\n\npackage main\n')).toBe('main')
    expect(goPackageName('not go at all\n')).toBeNull()
    expect(goPackageName('')).toBeNull()
  })

  it('goMainCandidates groups by directory, tries main.go first and skips tests and sample directories', () => {
    const candidates = goMainCandidates(
      ['main.go', 'cmd/api/main.go', 'examples/demo/main.go', 'testdata/x/main.go', '_old/main.go'],
      ['cmd/api/server.go', 'cmd/api/main.go', 'cmd/api/main_test.go', 'cmd/tool/a.go'],
    )
    expect([...candidates]).toEqual([
      ['.', ['main.go']],
      ['cmd/api', ['cmd/api/main.go', 'cmd/api/server.go']],
      ['cmd/tool', ['cmd/tool/a.go']],
    ])
  })

  it('binEntrypoints reads string and object forms and drops paths outside the root', () => {
    expect(binEntrypoints({ dir: 'packages/cli', name: '@acme/cli', raw: { bin: './bin/cli.js' } })).toEqual([
      { kind: 'bin', path: 'packages/cli/bin/cli.js', name: 'cli' },
    ])
    expect(
      binEntrypoints({ dir: '.', raw: { bin: { a: 'dist/a.js', b: '../../etc/passwd', c: '/usr/bin/c', d: 3 } } }),
    ).toEqual([{ kind: 'bin', path: 'dist/a.js', name: 'a' }])
    expect(binEntrypoints({ dir: '.', raw: { bin: 'bin/tool.mjs' } })).toEqual([
      { kind: 'bin', path: 'bin/tool.mjs', name: 'tool' },
    ])
  })

  it('summarizeStructure counts top-level directories, largest first, at most 15', () => {
    const files = ['README.md', 'src/a.ts', 'src/b.ts', '.github/workflows/ci.yml', 'docs/x.md', 'docs/y.md', 'b/z']
    expect(summarizeStructure(files)).toEqual([
      { path: 'docs', files: 2 },
      { path: 'src', files: 2 },
      { path: '.github', files: 1 },
      { path: 'b', files: 1 },
    ])
    const many = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, '0')}/f`)
    expect(summarizeStructure(many)).toHaveLength(15)
  })

  it('isLibraryShaped requires a public package with a publish-only field or a main in build output', () => {
    expect(isLibraryShaped({ exports: { '.': './x.js' } })).toBe(true)
    for (const key of ['module', 'types', 'typings', 'files', 'publishConfig']) {
      expect(isLibraryShaped({ [key]: key === 'files' ? ['dist'] : 'x' }), key).toBe(true)
    }
    expect(isLibraryShaped({ main: 'dist/index.js' })).toBe(true)
    expect(isLibraryShaped({ main: './lib/index.cjs' })).toBe(true)
    // `npm init -y` writes "main": "index.js" into every application.
    expect(isLibraryShaped({ main: 'index.js' })).toBe(false)
    expect(isLibraryShaped({ main: 'src/server.js' })).toBe(false)
    expect(isLibraryShaped({ private: true, exports: './x.js' })).toBe(false)
    expect(isLibraryShaped({ name: 'x' })).toBe(false)
  })

  it('serverFramework only reads runtime dependencies', () => {
    expect(serverFramework(manifest({}, { dependencies: { express: '^5.0.0' } }))).toBe('express')
    expect(serverFramework(manifest({}, { devDependencies: { express: '^5.0.0' } }))).toBeUndefined()
  })

  it('inferProjectType applies monorepo > cli > application > library', () => {
    const base = { workspacePackages: 0, root: null, goMainPackages: 0, hasRootGoModule: false }
    expect(inferProjectType({ ...base, workspacePackages: 2, root: manifest({ bin: 'x.js' }) })).toBe('monorepo')
    expect(inferProjectType({ ...base, workspacePackages: 1, root: manifest({ bin: 'x.js' }) })).toBe('cli')
    expect(inferProjectType({ ...base, root: manifest({ main: 'dist/x.js' }), applicationEvidence: 'dep' })).toBe(
      'application',
    )
    expect(inferProjectType({ ...base, goMainPackages: 1, hasRootGoModule: true })).toBe('application')
    expect(inferProjectType({ ...base, root: manifest({ main: 'dist/x.js' }) })).toBe('library')
    expect(inferProjectType({ ...base, root: manifest({ main: 'x.js' }) })).toBe('unknown')
    expect(inferProjectType({ ...base, root: manifest({ private: true, main: 'x.js' }) })).toBe('unknown')
    expect(inferProjectType({ ...base, hasRootGoModule: true })).toBe('library')
    expect(inferProjectType(base)).toBe('unknown')
  })

  it('inferProjectType needs a usable bin entry for a CLI', () => {
    const base = { workspacePackages: 0, goMainPackages: 0, hasRootGoModule: false }
    expect(inferProjectType({ ...base, root: manifest({ bin: {} }) })).toBe('unknown')
    expect(inferProjectType({ ...base, root: manifest({ bin: '../outside.js' }) })).toBe('unknown')
    expect(inferProjectType({ ...base, root: manifest({ bin: { x: 'bin/x.js' }, main: 'index.js' }) })).toBe('cli')
  })

  it('inferProjectType lets a server framework outrank bin', () => {
    const base = { workspacePackages: 0, goMainPackages: 0, hasRootGoModule: false }
    const server = manifest({ bin: { serve: 'bin/serve.js' } }, { dependencies: { express: '^5.0.0' } })
    expect(inferProjectType({ ...base, root: server })).toBe('application')
    const devOnly = manifest({ bin: { serve: 'bin/serve.js' } }, { devDependencies: { express: '^5.0.0' } })
    expect(inferProjectType({ ...base, root: devOnly })).toBe('cli')
  })
})

describe('projectDetector on fixtures', () => {
  it('monorepo', async () => {
    const { section, root } = await detectFixture('monorepo')
    expect(section).toEqual({
      name: 'acme',
      directory: path.basename(root),
      type: 'monorepo',
      private: true,
      manifests: ['package.json'],
      entrypoints: [{ kind: 'go-main', path: 'services/billing' }],
      structure: [
        { path: 'apps', files: 8 },
        { path: 'packages', files: 5 },
        { path: 'services', files: 3 },
        { path: '.github', files: 1 },
      ],
    })
  })

  it('go-api: Go module name, two main packages', async () => {
    const { section } = await detectFixture('go-api')
    expect(section.name).toBe('go-api')
    expect(section.type).toBe('application')
    expect(section.manifests).toEqual(['go.mod'])
    expect(section.entrypoints).toEqual([
      { kind: 'go-main', path: 'cmd/api' },
      { kind: 'go-main', path: 'cmd/worker' },
    ])
    expect(section.license).toBeUndefined()
  })

  it('plain-repo: directory name, MIT from LICENSE, unknown type', async () => {
    const { section, root } = await detectFixture('plain-repo')
    expect(section.name).toBe(path.basename(root))
    expect(section.license).toBe('MIT')
    expect(section.type).toBe('unknown')
    expect(section.manifests).toEqual(['requirements.txt'])
    expect(section.entrypoints).toEqual([])
  })

  it('broken-manifest: falls back to the directory name without crashing', async () => {
    const { section, root } = await detectFixture('broken-manifest')
    expect(section.name).toBe(path.basename(root))
    expect(section.directory).toBe(path.basename(root))
    expect(section.manifests).toEqual(['package.json'])
    expect(section.type).toBe('unknown')
  })

  it('express-api: package metadata and an application type', async () => {
    const { section } = await detectFixture('express-api')
    expect(section).toMatchObject({
      name: 'express-api',
      description: 'Inventory items REST API',
      version: '1.0.0',
      license: 'ISC',
      type: 'application',
    })
    expect(section.private).toBeUndefined()
  })

  it('app fixtures are applications', async () => {
    for (const fixture of ['nuxt-app', 'next-app', 'fastify-api', 'bun-app', 'nest-api', 'broken-env']) {
      const { section } = await detectFixture(fixture)
      expect([fixture, section.type]).toEqual([fixture, 'application'])
    }
  })

  it('never outputs an absolute path', async () => {
    const { section, root } = await detectFixture('monorepo')
    expectNoPath(JSON.stringify(section), root)
    expect(section.directory).not.toContain('/')
  })
})

describe('projectDetector on inline projects', () => {
  it('detects a CLI with bin entry points in the root and workspace packages', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        name: '@acme/tool',
        bin: { acme: './bin/acme.js' },
        workspaces: ['packages/*'],
        repository: 'git+https://github.com/acme/tool.git',
        homepage: 'https://acme.dev/tool?ref=npm',
      }),
      'packages/helper/package.json': JSON.stringify({ name: 'helper', bin: 'cli.js' }),
    })
    expect(section.type).toBe('cli')
    expect(section.repository).toBe('https://github.com/acme/tool')
    expect(section.homepage).toBe('https://acme.dev/tool')
    expect(section.entrypoints).toEqual([
      { kind: 'bin', path: 'bin/acme.js', name: 'acme' },
      { kind: 'bin', path: 'packages/helper/cli.js', name: 'helper' },
    ])
  })

  it('detects a publishable library, and ignores dev-only framework dependencies in it', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        name: 'nuxt-module-x',
        exports: { '.': './dist/module.mjs' },
        devDependencies: { nuxt: '^4.0.0', express: '^5.0.0' },
        peerDependencies: { fastify: '^5.0.0' },
      }),
    })
    expect(section.type).toBe('library')
  })

  it('counts vite as an application only with an index.html', async () => {
    const withHtml = await detectFiles({
      'package.json': JSON.stringify({ private: true, devDependencies: { vite: '^7.0.0' } }),
      'index.html': '<!doctype html>',
    })
    expect(withHtml.type).toBe('application')
    const withoutHtml = await detectFiles({
      'package.json': JSON.stringify({ private: true, devDependencies: { vite: '^7.0.0' } }),
    })
    expect(withoutHtml.type).toBe('unknown')
  })

  it('treats a Go module without main packages as a library', async () => {
    const section = await detectFiles({
      'go.mod': 'module github.com/acme/kit/v3\n\ngo 1.25\n',
      'kit.go': 'package kit\n',
      'examples/demo/main.go': 'package main\n\nfunc main() {}\n',
      'internal/gen/main.go': '//go:build ignore\n\npackage main\n',
    })
    expect(section.name).toBe('kit')
    expect(section.type).toBe('library')
    expect(section.entrypoints).toEqual([])
  })

  it('finds a root main package and Go web frameworks', async () => {
    const section = await detectFiles({
      'go.mod': 'module example.com/svc\n\nrequire github.com/labstack/echo/v4 v4.13.0\n',
      'main.go': '// Command svc.\npackage main\n',
      'cmd/migrate/migrate.go': 'package main\n',
      'cmd/lib/lib.go': 'package lib\n',
    })
    expect(section.type).toBe('application')
    expect(section.entrypoints).toEqual([
      { kind: 'go-main', path: '.' },
      { kind: 'go-main', path: 'cmd/migrate' },
    ])
  })

  it('treats an `npm init -y` application with a start script as an application, not a library', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        name: 'my-discord-bot',
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js', test: 'echo "Error: no test specified" && exit 1' },
        license: 'ISC',
        dependencies: { 'discord.js': '^14.16.0', dotenv: '^16.4.0' },
      }),
      'index.js': "require('dotenv').config()\n",
    })
    expect(section.type).toBe('application')
  })

  it('treats a package with bin and Express as an application (a server with a launcher)', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({
        name: 'api-server',
        bin: { 'api-server': 'bin/start.js' },
        dependencies: { express: '^5.1.0' },
      }),
    })
    expect(section.type).toBe('application')
    expect(section.entrypoints).toEqual([{ kind: 'bin', path: 'bin/start.js', name: 'api-server' }])
  })

  it('finds a Go main package in a root-level file that is not main.go', async () => {
    for (const file of ['server.go', 'hello.go']) {
      const section = await detectFiles({
        'go.mod': 'module example.com/hello\n\ngo 1.25\n',
        [file]: 'package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.ListenAndServe(":8080", nil)\n}\n',
        'handlers.go': 'package main\n',
        'handlers_test.go': 'package main_test\n',
      })
      expect([file, section.type]).toEqual([file, 'application'])
      expect(section.entrypoints).toEqual([{ kind: 'go-main', path: '.' }])
    }
  })

  it('counts a net/http ListenAndServe call as application evidence', async () => {
    const section = await detectFiles({
      'go.mod': 'module example.com/svc\n\ngo 1.25\n',
      'svc.go': 'package svc\n',
      'server/serve.go':
        'package main\n\nimport (\n\t"log"\n\t"net/http"\n)\n\nfunc main() { log.Fatal(http.ListenAndServe(":8080", nil)) }\n',
    })
    expect(section.type).toBe('application')
    expect(section.entrypoints).toEqual([{ kind: 'go-main', path: 'server' }])
  })

  it('keeps a Go module that only registers handlers a library', async () => {
    const section = await detectFiles({
      'go.mod': 'module example.com/kit\n\ngo 1.25\n',
      'kit.go': 'package kit\n\nimport "net/http"\n\nfunc Register(m *http.ServeMux) { m.HandleFunc("/x", nil) }\n',
    })
    expect(section.type).toBe('library')
  })

  it('reads a Deno import map as application evidence', async () => {
    const section = await detectFiles({
      'deno.json': JSON.stringify({ imports: { '@hono/hono': 'jsr:@hono/hono@^4' } }),
    })
    expect(section.type).toBe('application')
  })

  it('still reports the project when the workspace detector fails', async () => {
    const original = workspaceDetector.run
    workspaceDetector.run = async () => {
      throw new Error('boom')
    }
    try {
      const section = await detectFiles({
        'package.json': JSON.stringify({ name: 'x', dependencies: { next: '16.0.0' } }),
      })
      expect(section).toMatchObject({ name: 'x', type: 'application' })
    } finally {
      workspaceDetector.run = original
    }
  })

  it('lists root manifests in a fixed order', async () => {
    const section = await detectFiles({
      'Package.swift': '',
      'pyproject.toml': '',
      'Cargo.toml': '',
      'go.work': 'go 1.25\n',
      'deno.json': '{}',
      'nested/Cargo.toml': '',
    })
    expect(section.manifests).toEqual(['go.work', 'deno.json', 'Cargo.toml', 'pyproject.toml', 'Package.swift'])
  })

  it('prefers the package.json license and falls back to COPYING', async () => {
    const fromManifest = await detectFiles({ 'package.json': '{"license":"Apache-2.0"}', LICENSE: MIT })
    expect(fromManifest.license).toBe('Apache-2.0')
    const fromFile = await detectFiles({ COPYING: ISC })
    expect(fromFile.license).toBe('ISC')
    const unknown = await detectFiles({ LICENSE: 'Custom terms. All rights reserved.' })
    expect(unknown.license).toBeUndefined()
  })

  it('drops non-http homepages and repository values', async () => {
    const section = await detectFiles({
      'package.json': JSON.stringify({ homepage: 'javascript:alert(1)', repository: { url: 'not a url' } }),
    })
    expect(section.homepage).toBeUndefined()
    expect(section.repository).toBeUndefined()
  })

  it('skips hostile repository and homepage values without hanging', async () => {
    const started = performance.now()
    const section = await detectFiles({
      'package.json': JSON.stringify({
        repository: 'a.'.repeat(200_000),
        homepage: `https://${'?'.repeat(200_000)}\nx`,
      }),
    })
    expect(section.repository).toBeUndefined()
    expect(section.homepage).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
  })
})

describe('owned sections across all fixtures', () => {
  const FIXTURES = [
    'broken-config',
    'broken-env',
    'broken-manifest',
    'bun-app',
    'docker-project',
    'express-api',
    'fastify-api',
    'go-api',
    'legacy-config',
    'mixed-lockfiles',
    'monorepo',
    'nest-api',
    'next-app',
    'nuxt-app',
    'plain-repo',
  ]

  async function sections(dir: string) {
    const ctx = await contextFor(dir)
    return {
      project: await ctx.use(projectDetector),
      packageManagers: await ctx.use(packageManagersDetector),
      workspace: await ctx.use(workspaceDetector),
      scripts: await ctx.use(scriptsDetector),
      dependencies: await ctx.use(dependenciesDetector),
    }
  }

  it.each(FIXTURES)('%s: no secrets, no absolute paths, deterministic', async (fixture) => {
    const dir = await copyFixture(fixture)
    const first = await sections(dir)
    const json = JSON.stringify(first)
    expect(json).not.toContain(SECRET_SENTINEL)
    expectNoPath(json, dir)
    expect(await sections(dir)).toEqual(first)
  })
})
