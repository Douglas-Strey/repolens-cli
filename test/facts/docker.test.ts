// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Dockerfile ${VAR} interpolation is the syntax under test
import { describe, expect, it } from 'vitest'
import {
  dockerfiles,
  findDockerfiles,
  isDockerfileName,
  MAX_DOCKERFILE_EXPANSION,
  MAX_DOCKERFILES,
  parseDockerfile,
} from '../../src/facts/docker.ts'
import { contextFor, makeProject, SECRET_SENTINEL, timeBudget } from '../helpers.ts'

describe('Dockerfile discovery', () => {
  it('recognizes Dockerfile names in any case, but not code or docs about Dockerfiles', () => {
    for (const name of [
      'Dockerfile',
      'dockerfile',
      'Dockerfile.dev',
      'dockerfile.prod',
      'DOCKERFILE.ci',
      'api.Dockerfile',
      'web.dockerfile',
      'Containerfile',
      'containerfile.dev',
    ]) {
      expect(isDockerfileName(name), name).toBe(true)
    }
    for (const name of [
      'Dockerfile.dockerignore',
      '.dockerignore',
      'dockerfile.go',
      'Dockerfile.md',
      'dockerfile.test.ts',
      'Dockerfiles',
      'docker-compose.yml',
    ]) {
      expect(isDockerfileName(name), name).toBe(false)
    }
  })

  it('uses one depth limit and one sample-directory rule, sorted by path', () => {
    expect(
      findDockerfiles([
        'services/api/dockerfile.dev',
        'Dockerfile',
        'a/b/c/d/Dockerfile',
        'a/b/c/d/e/Dockerfile',
        'tests/Dockerfile',
        'examples/demo/Dockerfile',
        'templates/app/Dockerfile',
        'playground/Dockerfile',
        'benchmarks/Dockerfile',
        'test/fixtures/app/Dockerfile',
      ]),
    ).toEqual(['Dockerfile', 'a/b/c/d/Dockerfile', 'services/api/dockerfile.dev'])
  })
})

describe('parseDockerfile', () => {
  it('lists stages with their names and marks stage references', () => {
    const parsed = parseDockerfile(
      ['FROM node:22 AS deps', 'FROM deps AS build', 'FROM BUILD AS other', 'FROM gcr.io/distroless/nodejs22'].join(
        '\n',
      ),
    )
    expect(parsed.stages).toEqual([
      { image: 'node:22', name: 'deps', fromStage: false },
      { image: 'deps', name: 'build', fromStage: true },
      { image: 'BUILD', name: 'other', fromStage: true },
      { image: 'gcr.io/distroless/nodejs22', fromStage: false },
    ])
  })

  it('never substitutes secret-looking ARGs and redacts their inline defaults', () => {
    const parsed = parseDockerfile(
      [
        `ARG NPM_TOKEN=${SECRET_SENTINEL}`,
        'ARG TAG=22',
        'FROM node:${NPM_TOKEN}',
        `FROM node:\${REGISTRY_PASSWORD:-${SECRET_SENTINEL}}`,
        'FROM node:${TAG}',
      ].join('\n'),
    )
    expect(parsed.stages.map((stage) => stage.image)).toEqual([
      'node:${NPM_TOKEN}',
      'node:${REGISTRY_PASSWORD:-***}',
      'node:22',
    ])
    expect(JSON.stringify(parsed)).not.toContain(SECRET_SENTINEL)
  })

  it('bounds substitution across the whole file', () => {
    const value = 'x'.repeat(400_000)
    const text = `ARG A=${value}\n${`FROM ${'$A'.repeat(200)}\n`.repeat(1_000)}`
    const started = performance.now()
    const parsed = parseDockerfile(text)
    expect(performance.now() - started).toBeLessThan(timeBudget(2000))
    expect(parsed.stages).toHaveLength(1_000)
    const inserted = parsed.stages.reduce((sum, stage) => sum + stage.image.replaceAll('$A', '').length, 0)
    expect(inserted).toBeLessThanOrEqual(MAX_DOCKERFILE_EXPANSION)
  })
})

describe('dockerfiles fact', () => {
  it('parses each project Dockerfile once, skipping unreadable ones', async () => {
    const ctx = await contextFor(
      await makeProject({
        Dockerfile: 'FROM node:22-alpine\nEXPOSE 3000\n',
        'worker/dockerfile.dev': 'ARG GO=1.25\nFROM golang:${GO}\n',
        'examples/demo/Dockerfile': 'FROM node:12\n',
      }),
    )
    const found = await ctx.use(dockerfiles)
    expect(found.truncated).toBe(false)
    expect(found.files.map((file) => [file.path, file.stages.map((stage) => stage.image), file.exposes])).toEqual([
      ['Dockerfile', ['node:22-alpine'], ['3000']],
      ['worker/dockerfile.dev', ['golang:1.25'], []],
    ])
    expect(await ctx.use(dockerfiles)).toBe(found)
  })

  it('reads at most MAX_DOCKERFILES files, the first ones by path', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_DOCKERFILES + 5; i++)
      files[`svc/${String(i).padStart(3, '0')}.Dockerfile`] = 'FROM node:22\n'
    const found = await (await contextFor(await makeProject(files))).use(dockerfiles)
    expect(found.truncated).toBe(true)
    expect(found.files).toHaveLength(MAX_DOCKERFILES)
    expect(found.files[0]?.path).toBe('svc/000.Dockerfile')
  })
})
