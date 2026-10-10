import { Check } from 'lucide-react'
import type { Binding, Catalogue } from './api.ts'
import { statusOf } from './shared.tsx'

/**
 * Roles against permissions, as one grid: what each role allows, read across
 * a row for "who can do this?" or down a column for "what does this role
 * give?". Each column says how many bindings hold the role, and opens them.
 * Roles live in code; this is the reference, not something to edit.
 */
export function RolesTab({ catalogue, bindings, onRole }: { catalogue: Catalogue; bindings: Binding[]; onRole: (role: string) => void }) {
  const holders = (role: string) => bindings.filter((b) => b.role === role && statusOf(b, catalogue) !== 'expired').length
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">What each role allows</caption>
          <thead>
            <tr className="border-b bg-muted/40">
              <th scope="col" className="sticky left-0 z-10 min-w-64 bg-muted/40 px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                Permission
              </th>
              {catalogue.roles.map((r) => (
                <th key={r.id} scope="col" className="min-w-28 px-3 py-3 text-center align-bottom">
                  <span className="block text-sm font-medium">{r.label}</span>
                  <button
                    type="button"
                    onClick={() => onRole(r.id)}
                    className="mt-1 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    title={r.description}
                  >
                    {r.id === 'member' ? 'everyone' : `${holders(r.id)} ${holders(r.id) === 1 ? 'binding' : 'bindings'}`}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalogue.permissions.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                <th scope="row" className="sticky left-0 z-10 bg-card px-4 py-2.5 text-left font-normal">
                  <span className="block">{p.description}</span>
                  <code className="text-xs text-muted-foreground">{p.id}</code>
                </th>
                {catalogue.roles.map((r) => {
                  const on = r.permissions.includes(p.id)
                  return (
                    <td key={r.id} className="px-3 py-2.5 text-center">
                      {on ? (
                        <Check className="mx-auto size-4 text-success" aria-label={`${r.label} has it`} />
                      ) : (
                        <span className="mx-auto block size-1 rounded-full bg-border" aria-label={`${r.label} does not`} />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Roles and their permissions are defined in code (<code>modules/access/service.ts</code>); this page manages who holds them.
      </p>
    </div>
  )
}
