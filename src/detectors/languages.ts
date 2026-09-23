import type { Detector, LanguageKind, LanguageStat } from '../types.ts'
import { compareText } from '../utils/compare.ts'
import { isUnder, type PathRole } from '../utils/path-roles.ts'
import { baseName, extOf } from '../utils/paths.ts'

interface LanguageDef {
  name: string
  kind: LanguageKind
  extensions: readonly string[]
}

/**
 * Languages counted by file extension. Data and documentation formats (JSON,
 * YAML, Markdown, TOML, lockfiles, images) are deliberately absent: they say
 * little about what a project is written in.
 */
const LANGUAGES: readonly LanguageDef[] = [
  { name: 'TypeScript', kind: 'programming', extensions: ['.ts', '.tsx', '.mts', '.cts'] },
  { name: 'JavaScript', kind: 'programming', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  { name: 'Go', kind: 'programming', extensions: ['.go'] },
  { name: 'Python', kind: 'programming', extensions: ['.py', '.pyi'] },
  { name: 'Rust', kind: 'programming', extensions: ['.rs'] },
  { name: 'Ruby', kind: 'programming', extensions: ['.rb', '.rake'] },
  { name: 'PHP', kind: 'programming', extensions: ['.php'] },
  { name: 'Java', kind: 'programming', extensions: ['.java'] },
  { name: 'Kotlin', kind: 'programming', extensions: ['.kt', '.kts'] },
  { name: 'Swift', kind: 'programming', extensions: ['.swift'] },
  { name: 'C', kind: 'programming', extensions: ['.c', '.h'] },
  { name: 'C++', kind: 'programming', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] },
  { name: 'C#', kind: 'programming', extensions: ['.cs'] },
  { name: 'Dart', kind: 'programming', extensions: ['.dart'] },
  { name: 'Elixir', kind: 'programming', extensions: ['.ex', '.exs'] },
  { name: 'Erlang', kind: 'programming', extensions: ['.erl', '.hrl'] },
  { name: 'Scala', kind: 'programming', extensions: ['.scala'] },
  { name: 'Lua', kind: 'programming', extensions: ['.lua'] },
  { name: 'Zig', kind: 'programming', extensions: ['.zig'] },
  { name: 'Shell', kind: 'programming', extensions: ['.sh', '.bash', '.zsh', '.fish'] },
  { name: 'PowerShell', kind: 'programming', extensions: ['.ps1', '.psm1'] },
  { name: 'SQL', kind: 'programming', extensions: ['.sql'] },
  { name: 'Vue', kind: 'markup', extensions: ['.vue'] },
  { name: 'Svelte', kind: 'markup', extensions: ['.svelte'] },
  { name: 'Astro', kind: 'markup', extensions: ['.astro'] },
  { name: 'HTML', kind: 'markup', extensions: ['.html', '.htm'] },
  { name: 'CSS', kind: 'style', extensions: ['.css'] },
  { name: 'SCSS', kind: 'style', extensions: ['.scss', '.sass'] },
  { name: 'Less', kind: 'style', extensions: ['.less'] },
  { name: 'Stylus', kind: 'style', extensions: ['.styl'] },
]

const BY_EXTENSION: ReadonlyMap<string, LanguageDef> = new Map(
  LANGUAGES.flatMap((language) => language.extensions.map((ext) => [ext, language] as const)),
)

/** Minified bundles are build output, not source. */
const MINIFIED = /\.min\.(?:[cm]?js|css)$/i

/** Language of a file by extension, or null when it is not counted. */
export function languageOf(file: string): { name: string; kind: LanguageKind } | null {
  if (MINIFIED.test(baseName(file))) return null
  const language = BY_EXTENSION.get(extOf(file))
  return language ? { name: language.name, kind: language.kind } : null
}

/**
 * Sample code in other languages (test fixtures, examples, templates) says
 * nothing about what the project is written in. Tests do count: they are
 * written in the project's languages.
 */
const SAMPLE_ROLES: readonly PathRole[] = ['fixture', 'example', 'template']

/** Files that count toward language shares; everything when the repository is nothing but samples. */
export function languageFiles(files: readonly string[]): readonly string[] {
  const own = files.filter((file) => !isUnder(file, SAMPLE_ROLES))
  return own.some((file) => languageOf(file) !== null) ? own : files
}

/**
 * Count files per language. Sorted by file count (descending), then name;
 * `share` is the fraction of all counted files, rounded to 3 decimals.
 */
export function countLanguages(files: readonly string[]): LanguageStat[] {
  const counts = new Map<string, LanguageStat>()
  let total = 0
  for (const file of files) {
    const language = languageOf(file)
    if (!language) continue
    total++
    const stat = counts.get(language.name)
    if (stat) stat.files++
    else counts.set(language.name, { name: language.name, kind: language.kind, files: 1, share: 0 })
  }
  const stats = [...counts.values()]
  for (const stat of stats) stat.share = Math.round((stat.files / total) * 1000) / 1000
  return stats.sort((a, b) => b.files - a.files || compareText(a.name, b.name))
}

export const languagesDetector: Detector<'languages'> = {
  id: 'languages',
  title: 'Languages',
  async run(ctx) {
    return countLanguages(languageFiles(ctx.files.files))
  },
}
