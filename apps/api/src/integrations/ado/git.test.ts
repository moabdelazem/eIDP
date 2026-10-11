// Writing to a repository (git.ts) against a local one over file://: the
// copy is reset to the remote, a push overtaken by someone else's is
// reported rather than forced, and nothing is written outside the copy.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commitAndPush, findCommit, freshCopy, type Remote } from './git.ts'

const dirs: string[] = []
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `eidp-git-${name}-`))
  dirs.push(dir)
  return dir
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
const who = { name: 'e-IDP', email: 'e-idp@noreply.local' }

function origin(): Remote {
  const bare = temp('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'trunk')
  const seed = temp('seed')
  git(seed, 'init', '-q', '-b', 'trunk')
  writeFileSync(join(seed, 'README'), 'inventories\n')
  git(seed, 'add', '.')
  git(seed, '-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'seed')
  git(seed, 'push', '-q', bare, 'trunk')
  return { url: `file://${bare}`, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
}

/** Someone else pushing a file to the remote. */
function pushElsewhere(remote: Remote, file: string) {
  const other = temp('other')
  git(other, 'clone', '-q', remote.url, '.')
  writeFileSync(join(other, file), 'theirs\n')
  git(other, 'add', '.')
  git(other, '-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '-q', '-m', 'theirs')
  git(other, 'push', '-q', 'origin', 'HEAD')
}

test('the default branch is found, a write is pushed, and its marker found again', async () => {
  const remote = origin()
  const copy = join(temp('copy'), 'inventories')
  const { branch } = await freshCopy(remote, copy)
  assert.equal(branch, 'trunk')
  const pushed = await commitAndPush(remote, copy, branch, [{ path: 'Sys/group_vars/app/cicd.yml', content: 'a: 1\n' }], 'Add app\n\ne-IDP-Request: r-1\n', who)
  assert.ok(pushed.pushed)
  await freshCopy(remote, copy)
  assert.equal(await findCommit(copy, 'e-IDP-Request: r-1'), pushed.pushed && pushed.commit)
  assert.equal(await findCommit(copy, 'e-IDP-Request: r-2'), null)
})

test('a push overtaken by someone else’s is reported, not forced; a fresh copy then has theirs', async () => {
  const remote = origin()
  const copy = join(temp('copy'), 'inventories')
  const { branch } = await freshCopy(remote, copy)
  pushElsewhere(remote, 'THEIRS')
  const result = await commitAndPush(remote, copy, branch, [{ path: 'MINE', content: 'mine\n' }], 'mine', who)
  assert.deepEqual(result, { pushed: false })
  await freshCopy(remote, copy)
  assert.equal(readFileSync(join(copy, 'THEIRS'), 'utf8'), 'theirs\n')
  assert.throws(() => readFileSync(join(copy, 'MINE')), 'what the refused attempt left is gone')
})

test('a path that leaves the working copy is refused', async () => {
  const remote = origin()
  const copy = join(temp('copy'), 'inventories')
  const { branch } = await freshCopy(remote, copy)
  await assert.rejects(commitAndPush(remote, copy, branch, [{ path: '../escape', content: 'x' }], 'x', who), /outside the repository/)
})
