import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))

await rm(new URL('../lib/', import.meta.url), { recursive: true, force: true })

const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', status => resolve(status ?? 1))
})
if (code !== 0) process.exit(code)
