/**
 * Render real RepoLens terminal output as SVG "screenshots" for the README.
 *
 *   node scripts/screenshot.ts
 *
 * Scans a copy of test/fixtures/monorepo (committed to a throwaway Git repo so
 * the Git section is realistic), runs the CLI in-process with colors forced on,
 * and converts the ANSI output to SVG. Nothing is mocked: the images show
 * exactly what this version of RepoLens prints.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli/main.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COLUMNS = 92

const THEME = {
  background: '#0d1117',
  chrome: '#161b22',
  border: '#30363d',
  foreground: '#e6edf3',
  dim: '#8b949e',
  colors: {
    31: '#ff7b72',
    32: '#3fb950',
    33: '#d29922',
    34: '#58a6ff',
    35: '#bc8cff',
    36: '#39c5cf',
    90: '#8b949e',
  } as Record<number, string>,
}

interface Span {
  text: string
  color?: string
  bold: boolean
  dim: boolean
}

function parseAnsi(line: string): Span[] {
  const spans: Span[] = []
  let color: string | undefined
  let bold = false
  let dim = false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing ANSI escape sequences
  const pattern = /\u001b\[([0-9;]*)m/g
  let last = 0
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    if (match.index > last) spans.push({ text: line.slice(last, match.index), color, bold, dim })
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        color = undefined
        bold = false
        dim = false
      } else if (code === 1) bold = true
      else if (code === 2) dim = true
      else if (code === 22) {
        bold = false
        dim = false
      } else if (code === 39) color = undefined
      else if (THEME.colors[code]) color = THEME.colors[code]
    }
    last = pattern.lastIndex
  }
  if (last < line.length) spans.push({ text: line.slice(last), color, bold, dim })
  return spans
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function toSvg(command: string, output: string): string {
  const lines = [`$ ${command}`, '', ...output.replace(/\n+$/, '').split('\n')]
  const lineHeight = 20
  const charWidth = 8.4
  const padX = 20
  const top = 48
  const width = Math.ceil(COLUMNS * charWidth + padX * 2)
  const height = top + lines.length * lineHeight + 16

  const rows = lines.map((line, index) => {
    const y = top + index * lineHeight + 14
    const spans =
      index === 0
        ? [
            { text: '$ ', color: THEME.dim, bold: false, dim: false },
            { text: command, bold: true, dim: false },
          ]
        : parseAnsi(line)
    const tspans = spans
      .map((span: Span) => {
        const fill = span.color ?? (span.dim ? THEME.dim : THEME.foreground)
        const weight = span.bold ? ' font-weight="700"' : ''
        const opacity = span.dim && span.color ? ' fill-opacity="0.75"' : ''
        return `<tspan fill="${fill}"${weight}${opacity}>${escapeXml(span.text)}</tspan>`
      })
      .join('')
    return `    <text x="${padX}" y="${y}" xml:space="preserve">${tspans}</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Terminal output of ${escapeXml(command)}">
  <rect width="${width}" height="${height}" rx="10" fill="${THEME.background}" stroke="${THEME.border}"/>
  <rect width="${width}" height="32" rx="10" fill="${THEME.chrome}"/>
  <rect y="22" width="${width}" height="10" fill="${THEME.chrome}"/>
  <circle cx="20" cy="16" r="6" fill="#ff5f57"/>
  <circle cx="40" cy="16" r="6" fill="#febc2e"/>
  <circle cx="60" cy="16" r="6" fill="#28c840"/>
  <g font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" font-size="14">
${rows.join('\n')}
  </g>
</svg>
`
}

async function capture(argv: string[], cwd: string): Promise<string> {
  let stdout = ''
  await main(argv, {
    stdout: { write: (chunk: string) => (stdout += chunk), isTTY: true, columns: COLUMNS },
    stderr: { write: () => true, isTTY: false },
    env: { FORCE_COLOR: '1', TERM: 'xterm-256color' },
    cwd,
    platform: 'linux',
  })
  return stdout
}

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-screenshot-'))
const project = path.join(workDir, 'acme')
try {
  await fs.cp(path.join(ROOT, 'test/fixtures/monorepo'), project, { recursive: true })
  // Fixtures store their ignore rules as _gitignore (see test/fixtures/README.md).
  await fs.rename(path.join(project, '_gitignore'), path.join(project, '.gitignore'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@repolens.invalid', ...args], {
      cwd: project,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'init', '--no-gpg-sign')
  git('remote', 'add', 'origin', 'https://github.com/acme/acme.git')

  await fs.mkdir(path.join(ROOT, 'assets'), { recursive: true })
  for (const [name, argv] of [
    ['scan', []],
    ['doctor', ['doctor']],
  ] as const) {
    const output = await capture([...argv], project)
    const command = ['repolens', ...argv].join(' ')
    await fs.writeFile(path.join(ROOT, 'assets', `demo-${name}.svg`), toSvg(command, output))
    console.log(`wrote assets/demo-${name}.svg (${output.split('\n').length} lines)`)
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true })
}
