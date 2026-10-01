/**
 * A small stand-in for Jenkins, for tests and for running the Jenkins page
 * locally without a real server.
 *
 *   pnpm --filter @eidp/api jenkins:fake
 *   JENKINS_URL=http://localhost:4030/jenkins JENKINS_USER=eidp JENKINS_TOKEN=fake
 *
 * It implements only what e-IDP calls, in Jenkins' shapes: jobs nested in
 * folders and a multibranch project, builds newest first, a week of history
 * with parameters, commits and agents, pipeline stages from `wfapi`, a queue,
 * agents, and the 201 + Location a build request answers with. `tree` is
 * honoured only for the `{0,n}` range on builds — otherwise it answers with
 * everything, which is what the client asks for.
 */
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'

type Parameter = { _class: string; name: string; value?: unknown }
type Outcome = 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | null
export type FakeBuild = {
  number: number
  result: Outcome
  timestamp: number
  duration: number
  building: boolean
  builtOn: string
  parameters: Parameter[]
  cause: string
  changes: { commitId: string; msg: string; author: string }[]
  log: string
}
type Job = { kind: 'job'; name: string; pipeline: boolean; builds: FakeBuild[] }
type Folder = { kind: 'folder'; name: string; className: string; children: Node[] }
type Node = Job | Folder
type Queued = { id: number; job: string; since: number; why: string }

const FOLDER = 'com.cloudbees.hudson.plugins.folder.Folder'
const MULTIBRANCH = 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject'
const STRING = 'hudson.model.StringParameterValue'
const BOOLEAN = 'hudson.model.BooleanParameterValue'
const PASSWORD = 'hudson.model.PasswordParameterValue'
const HOUR = 3_600_000
const AGENTS = ['linux-01', 'linux-02', 'linux-03']
const PEOPLE = ['alice', 'bob', 'carol']

/**
 * A job's history, newest first. `outcome(i)` decides build i (0 = newest),
 * `params(i)` its parameters; builds are `every` hours apart, the newest
 * `ago` hours old. Deterministic, so tests can recompute what they expect.
 */
function history(
  now: number,
  count: number,
  { every, ago = 0.2, outcome, params = () => [] }: { every: number; ago?: number; outcome: (i: number) => Outcome; params?: (i: number) => Parameter[] },
): FakeBuild[] {
  return Array.from({ length: count }, (_, i) => {
    const result = outcome(i)
    const failed = result === 'FAILURE'
    const who = PEOPLE[i % PEOPLE.length]!
    return {
      number: count - i,
      result,
      timestamp: now - (ago + i * every) * HOUR,
      duration: result === null ? 0 : 60_000 + ((i * 37) % 11) * 15_000,
      building: result === null,
      builtOn: AGENTS[i % AGENTS.length]!,
      parameters: params(i),
      cause: i % 4 === 0 ? 'Started by an SCM change' : `Started by user ${who}`,
      changes: i % 4 === 0 ? [{ commitId: `c0ffee${String(count - i).padStart(2, '0')}`, msg: `Fix scoring for build ${count - i}`, author: who }] : [],
      log: [
        `Started by user ${who}`,
        `Running on ${AGENTS[i % AGENTS.length]} in /var/jenkins/workspace`,
        '[Pipeline] Start of Pipeline',
        '[Pipeline] { (Checkout)',
        '+ git checkout main',
        // Secrets as real logs leak them — for the build explainer to redact.
        '+ git fetch https://deploy:s3cr3t-pass@git.example.com/payments/loan.git',
        '+ curl -sf -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXBsb3kifQ.c2lnbmF0dXJl" https://nexus.example.com/api/v1/status',
        '+ export DB_PASSWORD=hunter2',
        '[Pipeline] }',
        '[Pipeline] { (Build)',
        ...Array.from({ length: 40 }, (_, n) => `[INFO] Compiling module ${n + 1} of 40`),
        'WARNING: deprecated API used in ScoreCalculator.java',
        '[Pipeline] }',
        '[Pipeline] { (Test)',
        failed ? 'Tests run: 42, Failures: 3, Errors: 0' : 'Tests run: 42, Failures: 0, Errors: 0',
        ...(failed ? ['[ERROR] ScoreCalculatorTest.rejectsNegativeIncome: expected <false> but was <true>', 'ERROR: script returned exit code 1'] : []),
        '[Pipeline] }',
        '[Pipeline] End of Pipeline',
        `Finished: ${result ?? 'running'}`,
        '',
      ].join('\n'),
    }
  })
}

