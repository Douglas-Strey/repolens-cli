/**
 * A Model Context Protocol server over stdio, without the SDK: JSON-RPC 2.0,
 * one message per line. RepoLens only serves tools, which takes a handful of
 * methods; the official SDK would add 18 dependencies to a tool meant to run
 * on unfamiliar repositories.
 *
 * One process serves both protocol eras, as the specification allows: a
 * legacy client (2025-11-25 and earlier) opens with `initialize`, a modern
 * one (2026-07-28) sends its protocol version in every request's `_meta`.
 */
import { createInterface } from 'node:readline'
import { isRecord } from '../core/parse.ts'

/** Modern versions: no handshake, the version travels with every request. */
export const MODERN_VERSIONS: readonly string[] = ['2026-07-28']
/** Versions negotiated with `initialize`, newest first. */
export const LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
} as const

/** How long a modern client may cache the server's description and tool list: they only change with a new version. */
const CACHE_TTL_MS = 3_600_000

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown>
}

export interface ToolResult {
  text: string
  /** A failure the model can correct (a bad argument, a path that doesn't exist). */
  isError?: boolean
}

export interface McpServerOptions {
  name: string
  title: string
  version: string
  /** Shown to the model: what the server is for and how to use its tools. */
  instructions: string
  tools: readonly ToolDefinition[]
  /** Runs a known tool; throwing reports an internal error without details. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  /** Diagnostics for stderr; stdout carries protocol messages only. */
  log?: (message: string) => void
}

type Id = string | number

export interface RpcResponse {
  jsonrpc: '2.0'
  id: Id | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function failure(id: Id | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/**
 * The modern protocol version a request carries in `_meta`, or null for a
 * legacy request. A modern request must also declare the client's
 * capabilities, and use a version this server speaks.
 */
function modernVersion(params: Record<string, unknown>): string | null {
  const meta = params._meta
  if (!isRecord(meta) || !Object.hasOwn(meta, META_VERSION)) return null
  const version = meta[META_VERSION]
  if (typeof version !== 'string') throw new RpcError(RPC_ERRORS.invalidParams, `${META_VERSION} must be a string`)
  if (!isRecord(meta[META_CAPABILITIES])) {
    throw new RpcError(RPC_ERRORS.invalidParams, `Missing ${META_CAPABILITIES} in _meta`)
  }
  if (!MODERN_VERSIONS.includes(version)) {
    throw new RpcError(RPC_ERRORS.unsupportedVersion, 'Unsupported protocol version', {
      supported: MODERN_VERSIONS,
      requested: version,
    })
  }
  return version
}

/** The server: `handle` takes one parsed message and returns the response to send, or null for none. */
export function createMcpServer(options: McpServerOptions): {
  handle: (message: unknown) => Promise<RpcResponse | null>
} {
  const serverInfo = { name: options.name, title: options.title, version: options.version }
  const capabilities = { tools: {} }
  const toolList = options.tools.map((tool) => ({ ...tool }))
  const known = new Set(options.tools.map((tool) => tool.name))

  const dispatch = async (method: string, rawParams: unknown): Promise<unknown> => {
    if (rawParams !== undefined && !isRecord(rawParams)) {
      throw new RpcError(RPC_ERRORS.invalidParams, 'params must be an object')
    }
    const params = rawParams ?? {}
    const modern = modernVersion(params) !== null
    // Modern results say they are complete; legacy ones have no such field.
    const complete = (result: Record<string, unknown>) => (modern ? { resultType: 'complete', ...result } : result)

    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion
        const protocolVersion =
          typeof requested === 'string' && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0]
        return { protocolVersion, capabilities, serverInfo, instructions: options.instructions }
      }
      case 'server/discover':
        if (!modern) throw new RpcError(RPC_ERRORS.invalidParams, `Missing ${META_VERSION} in _meta`)
        return complete({
          supportedVersions: MODERN_VERSIONS,
          capabilities,
          instructions: options.instructions,
          ttlMs: CACHE_TTL_MS,
          cacheScope: 'public',
          _meta: { [META_SERVER_INFO]: serverInfo },
        })
      case 'tools/list':
        // Everything fits on one page, so no cursor is valid.
        if (params.cursor !== undefined) throw new RpcError(RPC_ERRORS.invalidParams, 'Invalid cursor')
        return modern ? complete({ tools: toolList, ttlMs: CACHE_TTL_MS, cacheScope: 'public' }) : { tools: toolList }
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string') throw new RpcError(RPC_ERRORS.invalidParams, 'params.name must be a string')
        if (!known.has(name)) throw new RpcError(RPC_ERRORS.invalidParams, `Unknown tool: ${name.slice(0, 100)}`)
        const args = params.arguments ?? {}
        if (!isRecord(args)) throw new RpcError(RPC_ERRORS.invalidParams, 'params.arguments must be an object')
        const result = await options.callTool(name, args)
        return complete({
          content: [{ type: 'text', text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        })
      }
      // Legacy clients may ping; the modern revision dropped it, but answering costs nothing.
      case 'ping':
        return {}
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method.slice(0, 100)}`)
    }
  }

  const handle = async (message: unknown): Promise<RpcResponse | null> => {
    if (Array.isArray(message)) return failure(null, RPC_ERRORS.invalidRequest, 'Batches are not supported')
    if (!isRecord(message)) return failure(null, RPC_ERRORS.invalidRequest, 'Invalid Request')
    // Responses to requests this server never sends need no answer.
    if (typeof message.method !== 'string' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      return null
    }
    const id = isId(message.id) ? message.id : null
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return failure(id, RPC_ERRORS.invalidRequest, 'Invalid Request')
    }
    // Notifications (notifications/initialized, notifications/cancelled, …) never get a response.
    if (!Object.hasOwn(message, 'id')) return null
    if (id === null) return failure(null, RPC_ERRORS.invalidRequest, 'id must be a string or a number')
    try {
      return { jsonrpc: '2.0', id, result: await dispatch(message.method, message.params) }
    } catch (error) {
      if (error instanceof RpcError) return failure(id, error.code, error.message, error.data)
      options.log?.(`mcp: ${message.method} failed: ${String((error as Error)?.stack ?? error)}`)
      return failure(id, RPC_ERRORS.internal, 'Internal error')
    }
  }

  return { handle }
}

/**
 * Serve newline-delimited JSON-RPC from `input` until it ends. Requests are
 * handled one at a time, in order: a scan uses every core it gets, and the
 * order of responses then follows the order of requests.
 */
export async function serveLines(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  server: { handle: (message: unknown) => Promise<RpcResponse | null> },
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write(`${JSON.stringify(failure(null, RPC_ERRORS.parse, 'Parse error'))}\n`)
      continue
    }
    const response = await server.handle(message)
    // JSON.stringify escapes newlines inside strings, so every message stays on one line.
    if (response) write(`${JSON.stringify(response)}\n`)
  }
}
