/**
 * A small stand-in for Jenkins, for tests and for running the Jenkins page
 * locally without a real server.
 *
 *   pnpm --filter @eidp/api jenkins:fake
 *   JENKINS_URL=http://localhost:4030/jenkins JENKINS_USER=eidp JENKINS_TOKEN=fake
 *
 * It implements only what e-IDP calls, in Jenkins' shapes: jobs nested in
 * folders and a multibranch project, builds newest first, a queue, agents,
 * and the 201 + Location a build request answers with. `tree` is ignored —
 * it always answers with everything, which is what the client asks for.
 */
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'

type Parameter = { _class: string; name: string; value?: unknown }
type Build = {
  number: number
  result: 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | null
  timestamp: number
  duration: number
  building: boolean
  parameters: Parameter[]
  cause: string
  log: string
}
type Job = { kind: 'job'; name: string; builds: Build[] }
type Folder = { kind: 'folder'; name: string; className: string; children: Node[] }
type Node = Job | Folder
type Queued = { id: number; job: string; since: number; why: string }

const FOLDER = 'com.cloudbees.hudson.plugins.folder.Folder'
const MULTIBRANCH = 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject'
const PIPELINE = 'org.jenkinsci.plugins.workflow.job.WorkflowJob'
const STRING = 'hudson.model.StringParameterValue'
const PASSWORD = 'hudson.model.PasswordParameterValue'

