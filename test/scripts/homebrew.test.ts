import { describe, expect, it } from 'vitest'
import { renderFormula, tarballUrl } from '../../scripts/lib/homebrew.ts'

const SHA = 'a'.repeat(64)

describe('Homebrew formula', () => {
  it('installs the npm tarball of the given version', () => {
    const formula = renderFormula({ version: '1.2.3', sha256: SHA })
    expect(formula).toContain('class Repolens < Formula')
    expect(formula).toContain(`url "${tarballUrl('1.2.3')}"`)
    expect(formula).toContain('https://registry.npmjs.org/repolens-cli/-/repolens-cli-1.2.3.tgz')
    expect(formula).toContain(`sha256 "${SHA}"`)
    expect(formula).toContain('depends_on "node"')
    expect(formula).toContain('system "npm", "install", *std_npm_args')
  })

  it('rejects malformed input', () => {
    expect(() => renderFormula({ version: '1.2', sha256: SHA })).toThrow('Invalid version')
    expect(() => renderFormula({ version: '1.2.3', sha256: 'nothex' })).toThrow('Invalid sha256')
  })
})
