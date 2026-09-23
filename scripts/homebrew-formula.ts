/**
 * Print the Homebrew formula for a published version of RepoLens.
 *
 *   node scripts/homebrew-formula.ts 0.1.0                       # hashes the tarball on npm
 *   node scripts/homebrew-formula.ts 0.1.0 --tarball x.tgz       # hashes a local `npm pack` tarball
 *   node scripts/homebrew-formula.ts 0.1.0 --output Formula/repolens.rb
 *
 * Used by the release workflow to update the Douglas-Strey/homebrew-tap repository.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { renderFormula, tarballUrl } from './lib/homebrew.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tarball: { type: 'string' }, output: { type: 'string' } },
})
const version = (positionals[0] ?? '').replace(/^v/, '')
if (!version) {
  console.error('Usage: node scripts/homebrew-formula.ts <version> [--tarball <file>] [--output <file>]')
  process.exit(2)
}

async function download(url: string): Promise<Buffer> {
  // The registry can take a moment to serve a version that was just published.
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url)
    if (response.ok) return Buffer.from(await response.arrayBuffer())
    if (attempt === 10) throw new Error(`GET ${url} failed with ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 3000))
  }
}

const bytes = values.tarball ? await fs.readFile(values.tarball) : await download(tarballUrl(version))
const sha256 = createHash('sha256').update(bytes).digest('hex')
const formula = renderFormula({ version, sha256 })

if (values.output) {
  await fs.mkdir(path.dirname(values.output), { recursive: true })
  await fs.writeFile(values.output, formula)
  console.log(`Wrote ${values.output} (repolens ${version}, sha256 ${sha256})`)
} else {
  process.stdout.write(formula)
}