/**
 * How the fake authorizes, for My pipelines: no per-team rules, the
 * role-strategy plugin, or matrix grants in folders' and jobs' config.xml.
 * Both rule sets say the same thing — Payments reads loan-scoring-api and
 * payments-web, DEVOPS all of payments, dave (by name) agriland-api, and
 * everyone inventories-lint — so tests can expect one answer from either.
 */
export type FakeAccess = 'none' | 'role-strategy' | 'matrix'

const READ = 'hudson.model.Item.Read'
const ROLES: Record<string, { pattern: string; read: boolean; sids: { type: 'USER' | 'GROUP'; sid: string }[] }> = {
  'payments-devs': { pattern: 'payments/(loan-scoring-api|payments-web)', read: true, sids: [{ type: 'GROUP', sid: 'Payments' }] },
  'payments-ops': { pattern: 'payments/.*', read: true, sids: [{ type: 'GROUP', sid: 'DEVOPS' }] },
  'agri-dave': { pattern: 'agriland-api/.*', read: true, sids: [{ type: 'USER', sid: 'dave' }] },
  'everyone-lint': { pattern: 'inventories-lint', read: true, sids: [{ type: 'GROUP', sid: 'authenticated' }] },
  // Build without Read: not a grant to see.
  builders: { pattern: '.*', read: false, sids: [{ type: 'GROUP', sid: 'Payments' }] },
}

/** Each matrix-auth spelling once, so the parser is tested on all three. */
const MATRIX: Record<string, string> = {
  payments: `<com.cloudbees.hudson.plugins.folder.properties.AuthorizationMatrixProperty>
      <inheritanceStrategy class="org.jenkinsci.plugins.matrixauth.inheritance.InheritParentStrategy"/>
      <permission>GROUP:${READ}:Payments</permission>
      <permission>GROUP:${READ}:DEVOPS</permission>
      <permission>GROUP:hudson.model.Item.Build:Payments</permission>
    </com.cloudbees.hudson.plugins.folder.properties.AuthorizationMatrixProperty>`,
  'payments/deploy-prod': `<hudson.security.AuthorizationMatrixProperty>
      <inheritanceStrategy class="org.jenkinsci.plugins.matrixauth.inheritance.NonInheritingStrategy"/>
      <permission>GROUP:${READ}:DEVOPS</permission>
    </hudson.security.AuthorizationMatrixProperty>`,
  'agriland-api': `<com.cloudbees.hudson.plugins.folder.properties.AuthorizationMatrixProperty>
      <entry><user><name>dave</name><permission>${READ}</permission></user></entry>
    </com.cloudbees.hudson.plugins.folder.properties.AuthorizationMatrixProperty>`,
  'inventories-lint': `<hudson.security.AuthorizationMatrixProperty>
      <permission>${READ}:authenticated</permission>
    </hudson.security.AuthorizationMatrixProperty>`,
}

