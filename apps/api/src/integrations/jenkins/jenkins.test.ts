import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiUrl, fullNameFromUrl, jenkinsConfig, jobPath } from './client.ts'

test('a job in folders nests as repeated job/ segments', () => {
  assert.equal(jobPath('payments/loan-scoring-api'), 'job/payments/job/loan-scoring-api')
})

test('a multibranch branch keeps its encoded slash, encoded once more in the path', () => {
  // Jenkins names the branch feature/x as "feature%2Fx"; its URL is feature%252Fx.
  assert.equal(jobPath('agriland-api/feature%2Fx'), 'job/agriland-api/job/feature%252Fx')
  assert.equal(fullNameFromUrl('https://ci/job/agriland-api/job/feature%252Fx/'), 'agriland-api/feature%2Fx')
})

test('a URL outside any job has no job name', () => {
  assert.equal(fullNameFromUrl('https://ci/computer/linux-02/'), null)
})

test('the tree query is encoded, not left raw', () => {
  const url = apiUrl('https://ci.example.com', 'api/json', { tree: 'jobs[name,builds[number]{0,10}]' })
  assert.ok(url.startsWith('https://ci.example.com/api/json?tree=jobs%5Bname'), url)
})

test('missing settings are named', () => {
  if (process.env.JENKINS_URL) return
  assert.throws(jenkinsConfig, /JENKINS_URL, JENKINS_USER and JENKINS_TOKEN are not set/)
})

test('a log names the agents it ran on, Jenkins’ own node as built-in', async () => {
  const { agentsInLog } = await import('./index.ts')
  const log = 'Started by user bob\nRunning on linux-02 in /var/jenkins/workspace/x\n[Pipeline] {\nRunning on Jenkins in /var/jenkins_home/workspace/x\nRunning on linux-02 in /tmp/y\n'
  assert.deepEqual(agentsInLog(log), ['linux-02', 'built-in'])
  assert.deepEqual(agentsInLog('Building in workspace /var/x\n'), [])
})

test('a console note on the agent’s name is not part of the name', async () => {
  const { agentsInLog, stripNotes } = await import('./index.ts')
  // As a real Jenkins writes it: the note links the name, inside the line.
  const note = '\x1b[8mha:////4LHZjdXBWyMtpg/9Z+p6P2xuWoE2i6y8iqqhl5UwObq/AAAAnx+LCAAAAAAAAP9b85aBtbiI==\x1b[0m'
  assert.deepEqual(agentsInLog(`Running on ${note}devops08 in /home/jenkins/workspace/app\n`), ['devops08'])
  assert.equal(stripNotes(`${note}[Pipeline] Start of Pipeline\n\x1b[31mred\x1b[0m`), '[Pipeline] Start of Pipeline\n\x1b[31mred\x1b[0m')
})
