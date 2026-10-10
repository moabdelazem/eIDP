import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { adoConfig, authHeader } from './client.ts'

const exec = promisify(execFile)
/** A fetch that stalls is killed rather than holding the catalog lock (lib/locks.ts) for good. */
const GIT_TIMEOUT_MS = 5 * 60_000
const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => exec(file, args, { ...options, timeout: GIT_TIMEOUT_MS })

/**
 * Clones or updates a repository into `checkout`.
 *
 * Reading 1100 applications over the Items API would be thousands of calls, so
 * the sync works against a real working copy: shallow clone once, fetch after.
 *
 * The token goes in through GIT_CONFIG_* environment variables rather than the
 * remote URL or `-c` arguments. Command-line arguments are world-readable in
 * `ps`; a process's environment is not.
 */
export async function cloneOrUpdate(project: string, repo: string, checkout: string): Promise<void> {
  const ado = adoConfig()
  const remote = `${ado.baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`

  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // fail instead of hanging on a credential prompt
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${authHeader(ado.pat)}`,
  }

  if (await exists(`${checkout}/.git`)) {
    await run('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', 'HEAD'], { env })
    await run('git', ['-C', checkout, 'reset', '--hard', 'FETCH_HEAD'], { env })
    return
  }

  await mkdir(dirname(checkout), { recursive: true })
  await run('git', ['clone', '--depth', '1', '--', remote, checkout], { env })
}

/** The commit the working copy is on, so a sync can record its source. */
export async function headCommit(checkout: string): Promise<string> {
  const { stdout } = await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