export function createFakeJenkins({ now = Date.now() } = {}) {
  const base = '/jenkins'
  let nextQueueId = 500
  let access: FakeAccess = 'none'
  /** config.xml reads, for tests to see what was asked. */
  const configReads: string[] = []

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
          // Broken for its last three builds, after a week of mostly passing.
          {
            kind: 'job',
            name: 'loan-scoring-api',
            pipeline: true,
            builds: history(now, 40, {
              every: 4,
              outcome: (i) => (i < 3 || i % 9 === 5 ? 'FAILURE' : 'SUCCESS'),
              params: (i) => [
                { _class: STRING, name: 'BRANCH', value: i % 3 === 0 ? 'release/2.3' : 'main' },
                { _class: STRING, name: 'ENV', value: i % 2 === 0 ? 'staging' : 'dev' },
                { _class: BOOLEAN, name: 'SKIP_TESTS', value: false },
              ],
            }),
          },
          { kind: 'job', name: 'payments-web', pipeline: true, builds: history(now, 10, { every: 12, ago: 0.5, outcome: (i) => (i === 6 ? 'UNSTABLE' : 'SUCCESS') }) },
          // Broken, and holding a password parameter: cannot be re-run from here.
          {
            kind: 'job',
            name: 'deploy-prod',
            pipeline: false,
            builds: history(now, 5, {
              every: 24,
              ago: 0.3,
              outcome: (i) => (i === 0 ? 'FAILURE' : 'SUCCESS'),
              params: (i) => [
                { _class: STRING, name: 'VERSION', value: `1.4.${5 - i}` },
                { _class: STRING, name: 'API_TOKEN', value: 'tok-123' },
                { _class: PASSWORD, name: 'DB_PASSWORD' },
              ],
            }),
          },
        ],
      },
      {
        kind: 'folder',
        name: 'agriland-api',
        className: MULTIBRANCH,
        children: [
          { kind: 'job', name: 'main', pipeline: true, builds: history(now, 20, { every: 8, ago: 0.7, outcome: (i) => (i === 0 ? 'UNSTABLE' : 'SUCCESS') }) },
          { kind: 'job', name: 'feature%2Fscoring', pipeline: true, builds: history(now, 3, { every: 20, ago: 0.8, outcome: () => 'SUCCESS' }) },
        ],
      },
      // Running now; every so often aborted.
      {
        kind: 'job',
        name: 'inventories-lint',
        pipeline: true,
        builds: history(now, 50, { every: 2, ago: 0.05, outcome: (i) => (i === 0 ? null : i % 13 === 0 ? 'ABORTED' : 'SUCCESS') }),
      },
      // Last built two months ago: older than any window, and than retention.
      { kind: 'job', name: 'legacy-batch', pipeline: false, builds: history(now, 3, { every: 24, ago: 24 * 60, outcome: () => 'SUCCESS' }) },
      { kind: 'job', name: 'never-built', pipeline: false, builds: [] },
    ],
  }

  const queue: Queued[] = [{ id: 499, job: 'payments/payments-web', since: now - 3 * 60_000, why: 'Waiting for next available executor' }]
  const agents = [
    { displayName: 'Built-In Node', offline: false, temporarilyOffline: false, offlineCauseReason: '', numExecutors: 2, busy: 1 },
    { displayName: 'linux-02', offline: true, temporarilyOffline: true, offlineCauseReason: 'Disk full, taken offline by carol', numExecutors: 4, busy: 0 },
  ]

  /** What e-IDP did, for tests to inspect. */
  const triggered: { job: string; parameters: Record<string, string> }[] = []
  const stopped: string[] = []
  /** Job-level build reads, by job — to check the sync reads only what changed. */
  const reads: string[] = []

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

  /** Every job, flattened, with its full name. */
  function jobs(): { fullName: string; job: Job }[] {
    const found: { fullName: string; job: Job }[] = []
    const walk = (node: Node, parents: string[]) => {
      const names = node.name ? [...parents, node.name] : parents
      if (node.kind === 'folder') node.children.forEach((child) => walk(child, names))
      else found.push({ fullName: names.join('/'), job: node })
    }
    walk(root, [])
    return found
  }

  /** Adds a build to a job, as Jenkins would when one starts. */
  function addBuild(fullName: string, build: Partial<FakeBuild> & { result: Outcome }) {
    const job = find(fullName.split('/')) as Job
    const number = (job.builds[0]?.number ?? 0) + 1
    job.builds.unshift({ ...history(Date.now(), 1, { every: 1, ago: 0, outcome: () => build.result })[0]!, ...build, number })
  }

  const urlOf = (names: string[]) => `http://jenkins.example.com${base}/${names.map((n) => `job/${encodeURIComponent(n)}/`).join('')}`

  function serialise(node: Node, parents: string[]): Record<string, unknown> {
    const names = [...parents, node.name]
    const common = { name: node.name, fullName: names.join('/'), url: urlOf(names) }
    if (node.kind === 'folder') {
      return { _class: node.className, ...common, jobs: node.children.map((child) => serialise(child, names)) }
    }
    return {
      _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
      ...common,
      buildable: true,
      inQueue: queue.some((q) => q.job === names.join('/')),
      lastBuild: node.builds[0] ? { number: node.builds[0].number } : null,
    }
  }

  function buildJson(names: string[], b: FakeBuild) {
    return {
      _class: 'org.jenkinsci.plugins.workflow.job.WorkflowRun',
      number: b.number,
      result: b.result,
      timestamp: b.timestamp,
      duration: b.duration,
      building: b.building,
      builtOn: b.builtOn,
      url: `${urlOf(names)}${b.number}/`,
      actions: [
        { _class: 'hudson.model.CauseAction', causes: [{ shortDescription: b.cause }] },
        // Jenkins leaves null holes in actions, and password values out entirely.
        null,
        ...(b.parameters.length ? [{ _class: 'hudson.model.ParametersAction', parameters: b.parameters }] : []),
      ],
      changeSets: [{ items: b.changes.map((c) => ({ commitId: c.commitId, msg: c.msg, author: { fullName: c.author } })) }],
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

  // The role-strategy plugin's REST API; a 404 when it is not installed.
  app.get('/role-strategy/strategy/getAllRoles', (c) => {
    if (access !== 'role-strategy') return c.html('<html>Not found</html>', 404)
    return c.json(Object.fromEntries(Object.entries(ROLES).map(([name, role]) => [name, role.sids])))
  })
  app.get('/role-strategy/strategy/getRole', (c) => {
    const role = access === 'role-strategy' ? ROLES[c.req.query('roleName') ?? ''] : undefined
    if (!role) return c.html('<html>Not found</html>', 404)
    return c.json({ permissionIds: { [role.read ? READ : 'hudson.model.Item.Build']: true }, pattern: role.pattern, sids: role.sids })
  })

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
    // Any item's configuration, folders included — where matrix grants live.
    if (node && rest.join('/') === 'config.xml') {
      configReads.push(names.join('/'))
      const property = access === 'matrix' ? (MATRIX[names.join('/')] ?? '') : ''
      return c.body(`<?xml version='1.1' encoding='UTF-8'?>\n<item>\n  <properties>\n    ${property}\n  </properties>\n</item>\n`, 200, { 'content-type': 'application/xml' })
    }
    if (!node || node.kind !== 'job') return c.html('<html>Not found</html>', 404)
    const job = node
    const fullName = names.join('/')

    // The job itself: its builds, `{0,n}` honoured.
    if (rest.join('/') === 'api/json') {
      reads.push(fullName)
      const range = /\{0,(\d+)\}/.exec(c.req.query('tree') ?? '')
      const builds = range ? job.builds.slice(0, Number(range[1])) : job.builds
      return c.json({ builds: builds.map((b) => buildJson(names, b)) })
    }

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
    if (what === 'api/json') return c.json(buildJson(names, build))
    // Stage View, for pipelines only — a freestyle job has none, and a server
    // without the plugin 404s the same way.
    if (what === 'wfapi/describe' && job.pipeline) {
      const failedAt = build.result === 'FAILURE' ? 'Test' : null
      let reached = true
      return c.json({
        stages: ['Checkout', 'Build', 'Test', 'Deploy'].map((name, n) => {
          const status = !reached ? 'NOT_EXECUTED' : name === failedAt ? 'FAILED' : build.building && n === 2 ? 'IN_PROGRESS' : 'SUCCESS'
          if (status !== 'SUCCESS') reached = false
          return { name, status, startTimeMillis: build.timestamp + n * 15_000, durationMillis: status === 'NOT_EXECUTED' ? 0 : 15_000 }
        }),
      })
    }
    return c.html('<html>Not found</html>', 404)
  })

  return {
    app,
    root,
    queue,
    agents,
    triggered,
    stopped,
    reads,
    configReads,
    find,
    jobs,
    addBuild,
    setAccess: (next: FakeAccess) => {
      access = next
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_JENKINS_PORT ?? 4030)
  const fake = createFakeJenkins()
  // FAKE_JENKINS_ACCESS=role-strategy or matrix for per-team rules.
  fake.setAccess((process.env.FAKE_JENKINS_ACCESS as FakeAccess | undefined) ?? 'none')
  serve({ fetch: fake.app.fetch, port })
  console.log(`fake Jenkins on http://localhost:${port}/jenkins (access rules: ${process.env.FAKE_JENKINS_ACCESS ?? 'none'})`)
  console.log(`  JENKINS_URL=http://localhost:${port}/jenkins JENKINS_USER=eidp JENKINS_TOKEN=fake`)
}
