import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { DataView } from '@/components/data-view.tsx'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile, type Profile } from './profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'

const GROUPS_SHOWN = 24

export function ProfilePage() {
  usePageTitle('Your profile')
  const { profile, error, reload } = useProfile()

  if (error && !profile) {
    return (
      <div className="max-w-prose">
        <h1 className="text-lg font-semibold tracking-tight">Your profile</h1>
        <p className="mt-2 text-muted-foreground">{error}</p>
        <Button variant="outline" className="mt-5" onClick={reload}>
          Try again
        </Button>
      </div>
    )
  }
  if (!profile) return <Skeleton className="h-72 w-full max-w-2xl" />

  // Department and team are always listed, empty or not — they are what people
  // come here to check. The rest appear only when the directory has them, so a
  // sparse profile is not a column of "not set".
  const details: [string, string | null, boolean?][] = [
    ['Department', profile.department],
    ['Team', profile.division],
    ...(
      [
        ['Company', profile.company],
        ['Office', profile.office],
        ['Manager', profile.manager],
        ['Email', profile.mail || null],
      ] as [string, string | null][]
    ).filter(([, value]) => value),
    ['Username', profile.uid, true],
  ]

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4">
        <Avatar className="size-14 rounded-lg">
          <AvatarFallback className="rounded-lg bg-accent text-lg text-accent-foreground">
            {initials(profile.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{profile.name}</h1>
          {profile.title && <p className="truncate text-muted-foreground">{profile.title}</p>}
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-[9rem_minmax(0,1fr)] gap-y-3 text-sm">
        {details.map(([label, value, mono]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={mono ? 'font-mono' : ''}>
              {value ?? <span className="text-muted-foreground">Not set in the directory</span>}
            </dd>
          </div>
        ))}
      </dl>

      <ApprovalStatus profile={profile} />
      <Groups profile={profile} />

      <details className="mt-10">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          What the directory returned
        </summary>
        <DataView className="mt-3" data={profile} filename={`profile-${profile.uid}`} />
      </details>
    </div>
  )
}

/**
 * Says plainly whether you can approve — and when you expected to and can't,
 * gives the reason the directory offers rather than a silence.
 */
function ApprovalStatus({ profile }: { profile: Profile }) {
  if (profile.isApprover) {
    return (
      <section className="mt-10 flex flex-wrap items-center gap-4 rounded-lg border bg-card p-5">
        <ShieldCheck className="size-5 shrink-0" />
        <p className="min-w-0 flex-1 text-sm">
          You’re in <span className="font-medium">{profile.approverGroup}</span>, so you can approve
          and reject requests.
        </p>
        <Button asChild size="sm">
          <Link to="/approvals">Open approvals</Link>
        </Button>
      </section>
    )
  }

  return (
    <section className="mt-10 rounded-lg border bg-card p-5 text-sm">
      <p>
        You’re not in <span className="font-medium">{profile.approverGroup}</span>, as far as the
        directory reports, so requests are decided by others.
      </p>
      {profile.groups.length === 0 ? (
        <p className="mt-3 text-muted-foreground">
          The directory returned no groups for you at all. That usually means the portal’s group
          lookup doesn’t match your directory, not that you belong to none. Whoever runs e-IDP can
          check with <code className="text-foreground">pnpm --filter @eidp/api ldap:doctor {profile.uid}</code>.
        </p>
      ) : (
        <p className="mt-3 text-muted-foreground">
          If you should be, check that you are a member of {profile.approverGroup} in Active
          Directory, or that the portal’s <code className="text-foreground">APPROVER_GROUP</code>{' '}
          names the group you are in.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Groups looked up by: {profile.groupLookup}</p>
    </section>
  )
}

function Groups({ profile }: { profile: Profile }) {
  const [all, setAll] = useState(false)
  if (profile.groups.length === 0) return null

  const approver = profile.approverGroup.toLowerCase()
  // Put the one that grants something first, where it is seen.
  const ordered = [...profile.groups].sort(
    (a, b) => Number(b.toLowerCase() === approver) - Number(a.toLowerCase() === approver),
  )
  const shown = all ? ordered : ordered.slice(0, GROUPS_SHOWN)

  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium text-muted-foreground">
        Groups in the directory ({profile.groups.length})
      </h2>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {shown.map((group) => (
          <li
            key={group}
            className={[
              'rounded-md border px-2 py-0.5 text-xs',
              group.toLowerCase() === approver ? 'border-foreground font-medium' : 'text-muted-foreground',
            ].join(' ')}
          >
            {group}
          </li>
        ))}
      </ul>
      {ordered.length > GROUPS_SHOWN && (
        <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${ordered.length}`}
        </Button>
      )}
    </section>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}
