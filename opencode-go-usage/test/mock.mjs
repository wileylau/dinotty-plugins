// Standalone smoke test for the plugin's activation/status logic.
// Runs the real bin/ helper and reads the real opencode files; no Dinotty host.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginDir = join(import.meta.dirname, '..')
const wrapper =
  process.platform === 'win32'
    ? join(pluginDir, 'bin', 'opencode-go-usage.cmd')
    : join(pluginDir, 'bin', 'opencode-go-usage.sh')

const storage = new Map()
const auth = JSON.parse(readFileSync(join(homedir(), '.local/share/opencode/auth.json'), 'utf8'))
storage.set('apiKey', auth['opencode-go']?.key)
storage.set('plan', 'go')

const ctx = {
  ref: (value) => ({ value }),
  h: (tag, props, children) => ({ tag, props, children }),
  i18n: { getLocale: () => 'en', onDidChangeLocale: () => ({ dispose() {} }) },
  storage: {
    get: async (key) => storage.get(key),
    set: async (key, value) => storage.set(key, value),
    delete: async (key) => storage.delete(key),
  },
  workspace: {
    readFile: async (path) => {
      const resolved = path.replace(/^~(?=\/|\\)/, homedir())
      try {
        return { content: readFileSync(resolved, 'utf8'), truncated: false }
      } catch {
        return { content: null, truncated: false }
      }
    },
  },
  exec: {
    run: (args, options = {}) => {
      const result = spawnSync(`"${wrapper}"`, args, {
        env: { ...process.env, ...(options.env ?? {}) },
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: options.timeout ?? 20000,
      })
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
    spawn: (args, options = {}) => {
      const child = spawn(`"${wrapper}"`, args, {
        env: { ...process.env, ...(options.env ?? {}) },
        shell: process.platform === 'win32',
      })
      const stdout = new ReadableStream({
        start(c) {
          child.stdout.on('data', (chunk) => c.enqueue(String(chunk)))
          child.stdout.on('end', () => {
            try {
              c.close()
            } catch {
              /* already closed */
            }
          })
          child.on('error', () => {
            try {
              c.close()
            } catch {
              /* already closed */
            }
          })
        },
      })
      return Promise.resolve({
        stdout,
        stderr: new ReadableStream(),
        kill: () => {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)])
          } else {
            child.kill()
          }
        },
      })
    },
  },
  commands: { register: () => ({ dispose() {} }) },
  open: () => {},
}

const { activate } = await import(pathToFileURL(join(pluginDir, 'main.js')).href)
const plugin = await activate(ctx)
const series = plugin.monitor.series[0]

await new Promise((resolve) => setTimeout(resolve, 3000))

console.log('statusText:', series.statusText())
console.log('detail:')
for (const row of series.detail()) console.log(`  ${row.label}: ${row.value}`)

plugin.dispose()
