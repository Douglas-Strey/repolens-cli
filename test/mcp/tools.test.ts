import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type CliIO, main } from '../../src/cli/main.ts'
import { scan } from '../../src/core/scan.ts'
import { callRepoLensTool, REPOLENS_TOOLS, type ToolContext } from '../../src/mcp/tools.ts'
import { canSymlink, copyFixture, expectNoPath, makeProject, SECRET_SENTINEL, TEST_NOW } from '../helpers.ts'

function context(root: string): ToolContext {
  return { root, scanOptions: async (dir) => ({ cwd: dir, now: TEST_NOW }), scan }
}

/** Run `repolens mcp` in-process: send the messages, close stdin, return the parsed responses. */
async function converse(
  root: string,
  messages: readonly unknown[],
  argv: string[] = [],
  env: Record<string, string> = {},
) {
  const stdin = new PassThrough()
  let stdout = ''
  let stderr = ''
  const io: CliIO = {
    stdout: { write: (chunk: string) => (stdout += chunk), isTTY: false },
    stderr: { write: (chunk: string) => (stderr += chunk), isTTY: false },
    stdin,
    env,
    cwd: root,
    platform: 'linux',
    now: TEST_NOW,
  }
  const running = main(['mcp', ...argv], io)
  stdin.end(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  const code = await running
  return {
    code,
    stdout,
    stderr,
    responses: stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  }
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})

describe('RepoLens MCP tools', () => {
  it('declares read-only tools with a strict input schema', () => {
    expect(REPOLENS_TOOLS.map((tool) => tool.definition.name)).toEqual([
      'get_project_overview',
      'get_services',
      'get_environment_variables',
      'get_routes',
      'get_scripts',
      'get_diagnostics',
    ])
    for (const { definition } of REPOLENS_TOOLS) {
      expect(definition.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(definition.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('answers with the matching part of the report, never with secret values or absolute paths', async () => {
    const root = await copyFixture('monorepo')
    for (const { definition } of REPOLENS_TOOLS) {
      for (const format of ['markdown', 'json']) {
        const result = await callRepoLensTool(definition.name, { format }, context(root))
        expect(result.isError, `${definition.name} ${format}`).toBeUndefined()
        expect(result.text).not.toContain(SECRET_SENTINEL)
        expectNoPath(result.text, root)
      }
    }
    const env = await callRepoLensTool('get_environment_variables', {}, context(root))
    expect(env.text).toContain('## Environment variables')
    expect(env.text).not.toContain('## Services')
    const services = await callRepoLensTool('get_services', { format: 'json' }, context(root))
    expect(Object.keys(JSON.parse(services.text))).toEqual(['schemaVersion', 'services', 'databases'])
  })

  it('looks at a subdirectory, and refuses paths outside the project', async () => {
    const root = await copyFixture('monorepo')
    const web = await callRepoLensTool('get_project_overview', { path: 'apps/web', format: 'json' }, context(root))
    expect(JSON.parse(web.text).project.directory).toBe('web')
    for (const bad of ['..', '../x', '/etc', 'C:\\Windows', 3]) {
      expect((await callRepoLensTool('get_routes', { path: bad }, context(root))).isError, String(bad)).toBe(true)
    }
    const missing = await callRepoLensTool('get_routes', { path: 'nope' }, context(root))
    expect(missing).toEqual({ text: 'nope does not exist in the project.', isError: true })
  })

  it.runIf(canSymlink)('refuses a link that leads out of the project', async () => {
    const outside = await makeProject({ 'package.json': '{"name":"outside"}' })
    const root = await makeProject({ 'package.json': '{"name":"inside"}' })
    await fs.symlink(outside, path.join(root, 'link'), 'dir')
    const result = await callRepoLensTool('get_project_overview', { path: 'link' }, context(root))
    expect(result).toEqual({ text: '`path` must be a directory inside the project.', isError: true })
  })

  it('rejects unknown arguments and formats', async () => {
    const root = await makeProject({ 'package.json': '{}' })
    expect(await callRepoLensTool('get_routes', { verbose: true }, context(root))).toEqual({
      text: 'Unknown argument verbose: use path and format.',
      isError: true,
    })
    expect((await callRepoLensTool('get_routes', { format: 'yaml' }, context(root))).isError).toBe(true)
  })
})

describe('repolens mcp', () => {
  it('serves a whole conversation over stdin and stdout', async () => {
    const root = await copyFixture('monorepo')
    const { code, stderr, responses } = await converse(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      call(3, 'get_diagnostics'),
      call(4, 'get_routes', { path: '../outside' }),
    ])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4])
    expect(responses[1].result.tools).toHaveLength(6)
    expect(responses[2].result.content[0].text).toMatch(/^# /)
    expect(responses[3].result.isError).toBe(true)
  })

  it("serves Claude Code's project directory when no path is given", async () => {
    const project = await makeProject({ 'package.json': '{"name":"from-env"}' })
    const elsewhere = await makeProject({ 'package.json': '{"name":"cwd"}' })
    const overview = (env: Record<string, string>, argv: string[] = []) =>
      converse(elsewhere, [call(1, 'get_project_overview', { format: 'json' })], argv, env).then(
        ({ responses }) => JSON.parse(responses[0].result.content[0].text).project.name,
      )
    expect(await overview({ CLAUDE_PROJECT_DIR: project })).toBe('from-env')
    expect(await overview({})).toBe('cwd')
    expect(await overview({ CLAUDE_PROJECT_DIR: project }, [elsewhere])).toBe('cwd')
    expect(await overview({ CLAUDE_PROJECT_DIR: 'relative' })).toBe('cwd')
  })

  it('applies --no-config and rejects flags that make no sense for it', async () => {
    const root = await makeProject({ 'package.json': '{}', 'repolens.config.json': '{"ignore": [' })
    const { stderr } = await converse(root, [call(1, 'get_scripts')], ['--no-config'])
    expect(stderr).toBe('')
    const rejected = await converse(root, [], ['--json'])
    expect(rejected.code).toBe(2)
    expect(rejected.stderr).toContain('--json does not apply to mcp')
  })
})
