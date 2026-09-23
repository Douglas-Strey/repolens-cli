import { type Document, isAlias, isCollection, isPair, isScalar, parseDocument, type YAMLError } from 'yaml'

export class ParseError extends Error {
  override name = 'ParseError'
}

/**
 * Strip comments and trailing commas from JSONC (tsconfig.json, biome.json,
 * turbo.json, …) so it can be handed to JSON.parse. String contents are left
 * untouched.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (ch === '"') {
      // Copy the string literal verbatim, honoring escapes.
      let j = i + 1
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end
      // Keep the comment's line breaks so parse errors report the right line.
      for (let j = i + 2; j < stop; j++) if (text[j] === '\n') out += '\n'
      out += ' '
      i = end === -1 ? n : end + 2
    } else {
      out += ch
      i++
    }
  }
  return removeTrailingCommas(out)
}

function removeTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j] as string)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Line (1-based) of a character offset. */
function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * V8's JSON.parse messages quote the text around the error, which may be a
 * secret. Keep only the error kind and its location.
 */
export function describeJsonError(message: string, text: string): string {
  const located = /^(.*?) in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/s.exec(message)
  if (located?.[1] && located[2]) {
    const line = located[3] ?? String(lineAt(text, Number(located[2])))
    return `${located[1]} at line ${line}${located[4] ? `, column ${located[4]}` : ''}`
  }
  if (message.startsWith('Unexpected end of JSON input')) return 'Unexpected end of JSON input'
  const quoted = /^Unexpected token .*?, (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON$/.exec(message)
  if (quoted) {
    const snippet = quoted[1] ?? ''
    const index = snippet === '' ? -1 : text.indexOf(snippet)
    return index === -1 ? 'Unexpected token' : `Unexpected token near line ${lineAt(text, index)}`
  }
  return 'Invalid JSON'
}

/**
 * Errors whose message quotes source text in the middle ("The !x! tag has no
 * suffix", "Unsupported YAML version 1.x", "Invalid escape sequence \\x"):
 * described by their code instead.
 */
const YAML_ERROR_SUMMARY: Readonly<Record<string, string>> = {
  TAG_RESOLVE_FAILED: 'Invalid or unresolved tag',
  BAD_DIRECTIVE: 'Invalid directive',
  BAD_DQ_ESCAPE: 'Invalid escape sequence in a double-quoted string',
}

/**
 * yaml's messages may end with source text (`…: "token"`, an alias name or a
 * code frame). Keep the first clause and add the position.
 */
function describeYamlError(error: YAMLError, text: string): string {
  const firstLine = (error.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, '')
  const clause = YAML_ERROR_SUMMARY[error.code] ?? (firstLine.split(': ')[0]?.trim() || 'Invalid YAML')
  const offset = error.pos[0]
  if (!Number.isInteger(offset) || offset < 0) return clause
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return `${clause} at line ${lineAt(text, offset)}, column ${offset - lineStart + 1}`
}

export function parseJson<T = unknown>(text: string): T {
  const source = stripBom(text)
  try {
    return JSON.parse(source) as T
  } catch (error) {
    throw new ParseError(describeJsonError((error as Error).message, source))
  }
}

export function parseJsonc<T = unknown>(text: string): T {
  const source = stripJsonComments(stripBom(text))
  try {
    return JSON.parse(source) as T
  } catch (error) {
    throw new ParseError(describeJsonError((error as Error).message, source))
  }
}

/**
 * Upper bound on YAML nodes after expanding aliases and merge keys. A 1 MiB
 * file has far fewer nodes than this; only alias bombs get near it.
 */
const MAX_YAML_NODES = 1_000_000
const MAX_YAML_DEPTH = 1_000

/**
 * Map every alias to the node it refers to: the last node with that anchor
 * before it in document order, as yaml's `Alias.resolve` does. yaml walks the
 * whole document for every alias it resolves, which is quadratic: 50,000
 * aliases in a 200 KB file took minutes. One pre-order pass does it for all.
 */
function resolveAliases(doc: Document): Map<unknown, unknown> {
  const anchors = new Map<string, unknown>()
  const targets = new Map<unknown, unknown>()
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_YAML_DEPTH) throw new ParseError('YAML is nested too deeply')
    if (isAlias(node)) {
      const target = anchors.get(node.source)
      if (target !== undefined) targets.set(node, target)
    } else if (isPair(node)) {
      visit(node.key, depth + 1)
      visit(node.value, depth + 1)
    } else if (isScalar(node) || isCollection(node)) {
      if (node.anchor) anchors.set(node.anchor, node)
      if (isCollection(node)) for (const item of node.items) visit(item, depth + 1)
    }
  }
  visit(doc.contents, 0)
  return targets
}

