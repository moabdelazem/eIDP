// The log viewer's reading of a console log, without a browser: colours,
// highlighting and the stage tree are pure functions of the text.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { css, lastFrame, palette, readAnsi } from './ansi.ts'
import { highlight, type Token } from './highlight.ts'
import { parseLog, stageTree, stripAnsi } from './parse.ts'

const E = '\x1b'
const words = (text: string, tokens: Token[]) => tokens.map((t) => [text.slice(t.start, t.end), t.type])

test('colours carry from line to line until reset, and the text keeps no codes', () => {
  const [a, b, c] = readAnsi([`${E}[31mred ${E}[1mbold`, 'still red', `${E}[0mplain`])
  assert.equal(a!.text, 'red bold')
  assert.deepEqual(a!.segments!.map((s) => [s.text, s.style.fg, s.style.bold]), [['red ', { index: 1 }, false], ['bold', { index: 1 }, true]])
  assert.deepEqual(b!.segments!.map((s) => s.style.fg), [{ index: 1 }], 'a colour runs on into the next line')
  assert.equal(c!.segments, null, 'a reset back to plain is no styling')
})

test('256 colours, true colour, and codes that are not colours', () => {
  const [line] = readAnsi([`${E}[38;5;196mA${E}[48;2;10;20;30mB${E}[2K${E}[?25lC${E}[0m`])
  assert.equal(line!.text, 'ABC')
  assert.deepEqual(line!.segments![0]!.style.fg, { rgb: [255, 0, 0] })
  assert.deepEqual(line!.segments![1]!.style.bg, { rgb: [10, 20, 30] })
  assert.deepEqual(palette(3), { index: 3 }, 'the first 16 are the themed colours')
  assert.deepEqual(palette(244), { rgb: [128, 128, 128] })
  assert.equal(css({ fg: { index: 1 }, bg: null, bold: true, dim: false, italic: false, underline: false, inverse: false })!.color, 'var(--ansi-9)', 'bold brightens the base colours')
})

test('a progress line shows its last frame, as the terminal did', () => {
  assert.equal(lastFrame('10%\r50%\r100% done'), '100% done')
  assert.equal(lastFrame('Downloading 12345\rDone'), 'Doneloading 12345', 'a shorter frame leaves the end of the longer one')
  assert.equal(lastFrame('windows line\r'), 'windows line')
  assert.equal(stripAnsi(`${E}[32mok${E}[0m\r\nnext`), 'ok\nnext')
})

test('a shell command: program, flags, strings, variables, operators', () => {
  const text = `mvn -B clean deploy -DskipTests "-Dversion=$VERSION" | tee build.log && ./gradlew --info`
  assert.deepEqual(words(text, highlight(text, 'command')), [
    ['mvn', 'program'],
    ['-B', 'flag'],
    ['-DskipTests', 'flag'],
    ['"-Dversion=$VERSION"', 'string'],
    ['|', 'operator'],
    ['tee', 'program'],
    ['&&', 'operator'],
    ['./gradlew', 'program'],
    ['--info', 'flag'],
  ])
})

test('stack frames: the method and file stand out, the package recedes', () => {
  const java = '\tat com.efinance.billing.Invoice.total(Invoice.java:42)'
  assert.deepEqual(words(java, highlight(java, 'other')), [
    ['at', 'muted'],
    ['com.efinance.billing.', 'muted'],
    ['Invoice.total', 'function'],
    ['Invoice.java', 'path'],
    ['42', 'number'],
  ])
  const dotnet = '   at Billing.Api.Startup.Run() in /src/Billing/Startup.cs:line 17'
  assert.deepEqual(words(dotnet, highlight(dotnet, 'other')).map(([, t]) => t), ['muted', 'function', 'path', 'number'])
})

test('a plain line: levels, exceptions, paths, versions, hashes and durations', () => {
  const text = '[ERROR] Failed to deploy 1.4.2 to /opt/app in 12.5 s (commit 3f9c2ab1): java.lang.IllegalStateException'
  const found = Object.fromEntries(words(text, highlight(text, 'other')).map(([w, t]) => [w, t]))
  assert.equal(found['[ERROR]'], 'error')
  assert.equal(found['1.4.2'], 'number')
  assert.equal(found['/opt/app'], 'path')
  assert.equal(found['12.5 s'], 'number')
  assert.equal(found['3f9c2ab1'], 'constant')
  assert.equal(found['java.lang.IllegalStateException'], 'function')
  const agent = 'Running on linux-01 in /var/jenkins/workspace'
  assert.deepEqual(words(agent, highlight(agent, 'other')), [['/var/jenkins/workspace', 'path']], 'a number joined to a name is the name')
  const json = '{"status": "UP", "replicas": 3, "ready": true}'
  assert.deepEqual(words(json, highlight(json, 'other')).map(([, t]) => t), ['key', 'string', 'key', 'number', 'key', 'constant'])
})

test('a coloured line keeps the tool’s colours and is not highlighted over them', () => {
  const [line] = parseLog(`${E}[1;31m[ERROR]${E}[m Tests failed: 3`)
  assert.equal(line!.text, '[ERROR] Tests failed: 3')
  assert.equal(line!.kind, 'error', 'the error rules read the text without codes')
  assert.ok(line!.segments)
  assert.deepEqual(line!.tokens, [])
})

test('the stage tree follows Jenkins’ own nesting: a parallel stage and its branches', () => {
  const log = [
    '[Pipeline] node',
    '[Pipeline] {',
    '[Pipeline] stage',
    '[Pipeline] { (Build)',
    '+ mvn package',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] stage',
    '[Pipeline] { (Tests)',
    '[Pipeline] parallel',
    '[Pipeline] { (Branch: unit)',
    'ERROR: 2 tests failed',
    '[Pipeline] }',
    '[Pipeline] { (Branch: lint)',
    'WARNING: style',
    '[Pipeline] }',
    '[Pipeline] // parallel',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] }',
    'Finished: FAILURE',
  ].join('\n')
  const lines = parseLog(log)
  const tree = stageTree(lines)
  assert.deepEqual(
    tree.map((s) => [s.name, s.line, s.end, s.depth, s.parent, s.errors, s.warnings]),
    [
      ['Build', 4, 6, 0, null, 0, 0],
      ['Tests', 9, 18, 0, null, 1, 1],
      ['Branch: unit', 11, 13, 1, 9, 1, 0],
      ['Branch: lint', 14, 16, 1, 9, 0, 1],
    ],
  )
  assert.deepEqual(lines[10]!.path, ['Tests', 'Branch: unit'], 'a pinned heading reads its whole path')
  assert.deepEqual(lines[11]!.within, [9, 11])
  assert.equal(lines[11]!.stage, 'Branch: unit')
  assert.deepEqual(lines[20]!.within, [], 'after the last stage closes, nothing is around it')
})

test('a cut or running log: closes without opens are ignored, open stages run to the end', () => {
  const tree = stageTree(parseLog(['[Pipeline] }', '[Pipeline] { (Deploy)', 'Deploying…', 'still deploying'].join('\n'), 400))
  assert.deepEqual(tree.map((s) => [s.name, s.line, s.end]), [['Deploy', 401, 403]])
})
