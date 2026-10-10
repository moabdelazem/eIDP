# The chatbot

The agent, its tools and the rules that hold it, streaming, conversations, and how answers render. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

**The chatbot** (`/chatbot/:conversationId?`, `features/chatbot/`,
`modules/chatbot/service.ts`; it was "the assistant", and `/assistant` links redirect)
is an agent inside the portal with the same model, for everyone: `ai.chat` is a
`member` permission. General engineering it answers from what the model knows;
questions about *us* it answers through read-only tools in
`modules/chatbot/tools.ts` — applications, configuration, owners, your
requests and one request, what waits for your approval, Jenkins failures,
builds and numbers, your pipelines, one build in detail (stages, the branch
that broke, the stored explanation, the redacted end of its log), a team's
week (`peek` — never a second model call mid-answer), and
`whoami` (your groups, teams and every permission with the group or binding
behind it). Five rules hold it, each tested in `modules/chatbot/routes.test.ts`:

- **It looks, never acts.** No tool creates, approves, runs or changes
  anything. For a request it **drafts**: `draft_request` returns the form's
  URL filled in (`?project=…&repository=…&from=chatbot`), the forms read
  their fields from the query, and `DraftedNote` says the chatbot filled it
  in — the person checks it and submits it. A prefilled project takes the
  spelling ADO uses.
- **Tools are offered per person.** Each tool has an `allowed(access)`; without
  `jenkins.view`, Jenkins does not exist for the model, and a build is read
  through `demandView`, as the build page reads it. A call to a tool not
  offered — invented, or not this person's — is refused, not run.
- **Tool results are data, not instructions** (the prompt says so), capped in
  size, and already redacted where they are stored (`[hidden]`).
- **Conversations are the owner's alone** — anyone else's id is a 404, to
  read, continue, rename, delete or give feedback on.
- **It knows the page it is asked from**: `context` (path and tab title, a
  portal path only) goes into the system prompt, so "why did this build
  fail?" on a build page is about that build.

It streams: Ollama's NDJSON (`chatStream`, tool calls arrive whole) becomes
server-sent events (`conversation`, `step`, `delta`, `reset`, `done`, `title`,
`error`) through `hono/streaming`, read by `apiStream` in `lib/api-client.ts` —
not `EventSource`, which can neither POST nor send the token. Refusals (busy,
not yours, not configured) are checked *before* the stream opens, so they are
ordinary JSON errors. A turn that calls tools may have streamed a preamble;
`reset` drops it. Up to five tool rounds, then the model answers with what it
has. One answer at a time per person; closing the page aborts the model call.
The question is stored at once, the answer only when complete, and tool
results never — the next turn asks again, which keeps history small and data
current. History is trimmed from the oldest to fit `num_ctx`. A new
conversation is **named by the model** after its first answer (`title`), never
over a name the person gave it (`titled`); **regenerate** drops the last answer
and answers its question again; each answer takes a thumbs up or down
(`feedback`), kept beside it. The tables keep the assistant's name
(`assistant_*`): renaming them is a migration for a word.

The UI is one `ChatThread` and one `useChat` hook in two places: the full page
(conversations grouped by when they were used, searchable, renamable) and the
**dock** (`chatbot-dock.tsx`, mounted in `AppShell`): a launcher in the corner
of every page but the chatbot's own, or Ctrl/⌘ J, opens the chat in a sheet
over the page, with questions to start from that fit the page and the
person's permissions; other pages hand it a question with `askChatbot`
(`lib/ask-chatbot.ts`, a window event, so no feature imports the chatbot's
internals) and it opens and sends it; its conversation carries on from page to page for the
session (`sessionStorage`), opens in the full page with one click, and a link
in an answer closes it onto that page. Steps fold into "Looked up N things"
once the answer is written; the thinking dots move only under `no-preference`.

Answers are markdown, rendered by **react-markdown** with `remark-gfm` into
React elements — never HTML, since a model that read our data wrote it:
`skipHtml`, and links only to portal paths (in-app) or http(s) (new tab).
CommonMark reads `_x_` inside a word as text, so `NBFS_LoanManagementSystem`
stays a name. Code blocks are highlighted by Shiki in their fence's language,
each grammar its own chunk loaded the first time it appears
(`highlightCode` in `lib/highlight.ts`), with copy. `markdown.tsx` is
lazy-loaded, so the parser is not in the bundle the dock rides on. The catalog
tests and the chatbot tests share `pg_advisory_lock(4202)`: `catalog.test.ts`
replaces the catalog wholesale, and they run in parallel processes.
