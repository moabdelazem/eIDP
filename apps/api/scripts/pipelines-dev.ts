/**
 * Pipeline requests locally, end to end, with no real Azure DevOps, Jenkins
 * or inventories:
 *
 *   pnpm --filter @eidp/api ado:fake         # fake Azure DevOps on :4010
 *   pnpm --filter @eidp/api jenkins:fake     # fake Jenkins on :4030; makes an application's job when asked to build it
 *   pnpm --filter @eidp/api pipelines:dev    # this: once, then add what it prints to .env
 *
 * It makes two local git repositories under apps/api/.cache/dev-git —
 * inventories (the parser's fixtures, plus the reference applications the
 * .NET and new-project templates are imported from) and ocp-templates (the
 * .NET manifests' reference) — and saves the .NET-on-OpenShift and
 * new-project templates by importing them from those references, as DevOps
 * would on the Pipeline templates page. A template already saved is left as
 * it is. Run it again after deleting .cache/dev-git to start over.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = fileURLToPath(new URL('../', import.meta.url))
const home = join(api, '.cache/dev-git')
const inventories = join(home, 'inventories.git')
const ocpTemplates = join(home, 'ocp-templates.git')

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

/** A bare repository with `files` as its first commit on main — unless it is there already. */
function seed(bare: string, files: Record<string, string>, copyFrom?: string): boolean {
  if (existsSync(bare)) return false
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  const work = mkdtempSync(join(tmpdir(), 'eidp-dev-seed-'))
  if (copyFrom) cpSync(copyFrom, work, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'add', '.')
  git(work, '-c', 'user.name=e-IDP dev', '-c', 'user.email=dev@eidp.local', 'commit', '-q', '-m', 'Seed for trying pipeline requests locally')
  git(work, 'push', '-q', bare, 'main')
  rmSync(work, { recursive: true, force: true })
  return true
}

const madeInventories = seed(
  inventories,
  {
    // The .NET reference application (definitions.ts: LPGMS_Penalty/LPGMS.PWebApi).
    'LPGMS_Penalty/group_vars/all/project.yml': 'project_name: LPGMS_Penalty\n',
    'LPGMS_Penalty/group_vars/LPGMS.PWebApi/cicd.yml': [
      'repository_name: LPGMS.PWebApi',
      'build_technology: DotNetCore',
      'dockerfile_name: Dockerfile-User-global',
      'packages: tz-global',
      'nuget_name: Reference.Package',
      'db_password: hunter2',
      'build_image:',
      '  name: sdk',
      '  tag: "6.0"',
      'deploy_image:',
      '  tag: 6.0',
      '',
    ].join('\n'),
    'LPGMS_Penalty/group_vars/LPGMS.PWebApi/LPGMS.PWebApi.env.yml': 'service: LPGMS.PWebApi\nreplicas: 1\n',
    // The new-project reference (GAFI_Digital_Network): its own files, not its team.yml.
    'GAFI_Digital_Network/group_vars/all/project.yml': 'project_name: GAFI_Digital_Network\nmail_subject: GAFI_Digital_Network builds\n',
    'GAFI_Digital_Network/group_vars/all/team.yml': 'company: eFinance\ndev_team: DEVdotNET\n',
  },
  fileURLToPath(new URL('../src/integrations/inventories/__fixtures__/repo', import.meta.url)),
)
const madeTemplates = seed(ocpTemplates, {
  'LPGMS_Penalty/LPGMS.PWebApi/deployment-LPGMS.PWebApi.yml': 'kind: Deployment\nmetadata:\n  name: "{{ app_name }}"\nspec:\n  replicas: 1\n',
  'LPGMS_Penalty/LPGMS.PWebApi/service-LPGMS.PWebApi.yml': 'kind: Service\nmetadata:\n  name: "{{ app_name }}"\n',
})

// The templates are imported through the portal's own code, reading the repositories above.
process.env.INVENTORIES_GIT_URL = `file://${inventories}`
process.env.OCP_TEMPLATES_GIT_URL = `file://${ocpTemplates}`
const { closeDb, migrate } = await import('../src/lib/db.ts')
const { listTemplates, saveTemplate } = await import('../src/modules/requests/pipeline/templates.ts')
const { importReference } = await import('../src/modules/requests/pipeline/write.ts')

await migrate()
const saved = new Map((await listTemplates()).map((slot) => [slot.dir, slot.saved]))
const done: string[] = []
for (const dir of ['DotNetCore/OCP', 'manifests/DotNetCore/OCP', 'project']) {
  if (saved.get(dir)) continue
  const { files } = await importReference(dir)
  await saveTemplate(dir, files, { uid: 'e-idp-dev', name: 'Local seed' })
  done.push(dir)
}
await closeDb()

console.log(`inventories     ${madeInventories ? 'made' : 'already there'}: ${inventories}`)
console.log(`ocp-templates   ${madeTemplates ? 'made' : 'already there'}: ${ocpTemplates}`)
console.log(`templates saved: ${done.length ? done.join(', ') : 'none — all were there'}`)
console.log(`
Add to .env, then start the API:

INVENTORIES_GIT_URL=file://${inventories}
OCP_TEMPLATES_GIT_URL=file://${ocpTemplates}
ADO_BASE_URL=http://localhost:4010/tfs/DefaultCollection
ADO_PAT=fake
JENKINS_URL=http://localhost:4030/jenkins
JENKINS_USER=eidp
JENKINS_TOKEN=fake
PIPELINE_TEST_JOB={project}/{application}/develop
`)
