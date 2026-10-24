// The SMTP client against the fake server: what is sent arrives with its
// recipients, subject, text and HTML, non-ASCII intact; a login is checked;
// a refusal comes back as an error that says why.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createFakeMail } from './fake-server.ts'

const fake = createFakeMail({ username: 'eidp', password: 'fake' })
const port = await fake.listen()
process.env.MAIL_HOST = '127.0.0.1'
process.env.MAIL_PORT = String(port)
process.env.MAIL_FROM = 'e-IDP <e-idp@eidp.local>'
process.env.MAIL_USERNAME = 'eidp'
process.env.MAIL_PASSWORD = 'fake'

const { mailConfigured, parseAddresses, send } = await import('./index.ts')

before(() => fake.refuse(null))
after(() => fake.close())

test('addresses are read from a list, each once', () => {
  assert.deepEqual(parseAddresses('devops@x.com; DevOps@x.com, ops@x.com  nobody'), ['devops@x.com', 'ops@x.com'])
  assert.deepEqual(parseAddresses(undefined), [])
})

test('a message arrives with its recipients, subject, text and HTML', async () => {
  assert.ok(mailConfigured())
  const { messageId } = await send({
    to: ['bob@eidp.local'],
    cc: ['devops@eidp.local'],
    subject: 'Approved: الوصول إلى AgriLand',
    text: 'Your request was approved.\nIt is done.',
    html: '<p>Your request was <b>approved</b>.</p>',
  })
  assert.ok(messageId)
  const mail = fake.messages.at(-1)!
  assert.equal(mail.from, 'e-idp@eidp.local')
  assert.deepEqual(mail.recipients, ['bob@eidp.local', 'devops@eidp.local'])
  assert.equal(mail.subject, 'Approved: الوصول إلى AgriLand')
  assert.match(mail.text, /Your request was approved\.\r?\nIt is done\./)
  assert.match(mail.html, /<b>approved<\/b>/)
})

test('a refusal is an error with the server’s reason', async () => {
  fake.refuse('recipients')
  await assert.rejects(send({ to: ['nobody@eidp.local'], subject: 'x', text: 'x', html: '<p>x</p>' }), /User unknown|refused/)
  fake.refuse('message')
  await assert.rejects(send({ to: ['bob@eidp.local'], subject: 'x', text: 'x', html: '<p>x</p>' }), /554|refused/)
})
