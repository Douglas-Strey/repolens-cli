export type RepoLensErrorCode = 'INVALID_ROOT' | 'INVALID_ARGUMENT' | 'INVALID_CONFIG' | 'OUTPUT_FAILED'

/**
 * An expected, user-facing error. The CLI prints `message` without a stack
 * trace (the stack is shown with --verbose) and exits with code 2.
 */
export class RepoLensError extends Error {
  override name = 'RepoLensError'
  readonly code: RepoLensErrorCode
  readonly detail?: string

  constructor(code: RepoLensErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One-line description of an unexpected error with the project root replaced
 * by ".". Covers the spellings a root can take in error messages: as given,
 * with forward slashes, and with Windows' \\?\ prefix (case-insensitively there).
 */
export function errorSummary(error: unknown, root: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  let line = message.split('\n')[0] ?? ''
  const forms = [`\\\\?\\${root}`, root, root.replaceAll('\\', '/')].filter((form) => form.length > 1)
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  for (const form of forms) line = line.replace(new RegExp(escapeRegExp(form), flags), '.')
  // Paths inside the root keep forward slashes, like every other path RepoLens prints.
  return line.replace(/\.\\[^\s'"]*/g, (match) => match.replaceAll('\\', '/'))
}
