# Auth

LDAP sign-in, Active Directory's error codes, the six causes of a failed login, and the test users. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

LDAP is the auth service. `integrations/ldap/` service-binds, searches for the
uid, then re-binds as that user's DN to verify the password — the uid is never
assumed to map to a DN pattern. `client.ts` owns connection handling: every
call goes through `withClient`, which always unbinds.

`POST /auth/login` returns an 8h HS256 JWT (`hono/jwt`, no extra dep);
`hono/jwt` middleware guards protected routes. `JWT_SECRET` is required at
boot.

The organization runs **Active Directory**, which `.env.example` is written
for. `ad-errors.ts` reads the sub-code AD buries in every bind rejection
(`... data 532 ...`): an expired password, a locked, disabled or expired
account and a logon restriction are each named to the person, because being
told "wrong password" when the account is locked makes people retry into a
longer lockout. `525` (no such user) and `52e` (wrong password) stay generic —
separating them would turn the login form into an account-name oracle.

Name and mail are read from the first attribute that has a value —
`displayName` then `cn`, `mail` then `userPrincipalName` — rather than
assuming one directory's schema.

The directory product is not assumed. `identify.ts` reads the rootDSE to name
the vendor and list its naming contexts, and the user filter is configurable —
`LDAP_USER_FILTER` as a `{username}` template when the two schema settings
cannot express what a directory needs. The username is escaped before
substitution, so a template cannot become an injection point.

A failed login has six distinct causes and they must not be conflated: the
directory being unreachable, the *service* account being rejected, a
`LDAP_BASE_DN` the server does not serve, the service account being denied the
search, no account matching the filter, and the user's own password being
wrong. Only the last is a 401 — the rest are 503s naming the setting at fault,
because a broken deployment must never be reported as the user's mistake.
`ldap:doctor` reports which one.

Test users live in `ldap/seed.ldif` (alice/alicepw, bob/bobpw, carol/carolpw,
dave/davepw; alice and carol are in DEVOPS, alice, bob and carol in Payments,
and dave in nothing — the RBAC tests bind roles to him), mounted into
the container's bootstrap dir so a fresh volume gets them. `pnpm --filter
@eidp/api test` runs against the live container.
