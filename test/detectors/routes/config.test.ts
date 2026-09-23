import { describe, expect, it } from 'vitest'
import { configValue, parseNextConfig, parseNuxtConfig } from '../../../src/detectors/routes/config.ts'
import { parseJsFile } from '../../../src/detectors/routes/js.ts'

const value = (text: string, key: string) => configValue(parseJsFile('next.config.js', '.', text), key)

describe('configValue', () => {
  it('reads string literals, arrays of them and same-file constants', () => {
    expect(value("module.exports = { basePath: '/docs' }", 'basePath')).toEqual({ kind: 'value', value: '/docs' })
    expect(value('export default { "basePath": `/docs` }', 'basePath')).toEqual({ kind: 'value', value: '/docs' })
    expect(value("const nextConfig = { pageExtensions: ['page.tsx', 'api.ts'] }", 'pageExtensions')).toEqual({
      kind: 'value',
      value: ['page.tsx', 'api.ts'],
    })
    expect(value("const basePath = '/shop'\nmodule.exports = { basePath }", 'basePath')).toEqual({
      kind: 'value',
      value: '/shop',
    })
    expect(value("const BASE = '/shop'\nmodule.exports = { basePath: BASE }", 'basePath')).toEqual({
      kind: 'value',
      value: '/shop',
    })
  })

  it('reports expressions as dynamic', () => {
    for (const text of [
      'module.exports = { basePath: process.env.BASE_PATH }',
      "module.exports = { basePath: isProd ? '/docs' : '' }",
      "module.exports = { basePath: '/docs' + suffix }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'module.exports = { basePath: `${prefix}/docs` }',
      'module.exports = { basePath }',
      "module.exports = { basePath: '/a', other: { basePath: '/b' } }",
    ]) {
      expect(value(text, 'basePath'), text).toEqual({ kind: 'dynamic' })
    }
  })

  it('ignores comments, strings, booleans and member accesses', () => {
    for (const text of [
      "// basePath: '/commented'\nmodule.exports = {}",
      'const doc = "basePath: \'/in-string\'"',
      "module.exports = { async rewrites() { return [{ source: '/a', destination: 'https://x', basePath: false }] } }",
      'const x = config.basePath',
    ]) {
      expect(value(text, 'basePath'), text).toEqual({ kind: 'none' })
    }
  })
})

describe('parseNextConfig / parseNuxtConfig', () => {
  it('keeps valid values and flags unreadable or invalid ones', () => {
    expect(parseNextConfig("module.exports = { basePath: '/store', pageExtensions: ['page.tsx'] }")).toEqual({
      basePath: '/store',
      pageExtensions: ['page.tsx'],
      dynamic: [],
    })
    expect(parseNextConfig("module.exports = { basePath: 'store/', pageExtensions: exts }").dynamic).toEqual([
      'basePath',
      'pageExtensions',
    ])
    expect(parseNextConfig(null)).toEqual({ basePath: '', pageExtensions: null, dynamic: [] })
  })

  it('normalizes srcDir and refuses paths outside the package', () => {
    expect(parseNuxtConfig("export default defineNuxtConfig({ srcDir: 'src/' })").srcDir).toBe('src')
    expect(parseNuxtConfig("export default defineNuxtConfig({ srcDir: './client' })").srcDir).toBe('client')
    expect(parseNuxtConfig("export default defineNuxtConfig({ srcDir: '../shared' })")).toEqual({
      srcDir: null,
      dynamic: ['srcDir'],
    })
    expect(parseNuxtConfig("export default defineNuxtConfig({ srcDir: '~/app' })").dynamic).toEqual(['srcDir'])
    expect(parseNuxtConfig('export default defineNuxtConfig({})')).toEqual({ srcDir: null, dynamic: [] })
  })
})