export function createFakeJenkins() {
  const base = '/jenkins'
  let nextQueueId = 500
  const now = Date.now()
  const minutes = (n: number) => now - n * 60_000

  function history(results: Build['result'][], params: Parameter[] = [], startMinutesAgo = 10): Build[] {
    // Newest first, like Jenkins; the first entry is the latest build.
    return results.map((result, index) => ({
      number: results.length - index,
      result,
      timestamp: minutes(startMinutesAgo + index * 60),
      duration: result === null ? 0 : 90_000 + index * 1000,
      building: result === null,
      parameters: params,
      cause: 'Started by user alice',
      log:
        result === 'FAILURE'
          ? `Started by user alice\n[Pipeline] stage (Test)\n${'noise line\n'.repeat(50)}Tests run: 42, Failures: 3\nERROR: script returned exit code 1\nFinished: FAILURE\n`
          : `Started by user alice\n[Pipeline] stage (Build)\nFinished: ${result ?? 'running'}\n`,
    }))
  }

  const root: Folder = {
    kind: 'folder',
    name: '',
    className: 'hudson.model.Hudson',
    children: [
      {
        kind: 'folder',
        name: 'payments',
        className: FOLDER,
        children: [
          // Failing three builds in a row, after a pass, with a plain parameter.
          {
            kind: 'job',
            name: 'loan-scoring-api',
            builds: history(['FAILURE', 'FAILURE', 'FAILURE', 'SUCCESS'], [{ _class: STRING, name: 'BRANCH', value: 'main' }]),
          },
          { kind: 'job', name: 'payments-web', builds: history(['SUCCESS', 'SUCCESS'], [], 30) },
          // Fails, but a password parameter means it cannot be re-run from here.
          {
            kind: 'job',
            name: 'deploy-prod',
            builds: history(
              ['FAILURE', 'SUCCESS'],
              [
                { _class: STRING, name: 'VERSION', value: '1.4.2' },
                { _class: STRING, name: 'API_TOKEN', value: 'tok-123' },
                { _class: PASSWORD, name: 'DB_PASSWORD' },
              ],
              20,
            ),
          },
        ],
      },
      {
        kind: 'folder',
        name: 'agriland-api',
        className: MULTIBRANCH,
        children: [
          { kind: 'job', name: 'main', builds: history(['UNSTABLE', 'SUCCESS'], [], 40) },
          { kind: 'job', name: 'feature%2Fscoring', builds: history(['SUCCESS'], [], 50) },
        ],
      },
      // Running now, with an earlier pass.
      { kind: 'job', name: 'inventories-lint', builds: history([null, 'SUCCESS'], [], 1) },
      { kind: 'job', name: 'never-built', builds: [] },
    ],
  }

  const queue: Queued[] = [{ id: 499, job: 'payments/payments-web', since: minutes(3), why: 'Waiting for next available executor' }]
  const agents = [
    { displayName: 'Built-In Node', offline: false, temporarilyOffline: false, offlineCauseReason: '', numExecutors: 2, busy: 1 },
    { displayName: 'linux-02', offline: true, temporarilyOffline: true, offlineCauseReason: 'Disk full, taken offline by carol', numExecutors: 4, busy: 0 },
  ]

  /** Every triggered build, for tests to inspect: job, parameters. */
  const triggered: { job: string; parameters: Record<string, string> }[] = []
  const stopped: string[] = []

  function find(names: string[]): Node | null {
    let node: Node = root
    for (const name of names) {
      if (node.kind !== 'folder') return null
      const next: Node | undefined = node.children.find((child) => child.name === name)
      if (!next) return null
      node = next
    }
    return node
  }

  function urlOf(names: string[]): string {
    return `http://jenkins.example.com${base}/${names.map((n) => `job/${encodeURIComponent(n)}/`).join('')}`
  }

  function serialise(node: Node, parents: string[]): Record<string, unknown> {
    const names = [...parents, node.name]
    const common = { name: node.name, fullName: names.join('/'), url: urlOf(names) }
    if (node.kind === 'folder') {
      return { _class: node.className, ...common, jobs: node.children.map((child) => serialise(child, names)) }
    }
    return {
      _class: PIPELINE,
      ...common,
      buildable: true,
      inQueue: queue.some((q) => q.job === names.join('/')),
      builds: node.builds.map((b) => buildJson(names, b)),
    }
  }

  function buildJson(names: string[], b: Build) {
    return {
      _class: 'org.jenkinsci.plugins.workflow.job.WorkflowRun',
      number: b.number,
      result: b.result,
      timestamp: b.timestamp,
      duration: b.duration,
      building: b.building,
      url: `${urlOf(names)}${b.number}/`,
    }
  }

  const app = new Hono().basePath(base)

  app.use('*', async (c, next) => {
    if (!c.req.header('authorization')?.startsWith('Basic ')) {
      c.header('X-You-Are-Authenticated-As', 'anonymous')
      return c.html('<html>Authentication required</html>', 403)
    }
    await next()
  })

  app.get('/api/json', (c) => c.json({ _class: 'hudson.model.Hudson', jobs: root.children.map((child) => serialise(child, [])) }))

  app.get('/queue/api/json', (c) =>
    c.json({
      items: queue.map((q) => ({
        id: q.id,
        inQueueSince: q.since,
        why: q.why,
        stuck: false,
        blocked: false,
        task: { name: q.job.split('/').pop(), url: urlOf(q.job.split('/')) },
      })),
    }),
  )

  app.post('/queue/cancelItem', (c) => {
    const index = queue.findIndex((q) => q.id === Number(c.req.query('id')))
    if (index >= 0) queue.splice(index, 1)
    // Jenkins redirects back to the queue page.
    return c.redirect(`${base}/`, 302)
  })

  app.get('/computer/api/json', (c) =>
    c.json({
      computer: agents.map(({ busy, ...agent }) => ({
        ...agent,
        executors: Array.from({ length: agent.numExecutors }, (_, i) => ({ idle: i >= busy })),
      })),
    }),
  )

  // Everything under /job/…: the job path first, then what is asked of it.
  app.all('/job/*', async (c: Context) => {
    const segments = c.req.path.slice(base.length + 1).split('/').filter(Boolean)
    const names: string[] = []
    let i = 0
    while (segments[i] === 'job' && segments[i + 1] !== undefined) {
      names.push(decodeURIComponent(segments[i + 1]!))
      i += 2
    }
    const rest = segments.slice(i)
    const node = find(names)
    if (!node || node.kind !== 'job') return c.html('<html>Not found</html>', 404)
    const job = node
    const fullName = names.join('/')

    if (c.req.method === 'POST' && (rest[0] === 'build' || rest[0] === 'buildWithParameters')) {
      const form = rest[0] === 'buildWithParameters' ? Object.fromEntries(new URLSearchParams(await c.req.text())) : {}
      triggered.push({ job: fullName, parameters: form as Record<string, string> })
      const id = nextQueueId++
      queue.push({ id, job: fullName, since: Date.now(), why: 'Waiting for next available executor' })
      c.header('Location', `http://jenkins.example.com${base}/queue/item/${id}/`)
      return c.body(null, 201)
    }

    const build = job.builds.find((b) => b.number === Number(rest[0]))
    if (!build) return c.html('<html>Not found</html>', 404)
    const what = rest.slice(1).join('/')

    if (c.req.method === 'POST' && what === 'stop') {
      stopped.push(`${fullName}#${build.number}`)
      if (build.building) Object.assign(build, { building: false, result: 'ABORTED' })
      return c.redirect(urlOf(names), 302)
    }
    if (what === 'consoleText') return c.text(build.log)
    if (what === 'api/json') {
      return c.json({
        ...buildJson(names, build),
        actions: [
          { _class: 'hudson.model.CauseAction', causes: [{ shortDescription: build.cause }] },
          // Jenkins leaves null holes in actions, and password values out entirely.
          null,
          ...(build.parameters.length ? [{ _class: 'hudson.model.ParametersAction', parameters: build.parameters }] : []),
        ],
      })
    }
    return c.html('<html>Not found</html>', 404)
  })

  return { app, root, queue, agents, triggered, stopped, find }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_JENKINS_PORT ?? 4030)
  serve({ fetch: createFakeJenkins().app.fetch, port })
  console.log(`fake Jenkins on http://localhost:${port}/jenkins`)
  console.log(`  JENKINS_URL=http://localhost:${port}/jenkins JENKINS_USER=eidp JENKINS_TOKEN=fake`)
}
