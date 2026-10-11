/**
 * The pipeline templates, from the reference applications in inventories:
 *
 *   pnpm --filter @eidp/api pipeline:templates extract <inventories checkout> <ocp-templates checkout>
 *   pnpm --filter @eidp/api pipeline:templates check   <inventories checkout> <ocp-templates checkout>
 *
 * `extract` copies each reference named in definitions.ts — its
 * `group_vars/<app>/`, and the new-project template's `group_vars/all/` — into
 * src/modules/requests/pipeline/templates, with the reference's name replaced
 * by `__APPLICATION__` (`__PROJECT__` for the project). Read the diff before
 * committing: the replacement is textual, and this is the one place a person
 * sees it. A literal credential in a reference is not copied: its value is
 * written as `changeme` and listed below.
 *
 * The manifests come from ocp-templates, each technology's reference_template
 * folder, into `manifests/<Technology>/<target>/`. As the old portal did, the
 * reference's name is replaced in their paths only; their contents are copied
 * as they are, and a content that still names the reference is pointed out.
 *
 * `check` extracts again in memory and compares with what is committed: a
 * reference that has moved on since is drift, and it exits 1. The portal
 * never follows a reference by itself.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { credentialsIn } from '../src/modules/requests/pipeline/credentials.ts'
import { PROJECT_TEMPLATE, TECHNOLOGIES } from '../src/modules/requests/pipeline/definitions.ts'
import { APPLICATION, PLACEHOLDER, PROJECT, type TemplateFile } from '../src/modules/requests/pipeline/generate.ts'
import { BUNDLED_TEMPLATES, manifestVariantsOf, PROJECT_TEMPLATE_DIR, readTemplate, variantsOf } from '../src/modules/requests/pipeline/templates.ts'

const [mode, inventories, ocpTemplates] = process.argv.slice(2)
/** Where the templates are written and compared: the bundled ones, unless PIPELINE_TEMPLATES_DIR says otherwise. */
const templates = process.env.PIPELINE_TEMPLATES_DIR ?? BUNDLED_TEMPLATES
if ((mode !== 'extract' && mode !== 'check') || !inventories || !ocpTemplates) {
  console.error('usage: pnpm pipeline:templates extract|check <inventories checkout> <ocp-templates checkout>')
  process.exit(2)
}

type Source = { root: string; dir: string; from: string; name: string; placeholder: string; topLevelOnly: boolean; skip: string[]; pathsOnly?: boolean }

const sources: Source[] = [
  ...Object.entries(TECHNOLOGIES).flatMap(([key, definition]) =>
    variantsOf(key, definition).map((v) => ({
      root: inventories,
      dir: v.dir,
      from: join(v.reference.project, 'group_vars', v.reference.app),
      name: v.reference.app,
      placeholder: APPLICATION,
      topLevelOnly: false,
      skip: [],
    })),
  ),
  // As the old portal: the project's own files only, and never its team.yml — that is the requester's.
  ...Object.entries(TECHNOLOGIES).flatMap(([key, definition]) =>
    manifestVariantsOf(key, definition).map((m) => ({
      root: ocpTemplates,
      dir: m.dir,
      from: m.reference,
      name: m.reference.split('/').at(-1)!,
      placeholder: APPLICATION,
      topLevelOnly: false,
      skip: [],
      pathsOnly: true,
    })),
  ),
  { root: inventories, dir: PROJECT_TEMPLATE_DIR, from: join(PROJECT_TEMPLATE, 'group_vars', 'all'), name: PROJECT_TEMPLATE, placeholder: PROJECT, topLevelOnly: true, skip: ['team.yml'] },
]

let problems = 0
const report = (line: string) => {
  problems++
  console.log(`  ! ${line}`)
}

for (const source of sources) {
  console.log(`${source.dir}  ←  ${source.from}`)
  const extracted = extract(source)
  if (!extracted) continue
  if (mode === 'extract') {
    const target = join(templates, source.dir)
    rmSync(target, { recursive: true, force: true })
    for (const file of extracted) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true })
      writeFileSync(join(target, file.path), file.content)
    }
    console.log(`  ${extracted.length} files`)
  } else {
    const committed = new Map(((await readTemplate(templates, source.dir)) ?? []).map((f) => [f.path, f.content]))
    if (!committed.size) report('not extracted yet')
    else {
      const now = new Map(extracted.map((f) => [f.path, f.content]))
      for (const [path, content] of now) if (!committed.has(path)) report(`new in the reference: ${path}`)
      else if (committed.get(path) !== content) report(`changed in the reference: ${path}`)
      for (const path of committed.keys()) if (!now.has(path)) report(`gone from the reference: ${path}`)
    }
  }
}

console.log(problems ? `\n${problems} to look at.` : '\nNothing to look at.')
process.exit(mode === 'check' && problems ? 1 : 0)

/** A reference's files as a template: the name replaced, credentials not carried. */
function extract(source: Source): TemplateFile[] | null {
  const root = join(source.root, source.from)
  let names: string[]
  try {
    names = readdirSync(root, { recursive: !source.topLevelOnly }) as string[]
  } catch {
    report(`the reference is not in inventories: ${source.from}`)
    return null
  }
  const files: TemplateFile[] = []
  for (const name of names.sort()) {
    const full = join(root, name)
    if (!statSync(full).isFile() || source.skip.includes(name)) continue
    const original = readFileSync(full, 'utf8')
    const count = original.split(source.name).length - 1
    let content = source.pathsOnly ? original : original.replaceAll(source.name, source.placeholder)
    for (const key of credentialsIn(content)) {
      content = content.replace(new RegExp(`^(\\s*(?:-\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*).*$`, 'gm'), `$1${PLACEHOLDER}`)
      // Drift only when it is new; a scrubbed credential is already in the committed template.
      if (mode === 'extract') report(`${name}: ${key} had a literal value; written as ${PLACEHOLDER}`)
    }
    if (source.pathsOnly && count) console.log(`  ${name}: names ${source.name} ${count} times, copied as it is — read it`)
    else if (count > 1) console.log(`  ${name}: the name replaced ${count} times — read it`)
    files.push({ path: name.split('\\').join('/').replaceAll(source.name, source.placeholder), content })
  }
  return files
}

