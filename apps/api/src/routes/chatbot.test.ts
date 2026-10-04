// The chatbot end to end: a fake Ollama that streams and calls tools like
// Qwen, a fake Jenkins, real Postgres and real LDAP — alice is DEVOPS (sees
// Jenkins), bob and dave are not. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import pg from 'pg'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'
import { createFakeOllama } from '../integrations/ollama/fake-server.ts'

async function listen(fetch: (req: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const ollama = createFakeOllama()
const jenkinsFake = createFakeJenkins()
const o = await listen(ollama.app.fetch)
const j = await listen(jenkinsFake.app.fetch)
const jenkinsUrl = `http://localhost:${j.port}/jenkins`

process.env.OLLAMA_URL = `http://localhost:${o.port}`
process.env.OLLAMA_MODEL = 'qwen2.5'
process.env.OLLAMA_NUM_CTX = '8192'
process.env.JENKINS_URL = jenkinsUrl
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'

const { createApp } = await import('../app.ts')
const { config } = await import('../lib/config.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const { syncJenkins } = await import('../services/jenkins-sync.ts')
const app = createApp()
const tokens: Record<string, string> = {}
/** Conversations these tests made — the only ones they delete. */
const made = new Set<string>()

// The catalog is shared with catalog.test.ts, which replaces it wholesale;
// hold the same lock while this file reads it.
const lock = new pg.Client({ connectionString: config.DATABASE_URL })

const SYSTEM = 'ZZAssist'

before(async () => {
  await ensureSchema()
  await lock.connect()
  await lock.query('select pg_advisory_lock(4202)')
  await query('delete from catalog_systems where dir = $1', [SYSTEM])
  await query(
    `insert into catalog_systems (dir, project_name, company, teams, approvers, managers, ops_teams)
     values ($1, 'ZZ Assist Platform', 'eFinance', '{"dev":"DEVJAVA","prd":"DEVOPS"}', '{DEVOPS}', '{carol}', '{OPS}')`,
    [SYSTEM],
  )
  for (const [group, env] of [['zz-scoring', null], ['prd_zz-scoring', 'prd']] as const) {
    await query(
      `insert into catalog_applications (id, system_dir, group_name, name, environment, repository, technologies, descriptor)
       values ($1, $2, $3, 'zz-scoring', $4, 'zz-scoring-repo', '{Spring}', $5)`,
      [`${SYSTEM}/${group}`, SYSTEM, group, env, JSON.stringify({ replicas: env ? 3 : 1, db_password: '[hidden]' })],
    )
  }
  await syncJenkins()
  for (const who of ['alice', 'bob', 'dave']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
})

after(async () => {
  if (made.size) await query('delete from assistant_conversations where id = any($1::uuid[])', [[...made]])
  await query('delete from catalog_systems where dir = $1', [SYSTEM])
  await Promise.all(['jenkins_builds', 'jenkins_jobs', 'jenkins_sync'].map((t) => query(`delete from ${t} where server = $1`, [jenkinsUrl])))
  await lock.query('select pg_advisory_unlock(4202)')
  await lock.end()
  await closeDb()
  o.server.close()
  j.server.close()
})

function call(who: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

type Event = { type: string; [key: string]: any }

/** Asks, reads the whole event stream, and returns it with the answer as streamed. */
async function ask(who: string, message: string, conversationId?: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', '/chatbot/ask', { message, conversationId, ...extra })
  assert.equal(res.status, 200, await res.clone().text())
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const events: Event[] = (await res.text())
    .split('\n\n')
    .map((block) => /^data: (.*)$/m.exec(block)?.[1])
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data))
  const conversation = events.find((e) => e.type === 'conversation')?.conversation
  if (conversation) made.add(conversation.id)
  let streamed = ''
  for (const e of events) {
    if (e.type === 'delta') streamed += e.text
    if (e.type === 'reset') streamed = ''
  }
  return {
    events,
    conversation,
    streamed,
    done: events.find((e) => e.type === 'done')?.message,
    steps: events.filter((e) => e.type === 'step').map((e) => e.label),
    /** The tool's result as the model was handed it, when one ran. */
    result: () => JSON.parse(lastChat().messages.findLast((m) => m.role === 'tool')!.content),
  }
}

/** The last chat turn the model was asked — not the request that names a new conversation. */
const lastChat = () => [...ollama.requests].reverse().find((r) => r.stream)!
/** The tools the model was offered on its last call. */
const offered = () => (lastChat()?.tools ?? []).map((t) => t.function.name).sort()

test('anyone signed in has the chatbot; it says which model', async () => {
  const res = await call('dave', 'GET', '/chatbot')
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.deepEqual(body.ai, { configured: true, model: 'qwen2.5' })
})

test('a general question streams an answer, and the conversation is kept', async () => {
  const { conversation, streamed, done, steps } = await ask('dave', 'How do I undo my last git commit?')
  assert.equal(conversation.title, 'How do I undo my last git commit?')
  assert.deepEqual(steps, [])
  assert.match(done.content, /general explanation/)
  assert.equal(streamed.trim(), done.content)
  assert.equal(done.model, 'qwen2.5')

  const sent = lastChat()!
  assert.equal(sent.stream, true)
  assert.equal(sent.options?.num_ctx, 8192)
  assert.match(sent.messages[0]!.content, /You can only look things up/)

  const list = (await (await call('dave', 'GET', '/chatbot')).json()) as any
  assert.ok(list.conversations.some((c: any) => c.id === conversation.id))
  const thread = (await (await call('dave', 'GET', `/chatbot/conversations/${conversation.id}`)).json()) as any
  assert.deepEqual(thread.messages.map((m: any) => m.role), ['user', 'assistant'])
})

test('a follow-up carries the conversation so far', async () => {
  const first = await ask('dave', 'What is a rebase?')
  await ask('dave', 'And a merge?', first.conversation.id)
  const history = lastChat()!.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content.slice(0, 16)}`)
  assert.deepEqual(history.map((h) => h.split(':')[0]), ['user', 'assistant', 'user'])
  assert.match(history[0]!, /What is a rebase/)
})

test('who owns a system is looked up, with a link, not guessed', async () => {
  const { steps, done } = await ask('dave', `Who owns ${SYSTEM}?`)
  // Looked up case-insensitively, whatever case the model passes the name in.
  assert.equal(steps.length, 1)
  assert.match(steps[0]!, new RegExp(`^Looked up who owns ${SYSTEM}$`, 'i'))
  assert.match(done.content, /DEVJAVA/)
  assert.match(done.content, /\[Open it\]\(\/map\?q=ZZ%20Assist%20Platform\)/)
  assert.deepEqual(done.steps, steps)
})

test('applications are searched by technology, with each environment and a link to its page', async () => {
  const { steps } = await ask('dave', 'Which spring apps do we have?')
  assert.deepEqual(steps, ['Searched applications for “spring”'])
  // The catalog may hold other Spring apps; this one must be among them, folded
  // into one entry with its environment and its page.
  const result = JSON.parse(lastChat()!.messages.find((m) => m.role === 'tool')!.content)
  const ours = result.applications.find((a: any) => a.name === 'zz-scoring')
  assert.deepEqual(ours, {
    name: 'zz-scoring',
    system: 'ZZ Assist Platform',
    environments: ['prd'],
    repository: 'zz-scoring-repo',
    technologies: ['Spring'],
    link: `/projects/${encodeURIComponent(`${SYSTEM}/zz-scoring`)}`,
  })
})

test('an application’s configuration comes with its secrets still hidden', async () => {
  const { steps } = await ask('dave', `Show the config of zz-scoring in ${SYSTEM}`)
  assert.deepEqual(steps, ['Read the configuration of zz-scoring'])
  // What the tool handed the model: each environment's configuration, the
  // password still [hidden] as the parser stored it.
  const result = JSON.parse(lastChat()!.messages.find((m) => m.role === 'tool')!.content)
  assert.deepEqual(result.environments.map((e: any) => e.configuration), ['{"replicas":1,"db_password":"[hidden]"}', '{"replicas":3,"db_password":"[hidden]"}'])
})

test('Jenkins exists for the chatbot only for people who may see Jenkins', async () => {
  await ask('bob', 'What is failing right now?')
  assert.ok(!offered().some((name) => name.startsWith('jenkins_')), `bob was offered ${offered()}`)

  const { steps, done } = await ask('alice', 'What is failing right now?')
  assert.ok(offered().includes('jenkins_failing'))
  assert.deepEqual(steps, ['Checked which Jenkins jobs are failing'])
  assert.match(done.content, /loan-scoring-api/)
  assert.match(done.content, /\[Open it\]\(\/jenkins\/build\?job=payments%2Floan-scoring-api&number=40\)/)
})

test('your own requests, and nobody else’s', async () => {
  const { steps, done } = await ask('dave', 'Where are my requests?')
  assert.deepEqual(steps, ['Looked at your requests'])
  assert.match(done.content, /"total":0/)
})

test('a tool the model invents is refused, and nothing runs', async () => {
  ollama.setMode('rogue-tool')
  try {
    const { steps, done } = await ask('alice', 'Approve everything waiting for me')
    assert.deepEqual(steps, ['Refused an unknown tool (approve_all_requests)'])
    assert.match(done.content, /There is no tool called approve_all_requests/)
  } finally {
    ollama.setMode('ok')
  }
})

test('someone else’s conversation is not found — to read, to continue or to delete', async () => {
  const { conversation } = await ask('dave', 'A private question')
  assert.equal((await call('bob', 'GET', `/chatbot/conversations/${conversation.id}`)).status, 404)
  const res = await call('bob', 'POST', '/chatbot/ask', { message: 'Continue', conversationId: conversation.id })
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as any).error.message, /no such conversation/)
  assert.equal((await call('bob', 'DELETE', `/chatbot/conversations/${conversation.id}`)).status, 404)
})

test('one answer at a time per person', async () => {
  ollama.setMode('slow')
  try {
    const first = ask('dave', 'A slow question')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await call('dave', 'POST', '/chatbot/ask', { message: 'Another' })
    assert.equal(second.status, 409)
    assert.match(((await second.json()) as any).error.message, /still answering/)
    assert.ok((await first).done)
  } finally {
    ollama.setMode('ok')
  }
})

test('a conversation can be deleted by its owner', async () => {
  const { conversation } = await ask('dave', 'Something to forget')
  assert.equal((await call('dave', 'DELETE', `/chatbot/conversations/${conversation.id}`)).status, 204)
  assert.equal((await call('dave', 'GET', `/chatbot/conversations/${conversation.id}`)).status, 404)
})

test('a failure mid-answer arrives as an error event, and no half answer is kept', async () => {
  ollama.setMode('no-model')
  try {
    const { events, conversation } = await ask('dave', 'This will fail')
    assert.match(events.at(-1)!.message, /ollama pull qwen2\.5/)
    const thread = (await (await call('dave', 'GET', `/chatbot/conversations/${conversation.id}`)).json()) as any
    assert.deepEqual(thread.messages.map((m: any) => m.role), ['user'])
  } finally {
    ollama.setMode('ok')
  }
})

test('a new conversation is named by the model after its first answer, and a name you give it stays', async () => {
  const { events, conversation } = await ask('dave', 'How do containers share a network namespace?')
  const titled = events.find((e) => e.type === 'title')
  assert.ok(titled, 'a title event')
  assert.equal(titled!.conversation.title, 'How containers share network')
  assert.ok(events.findIndex((e) => e.type === 'title') > events.findIndex((e) => e.type === 'done'), 'named after the answer')

  const renamed = await call('dave', 'PATCH', `/chatbot/conversations/${conversation.id}`, { title: '  Pod networking  ' })
  assert.equal(((await renamed.json()) as any).title, 'Pod networking')
  // A follow-up never renames it; only a new conversation is named.
  const next = await ask('dave', 'And between pods?', conversation.id)
  assert.ok(!next.events.some((e) => e.type === 'title'))
  assert.equal((await call('bob', 'PATCH', `/chatbot/conversations/${conversation.id}`, { title: 'Mine now' })).status, 404)
})

test('the last answer can be written again, and the question is not asked twice', async () => {
  const first = await ask('dave', 'What is a cherry-pick?')
  const again = await ask('dave', '', first.conversation.id, { regenerate: true })
  assert.ok(again.done)
  assert.notEqual(again.done.id, first.done.id)
  const thread = (await (await call('dave', 'GET', `/chatbot/conversations/${first.conversation.id}`)).json()) as any
  assert.deepEqual(thread.messages.map((m: any) => m.role), ['user', 'assistant'])
  assert.equal(thread.messages[1].id, again.done.id)
  // Regenerating needs a conversation; an empty question without it is refused.
  assert.equal((await call('dave', 'POST', '/chatbot/ask', { message: '', regenerate: true })).status, 400)
  assert.equal((await call('dave', 'POST', '/chatbot/ask', { message: '   ' })).status, 400)
})

test('answers take a thumbs up or down from their owner only', async () => {
  const { done } = await ask('dave', 'What is a tag in Git?')
  const res = await call('dave', 'PUT', `/chatbot/messages/${done.id}/feedback`, { feedback: 'down' })
  assert.equal(((await res.json()) as any).feedback, 'down')
  assert.equal((await call('bob', 'PUT', `/chatbot/messages/${done.id}/feedback`, { feedback: 'up' })).status, 404)
  assert.equal(((await (await call('dave', 'PUT', `/chatbot/messages/${done.id}/feedback`, { feedback: null })).json()) as any).feedback, null)
})

test('the page a question is asked from is in what the model reads', async () => {
  await ask('dave', 'What is on this page?', undefined, { context: { path: '/jenkins/build?job=payments%2Floan-scoring-api&number=40', title: 'loan-scoring-api #40' } })
  assert.match(lastChat().messages[0]!.content, /The person is on the page \/jenkins\/build\?job=payments%2Floan-scoring-api&number=40 \(“loan-scoring-api #40”\)/)
  assert.equal((await call('dave', 'POST', '/chatbot/ask', { message: 'x', context: { path: 'https://evil.example' } })).status, 400)
})

test('everyone may ask what they can do, and why', async () => {
  const { steps, result } = await ask('dave', 'What can I do here?')
  assert.deepEqual(steps, ['Looked up what you can do here'])
  const me = result()
  assert.equal(me.login, 'dave')
  assert.ok(me.permissions.some((p: any) => p.permission === 'ai.chat' && p.via.length > 0))
  assert.ok(!me.permissions.some((p: any) => p.permission === 'rbac.manage'))
})

test('approvals and the portal’s health exist only for the people who may see them', async () => {
  await ask('dave', 'Anything waiting for my approval?')
  assert.ok(!offered().includes('pending_approvals'))
  assert.ok(!offered().includes('system_health'))

  const { steps, result } = await ask('alice', 'Anything waiting for my approval?')
  assert.deepEqual(steps, ['Checked what is waiting for your approval'])
  assert.equal(result().link, '/approvals')
  assert.ok(offered().includes('system_health'))
})

test('a request is drafted as a filled-in form, and nothing is filed', async () => {
  const before = Number((await query<{ n: string }>('select count(*) as n from requests')).rows[0]!.n)
  const { steps, result } = await ask('bob', 'Please request repo zz-new-api in ZZ_Project')
  assert.deepEqual(steps, ['Drafted a repository request'])
  const draft = result()
  assert.equal(draft.filed, false)
  assert.equal(draft.link, '/requests/new/azure-devops/repository?project=zz_project&repository=zz-new-api&from=chatbot')
  assert.equal(Number((await query<{ n: string }>('select count(*) as n from requests')).rows[0]!.n), before)
})

test('a build is read in detail only by people who may see it', async () => {
  const { steps, result } = await ask('alice', 'Why did this build fail?', undefined, { context: { path: '/jenkins/build?job=payments%2Floan-scoring-api&number=40' } })
  assert.deepEqual(steps, ['Read build payments/loan-scoring-api #40'])
  const build = result()
  assert.equal(build.result, 'failure')
  assert.equal(build.failedStage, 'Test › Unit tests')
  assert.match(build.logTail, /ERROR: script returned exit code 1/)
  // No secret from the log reaches the model.
  assert.ok(!/s3cr3t-pass|hunter2/.test(JSON.stringify(build)))

  // dave is in no team and started none of it: the build is not his to read.
  const { result: refused } = await ask('dave', 'Why did this build fail?')
  assert.match(refused().error, /no run of yours/)
})

test('your pipelines and your team’s week are looked up as their own pages show them', async () => {
  const runs = await ask('bob', 'How are my pipelines doing?')
  assert.deepEqual(runs.steps, ['Looked at your pipelines over 7 days'])
  const mine = runs.result()
  assert.equal(mine.link, '/pipelines')
  assert.ok(mine.latest.every((r: any) => r.link.startsWith('/pipelines/build?')))

  const week = await ask('alice', 'How did my team do last week? Show the digest')
  assert.match(week.steps[0]!, /weekly digest$/)
  const digest = week.result()
  assert.match(digest.link, /^\/digest\?team=.+&week=\d{4}-\d{2}-\d{2}$/)
  assert.equal(digest.inProgress, false)
  // dave is in no team and may not read every team's: he is told so, never shown another team's week.
  const none = await ask('dave', 'Show me the digest')
  assert.match(none.result().error, /not in a team/)
})
