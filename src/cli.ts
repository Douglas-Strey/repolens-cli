#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
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
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  platform: process.platform,
  // Only a person at a terminal can answer setup's question; piped input never says yes.
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? {
        confirm: async (question: string) => {
          const prompt = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return /^y(?:es)?$/i.test((await prompt.question(question)).trim())
          } finally {
            prompt.close()
          }
        },
      }
    : {}),
})
process.exitCode = code
