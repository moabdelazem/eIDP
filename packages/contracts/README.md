# @eidp/contracts

The shapes of the JSON the API sends and the web reads — **types only**. Both
apps import them with `import type`, which Node's type stripping and Vite
both erase, so nothing here is ever loaded at run time and no build step is
needed.

The API's services and routes declare what they return with these types; the
web's `features/*/api.ts` re-export them instead of keeping copies that drift.
A change here is checked by both apps' typechecks at once.

Rules: no imports from outside this package (no `pg`, `zod`, `node:*`), no
values — only `type`. Dates are ISO strings, as they are on the wire.
