import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { DataView } from '@/components/data-view.tsx'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile, type Profile } from './profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { FactsSkeleton, HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'

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
  if (!profile) {
    return (
      <Loading label="Loading your profile…" className={PAGE}>
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-lg" />
          <div className="flex-1">
            <HeaderSkeleton />
          </div>
        </div>
        <FactsSkeleton rows={6} />
      </Loading>
    )
  }

  // Department and team are always listed, empty or not — they are what people
  // come here to check. The rest appear only when the directory has them, so a
  // sparse profile is not a column of "not set".
  const organisation: [string, React.ReactNode][] = [
    ['Department', profile.department],
    ['Team', profile.division],
    ...(
      [
        ['Company', profile.company],
        ['Office', profile.office],
        ['Manager', profile.manager],
      ] as [string, string | null][]
    ).filter(([, value]) => value),
  ]

  return (
    <div className={PAGE}>
      <PageHeader
        title={
          <div className="flex items-center gap-4">
            <Avatar className="size-14 rounded-xl">
              <AvatarFallback className="rounded-xl bg-accent text-lg text-accent-foreground">
                {initials(profile.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{profile.name}</h1>
              {profile.title && <p className="truncate text-muted-foreground">{profile.title}</p>}
            </div>
          </div>
        }
      />

      <Split
        aside={
          <>
            <Section title="Account">
              <Facts
                items={[
                  ['Username', <code>{profile.uid}</code>],
                  ['Email', profile.mail || null],
                ]}
              />
            </Section>
            <YourAccess profile={profile} />
          </>
        }
      >
        <Section title="Organisation" description="As the directory has it.">
          <Facts items={organisation} empty="Not set in the directory" />
        </Section>
        <Groups profile={profile} />
        <Section title="What the directory returned" description="The whole profile, as the API reads it.">
          <DataView data={profile} filename={`profile-${profile.uid}`} />
        </Section>
      </Split>
    </div>
  )
}

/**
 * Every role you hold and where it comes from — a group, or a grant to you by
 * name — so "why can't I approve?" has an answer on the page. When nothing
 * beyond the basics shows, it says what the directory returned, because a
 * missing group is the usual cause.
 */
function YourAccess({ profile }: { profile: Profile }) {
  const { canSomewhere } = useProfile()
  const beyondMember = profile.access.roles.filter((r) => r.role !== 'member')
  return (
    <Section
      title="Your access"
      description="Roles you hold, and the group or grant each comes from."
      action={<ShieldCheck className="size-4 shrink-0 text-muted-foreground" />}
    >
      <ul className="space-y-3 text-sm">
        {profile.access.roles.map((r) => (
          <li key={`${r.role}:${r.via}:${r.scope ?? ''}`}>
            <p className="font-medium">
              {r.label}
              {r.scope && (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  for {r.scopeType} <code className="text-foreground">{r.scope}</code>
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {r.role === 'member' ? 'Everyone who can sign in' : r.via === 'you, by name' ? 'Granted to you by name' : <>Through {r.via}</>}
              {r.expiresAt && `, until ${new Date(r.expiresAt).toLocaleDateString()}`}
            </p>
          </li>
        ))}
      </ul>

      {canSomewhere('requests.decide_access') && (
        <Button asChild size="sm" className="mt-4">
          <Link to="/approvals">Open approvals</Link>
        </Button>
      )}

      {beyondMember.length === 0 &&
        (profile.groups.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            The directory returned no groups for you at all. That usually means the portal’s group
            lookup doesn’t match your directory, not that you belong to none. Whoever runs e-IDP can
            check with <code className="text-foreground">pnpm --filter @eidp/api ldap:doctor {profile.uid}</code>.
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Roles come from your directory groups. If you should hold one, ask DevOps to grant it to
            your team’s group on the Access page.
          </p>
        ))}
      <p className="mt-3 text-xs text-muted-foreground">Groups looked up by: {profile.groupLookup}</p>
    </Section>
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
    <Section title={`Groups (${profile.groups.length})`} description="Every directory group you are in, nested ones included.">
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((group) => (
          <li key={group}>
            {/* Not the default badge: that one is red, and a group is not an action. */}
            {group.toLowerCase() === approver ? (
              <Badge variant="secondary">{group}</Badge>
            ) : (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {group}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {ordered.length > GROUPS_SHOWN && (
        <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${ordered.length}`}
        </Button>
      )}
    </Section>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}
