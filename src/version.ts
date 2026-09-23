import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** RepoLens version, read from package.json (works from both src/ and dist/). */
export const VERSION: string = (require('../package.json') as { version: string }).version
