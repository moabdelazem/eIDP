# Weekly digest and Platform activity

A team's week, and who uses the portal and how. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

**Weekly digest** (`/digest`, `features/digest/`, `modules/digest/service.ts`) is a
team's week — its builds and the requests for its projects — for the
people in it, a browse item for everyone. Built as the
risk summary is: the **facts** are counted in code, the **model** adds only a
two-or-three-sentence summary and at most three highlights, labelled as its
reading; without Ollama the facts stand and the page says why. A team is a
`team.yml` value in the catalog; you read the digests of the teams your
directory groups are, and `digests.all` (`devops-admin`) reads every team's
and may *Write again* a finished week. A team's runs are `teamRuns` in
`modules/pipelines/service.ts` — judged as My pipelines judges a team's run
(parameters, else the job's name; Jenkins' rules when read), so the two pages
never disagree. Its requests are those whose `team_group` is the team or whose
project the team owns. Weeks are ISO weeks in UTC. A finished week is written
once and kept (`weekly_digests`) by a timer every `DIGEST_CHECK_MINUTES` (60)
after Monday — one team at a time, shared GPU — or on the first look; it reads
the same after its builds age out. Only the last `WEEKS_BACK` (4) weeks can be
counted, because builds are kept 30 days. The week in progress is counted
live and never summarised, and its count deltas are hidden: half a week
against a whole one is not a change. Tests: `modules/digest/routes.test.ts`, under
lock 4202, writing their own builds and requests. `Kpi`
(`components/kpi.tsx`) is shared with the Jenkins dashboard.

**Platform activity** (`/activity`, `features/activity/`, `modules/activity/service.ts`)
is a Manage page behind `activity.view` (`devops-admin`): who uses the portal
and what they do in it. Most of it is read from where it is already recorded —
requests filed and decided (`requests`), access granted, changed, removed and
viewed-as (`rbac_audit`), Jenkins actions including refused ones
(`jenkins_audit`), failures someone asked the AI about (`build_explanations`,
not `e-idp`'s) — as one `union all` (`EVERYTHING`). What nothing recorded
lives in `activity_events`: sign-ins and refused sign-ins (the name typed and
the error code, never the password — `modules/auth/routes.ts`), pages opened, and
chatbot questions (that one was asked and from which page, never its words;
a deleted conversation does not uncount it). Pages are reported by the shell
(`app/page-visits.tsx`, on each pathname change) as the **path only** — the
query can carry searches — once per person and path per 30 s, and grouped
into the sidebar's sections in the API (`sectionOf`). Never while viewing as
someone: the shell skips it and the API refuses the POST anyway, so an
admin's look around is never put down to the person they viewed as. Kept
`ACTIVITY_RETENTION_DAYS` (90), pruned by the hourly `activity-retention` job.

The page: six headline counts against the window before (24h/7d/30d), and an
amber callout when one name is refused five or more times — a lockout in the
making, or someone guessing. Tabs, all in the URL with their filters
(`?tab=feed&who=bob&group=jenkins&q=…`): **Overview** (people active per hour
or UTC day, pages by section top eight plus "Other", most active — visits not
counted), **Feed** (sentences a day at a time, narrowed by person, kind and
words, `Show older` paging on the `next` cursor; the same thing repeated in a
row is one line with ×N) and **People** (each person's window). Visits count
but are never feed lines — one per click would bury everything. Tests:
`modules/activity/routes.test.ts`, deleting only rows past the ids it started at.
