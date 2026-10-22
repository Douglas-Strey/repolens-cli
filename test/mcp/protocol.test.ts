import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  createMcpServer,
  LEGACY_VERSIONS,
  type McpServerOptions,
  MODERN_VERSIONS,
  RPC_ERRORS,
  serveLines,
} from '../../src/mcp/protocol.ts'

const TOOL = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes its argument',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
}

function server(overrides: Partial<McpServerOptions> = {}) {
  return createMcpServer({
    name: 'repolens',
    title: 'RepoLens',
    version: '9.9.9',
    instructions: 'Use the tools.',
    tools: [TOOL],
    callTool: async (_name, args) =>
      typeof args.text === 'string' ? { text: args.text } : { text: 'text is required', isError: true },
    ...overrides,
  })
}

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSIONS[0],
  'io.modelcontextprotocol/clientCapabilities': {},
}

function request(id: number | string, method: string, params?: unknown) {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
}

describe('legacy clients (initialize)', () => {
  it('echoes a supported version and offers the newest one otherwise', async () => {
    const { handle } = server()
    expect(await handle(request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'repolens', title: 'RepoLens', version: '9.9.9' },
        instructions: 'Use the tools.',
      },
    })
    const newer = await handle(request(2, 'initialize', { protocolVersion: '2099-01-01' }))
    expect(newer?.result).toMatchObject({ protocolVersion: LEGACY_VERSIONS[0] })
  })

  it('lists and calls tools without modern fields', async () => {
    const { handle } = server()
    expect(await handle(request(1, 'tools/list'))).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [TOOL] } })
    expect(await handle(request(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }))).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'hi' }] },
    })
    expect(await handle(request(3, 'tools/call', { name: 'echo' }))).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'text is required' }], isError: true },
    })
    expect(await handle(request(4, 'ping'))).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
  })
})

describe('modern clients (per-request _meta)', () => {
  it('describes the server with server/discover', async () => {
    const response = await server().handle(request('d', 'server/discover', { _meta: MODERN_META }))
    expect(response?.result).toEqual({
      resultType: 'complete',
      supportedVersions: MODERN_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'Use the tools.',
      ttlMs: 3_600_000,
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'repolens', title: 'RepoLens', version: '9.9.9' } },
    })
  })

  it('marks results complete and makes tool lists cacheable', async () => {
    const { handle } = server()
    expect((await handle(request(1, 'tools/list', { _meta: MODERN_META })))?.result).toEqual({
      resultType: 'complete',
      tools: [TOOL],
      ttlMs: 3_600_000,
      cacheScope: 'public',
    })
    const call = await handle(request(2, 'tools/call', { _meta: MODERN_META, name: 'echo', arguments: { text: 'x' } }))
    expect(call?.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'x' }] })
  })

  it('rejects an unsupported version, missing capabilities and a discover without _meta', async () => {
    const { handle } = server()
    const meta = { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }
    expect(await handle(request(1, 'tools/list', { _meta: meta }))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: RPC_ERRORS.unsupportedVersion,
        message: 'Unsupported protocol version',
        data: { supported: MODERN_VERSIONS, requested: '2099-01-01' },
      },
    })
    const noCapabilities = { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSIONS[0] }
    expect((await handle(request(2, 'tools/list', { _meta: noCapabilities })))?.error?.code).toBe(
      RPC_ERRORS.invalidParams,
    )
    expect((await handle(request(3, 'server/discover')))?.error?.code).toBe(RPC_ERRORS.invalidParams)
  })
})

describe('JSON-RPC errors', () => {
  it.each([
    ['an unknown method', request(1, 'resources/list'), RPC_ERRORS.methodNotFound],
    ['an unknown tool', request(1, 'tools/call', { name: 'rm' }), RPC_ERRORS.invalidParams],
    ['a tool name that is not a string', request(1, 'tools/call', { name: 3 }), RPC_ERRORS.invalidParams],
    [
      'arguments that are not an object',
      request(1, 'tools/call', { name: 'echo', arguments: [] }),
      RPC_ERRORS.invalidParams,
    ],
    ['params that are not an object', request(1, 'tools/list', 'x'), RPC_ERRORS.invalidParams],
    ['a cursor (there is one page)', request(1, 'tools/list', { cursor: 'x' }), RPC_ERRORS.invalidParams],
    ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'ping' }, RPC_ERRORS.invalidRequest],
    ['a null id', { jsonrpc: '2.0', id: null, method: 'ping' }, RPC_ERRORS.invalidRequest],
    ['a batch', [request(1, 'ping')], RPC_ERRORS.invalidRequest],
    ['a scalar', 42, RPC_ERRORS.invalidRequest],
  ])('answers %s with an error', async (_label, message, code) => {
    expect((await server().handle(message))?.error?.code).toBe(code)
  })

  it('never answers notifications or stray responses', async () => {
    const { handle } = server()
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', method: 'no/such/notification', params: 3 })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', id: 9, result: {} })).toBeNull()
  })

  it('hides internal failures from the client and logs them', async () => {
    const logged: string[] = []
    const { handle } = server({
      callTool: async () => {
        throw new Error('secret detail')
      },
      log: (message) => logged.push(message),
    })
    expect(await handle(request(1, 'tools/call', { name: 'echo' }))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: RPC_ERRORS.internal, message: 'Internal error' },
    })
    expect(logged.join('\n')).toContain('secret detail')
  })
})

describe('serveLines', () => {
  it('answers line by line, in order, one message per line, and stops at end of input', async () => {
    const input = new PassThrough()
    const written: string[] = []
    const done = serveLines(input, (line) => written.push(line), server())
    input.write(`${JSON.stringify(request(1, 'tools/call', { name: 'echo', arguments: { text: 'a\nb' } }))}\r\n`)
    input.write('\n   \nnot json\n')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    input.end(`${JSON.stringify(request(2, 'ping'))}`)
    await done
    expect(written.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(true)
    expect(written.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'a\nb' }] } },
      { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })
})