/**
 * Put each alias's target node in the alias's place, so `toJS` converts the
 * target again instead of resolving the alias (quadratic, see above). The
 * result is the same data; only object identity differs. Must run after
 * checkYamlExpansion, which rejects recursive aliases and bounds the size.
 */
function inlineAliases(doc: Document, targets: ReadonlyMap<unknown, unknown>): void {
  // Never descend into an inlined target: it is also in its original place and is visited once, there.
  const visit = (node: unknown): void => {
    if (isPair(node)) {
      if (isAlias(node.key)) node.key = targets.get(node.key) ?? node.key
      else visit(node.key)
      if (isAlias(node.value)) node.value = targets.get(node.value) ?? node.value
      else visit(node.value)
    } else if (isCollection(node)) {
      const items = node.items as unknown[]
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (isAlias(item)) items[i] = targets.get(item) ?? item
        else visit(item)
      }
    }
  }
  visit(doc.contents)
}

/**
 * Count the nodes the document expands to, following aliases. Throws on
 * recursive aliases (they would produce circular objects that hang naive
 * consumers) and on documents that expand past MAX_YAML_NODES.
 */
function checkYamlExpansion(doc: Document, targets: ReadonlyMap<unknown, unknown>): void {
  const sizes = new Map<unknown, number>()
  const active = new Set<unknown>()
  const sizeOf = (node: unknown, depth: number): number => {
    if (depth > MAX_YAML_DEPTH) throw new ParseError('YAML is nested too deeply')
    if (isAlias(node)) {
      const target = targets.get(node)
      if (!target) return 1
      if (active.has(target)) throw new ParseError('Recursive YAML aliases are not supported')
      return sizeOf(target, depth + 1)
    }
    if (isCollection(node)) {
      const known = sizes.get(node)
      if (known !== undefined) return known
      active.add(node)
      let size = 1
      for (const item of node.items) {
        size += sizeOf(item, depth + 1)
        if (size > MAX_YAML_NODES) throw new ParseError('YAML expands to too many nodes (alias bomb?)')
      }
      active.delete(node)
      sizes.set(node, size)
      return size
    }
    if (isPair(node)) return sizeOf(node.key, depth + 1) + sizeOf(node.value, depth + 1)
    return 1
  }
  if (sizeOf(doc.contents, 0) > MAX_YAML_NODES) throw new ParseError('YAML expands to too many nodes (alias bomb?)')
}

/**
 * Parse the first YAML document. Alias expansion is bounded and recursive
 * aliases are rejected, which defuses "billion laughs" documents while still
 * allowing files that reuse one anchor many times (`<<: *defaults` in every
 * Compose service or CI job). The parser never logs to the console, and error
 * messages never quote the source.
 */
export function parseYaml<T = unknown>(text: string): T {
  try {
    const source = stripBom(text)
    const doc = parseDocument(source, {
      merge: true,
      prettyErrors: false,
      logLevel: 'silent',
      uniqueKeys: false,
      strict: false,
    })
    const first = doc.errors[0]
    if (first) throw new ParseError(describeYamlError(first, source))
    const targets = resolveAliases(doc)
    checkYamlExpansion(doc, targets)
    inlineAliases(doc, targets)
    // No aliases remain unless one was unresolved, and toJS reports that as an error.
    return doc.toJS({ maxAliasCount: 10_000 }) as T
  } catch (error) {
    if (error instanceof ParseError) throw error
    // Only the first clause: messages from the library may quote source text.
    throw new ParseError(((error as Error).message ?? 'Invalid YAML').split(/:|\n/)[0] ?? 'Invalid YAML')
  }
}

/** Narrow unknown parsed data to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string property, ignoring non-string values. */
export function getString(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a string-to-string map, dropping non-string values. */
export function getStringMap(obj: unknown, key: string): Record<string, string> {
  if (!isRecord(obj)) return {}
  const value = obj[key]
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** Coerce a string or array of strings into an array of strings. */
export function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}
