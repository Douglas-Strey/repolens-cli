/**
 * Print the CHANGELOG.md section for a version, used as GitHub release notes.
 *   node scripts/changelog-section.ts v1.2.3
 */
import { readFileSync } from 'node:fs'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('Usage: node scripts/changelog-section.ts <version>')
  process.exit(2)
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`) || line.startsWith(`## ${version}`))
if (start === -1) {
  console.log(`See CHANGELOG.md for the changes in ${version}.`)
} else {
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  console.log(
    lines
      .slice(start + 1, end === -1 ? undefined : end)
      .join('\n')
      .trim(),
  )
}
