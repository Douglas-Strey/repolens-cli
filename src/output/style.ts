/**
 * Terminal styling without dependencies.
 *
 * Status is never communicated by color alone: every status has a symbol and
 * the symbols have ASCII fallbacks for terminals without Unicode support.
 */

export interface Symbols {
  pass: string
  warn: string
  fail: string
  info: string
  arrow: string
  bullet: string
  dot: string
  dash: string
}

const UNICODE_SYMBOLS: Symbols = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  info: 'ℹ',
  arrow: '→',
  bullet: '•',
  dot: '·',
  dash: '—',
}

const ASCII_SYMBOLS: Symbols = {
  pass: '+',
  warn: '!',
  fail: 'x',
  info: 'i',
  arrow: '->',
  bullet: '*',
  dot: '-',
  dash: '-',
}

export interface Style {
  readonly color: boolean
  readonly unicode: boolean
  readonly symbols: Symbols
  bold(text: string): string
  dim(text: string): string
  italic(text: string): string
  underline(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  blue(text: string): string
  magenta(text: string): string
  cyan(text: string): string
  gray(text: string): string
}

type Env = Record<string, string | undefined>

/**
 * Decide whether to emit ANSI colors.
 * Precedence: --color/--no-color > NO_COLOR > FORCE_COLOR > the user config > TERM=dumb > isTTY.
 */
export function supportsColor(options: {
  flag?: boolean | undefined
  isTTY?: boolean | undefined
  env?: Env
  /** `output.color` from the user config; flags and NO_COLOR/FORCE_COLOR take precedence. */
  preference?: 'auto' | 'always' | 'never' | undefined
}): boolean {
  const env = options.env ?? process.env
  if (options.flag === false) return false
  if (options.flag === true) return true
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  if (options.preference === 'never') return false
  if (options.preference === 'always') return true
  if (env.TERM === 'dumb') return false
  return options.isTTY === true
}

/** Heuristic from the `is-unicode-supported` package. */
export function supportsUnicode(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.REPOLENS_ASCII === '1') return false
  if (platform !== 'win32') return env.TERM !== 'linux'
  return Boolean(
    env.WT_SESSION ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'Terminus-Sublime' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
      env.CI,
  )
}

function wrap(enabled: boolean, open: number, close: number) {
  return enabled ? (text: string) => `\u001b[${open}m${text}\u001b[${close}m` : (text: string) => text
}

export function createStyle(options: { color: boolean; unicode: boolean }): Style {
  const { color, unicode } = options
  return {
    color,
    unicode,
    symbols: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
    bold: wrap(color, 1, 22),
    dim: wrap(color, 2, 22),
    italic: wrap(color, 3, 23),
    underline: wrap(color, 4, 24),
    red: wrap(color, 31, 39),
    green: wrap(color, 32, 39),
    yellow: wrap(color, 33, 39),
    blue: wrap(color, 34, 39),
    magenta: wrap(color, 35, 39),
    cyan: wrap(color, 36, 39),
    gray: wrap(color, 90, 39),
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Display width of a string, ignoring ANSI codes. Assumes single-width characters. */
export function visibleLength(text: string): number {
  return [...stripAnsi(text)].length
}

/** Pad to a visible width (ANSI-aware). */
export function padEnd(text: string, width: number): string {
  const length = visibleLength(text)
  return length >= width ? text : text + ' '.repeat(width - length)
}

/** Truncate to a visible width with an ellipsis. Only use on unstyled text. */
export function truncate(text: string, width: number, unicode = true): string {
  const chars = [...text]
  if (chars.length <= width) return text
  const ellipsis = unicode ? '…' : '...'
  return chars.slice(0, Math.max(0, width - ellipsis.length)).join('') + ellipsis
}

/** Options shared by all human-readable renderers. */
export interface RenderOptions {
  style: Style
  /** Show low-confidence findings, evidence, and technical details. */
  verbose: boolean
  /** Only print what needs attention. */
  quiet: boolean
  /** Terminal width in columns. */
  width: number
  /**
   * The scanned directory as the user passed it (`repolens ../api`), so suggested
   * follow-up commands target it: "Run repolens doctor ../api". Unset when the
   * scan ran in the current directory or the path was absolute (output never
   * contains absolute paths). Raw text: quote it with `shellQuote`.
   */
  commandPath?: string
}

export function defaultRenderOptions(overrides: Partial<RenderOptions> = {}): RenderOptions {
  // `{ width: undefined }` from a caller's optional value must not erase the default.
  const given = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  return {
    style: createStyle({ color: false, unicode: true }),
    verbose: false,
    quiet: false,
    width: 100,
    ...(given as Partial<RenderOptions>),
  }
}
