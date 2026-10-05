import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('package entrypoint is built JavaScript and matches the Cordis patch row', async () => {
  assert.equal(packageJson.main, './lib/index.js')
  assert.equal(packageJson.exports['.'], './lib/index.js')
  assert.ok(packageJson.files.includes('lib'))

  const row = patch.match(/- id: ([^\n]+)[\s\S]*?name: ([^\n]+)/)
  assert.ok(row, 'cordis.patch.yml must insert a named plugin row')
  assert.equal(row[1].trim(), 'llm-localforge')
  assert.equal(row[2].trim(), packageJson.name)

  const entry = await import(new URL('../lib/index.js', import.meta.url).href)
  assert.equal(entry.name, row[1].trim())
  assert.equal(typeof entry.apply, 'function')
})
