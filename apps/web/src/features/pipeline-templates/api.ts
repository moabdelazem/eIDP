import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts.
import type { PipelineFile, PipelineTemplate, TemplateImport, TemplateSlot } from '@eidp/contracts/requests'
export type { PipelineFile, PipelineTemplate, TemplateChange, TemplateImport, TemplateSlot } from '@eidp/contracts/requests'

const at = (dir: string) => `/requests/pipeline/template?dir=${encodeURIComponent(dir)}`

export const templatesApi = {
  list: () => api<TemplateSlot[]>('/requests/pipeline/templates'),
  get: (dir: string) => api<PipelineTemplate>(at(dir)),
  save: (dir: string, files: PipelineFile[]) => api<PipelineTemplate>(at(dir), { method: 'PUT', body: JSON.stringify({ files }) }),
  remove: (dir: string) => api<void>(at(dir), { method: 'DELETE' }),
  importReference: (dir: string) => api<TemplateImport>(`/requests/pipeline/template/import?dir=${encodeURIComponent(dir)}`, { method: 'POST' }),
}

/** Where a template's files land when a pipeline is approved. */
export function destination(slot: TemplateSlot): string {
  if (slot.kind === 'manifests') return 'ocp-templates · <project>/<application>/'
  if (slot.kind === 'project') return 'inventories · <project>/group_vars/all/ (a new project only)'
  return 'inventories · <project>/group_vars/<application>/'
}

export function slotName(slot: TemplateSlot): string {
  if (slot.kind === 'project') return 'New project'
  const what = slot.kind === 'manifests' ? 'manifests' : 'group_vars'
  return `${slot.label} · ${slot.target}${slot.appPath ? ` (${slot.appPath})` : ''} · ${what}`
}
