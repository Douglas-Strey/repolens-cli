import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isWithin, normalizeRelative } from '../utils/paths.ts'

export type ReadFailure = 'missing' | 'outside-root' | 'not-a-file' | 'too-large' | 'binary' | 'unreadable'

export type ReadResult = { ok: true; text: string } | { ok: false; reason: ReadFailure; detail?: string }

/** Bytes inspected when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * O_NONBLOCK keeps a FIFO swapped in after the type check from hanging the
 * scan; O_NOFOLLOW refuses a final path component that was swapped for a
 * symlink after it was resolved. Neither exists on Windows.
 */
const OPEN_FLAGS =
  constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))

export function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * Read a text file that must live inside `root`.
 *
 * - Rejects absolute paths and `..` traversal.
 * - Resolves symlinks (including symlinked parent directories) and refuses
 *   anything whose real path leaves the root.
 * - Refuses non-regular files (FIFOs, sockets, devices) and files over `maxBytes`.
 * - Refuses binary files (NUL byte in the first 8 KB).
 *
 * `root` must already be a real (symlink-free) absolute path.
 */
export async function readTextWithin(root: string, relative: string, maxBytes: number): Promise<ReadResult> {
  const rel = normalizeRelative(relative)
  if (rel === null) return { ok: false, reason: 'outside-root' }

  const candidate = path.join(root, rel)
  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch (error) {
    return failure(error)
  }
  if (!isWithin(root, real)) return { ok: false, reason: 'outside-root' }

  return readRegularFile(real, maxBytes)
}

type BytesResult = { ok: true; bytes: Buffer } | { ok: false; reason: ReadFailure; detail?: string }

function failure(error: unknown): { ok: false; reason: ReadFailure; detail?: string } {
  const code = (error as NodeJS.ErrnoException)?.code
  return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable', detail: code }
}

/**
 * Read a regular file's bytes. The type and size are checked before opening
 * (so FIFOs and devices are never opened) and again on the open handle (so a
 * file swapped in between is caught). Never reads more than `maxBytes`.
 */
async function readBytes(absolute: string, maxBytes: number): Promise<BytesResult> {
  let handle: fs.FileHandle | undefined
  try {
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large', detail: `${stat.size} bytes` }

    handle = await fs.open(absolute, OPEN_FLAGS)
    const opened = await handle.stat()
    if (!opened.isFile()) return { ok: false, reason: 'not-a-file' }
    if (opened.size > maxBytes) return { ok: false, reason: 'too-large', detail: `${opened.size} bytes` }

    const buffer = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { ok: true, bytes: buffer.subarray(0, offset) }
  } catch (error) {
    return failure(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Read a regular file by absolute path with the same size, type and binary
 * protections as `readTextWithin`, but without the root check. Only used for
 * Git metadata whose location has been validated by the caller. The final
 * path component must not be a symlink.
 */
export async function readRegularFile(absolute: string, maxBytes: number): Promise<ReadResult> {
  const result = await readBytes(absolute, maxBytes)
  if (!result.ok) return result
  if (isBinary(result.bytes)) return { ok: false, reason: 'binary' }
  let text = result.bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { ok: true, text }
}

/** Read a binary file (used for .git/index) with a size cap. Returns null on any failure. */
export async function readBinaryFile(absolute: string, maxBytes: number): Promise<Buffer | null> {
  const result = await readBytes(absolute, maxBytes)
  return result.ok ? result.bytes : null
}

export async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await fs.stat(absolute)).isDirectory()
  } catch {
    return false
  }
}
