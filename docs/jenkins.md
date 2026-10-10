# Jenkins, My pipelines and build logs

The Jenkins page, My pipelines and who sees which run, ignoring failures, the dashboard, history and retention, the build page and its stage graph, the log viewer, and the AI's explanations. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

**Jenkins** (`/jenkins`, `features/jenkins/`) is a Manage page behind
`jenkins.view`. Its tabs — Dashboard, Failing, Builds, Queue, Agents,
Activity — and the 24h/7d window and search all live in the URL, so a link
lands on exactly one view. `jenkins.operate` adds three actions — run a build
again, stop a running one, take one out of the queue — each behind a
confirmation. Both are `devops-admin`'s, and `build-operator` bundles them to
bind to anyone else. Every action goes to Jenkins as the service account, so
`jenkins_audit` records who asked, refused attempts included; the Activity tab
reads it, and the tests delete only rows they made (`id > ` the max before).

**My pipelines** (`/pipelines`, `features/pipelines/`, `services/pipelines.ts`)
is the same Jenkins for everyone else, a browse item behind `pipelines.view`
(a `member` permission) — and it lists **runs**, not jobs, because a job is
often shared: one build job and one deploy job for every project. A run is:

- **yours** when you started it (`Started by user <uid or display name>`), or
  when it built a commit you wrote — whoever started it. Pushes are built by
  the service account maika, so the commit author is the person a push run is
  for. The sync keeps each build's commit authors (`jenkins_builds.authors`:
  name, Jenkins user id and email), matched to your login, name and `mail`.
- **your team's** when it is for a project a team of yours owns. Its project
  is what its **parameters** name (`APP_NAME=loan-scoring-api`,
  `REPOSITORY=…/loan-scoring-api.git` — values matched whole, or by their last
  path segment without `.git`, against the catalog's applications and
  repositories), and only when they name none, what the job's own name does
  (`payments/loan-scoring-api`, multibranch `agriland-api/main`). So a shared
  deploy job shows each team only its own projects' runs, never every run of
  the job. Don't key it on the job alone again.

