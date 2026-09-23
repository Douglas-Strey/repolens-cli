import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function markdownFiles(): string[] {
  const root = fs.readdirSync(ROOT).filter((name) => name.endsWith('.md'))
  const docs = fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
  return [
    ...root,
    ...docs.filter((name) => name.endsWith('.md')).map((name) => path.join('docs', name)),
    path.join('test', 'fixtures', 'README.md'),
  ].sort()
}

/** Relative link targets outside code blocks: [text](target), href="target", src="target". */
function relativeLinks(text: string): string[] {
  const prose = text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '')
  const targets = [...prose.matchAll(/\]\(([^)\s]+)\)/g), ...prose.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map(
    (match) => match[1] as string,
  )
  // "…" stands for an elided URL in prose ("[Claude Code](…)").
  return targets.filter((target) => !/^(?:[a-z]+:|#|…$)/i.test(target))
}

describe('documentation links', () => {
  it.each(markdownFiles())('%s only links to files that exist', (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const missing = relativeLinks(text).filter((target) => {
      const resolved = path.resolve(ROOT, path.dirname(file), decodeURI(target.split('#')[0] as string))
      return !fs.existsSync(resolved)
    })
    expect(missing).toEqual([])
  })
})

describe('translations', () => {
  const english = fs.readdirSync(path.join(ROOT, 'docs')).filter((name) => name.endsWith('.md'))
  const translated = fs.readdirSync(path.join(ROOT, 'docs', 'pt-BR')).filter((name) => name.endsWith('.md'))

  it('has a pt-BR version of every document, and nothing else', () => {
    expect(translated.sort()).toEqual(english.sort())
    for (const name of ['README', 'CONTRIBUTING', 'SECURITY', 'ROADMAP']) {
      expect(fs.existsSync(path.join(ROOT, `${name}.pt-BR.md`))).toBe(true)
    }
  })

  it.each(english)('docs/%s links to its translation and back', (name) => {
    expect(fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8')).toContain(`(pt-BR/${name})`)
    expect(fs.readFileSync(path.join(ROOT, 'docs', 'pt-BR', name), 'utf8')).toContain(`(../${name})`)
  })

  it('keeps the same code blocks as the English version', () => {
    // Commands, JSON and code examples are never translated; comments inside them may be.
    const commands = (text: string) =>
      [...text.matchAll(/^```(?:sh|bash|json|jsonc|yaml|yml|ts)\n([\s\S]*?)^```/gm)]
        .flatMap((match) => (match[1] as string).replace(/\/\*[\s\S]*?\*\//g, '').split('\n'))
        .map((line) => line.replace(/\s*(?:#|\/\/).*$/, '').trim())
        .filter(Boolean)
    for (const name of english) {
      const source = commands(fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8'))
      const target = commands(fs.readFileSync(path.join(ROOT, 'docs', 'pt-BR', name), 'utf8'))
      expect(target, name).toEqual(source)
    }
  })
})
