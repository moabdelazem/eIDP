import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'
import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'
import { adoConfig, authHeader } from './client.ts'

const exec = promisify(execFile)
/** A fetch that stalls is killed rather than holding the catalog lock (lib/locks.ts) for good. */
const GIT_TIMEOUT_MS = 5 * 60_000
const run = async (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) => {
  const { input, ...rest } = options
  const child = exec(file, args, { ...rest, timeout: GIT_TIMEOUT_MS })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  return child
}

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

// ---- writing -------------------------------------------------------------------

/** A repository to push to, and the environment that authenticates git to it. */
export type Remote = { url: string; env: NodeJS.ProcessEnv }

/**
 * The inventories repository as git sees it: ADO's, with the service
 * account's token, unless INVENTORIES_GIT_URL names another — a mirror, or a
 * local repository in tests, which needs no token.
 */
export function inventoriesRemote(): Remote {
  return remoteFor(config.INVENTORIES_PROJECT, config.INVENTORIES_REPO, config.INVENTORIES_GIT_URL, 'INVENTORIES_PROJECT')
}

/**
 * The OpenShift/Kubernetes manifests repository a pipeline's deployment files
 * are written to — in the inventories' project unless OCP_TEMPLATES_PROJECT
 * says otherwise — or OCP_TEMPLATES_GIT_URL.
 */
export function ocpTemplatesRemote(): Remote {
  return remoteFor(config.OCP_TEMPLATES_PROJECT ?? config.INVENTORIES_PROJECT, config.OCP_TEMPLATES_REPO, config.OCP_TEMPLATES_GIT_URL, 'OCP_TEMPLATES_PROJECT or INVENTORIES_PROJECT')
}

function remoteFor(project: string | undefined, repository: string, override: string | undefined, setting: string): Remote {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (override) return { url: override, env }
  if (!project) throw new ApiError(503, 'repository_not_configured', `${setting} is not set, so there is no ${repository} repository to write to.`)
  const ado = adoConfig()
  return {
    url: `${ado.baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`,
    env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${authHeader(ado.pat)}` },
  }
}

/** History kept in the writing copy: enough to find a recent commit by its marker, not the whole repository. */
const WRITE_DEPTH = 200

/**
 * A working copy to write in, exactly at the remote's default branch: cloned
 * once, then fetched and reset, so nothing a failed write left behind
 * survives into the next. Returns the branch and the commit it is at.
 */
export async function freshCopy(remote: Remote, checkout: string): Promise<{ branch: string; head: string }> {
  const { env } = remote
  if (!(await exists(`${checkout}/.git`))) {
    await mkdir(dirname(checkout), { recursive: true })
    await run('git', ['clone', '--depth', String(WRITE_DEPTH), '--', remote.url, checkout], { env })
  }
  await run('git', ['-C', checkout, 'remote', 'set-url', 'origin', remote.url], { env })
  // The default branch as the server says now, not as the clone remembered it.
  const { stdout } = await run('git', ['-C', checkout, 'ls-remote', '--symref', 'origin', 'HEAD'], { env })
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(stdout)?.[1]
  if (!branch) throw new Error('The inventories repository has no default branch.')
  await run('git', ['-C', checkout, 'fetch', '--depth', String(WRITE_DEPTH), 'origin', branch], { env })
  await run('git', ['-C', checkout, 'checkout', '-q', '-B', branch, 'FETCH_HEAD'], { env })
  await run('git', ['-C', checkout, 'reset', '-q', '--hard', 'FETCH_HEAD'], { env })
  await run('git', ['-C', checkout, 'clean', '-q', '-fdx'], { env })
  return { branch, head: await headCommit(checkout) }
}

/** The newest commit in the copy whose message contains `marker`, if any — how a retry knows its push already landed. */
export async function findCommit(checkout: string, marker: string): Promise<string | null> {
  const { stdout } = await run('git', ['-C', checkout, 'log', '-F', `--grep=${marker}`, '--format=%H', '-n', '1'])
  return stdout.trim() || null
}

export type FileWrite = { path: string; content: string }

/**
 * Writes `files` into the copy, commits them and pushes to `branch`. False
 * when the push was refused because the branch moved on — someone else
 * pushed meanwhile — so the caller can start again from a fresh copy.
 * A path may not leave the working copy.
 */
export async function commitAndPush(
  remote: Remote,
  checkout: string,
  branch: string,
  files: FileWrite[],
  message: string,
  committer: { name: string; email: string },
): Promise<{ pushed: true; commit: string } | { pushed: false }> {
  for (const file of files) {
    const target = normalize(join(checkout, file.path))
    if (!target.startsWith(normalize(checkout) + sep)) throw new Error(`Refusing to write outside the repository: ${file.path}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
  }
  const { env } = remote
  await run('git', ['-C', checkout, 'add', '--', ...files.map((f) => f.path)], { env })
  await run(
    'git',
    ['-C', checkout, '-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, 'commit', '-q', '-F', '-'],
    { env, input: message },
  )
  try {
    await run('git', ['-C', checkout, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { env })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    if (/non-fast-forward|fetch first|rejected|stale info/i.test(stderr)) return { pushed: false }
    throw new Error(`Pushing to inventories failed: ${stderr.trim().split('\n').at(-1) || (err instanceof Error ? err.message : String(err))}`)
  }
  return { pushed: true, commit: await headCommit(checkout) }
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
