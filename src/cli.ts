#!/usr/bin/env node
import { main } from './cli/main.ts'

// `repolens | head` closes stdout early; exit quietly instead of crashing.
// Some libuv versions report a closed pipe on Windows as EOF rather than EPIPE.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE' || error.code === 'EOF') process.exit(0)
  throw error
})

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  platform: process.platform,
})
process.exitCode = code