Each run says why (*You started it*, *Your commit · run by maika*,
*Payments' project*). **Failing now** (`failing-now.tsx`) leads the page:
each pipeline whose latest finished run broke, how many in a row, and the AI's
reading of it — summary, category, what to try — with *See why* (the build
page, where the cited lines are), *Ask the chatbot*, or *Explain this failure*
when the automatic run has not reached it. `mine()` carries each failed run's
kept answer (`explanation`, a `Brief`: no evidence, that is the build page's),
read for the whole list in one query (`keptFor`), and `ai` says whether the
caller may ask and whether Ollama is there; the section hides without it. The
page narrows by group (`?group=Payments`, `me`
for just yours), window (`24h`/`7d`/`30d`, newest 500) and view: Runs, or
Pipelines — a row per job, and per project on a shared job, summed over the
runs you may see. Queue items are judged the same way, from the parameters
and causes Jenkins' queue carries.

**Jenkins has the last word on a team's runs** when its rules can be read.
`integrations/jenkins/access.ts` reads either the role-strategy plugin (project
roles: a regex over full names, matched whole and case-sensitively, and their
users and groups) or matrix grants in each folder's and job's `config.xml`
(all three spellings matrix-auth has written; grants flow down folders unless
an item stops inheriting). Only Job/Read counts; global roles are left out.
Grants to `authenticated`/`anonymous` are kept as `authenticated`: they name
no team, but they are how a shared job is readable by everyone.
`services/jenkins-access.ts` keeps them in `jenkins_job_access` every
`JENKINS_ACCESS_SYNC_MINUTES` (15); a failed read keeps the last rules. Once
rules exist, a team's run shows only if Jenkins lets the person read its job —
the portal reads with a service account that sees everything, and must not
show a team what Jenkins hides from it. A grant on a job also makes its runs
someone's, but only runs that name no project: a grant on a shared job says
nothing about whose each run is. Without rules (`source: none`, or the service
account may not read roles — it needs to administer them, or Job/ExtendedRead
for matrix), the catalog decides, and the page says which. The fake has both
(`FAKE_JENKINS_ACCESS=role-strategy|matrix`), stating one rule set two ways,
and the shared `platform/build` (maika, on push, with commit authors) and
`platform/deploy` (`APP_NAME`) jobs.

Acting is `jenkins.operate`, **scoped**, and judged per run: bound globally it
reaches every run (`build-operator`), bound to a team or project only runs for
the projects that team or project owns (`pipeline-operator`, which also
carries `pipelines.view`) — on a shared deploy job, the runs for its apps and
no others. Writing the commit or being in the team never lets you act; a rerun
can deploy to production, so that is a binding someone made on purpose. The
`/jenkins` action routes take anyone holding `jenkins.operate` anywhere and the
service judges the stored run (`demandOperate`); `cancel` judges the queued
item by what it will run with. A run opens at `/pipelines/build` on the Jenkins
build page (`BuildPage`, one of `features/jenkins`' public pieces with
`ActionDialog`, `result.tsx` and the types): `GET /jenkins/run` answers a run
that is not yours with 404, and returns `canOperate` so the page never guesses.
Links into the Jenkins page's search show only to `jenkins.view`. The tests are
`routes/pipelines.test.ts`; they put their own systems in the catalog under
lock 4202.

**Ignoring a failure** (`jenkins_ignored`, `POST /jenkins/ignore` and
`/unignore`, global `jenkins.operate`) sets a failing job aside — known broken,
being dealt with, or abandoned — so "failing now" is what still needs someone.
A reason is required; it holds until the job passes again after the build it
was ignored at, or for 1/7/30 days, or until someone stops it
(`IGNORE_HOLDS`, the one SQL every reader uses). Ignored jobs leave the
Failing tab, its count and the automatic explanations, are listed under
Ignored with who, why and until when, and are marked in "Failed most". Both
are written to `jenkins_audit` (`note` holds the reason), so the Activity tab
shows them.

The **Dashboard** also answers, each in its own chart: build time (typical and
slowest 5%, one hue, dashed for the tail — never a second axis), what starts
builds (by person or service account, SCM, timer, upstream), builds per agent
(with failure rate and busy time in the tooltip), why builds failed (the
model's categories, labelled as its reading), and time to fix — the median from
a job's first failure to its next pass, against the window before. Ranked
charts are top eight plus "Other", from the API. `RankedBars` and
`DurationChart` live in the lazy `charts.tsx` with the rest.

**History is the portal's own copy.** A day or a week of builds, searchable by
parameter, cannot be swept from Jenkins on every look, so
`services/jenkins-sync.ts` keeps `jenkins_builds` (with parameters, causes and
agent) and `jenkins_jobs` in step, every `JENKINS_SYNC_SECONDS` (60) and on
Refresh, single-flight. A sync is one light call for the job list (each job's
last build number) plus one call per job that built since, or had a build
still running — a handful a minute; only the first reads every job, up to
`BACKFILL` builds each. "Since" is the newest build stored *or* the last number
the previous sync saw, whichever is higher: without the second, a job whose
builds are all older than `JENKINS_RETENTION_DAYS` (30) would be backfilled on
every sync. A job that cannot be read keeps its old mark, so its builds are
read next time rather than skipped. Every table is keyed by `server`, so the
tests' fake Jenkins never touches a real server's rows. Queue and agents are
still asked live (15-second cache): only "now" matters for them.

**History is let go after a window** (`services/jenkins-retention.ts`, the hourly
`jenkins-retention` job, single-flight), because builds with their parameters are
the fastest-growing thing the portal stores. The sync only *stores* builds
inside `JENKINS_RETENTION_DAYS`; deleting is the retention job's alone, and it
covers what the sync never did: builds on **every** server (a changed
`JENKINS_URL` used to leave the old one's history forever), in batches of
5000 per server so a first run never holds one long lock; AI explanations and
their attempts past the window whose build is gone too — one whose build is
still kept stays, asking again costs the GPU; `jenkins_audit` after
`JENKINS_AUDIT_RETENTION_DAYS` (365); a server not configured and not read
within the window (its jobs, sync and access rows); and ignores that no longer
hold. Those go **first**: "until it passes" is `IGNORE_HOLDS` looking for the
passing build, so pruning the pass first would quietly ignore the job again.
Every reader goes through `IGNORE_HOLDS`, so a released row is never shown.
`WEEKS_BACK` follows the window (four weeks at 30 days). What a run
deleted is logged, when it deleted anything. Tests:
`routes/jenkins-retention.test.ts`, on servers named for the run, under lock
4202 (the digest tests write builds near the edge of the window).

Secrets never reach the table: parameter values under secret-like names, and
password parameters (Jenkins never returns their value), are `[hidden]` in
the integration, before storing — so search cannot find them either. Search
(`GET /jenkins/runs`) is words that must all match: `NAME=value` narrows to a
parameter (either side partial), anything else matches job, parameter value,
cause, agent or `#number`; `%` and `_` are characters, not wildcards.

The Dashboard compares the window with the one before it (deltas on each KPI;
colour says better or worse, the arrow says direction, builds count stays
neutral). Builds by result stack failure → unstable → success → aborted from
the baseline, in `--chart-failure/-unstable/-success/-aborted` (`index.css`,
validated; the meaning colours' text tones failed CVD against the red).
Success rate is its own chart — never a second axis on the first — with a
marker on every point, or a lone hour between two empty ones draws nothing.
The charts are `features/jenkins/charts.tsx`, lazy like the Overview's.

"Run again" is a rebuild, not "Build now": the same parameters the build had,
because a failed deploy re-run with defaults deploys something else. A build
with a password parameter or a file one is refused rather than re-run blank.

A build has its own page (`/jenkins/build?job=a/b&number=12` — the job carries
folders, so it rides in the query): its stages — from the **Pipeline Graph
View** plugin's `pipeline-graph/tree` when the server has it, the only source
that says what ran in parallel (`Stage.branches`), else Stage View's flat
`wfapi` (`stagesFrom` says which; none on a freestyle job) — drawn as a graph
the way Jenkins' own Pipeline Graph View draws it (`stage-graph.tsx`): a track
from Start to End, each stage a status circle on it (filled green/red/amber,
info-blue and pulsing while it runs, a dashed ring if it never ran) with its
name and time beneath, and a parallel stage's branches leaving the track on
rounded elbows, one row each, under the parallel stage's name. The canvas is
**React Flow** (`@xyflow/react`): pan by dragging, zoom from its controls (the
wheel too, in the large view), fit to view; it is lazy-loaded with the graph
(~44 KB gzipped), never in the main bundle. The layout is ours — a pipeline is
a row of columns, not a graph for dagre or ELK to guess at — and the elbows are
`smoothstep` edges meeting at an invisible junction between columns, so a fork
or a join is drawn once rather than once per pair. Three traps it has: React
Flow measures a node the moment it mounts, so its entrance is opacity only
(`graph-fade`) — the old `translateY` entrance anchored every line 6 px low; a
node that cannot be dragged or selected gets `pointer-events: none`, so stage
nodes take them back or the pane swallows the click; and strokes are opaque
(mixed into `--card`), because a fork's lines share a stretch and translucent
ones drew it darker. Inline it never fits below 85 % zoom — a long pipeline
is panned, not squeezed; **Expand** opens it in a dialog nearly the screen's
width, with each stage's agent too. Or as a list, the plain path to the same
stages; phones open on the list, and the choice is kept per browser. Picking a
stage in the dialog closes it without focus returning to the button, which
would scroll the page away from the log. A running stage pulses and the line
into it marches (React Flow's `animated`, stilled under reduced motion); a
stage that never ran is reached by a dashed line. A stage opens the log at its
`[Pipeline] { (name)` heading (a branch's `Branch: name`, else its stage's).
The sync's agent lookup still reads `wfapi` only — the tree is one more call
per build it does not need. The fake serves the tree for the `payments`
folder only, so both paths stay tested. Then parameters (each a
link to every build that had it), commits, agent, and the last 256 KB of the
log in the log viewer — opened at the first error, with find, error-to-error
jumps, errors-with-context, hiding `[Pipeline]` steps, and wrap. Find wins over
those filters, or "3 of 40" steps through lines nobody can see. Stage headings
stay pinned at the top of the box while their lines scroll under them (lines
are siblings of the box's content, never wrapped one by one — sticky sticks
only within its parent — and headings skip `content-visibility`, which would
stop drawing them), shell commands (`+ …`) read as `$ …`, and `timestamps {}`
prefixes become a column of their own. **A running build is a tail**: the page
asks every 3 s, the log opens at the end and keeps to it — a `ResizeObserver`
re-pins it, because lines below the fold only take their wrapped height once
drawn — new lines fade in, and a Live bar says which stage it is in. Scrolling
up pauses following; *Jump to latest* (with how many lines came since) or
scrolling back down resumes it. The fake's running build grows its log two
lines a second from when the fake started. It scrolls the
log box itself, never `scrollIntoView`, which also scrolled the page and
shifted the sidebar rail.

**The log viewer is the app's one** (`components/log-viewer/`: `parse.ts`
reads lines, `prefs.ts` keeps wrap, step hiding, timestamps and text size per
browser in `eidp.log`). The build page uses it, and so does the chatbot:
a ` ```log ` or ` ```console ` fence in an answer renders as a `compact`
viewer, and the system prompt asks the model to quote log lines that way.
**Expand** (or `f`) opens the same viewer in a Radix `Dialog` nearly the
window's size — not a portal of our own, because the chatbot's dock is a
sheet whose focus trap and `pointer-events: none` would leave our portal
dead; nested Radix dialogs stack. The state is the viewer's, so find,
filters, selection and live following carry across, and the line at the top
stays at the top. A line number selects (shift: a range) for *Copy lines*;
with `linkable` (the build page) it writes `#L12-L20` into the address with
`replaceState`, and the log opens on it — not for a truncated log, whose
numbers drift. The Stages menu jumps to a heading with its error count;
"N lines hidden" opens with a click; http(s) URLs are links, except ones
carrying credentials. Keys work only for events from inside the viewer's
own DOM — React bubbles a portalled menu's Esc up to it, which once cleared
the selection along with closing the menu: `/` find, `e`/`E` errors, `f`
expand, `w` wrap; Esc clears find, then closes, then clears the selection. A
pinned heading takes an opaque selected fill (`color-mix`), never a
translucent one, or lines show through it.

**"What went wrong"** on a failed or unstable build (`explain-panel.tsx`,
`services/build-explainer.ts`) is made **automatically** for each job's latest
failure (`services/auto-explain.ts`), after the Jenkins sync that finds it, so
the answer is usually waiting when someone opens the build; anything else
(an older failure, one the run could not do) is a click. The automatic run is
kept small because every answer is shared GPU time: only each job's *latest*
build and only when it failed or was unstable — a job failing twenty times in
a row is explained once per new failure, not twenty times; only within
`OLLAMA_AUTO_EXPLAIN_HOURS` (24), so turning it on does not work through a
month of history; at most five per run, one at a time, newest first. A build
the model fails on is tried once more fifteen minutes later
(`build_explain_attempts`), then left for a click, and its error shown. When
Ollama itself is down (unreachable, model missing) the run stops without
counting it against the build, and the next sync tries again. Automatic
answers are by `e-idp` ("e-IDP, automatically"); the explainer's single
flight means a click during an automatic run shares its call. The Failing tab
and the chatbot's `jenkins_failing` carry each failure's one-line summary.
`OLLAMA_AUTO_EXPLAIN=false` turns it off. Asking about one build
(`GET`/`POST /jenkins/explain`) needs only `ai.chat` — everyone's — and the run
itself, through `demandView`: anyone who may see a run may ask why it failed,
and a run that is not theirs is a 404 before the model is asked. `ai.use`
(`devops-admin`, `build-operator`) still decides whether Jenkins-wide lists —
the Failing tab, the chatbot's `jenkins_failing` — carry every job's summary. The model
gets the facts (failed stage, parameters, commits, agent) and an *excerpt* of
the log, numbered as the build page numbers it: each error line with six
before and three after, every stage heading, and the last 30 lines — or the
last 120 when nothing reads as an error. "Error line" is the same regex on both
sides (`ERROR` in `build-explainer.ts` and `components/log-viewer/parse.ts`); change them
together. Over budget, the first error and the end are kept, then errors from
the last backwards: the first is usually the cause, the last what stopped it.

Three rules keep the answer honest, each tested in
`routes/jenkins-explain.test.ts`: `redact` removes URL credentials,
authorization headers, secret-named `key=value` and `--flag value`, private
keys and token shapes before the model sees anything; a cited line must be one
the model was shown, or it is dropped; and the cited text is the log's own, not
the model's. Broken JSON is asked for once more, then reported. Answers are kept
in `build_explanations` per build, prompt version (`PROMPT_VERSION`) and model —
change the prompt, bump it — so each failure is explained once for everyone,
and two people asking at once share one call. The panel says the answer is
generated, by which model, for whom and when, and that it can be wrong; each
cited line jumps the log viewer to it.
