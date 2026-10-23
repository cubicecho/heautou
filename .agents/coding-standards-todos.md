# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. This file lives at
`.agents/coding-standards-todos.md`. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

**Gate 2, 2026-10-23.** Approved: M1–M6 with their items (R14, R15, A1; B2, R4; R5, R6;
T1, T3, R7, R8; R12, R13, D6, A2; B4, R28), what they need (R1), B1, and T5 and T6 for a
green baseline. Everything else stays open, not approved. Decisions:

- **A1, A2:** every persisted and public name stays: the tables, cookie names, the
  `documents.name` values (`keys.json`, …), archive paths and the `/admin/*` URLs. Code
  names and comments change; stored and wire names don't.
- **B1:** the generated activity list waits for queued entries, as the subscription does
  (`fix:` with a regression test).
- **B2:** a paired app's registration entries name the client the way every other entry does
  (`fix:` before R4).
- **B4:** the web host check matches the server's, by importing the server's rule (R28); a
  `fix:` first if importing changes behaviour.
- **M6 build:** the web may import pure server modules for shared rules and limits; nothing
  Node-only may reach the bundle, and a module that mixes the two is split.

Survey of 2026-10-23, on `main` at c5640c9 (after PR #28, storage in PGlite/Postgres). Scope:
server and web code structure, tests and docs. UX, layout and copy judgments are left to the
UI/UX pass running alongside. Code items assume the `M` items are approved; each says which
`M` it needs, so a declined `M` drops its items.

Baseline: `npm run check` clean (Biome: 329 files, no diagnostics; `tsc` server and web: no
errors). `npm test` (50 files, 384 tests) red only by timeouts under load: 6 failures in the
first run (load average 7), 2 different ones in a second run with `--maxWorkers=2` (load
average 13); every failing file passes alone. See T5 and T6.

## Summary

| Prefix | Kind |
|---|---|
| `M` | Model change: a change to `.agents/domain-model.md`, made true by the items that implement it |
| `R` | Refactor: same behavior, better shape |
| `T` | Test work |
| `D` | Comment or doc that no longer matches the code |
| `B` | Bug, or near copies that behave differently |
| `A` | Public API change; needs a decision |

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| M1 | Model change | Splits "admin" into the web session (any signed-in user's) and admin (a user in the admin group), in code names and in the server folders | A reader stops thinking the account page is admin-only | — | approved |
| R14 | Refactor [readability] | Renames the admin session store and service to web session, internal names only | M1 | M1 | approved |
| R15 | Refactor [pattern] | Moves the account page's routes (profile, second factors, own picture) out of `server/admin/` into `server/account/` | M1; P21 | M1 | approved |
| A1 | API change | Lists the persisted and public "admin" names of the web session (table, cookie, document name, `/admin/account/*` URLs) and proposes keeping them | M1 without a breaking change | M1 | approved |
| M2 | Model change | Gives a client's display name (built-in name, else stored name, else ID) one owner | Removes five copies that already differ once | — | done |
| B2 | Bug (question) | Asks whether a paired app's registration entries should name the client the way every other entry does | Settles the one differing copy before R4 merges them | — | done |
| R4 | Refactor [reuse] | Replaces the five client-name copies with one function | M2 | M2, B2 | done |
| M3 | Model change | Makes the audit module the owner of audit targets and of "record what the signed-in admin did" | One place to look when an entry reads wrong | — | done |
| R5 | Refactor [reuse] | Replaces four copies of the admin-change recorder in the GraphQL modules with one | M3; removes copies in the most-changed folder | M3 | done |
| R6 | Refactor [pattern] | Moves the target builders (client, API, site, group, pairing, settings, branding, mail, cookie domain) beside `userTarget` | M3 | M3, R4 | done |
| M4 | Model change | Makes backup and restore one operation of the backup module that the CLI and the server share; reading an older data directory moves to the import | Removes a copied restore and a CLI that imports all the services | — | done |
| T1 | Test [pin] | Pins that a restore brings back every store, not only the six checked today | Protects M4 and any services.ts change | — | done |
| T3 | Test [pin] | Pins the backup CLI's `--sessions` flag and its refusals | Protects R8 | — | done |
| R7 | Refactor [pattern] | Moves the older-data-directory reader from the backup module to the import module | M4 | M4 | done |
| R8 | Refactor [reuse] | One export and one restore (check, pick files, replace, audit entry) used by both the CLI and the running server | M4; services.ts changes most of any file | M4, T1, T3 | done |
| M5 | Model change | Retires "file" as the code's word for a store's document; "file" then means only an archive file | One concept, one name (P25), and the JSON-era word stops misleading | — | approved |
| R12 | Refactor [sweep] | Renames every store's `file` parameter to `document` (84 hits, 18 files) | M5 | M5 | approved |
| R13 | Refactor [readability] | Renames the document mapping's `file` field and `DOCUMENT_FILES` to say they are the document's name; the stored values stay | M5 | M5, A2 | approved |
| D6 | Doc [sweep] | Rewrites comments that say "the file" or "model files" where they mean the document or its tables | M5 | M5 | approved |
| A2 | API change | Asks whether the stored document names and archive paths (`keys.json`, …) keep their JSON-era values | Decides R13's scope | — | approved |
| M6 | Model change | Gives each rule or limit both sides check one owner on the server, imported by the web or held to it by a test | Ends silent drift between form checks and server checks | — | approved |
| B4 | Bug (question) | Asks whether the web's host check should match the server's, which also limits label and total length | Settles a copy that already drifted | — | done |
| R28 | Refactor [reuse] | Has the web import the server's limits and patterns (archive size, logo size, host and ID patterns, password user inputs) instead of copying them | M6 | M6, B4 | approved |
| R1 | Refactor [reuse] | One "signed-in user or 401" middleware, with a typed way to read the viewer, replacing seven copies | Removes copies in five route modules and an unchecked `res.locals` read | — | done |
| R2 | Refactor [simplify] | Makes the GraphQL context the services plus viewer and address, so nobody lists every service twice more | Removes two hand-kept lists in two of the most-changed files (P14) | R1 | open |
| R3 | Refactor [reuse] | Uses the shared JSON refusal helper in the sign-in routes instead of its exact copy | Removes a copy | — | open |
| T4 | Test [pin] | Pins the hand-written GraphQL fields no test names yet | Protects R9 | — | open |
| R9 | Refactor [consistency] | Splits the 1,344-line resolver file by concept, each module holding its SDL and resolvers as mail and forward auth already do | Where a field lives stops being a search; the file changes most of any GraphQL module | T4 | open |
| R10 | Refactor [simplify] | Drops the audit store's cursor paging, which only its own tests use since the activity list became a generated read | Removes dead code and two defaults | — | open |
| R11 | Refactor [consistency] | Gives every store the same clock, epoch milliseconds, and reads it once in services.ts | Same job, same shape; fewer Date wrappers at the call sites | — | open |
| T5 | Test [consistency] | Sets one timeout for tests that boot a server, so a busy machine stops failing them | A green baseline | — | done |
| T6 | Test [readability] | Makes the audit tests count only entries they made, so one failure no longer cascades | A failure points at its cause | — | done |
| T2 | Test [pin] | Pins that boot refuses a wrong key for factors and upstreams too | Covers two of five sealed stores left untested | — | open |
| T7 | Test [reuse] | Moves the copied `withTotp` helper into the shared authenticator helper | Removes a copy | — | open |
| T8 | Test [reuse] | One `signInToWebApp` helper in the browser helpers, used by `signInAsAdmin` too | Removes two copies | — | open |
| T9 | Test [reuse] | One test-services opener instead of three | Removes copies that differ in cleanup | — | open |
| T10 | Test [readability] | Types the device flow test's reply once instead of casting it nine times | P17 in tests | — | open |
| T11 | Test [readability] | Replaces fixed 50 ms sleeps in "nothing was sent" checks with a signal the work finished | Those tests prove something under load | (unverified seam) | open |
| T12 | Test [readability] | Keeps each backup behavior asserted in one test file | One layer per behavior; a shorter slow file | — | open |
| T13 | Test [pin] | Pins the web's reply reader, the sign-in post and the audit cache helpers | Protects R20–R23 | — | open |
| T14 | Test [consistency] | Splits the forward-auth "headers" test into the modules it covers | Its name points at an unrelated module | — | open |
| T15 | Test [readability] | Closes the data-set test's second database in `finally` | A failing assertion stops leaking a database | — | open |
| R20 | Refactor [reuse] | One web module for query keys and the refetch helper | Removes an exact copy and a duplicated key | — | open |
| R21 | Refactor [consistency] | Splits the web's 833-line admin hooks module by concept | The web module most files import becomes findable | R20 | open |
| R22 | Refactor [reuse] | Shares the `{ok}` and `{redirectTo}` reply schemas declared five times | Removes copies | — | open |
| B5 | Bug (question) | Asks whether the sign-in page's reply reader is meant to differ from the shared one | Settles R23's shape | — | open |
| R23 | Refactor [reuse] | Moves the sign-in page's fetching into a core module on the shared reply reader | Removes a near copy | T13, B5 | open |
| R24 | Refactor [reuse] | One helper reads a parameter from the URL fragment | Removes an exact copy | — | open |
| R25 | Refactor [readability] | Moves the error-message and claims helpers out of the web's `lists` module | The module says what it holds | — | open |
| R26 | Refactor [reuse] | One "not saved" alert for the five form dialogs | Removes five copies | — | open |
| R27 | Refactor [consistency] | Moves the five settings sections out of the settings route into concept folders, like mail and backup | Same shape as their siblings | — | open |
| B1 | Bug (question) | Asks whether the generated activity list should wait for audit entries still queued, as the subscription does | The list shows a change just made | — | done |
| B3 | Bug | Notes that nothing stops two servers sharing one Postgres, which the in-memory documents can't survive | Prevents silent data loss | — | open |
| B6 | Bug (question) | Asks whether edit dialogs should agree on keeping Save off until something changes | Consistency; may belong to the UX pass | — | open |
| B7 | Bug | The overview page always warns that secrets are plain text, even when they are sealed | The warning means something | — | open |
| D1 | Doc | Makes one project guide the source: AGENTS.md still describes flat JSON files and modules that are gone | Agents stop reading a wrong map | — | open |
| D2 | Doc | Brings CLAUDE.md up to date: device flow, pairing offers, code exchange and pages modules, a repeated phrase, `*.json` locations | The guide matches the code | D1 | open |
| D3 | Doc | Rewrites README's storage parts: it says there is no database, lists JSON files and tells operators to edit or delete them | Operators follow steps that work | — | open |
| D4 | Doc | Fixes the docs site's "a few JSON files instead of a database" | The site matches the product | — | open |
| D5 | Doc | Fixes forward-auth docs naming `proxy-sessions.json` | Matches the code | — | open |
| D7 | Doc | Cuts document.ts's header comment, which is the history of the JSON files, to its point | P19 | — | open |
| D8 | Doc | Fixes the web's backup section text ("on disk", the data directory, an incomplete list of what it holds) | Matches what a backup is now | B7 | open |
| R16 | Refactor [reuse] · low value | One mapping for the two identical hashed-token documents | Removes a copy | — | open |
| R17 | Refactor [simplify] · low value | Has `documentFromRows` reuse the loose mapping's `fromRows` | Removes a copied expression | — | open |
| R18 | Refactor [simplify] · low value | Groups model rows with `Map.groupBy` in the data set export | Reads as what it does | — | open |
| R19 | Refactor [readability] · low value | Types what `toRows` really takes: a document that may be an older file's, missing fields | The `?? default`s stop looking dead | — | open |
| R29 | Refactor [reuse] · low value | One "name=value" line parser for claims and group mappings | Removes a near copy | — | open |
| R30 | Refactor [consistency] · low value | Splits the one save hook with a mode flag into create and update | Same shape as its siblings | R21 | open |
| R31 | Refactor [consistency] · low value | A lookup table for upstream kinds, like auth methods and token formats | P24 | — | open |
| R32 | Refactor [pattern] · low value | Moves the token-lifetime duration helpers out of the clients folder | P21 | — | open |
| R33 | Refactor [reuse] · low value | Declares the web's HTTP statuses and sign-in paths once | Removes a copy | — | open |
| R34 | Refactor [readability] · low value | Names the condition in the activity cache helper | P1 | — | open |
| R35 | Refactor [readability] · low value | Explains or removes the re-render trick in `usePairing` | Had to work it out | — | open |
| R36 | Refactor [simplify] · low value | Stops exporting two web constants only their own file uses | Smaller surface | — | open |
| R37 | Refactor [sweep] · low value | P15: JSX drawn-or-not pieces as `{shouldShowX && <X />}` instead of a ternary with `null` | Sweep | — | open |
| R38 | Refactor [sweep] · low value | P16: GraphQL enum members by name in the web, via codegen's const enums | Sweep | — | open |
| R39 | Refactor [sweep] · low value | P22: a web defaults module for its five tunables | Sweep | — | open |
| R40 | Refactor [sweep] · low value | P4: settles whether components keep `@param props` (the org skill) or a summary alone (the preference) | Sweep, after a ruling | — | open |
| T16 | Test [reuse] · low value | One shared `newSecretKeys()` | Removes copies | — | open |
| T17 | Test [reuse] · low value | A `createTestUser` helper for the 24 hand-built test users | Each test shows what it changes | — | open |
| T18 | Test [readability] · low value | Renames the local `postJson` that means something else than the shared one | One name, one thing | — | open |
| T19 | Test [reuse] · low value | One `locationOf` helper, deciding whether it checks the 303 | Removes a near copy | — | open |
| T20 | Test [consistency] · low value | Uses `DOCUMENT_FILES` and `AUDIT_FILE` instead of name literals | Tests use the names | — | open |
| T21 | Test [consistency] · low value | Uses `isSealed()` instead of the `'enc:v1:'` literal | Tests use the names | — | open |
| T22 | Test [readability] · low value | Stops asserting vitest's own message text | Survives a vitest upgrade | — | open |
| T23 | Test [readability] · low value | Narrows caught errors with `instanceof` instead of casts | P17 | — | open |
| T24 | Test [consistency] · low value | Moves test files to mirror their modules (web tests, sealed-document, the directory reader) | P21 | R7 | open |
| T25 | Test [consistency] · low value | Moves the suite-wide browser helper to the tests' root | P21 | — | open |
| T26 | Test [readability] · low value | Rewords the proxy snippet test titles verb first | Title rule | — | open |
| B8 | Bug · low value | The web's GraphQL reply is cast, not checked | P17 at the boundary | — | open |
| D9 | Doc · low value | The `invalid_scope` message lists only the built-in scopes, not an API's | Matches the code | — | open |
| D10 | Doc · low value | Fixes `refetching`'s `@param` name | Matches the signature | R20 | open |

## Model changes

Changes to the domain model, `.agents/domain-model.md`, agreed or declined at Gate 1. The
domain model describes the code as it is, so a change waits here until the commit that
makes it true writes it into that file. Declined items stay, marked declined, so they
aren't proposed again.

### M1 — Split the homonym "admin": web session and admin

As-is: the store, service and folder named "admin" hold the web app's sessions and routes
for every signed-in user (`AdminSessionStore`, `services.adminSessions`, `server/admin/account.ts`,
`factors.ts`, `pictures.ts`), while "admin" also means a user in the admin group. CLAUDE.md
has to explain that "any enabled user may sign in this way". To-be: a **web session** is a
browser signed in to heautou's web app; an **admin** is a user in the admin group; the
account page's routes live in `server/account/`, the admin-only ones in `server/admin/`.
Persisted and public names stay (A1). Why it is simpler: each word means one thing.
Implemented by: R14, R15, A1. Status: open.

### M2 — Name "client display name" and give it one owner

As-is: "the built-in client's name, else the stored name, else the ID" is written out in
`server/admin/admin-client.ts:138`, `server/oidc/pages.ts:89`, `server/oidc/interactions.ts:221`
and `server/oidc/audit-events.ts:112`, and differently in `server/core/services.ts:323-338`
(the registration's own name first, no built-in check). To-be: one function, next to
`builtInClientName` in `server/admin/admin-client.ts` (or on the client store), answers it;
`sessionClientName` keeps its one extra rule (the web app goes by the brand's name). Why it
is simpler: one definition, and the next screen that names a client can't get it wrong.
Implemented by: B2, R4. Status: done.

### M3 — The audit module owns audit targets and the admin-change recorder

As-is: `actorOf`, `userTarget` and `KEYS_TARGET` live in `server/store/audit.ts`; every other
target is built where it is recorded (`graphql/resolvers.ts`, `apis.ts`, `forward-auth.ts`,
`mail.ts`, `oidc/audit-events.ts`, `oidc/interactions.ts`, `core/services.ts`), and "record
what the signed-in admin did" is written four times. To-be: target builders sit beside
`userTarget`; one `recordAdminChange(ctx, type, target, detail?)` serves every GraphQL module.
Why it is simpler: an entry's shape is decided in one module. Implemented by: R5, R6.
Status: done.

### M4 — Backup and restore are one operation; reading an old data directory is the import's

As-is: `server/core/services.ts` holds `BACKUP_LAYOUT` and a restore (check, pick files,
replace, reload, rebuild); `server/backup.ts` (CLI) imports services.ts for the layout and
repeats the export and restore, building its own `DataRestored` entry as `admin/backup.ts`
does. `server/store/backup.ts` also reads an older data directory, which only the import
uses. To-be: the backup module owns the layout and two operations, `exportArchive(store,
options)` and `restoreArchive(store, archive, box)`, which also builds the `DataRestored`
detail; the server's restore adds reloading the stores and rebuilding the provider. The
directory reader lives in `server/db/import.ts`. Why it is simpler: one restore to read and
test; the CLI depends on the backup module, not on every service. Implemented by: T1, T3,
R7, R8. Status: done.

### M5 — Retire "file" as the code's word for a store's document

As-is: every store takes its `DataDocument` as `file`, comments say "as the file holds it",
"model files", "whenever the file is written", and `DocumentMapping.file` is both the row
name in `documents` and the archive path. To-be: a store's data is its **document**; "file"
means only an archive file (or an older data directory's file). The mapping's field is its
`name`, which the archive path equals; the stored values stay (A2). Why it is simpler: P25,
and a newcomer stops looking for files that no longer exist. Implemented by: R12, R13, D6.
Status: open.

### M6 — Rules both sides check have one owner, on the server

As-is: the web copies server values and rules beside a comment naming them:
`MAX_ARCHIVE_BYTES` (`BACKUP_DEFAULTS.maxArchiveBytes`), `MAX_LOGO_BYTES`
(`BRANDING_DEFAULTS.maxLogoBytes`), the site host and upstream ID patterns, and the password
meter's user inputs (an exact copy of `server/core/password-policy.ts:17,49-58`). One copy has
already drifted (B4). To-be: the server module that owns each rule exports it from a module
that imports nothing server-only (`core/defaults.ts` already imports nothing), and the web
imports it; where that can't be, a test holds the two together. Why it is simpler: one
place to change a limit. Needs a decision on web/tsconfig `include` and the Vite build.
Implemented by: B4, R28. Status: open.

---

## Conventions

- Missing lookups and failures: a store throws a coded error (`notFound`, `badInput` from
  `server/core/errors.ts`); GraphQL surfaces its code. HTTP routes answer `{ error }` through
  `sendRefusal` (`server/http/guards.ts`).
- Tunables: `<CONCEPT>_DEFAULTS` groups in `server/core/defaults.ts`; facts (HTTP statuses,
  unit conversions, file modes) in `server/core/wire.ts`.
- Vocabularies: `as const` objects plus a union (`AuditType`, `HttpStatus`); small ones as
  flat `as const` constants (`CLIENT_SOURCE_ADMIN`).
- Store shape: `create<Concept>Store(document, options)` returning an interface; reads are
  synchronous from memory, writes change the document before their first `await`.
- A function's clock: `now: () => number` in epoch milliseconds is the majority (7 stores);
  6 take `() => Date` (R11).
- Events: `audit.onRecord` and oidc-provider's `provider.on(...)`; no other emitter.
- Shared server helpers live in `server/core/`; shared test helpers in `tests/helpers.ts`,
  `tests/db.ts`, `tests/oidc/browser.ts`, `tests/oidc/authenticator.ts`, `tests/fake-s3.ts`,
  `tests/mail/fake-transport.ts`.
- Web: `web/src/components/` and `web/src/lib/` are vendored (cubeui, shadcn); never edit.
- Generated files, never committed: `schema.graphql`, `web/src/__generated__/`,
  `web/src/route-tree.gen.ts` → `npm run codegen`. Committed: `drizzle/` migrations →
  `npm run db:generate`.
- Tests: describe/it everywhere, titles verb first.

## Refactoring

### R1 [reuse] — Extract function: one "signed-in user or 401" middleware, and a typed viewer

**File:** `server/admin/factors.ts:89-95` (`viewerOf`), `server/upstream/routes.ts:68-74`
(`userOf`, the same body), `server/admin/pictures.ts:113-127` (`signedIn`, as middleware),
`server/admin/account.ts:85-89, 106-110, 128-132, 164-168` (inline, four times); readers of
`res.locals.viewer` in `server/admin/pictures.ts:176-200`, `server/admin/backup.ts:112,129`,
`server/http/app.ts:92` (`as PublicUser`). Seven copies of "find the signed-in user or answer
401 'Sign in first.'", and `res.locals` is `any`, so every reader annotates it unchecked
(P17). Target: `requireSignedIn(deps)` beside `requireAdmin` in `server/admin/routes.ts`
(R15 moves it with the account routes), both setting the viewer through one typed
`setViewer(res, user)` / `viewerOf(res)` pair. Buys: removes copies; the one cast moves into
one helper. Line delta: about −40.

### R2 [simplify] — Inline the hand-kept context lists

**File:** `server/core/context.ts:1-40`, `server/http/app.ts:68-94`. `Context` picks 23 of
the services by name and `app.ts` copies the same 23 fields by hand: adding a service means
three edits, and these two files changed 15 and 17 times this year (P14). Target:
`interface Context extends Services { viewer: PublicUser; ip: string | null }` (or `Omit` of
the few a resolver must not see, if the user wants that boundary), built as
`{ ...services, viewer: viewerOf(res), ip: req.ip ?? null }`. Buys: two lists gone in hot
files. Needs: R1 (for `viewerOf`). Line delta: about −45.

### R3 [reuse] — Use what exists: `sendRefusal` in the interaction routes

**File:** `server/oidc/interactions.ts:148-150` (`sendError`, 14 callers) is
`server/http/guards.ts:14-16` (`sendRefusal`) word for word. Target: import `sendRefusal`,
delete `sendError`. Buys: removes an exact copy.

### R4 [reuse] — Consolidate to one owner: the client display name

**File:** `server/admin/admin-client.ts:138`, `server/oidc/pages.ts:89`,
`server/oidc/interactions.ts:221`, `server/oidc/audit-events.ts:107-114`,
`server/admin/account.ts:73-81`. Target: `clientDisplayName(clients, clientId, fallback?)`
next to `builtInClientName`; the four copies call it; `sessionClientName` keeps its brand
rule on top. Implements: M2. Needs: B2 (whether `services.ts`'s registration naming joins).

### R5 [reuse] — Extract function: record what the signed-in admin did

**File:** `server/graphql/resolvers.ts:271-273` (`audit`), `server/graphql/apis.ts:25-28`
(`auditedApi`), `server/graphql/forward-auth.ts:123`, `server/graphql/mail.ts:139`. Four
copies of `ctx.audit.record({ type, actor: actorOf(ctx.viewer), ip: ctx.ip, target, detail })`.
Target: one exported `recordAdminChange(ctx, type, target, detail?)` in a small
`server/graphql/audit.ts` (or in `server/store/audit.ts` taking viewer and ip). Implements: M3.

### R6 [pattern] — Move function: audit target builders beside `userTarget`

**File:** `server/graphql/resolvers.ts:281-320` (`clientTarget`, `groupTarget`,
`pairingTarget`, `SETTINGS_TARGET`, `BRANDING_TARGET`), `server/graphql/apis.ts:14-16`,
`server/graphql/forward-auth.ts` (`siteTarget`, the inline cookie-domain target at 230),
`server/graphql/mail.ts:113` (`MAIL_TARGET`), `server/oidc/audit-events.ts:107`,
`server/oidc/interactions.ts:242,466,529`, `server/core/services.ts:323-338`. Target: the
builders in `server/store/audit.ts` with `userTarget` and `KEYS_TARGET`. Implements: M3.
Needs: R4.

### R7 [pattern] — Move function: the older-data-directory reader to the import

**File:** `server/store/backup.ts:84-234` (`JSON_LINES_EXTENSION` reading, `listDataFiles`,
`readDataFile`, `readDataDirectory`, `isUnder`), whose only caller is `server/db/import.ts:54`.
The backup module reads like it scans a directory for backups, which it no longer does.
Target: they move to `server/db/import.ts`; the archive-checking helpers they share
(`isDataFile`, `parseDataFile`) stay exported from the backup module. The test at
`tests/store/backup.test.ts:186-196` moves in its own commit (T24). Implements: M4.

### R8 [reuse] — Consolidate to one owner: export and restore

**File:** `server/core/services.ts:68-75` (`BACKUP_LAYOUT`), `:349-364` (`backup.create`,
`backup.restore`); `server/backup.ts:41-88` (`exportTo`, `restoreFrom`);
`server/admin/backup.ts:125-140` and `server/backup.ts:69-80` (the `DataRestored` detail, built
twice). Target: `BACKUP_LAYOUT`, `exportArchive(store, options, now?)` and
`restoreArchive(store, archive, box)` (returning the summary and the entry detail) in the
backup module; `services.backup.restore` calls it and then reloads and rebuilds; the CLI
stops importing `core/services.ts`. Implements: M4. Needs: T1, T3. Line delta: about −30.

### R9 [consistency] — Split by concept: the resolver file

**File:** `server/graphql/resolvers.ts` (1,344 lines: clients, pairing, users, groups, keys,
branding, http redirects, password rules, upstreams, provider info, subscriptions),
`server/graphql/type-defs.ts` (445 lines). `mail.ts` and `forward-auth.ts` each hold their
SDL and resolvers; `apis.ts` holds resolvers only, with its SDL in `type-defs.ts`. Target:
`graphql/clients.ts`, `pairing.ts`, `users.ts`, `groups.ts`, `settings.ts` (keys, branding,
redirects, password rules), `upstreams.ts`, `audit.ts` (the subscription), each with its
SDL and resolvers; `apis.ts` takes its SDL; `type-defs.ts` keeps the shared types.
Paths only, then one commit per module. Buys: the file changed most of any GraphQL module
(21 times as `schema.ts`). Needs: T4.

### R10 [simplify] — Delete dead code: the audit store's cursor paging

**File:** `server/store/audit.ts:77-94` (`AuditQuery.after`, `AuditPage.nextCursor`),
`:329-350` (`list`); `server/core/defaults.ts:291-293,301-302` (`AUDIT_DEFAULTS.pageSize`,
`maxPageSize`). The activity list is a generated read now; the only server caller of
`audit.list` is `server/admin/account.ts:111`, which passes `first`, `types` and `userId`.
`after` and `nextCursor` are used only by `tests/store/audit.test.ts:75-79,155`. Target:
`list({ first, types, userId })` returning entries; the defaults lose the two members; the
paging tests go in a `test:` commit first. Buys: dead code left by PR #28.

### R11 [consistency] — One clock: epoch milliseconds

**File:** `() => Date` in `server/store/users.ts:157`, `keys.ts:101`, `branding.ts:54`,
`clients.ts:321`, `apis.ts:130`, `upstreams.ts:304`; `() => number` in `admin-sessions.ts:68`,
`factors.ts:187`, `protected-sites.ts:176`, `audit.ts:280`, `pairings.ts:151`,
`password-links.ts:74`, `proxy-sessions.ts:74` (7 to 6). `server/core/services.ts` passes
`settings.now` to some stores, `now` (declared halfway down, at :245) to others, and
`() => new Date(now())` to three. Target: every store takes `now: () => number`; services.ts
reads `const now = settings.now ?? Date.now` once at the top and passes it everywhere it
passes a clock today. Which stores get a clock stays as it is (a refactor).

### R12 [sweep] — apply P25 across the stores: the document parameter is `document`

Fixing P25, one concept, one name. Every store takes its `DataDocument` as `file`, a word
from the JSON files. One item; approve or decline it whole. Implements: M5.

```
hits - 84
-- files --
server/store/mail.ts (8)
server/store/apis.ts (8)
server/store/password-links.ts (7)
server/store/protected-sites.ts (6)
server/store/keys.ts (6)
server/store/factors.ts (6)
server/store/clients.ts (6)
server/store/settings.ts (5)
server/store/proxy-sessions.ts (5)
server/store/branding.ts (5)
server/store/admin-sessions.ts (5)
server/store/users.ts (3)
server/store/upstreams.ts (3)
server/store/pairings.ts (3)
server/db/documents.ts (4)
server/db/document.ts (2)
server/oidc/provider.ts (1)
server/db/import.ts (1)
```

(`server/db/data-set.ts`, `server/store/backup.ts` and `server/backup.ts` use `file` for
archive files, which is right, and are not counted.)

### R13 [readability] — Rename: the document mapping's `file` is its `name`

**File:** `server/db/document.ts:57-60,95-97,342` (`DocumentMapping.file`, `LooseMapping.file`,
`droppedWrite(file)`), `server/db/documents.ts:44-59,117-125,566-575` (`DOCUMENT_FILES`,
`singleDocument(file, …)`, `oidcModelDocument`), callers in `data-set.ts`, `import.ts`,
`services.ts` and tests. The field is the `documents.name` row key and the archive path at
once. Target: `name`, `DOCUMENT_NAMES`, with a one-line comment that the archive path is the
name. Values unchanged. Implements: M5. Needs: A2.

### R14 [readability] — Rename: the admin session store is the web session store

**File:** `server/store/admin-sessions.ts` (`AdminSessionStore`, `createAdminSessionStore`,
`AdminSessionDocument`), `server/core/services.ts` (`adminSessions`), its readers in
`server/admin/*.ts`, `server/upstream/routes.ts`, `server/core/context.ts`, tests, and
`ADMIN_SESSIONS_DOCUMENT`. Target: `WebSessionStore`, `services.webSessions`,
`web-sessions.ts`. Persisted names unchanged (A1). Implements: M1.

### R15 [pattern] — Move: the account page's routes to `server/account/`

**File:** `server/admin/account.ts`, `server/admin/factors.ts`, the self-service half of
`server/admin/pictures.ts` (`/admin/account/picture`), `signedInUser` and R1's
`requireSignedIn` from `server/admin/routes.ts`. Target: `server/account/account.ts`,
`factors.ts`, `pictures.ts`, `session.ts`; `server/admin/` keeps sign-in, setup, backup,
`requireAdmin`, the admin's picture route. Tests move in their own commit. Paths only.
Implements: M1. Needs: R1.

### R20 [reuse] — Consolidate: web query keys and the refetch helper

**File:** `web/src/core/admin.ts:72-101`, `web/src/core/protected-sites.ts:13-28` (an exact
copy of `refetching`, and `['groups']` declared again at :17), `web/src/core/apis.ts:13-28`
(`['clients']` declared again to avoid a circular import, and `refetchApisAndClients`),
`web/src/core/mail.ts:17-38`, `web/src/core/factors.ts:6,47-55`, `web/src/core/pictures.ts:12-13`;
inline keys `['zxcvbn']`, `['interaction', uid]`, `['forgot-password', uid]`,
`['password-link', token]`, `['backup']`. Target: `web/src/core/query-keys.ts`, importing
nothing, with every key and one `refetching(queryClient, ...keys)`.

### R21 [consistency] — Split by concept: `web/src/core/admin.ts`

**File:** `web/src/core/admin.ts:1-833`. APIs, mail, protected sites, factors, pictures and
backup already have `core/<concept>.ts`; the rest sit in one module named for a role.
Target: `core/clients.ts`, `users.ts`, `groups.ts`, `pairing.ts`, `keys.ts`, `settings.ts`,
`branding.ts`, `audit.ts`, `upstreams.ts`. Paths only. Changed 17 times this year. Needs: R20.

### R22 [reuse] — Extract: the shared reply schemas

**File:** `web/src/core/account.ts:44-45`, `web/src/core/mail.ts:132`,
`web/src/core/admin.ts:105` (`signOutSchema`), `web/src/core/backup.ts:15` (`restoredSchema`),
`web/src/routes/login.$uid.tsx:40` (`resultSchema`). `{ok: true}` and `{redirectTo}` five
times under four names. Target: `okReplySchema`, `redirectReplySchema` in
`web/src/core/json-reply.ts`.

### R23 [reuse] — Move: the sign-in page's fetching into `web/src/core/sign-in.ts`

**File:** `web/src/routes/login.$uid.tsx:51-88` (`SignInRefusal`, `post`), `:122-133` (the
details query), `web/src/core/mail.ts:103-152`. `post` rebuilds `postJson` + `jsonReply`,
adding a `restart` flag; the details query copies `jsonReply`'s error reading. Target: the
core module, on `jsonReply` with an error class that keeps the reply's extra fields.
Needs: T13, B5.

### R24 [reuse] — Extract function: read a URL fragment parameter

**File:** `web/src/routes/setup.tsx:32-34`, `web/src/routes/set-password.tsx:25-27` (exact
copies of `tokenFromLink`), `web/src/core/mail.ts:114` (the same for `uid`). Target:
`fragmentParam(name)` in `web/src/core/`.

### R25 [readability] — Move: errors and claims out of `web/src/core/lists.ts`

**File:** `web/src/core/lists.ts:35-37` (`messageOf`, imported by 27 files), `:51-76`
(`claimsOf`, `claimsText`, `claimsProblem`). A module called "lists" holds an error helper and
the claims parser; vendored `web/src/lib/error-message.ts` has its own `messageOf` with other
behavior. Target: `core/errors.ts` (or `json-reply.ts`) and `core/claims.ts`.

### R26 [reuse] — Extract component: the form dialogs' "not saved" alert

**File:** `web/src/clients/client-form-dialog.tsx:78-81,342`,
`web/src/apis/api-form-dialog.tsx:86-89,182`, `web/src/users/user-form-dialog.tsx:43-46,133`,
`web/src/sites/site-form-dialog.tsx:28-31,107`, `web/src/upstreams/upstream-form-dialog.tsx:277`.
Five copies of `failure = isEdit ? update.error : create.error` and the same alert. Target:
`<SaveFailure error={…} />`, optionally `useSaveMutations(isEdit, create, update)`.

### R27 [consistency] — Move: the settings sections to their concept folders

**File:** `web/src/routes/settings.tsx:58-445` (BrandingSection, UpstreamsSection,
KeysSection, RedirectUrisSection, PasswordRulesSection, `dataUrlOf`). Mail and backup
sections already live in `web/src/mail/` and `web/src/backup/`. Target:
`branding/branding-section.tsx`, `upstreams/upstreams-section.tsx`, … Paths only.

### R28 [reuse] — Use what exists: the web imports the server's rules

**File:** `web/src/backup/backup-section.tsx:18` (`MAX_ARCHIVE_BYTES`),
`web/src/routes/settings.tsx:48` (`MAX_LOGO_BYTES`), `web/src/core/admin.ts:650`
(`AUDIT_PAGE_SIZE`, likely `OPERATION_LIMIT_DEFAULTS.defaultPageSize`; unverified),
`web/src/passwords/strength.ts:17,47-50` (copy of `server/core/password-policy.ts:17,49-58`),
`web/src/sites/site-form-dialog.tsx:12` (`HOST_PATTERN`), `web/src/upstreams/upstream-form-dialog.tsx:22`
(`ID_PATTERN`). Target per M6. Implements: M6. Needs: B4.

---

## Tests

### T1 [pin] — A restore brings back every store

**File:** `tests/store/backup.test.ts`, `tests/backup.test.ts`. After a restore the tests
check users, clients, APIs, keys, web sessions and mail; factors, upstreams, protected sites,
branding, settings, pairings and password links are never checked, so a store opened without
`tracked(...)` in `services.ts` would keep stale data unnoticed. Pin: fill every store, back
up, change each, restore, assert each matches. Before R8 and any `services.ts` change.

### T2 [pin] — Boot refuses a wrong key for every sealed store

**File:** `tests/core/sealed-data.test.ts:99`, `tests/mail/mail.test.ts`. `checkSecrets` runs
for five stores; clients, keys and mail are tested, factors and upstreams are not.

### T3 [pin] — The backup CLI's flags

**File:** `tests/backup.test.ts`. `export --sessions`, and `restore` given a flag (usage,
exit 1), are untested. Before R8.

### T4 [pin] — Hand-written GraphQL fields no test names

**File:** `tests/graphql/schema.test.ts` or per-concept files. Mutations `rotateClientSecret`,
`unlinkUserUpstream`; queries `signOutUrl`, `upstreamRedirectUri`, `tokenLifetimeDefaults`,
`apiLifetimeBounds`, `maxNameLength`. Before R9.

### T5 [consistency] — One timeout for tests that boot a server

**File:** `vitest.config.ts` (no `testTimeout` / `hookTimeout`), `tests/backup.test.ts:16-18`
and `tests/store/backup.test.ts:33` (constants of their own). Every baseline failure was a test
that boots services or PGlite under load: `tests/core/sealed-data.test.ts:118`,
`tests/db/data-set.test.ts`, `tests/oidc/audit.test.ts:162`, `tests/web/presets.test.ts:58`,
the hook in `tests/upstream/sign-in.test.ts`. Target: the timeouts once in `vitest.config.ts`,
or one `BOOT_TIMEOUT_MS` in `tests/helpers.ts`. Buys: a green baseline.

### T6 [readability] — Audit tests count only what they made

**File:** `tests/oidc/audit.test.ts:43-55,259-266`. One app is shared through `beforeAll`;
"filters by type and by user" expects three `SIGN_IN_FAILED` entries made by earlier tests
(195, 212). In the baseline the subscription test failed (ECONNRESET), made one fewer, and
this test failed too. Target: each test makes the entries it counts.

### T7 [reuse] — `withTotp`

**File:** `tests/forward-auth/verify.test.ts:78-81`, `tests/oidc/two-factor.test.ts:113-116`
(exact copies). Target: `tests/oidc/authenticator.ts`.

### T8 [reuse] — `signInToWebApp`

**File:** `tests/admin/account.test.ts:20-30`, `tests/admin/pictures.test.ts:40-45`,
`tests/oidc/browser.ts:133-145` (`signInAsAdmin`). They differ in whether they create the user,
assert the 303, and return the landing. Target: `signInToWebApp(app, username, password?)`
returning `{ browser, landing }`; `signInAsAdmin` uses it.

### T9 [reuse] — One test-services opener

**File:** `tests/core/sealed-data.test.ts:32-37`, `tests/store/backup.test.ts:63-72`,
`tests/backup.test.ts:58-70` (`withDataDir`). They differ in the database they take and in
waiting for writes and cleanup. Target: `openTestServices(database, keys?)` in
`tests/helpers.ts`.

### T10 [readability] — Type the device flow reply once

**File:** `tests/oidc/device-flow.test.ts:36-47` (`postForm` returns `Record<string, unknown>`),
`as unknown as DeviceAuthorization` at 220, 301, 313, 329, 339, 366, 388, 424, 432. Target:
`startDevice` returns a typed body and holds the one assertion.

### T11 [readability] — No fixed sleeps before "nothing was sent"

**File:** `tests/mail/forgot-password.test.ts:88,113`, `tests/mail/mail.test.ts:178,202`.
A 50 ms sleep, then "no mail". Under load it passes without proving anything. Target: wait for
a signal that the work finished (unverified that one exists; may need a seam).

### T12 [readability] — One layer per backup behavior

**File:** `tests/backup.test.ts:71-107`, `tests/store/backup.test.ts:198-266`,
`tests/admin/backup.test.ts:62+`. The round trip and key checks are asserted three times.
Target: services-level checks in `tests/store/backup.test.ts`; `tests/backup.test.ts` keeps
the CLI; `tests/admin/backup.test.ts` the HTTP parts (cookie cleared, `redirectTo`,
`via: web`).

### T13 [pin] — The web's core helpers

**File:** new `tests/web/`. Pin `jsonReply` (`web/src/core/json-reply.ts`: success, `{error}`,
non-JSON), `post` in `web/src/routes/login.$uid.tsx` (the `restart` flag), `auditWhere` and
`withNewEntry` in `web/src/core/admin.ts`. Before R20–R23.

### T14 [consistency] — Split the forward-auth headers test

**File:** `tests/forward-auth/headers.test.ts`. It covers `trust.ts`, `request.ts` and
`returns.ts`; there is no forward-auth headers module, and `server/http/headers.ts` is
something else. Target: `trust.test.ts`, `request.test.ts`, `returns.test.ts`.

### T15 [readability] — Close the second database in `finally`

**File:** `tests/db/data-set.test.ts:68-76`. `target.close()` runs only when the assertions
pass; a failure leaks a database into the file's pool.

---

## Docs

### D1 — One project guide

**File:** `AGENTS.md` (127 lines), `CLAUDE.md` (170 lines). AGENTS.md was last changed on
2026-10-20 and still says the server "keeps everything in flat JSON files", lists
`server/store/json-file.ts` (gone) and `graphql/schema.ts` (now `build-schema.ts`,
`resolvers.ts`, `type-defs.ts`), and has no `server/db/`. CLAUDE.md has the database but lacks
what AGENTS.md has on device flow and pairing offers. Target: one file holds the guide (say
AGENTS.md) and the other is a one-line pointer to it; the concepts link
`.agents/domain-model.md` rather than repeat it.

### D2 — CLAUDE.md is missing modules and still names JSON files

**File:** `CLAUDE.md:48-62`. Lacks `server/oidc/device-flow.ts`, `pairing-offers.ts`,
`code-exchange.ts`, `pages.ts`, `/device` in the routes and `tests/oidc/device-flow.test.ts`;
`provider.ts`'s entry repeats "each read per token so a client's own `tokenLifetimes` win"
twice; `apis.json`, `factors.json`, `upstreams.json`, `mail.json`, `settings.json` are named as
where data lives (lines 50, 56, 128, 132, 148, 150), which are now document names. Needs: D1.

### D3 — README describes flat-file storage

**File:** `README.md:12` ("Flat-file storage… There is no database"), `:246` (`DATA_DIR`:
"Where the JSON files are written"), `:282-283` (delete `keys.json`, edit `clients.json` by
hand), `:336-361` ("Your data": a list of JSON files, audit rotation at 1 MB, "mode 0600",
"Back up the folder"). It never mentions `DATABASE_URL`, PGlite, Postgres, migrations or
`imported-json/`. An operator following the recovery steps would edit files that no longer
exist. Target: describe PGlite under `DATA_DIR/pg` or Postgres by `DATABASE_URL`, backups
through Settings or `npm run backup`, and recovery steps that work.

### D4 — The docs site says "a few JSON files instead of a database"

**File:** `site/src/index.njk:37`, `site/src/_data/site.js:6`.

### D5 — Forward-auth docs name `proxy-sessions.json`

**File:** `docs/forward-auth.md:290`. Now a table (`proxy_sessions`), still left out of backups.

### D6 [sweep] — Comments that say "the file" for a document

Implements M5. Examples: `server/oidc/adapter.ts:176-185` ("Keeps one model's artefacts in its
file", "whenever the file is written"), `server/oidc/host.ts:6` ("model files"),
`server/core/defaults.ts:522` ("so not every request writes the file"),
`server/store/protected-sites.ts:33,40` ("A new site's empty file"),
`server/store/proxy-sessions.ts:6,21`, `admin-sessions.ts:13`, `password-links.ts:13`,
`settings.ts:9`, `clients.ts:257,314`, `users.ts:138`, `tests/store/clients.test.ts:36`.
Count per file to be taken when approved (an automatic count mixes in archive files).

### D7 — `server/db/document.ts`'s header comment is history

**File:** `server/db/document.ts:1-9`. Nine lines on how the stores were written over JSON
files. Target (P19): two lines: a store's data is a document in memory, changed at once and
written through in order; one process owns the database. The history is in PR #28.

### D8 — The web's backup section describes the data directory

**File:** `web/src/backup/backup-section.tsx:41` ("as they are on disk", "as safe as the data
directory"), `:84` ("An archive of the data directory: clients, users, …", leaving out APIs,
upstreams, mail settings, protected sites). Coordinate with the UX pass. Needs: B7 for the
overview's sentence.

### D9 — `invalid_scope` lists only the built-in scopes · low value

**File:** `web/src/provider/error-copy.ts:30-33`. APIs add scopes of their own.

### D10 — `refetching`'s `@param` · low value

**File:** `web/src/core/admin.ts:93-98`. Says `@param key`; the parameter is `...keys`.
Needs: R20 (which may replace it).

---

## Bugs

### B1 — The generated activity list doesn't wait for queued entries

**File:** `server/graphql/build-schema.ts:121` (the generated `auditEntries` read) against
`server/graphql/resolvers.ts:813` (the subscription calls `await ctx.audit.settled()`) and
`server/store/audit.ts` (`list` runs on the queue). `audit.record` is fire-and-forget, so an
entry recorded just before a query can be missing from it. CLAUDE.md says the log's reads wait.
Intended? If not: the one field waits for `audit.settled()` before reading (a resolver wrapper
in `build-schema.ts`). Found by reading; not shown to cause a baseline failure.

### B2 — A registration's entry names the client differently

**File:** `server/core/services.ts:323-338` names it `client.clientName ?? stored name ??
clientId`; every other entry uses built-in name, else stored name, else the request's name,
else the ID (`server/oidc/audit-events.ts:107-114`). For a deleted registration only the first
form has a name to show. Intended? If yes, R4 leaves it apart with a comment; if no, a `fix:`
aligns it first.

### B3 — Two servers can share one Postgres

**File:** `server/db/client.ts:73-80,114-121`. PGlite gets a pid lock; Postgres gets nothing.
CLAUDE.md says "one server process per database", and each store keeps its document in
memory, so a second process (a scaled compose service, a forgotten container, `npm run backup
-- restore` against a running server) overwrites the first's rows from stale memory. Intended
behavior: refuse to start while another holds the database, for instance with
`pg_try_advisory_lock` held for the process's life. A `fix:` with a test.

### B4 — The web's host check accepts hosts the server refuses · low value

**File:** `web/src/sites/site-form-dialog.tsx:12` against `server/store/protected-sites.ts:10`.
The server's pattern limits a label to 63 characters and the host to 253; the web's doesn't, so
the form passes and the save fails. Fix as part of M6, or align the web copy first.

### B5 — The sign-in page reads replies its own way

**File:** `web/src/routes/login.$uid.tsx:73-88` against `web/src/core/json-reply.ts:12-19`.
`post` keeps `restart` and throws `SignInRefusal`; `jsonReply` throws a plain `Error` and
drops extra fields. Probably intended (only sign-in has `restart`); if so, R23 makes
`jsonReply`'s error carry the body.

### B6 — Edit dialogs disagree on keeping Save off until something changes

**File:** `requireChanges` on in `web/src/apis/api-form-dialog.tsx:189`,
`web/src/upstreams/upstream-form-dialog.tsx:285`, `web/src/mail/mail-section.tsx:159`; off in
`web/src/clients/client-form-dialog.tsx:350`, `web/src/users/user-form-dialog.tsx:140`,
`web/src/sites/site-form-dialog.tsx:114`. Intended? The UX pass may own the answer.

### B7 — The overview always warns secrets are plain text

**File:** `web/src/routes/index.tsx:54-58`. "The data directory holds client secrets and
signing keys in plain text" shows even when `SECRET_KEY` seals them, and the data is in a
database now. Target: show it only when the backup query's `isSealed` is false, in words
about the database.

### B8 — The web's GraphQL reply is cast, not checked · low value

**File:** `web/src/core/gql.ts:79,178`. The only assertions in the app's own web code;
replacing them with a check adds runtime behavior (P17).

---

## API changes (need a decision)

### A1 — The web session's persisted and public "admin" names

With M1, these keep their spelling unless the user asks (P27): the `admin_sessions` table, the
`admin-sessions.json` document name and archive path, the `heautou_admin` cookie (renaming
signs everyone out), and the `/admin/account/*`, `/admin/login`, `/admin/callback`,
`/admin/logout` URLs the web app calls. Proposal: keep all of them; only code names change.

### A2 — The stored document names keep their JSON-era values

`documents.name` holds `keys.json`, `settings.json`, … and archives use the same paths, which
older backups depend on (`BACKUP_VERSION` 1). Renaming the values needs a migration and an
archive version 2 that still reads version 1. Proposal: keep them; R13 renames only the code.

---

## Low value

### R16 [reuse] — One mapping for hashed-token documents

**File:** `server/db/documents.ts` (`PASSWORD_LINKS_DOCUMENT` and `ADMIN_SESSIONS_DOCUMENT`
are the same mapping over two tables: token hash, user, expiry). Target:
`hashedTokenDocument(name, table)`. Two concepts that may part ways; merge only if they
change together.

### R17 [simplify] — `documentFromRows` reuses `loose.fromRows`

**File:** `server/db/document.ts:333-334` repeats the padding `loosen` already does at :124-125.

### R18 [simplify] — `Map.groupBy` for model rows

**File:** `server/db/data-set.ts` (`exportFiles`, the `byModel` loop copies the array per row).

### R19 [readability] — Type what `toRows` takes

**File:** `server/db/documents.ts` (`?? ''`, `?? []`, `?? false` on fields the store's types
say are always there), `server/db/document.ts:118-120` (the cast in `loosen`). The defaults
are for older files read on import and restore; the types say they can't happen. Target: the
loose side takes a `Partial`-shaped older document, so the defaults read as what they are.

### R29 [reuse] — One "name=value" line parser

**File:** `web/src/core/lists.ts:51-76`, `web/src/upstreams/upstream-form-dialog.tsx:38-60`.
`pairsOf(text, separator)`, each caller keeping its own rule (claims allow an empty value,
group mappings don't).

### R30 [consistency] — Split `useSaveUpstream({ isNew })`

**File:** `web/src/core/admin.ts:788-798`. The only save hook with a mode flag. Needs: R21.

### R31 [consistency] — `UPSTREAM_KINDS` lookup table

**File:** `web/src/upstreams/upstream-form-dialog.tsx:14-35` (`kindOf`, a ternary),
`web/src/routes/settings.tsx:203` (the "GitHub" label again). Like `AUTH_METHODS` and
`TOKEN_FORMATS` (P24).

### R32 [pattern] — Move `web/src/clients/durations.ts`

Imported by `web/src/apis/api-form-dialog.tsx:2` and `web/src/routes/apis.tsx:5` too; it is
about token lifetimes, not clients.

### R33 [reuse] — The web's 401 and sign-in paths once

**File:** `web/src/core/gql.ts:7-14`, `web/src/core/account.ts:5-8`.

### R34 [readability] — Name the condition in `withNewEntry`

**File:** `web/src/core/admin.ts:695-705` (three checks in one `if`, and an `e`).

### R35 [readability] — `usePairing`'s re-render trick

**File:** `web/src/core/admin.ts:378-405` (`void query.dataUpdatedAt;`, and
`[...KEYS.pairings, id]` instead of the `queryKey` local). Unverified whether still needed.

### R36 [simplify] — Unexport two web constants

`ACCOUNT_LOGIN` (`web/src/core/account.ts:6`), `SCORE_LABELS`
(`web/src/passwords/strength-meter.tsx:6`). The app is private, so not an A item.

### R37 [sweep] — apply P15 across the web: drawn-or-not pieces use `&&`

Fixing P15's JSX rule. The web consistently writes `{cond ? <X /> : null}`. Up to 161
null-branch ternaries in `.tsx`, at least 83 confirmed JSX (the rest may be prop values that
stay). Counts are of candidate ternaries, to be confirmed when approved.

```
hits - 161 (83 confirmed)
-- files --
web/src/routes/settings.tsx (16)
web/src/routes/users.tsx (14)
web/src/routes/clients.tsx (13)
web/src/routes/sites.tsx (11)
web/src/mail/mail-section.tsx (11)
web/src/account/two-factor.tsx (10)
web/src/users/password-link-dialog.tsx (7)
web/src/routes/login.$uid.tsx (7)
web/src/routes/apis.tsx (6)
web/src/routes/account.tsx (6)
web/src/clients/pair-dialog.tsx (6)
web/src/backup/backup-section.tsx (6)
web/src/routes/error.tsx (5)
web/src/clients/client-form-dialog.tsx (4)
web/src/users/user-form-dialog.tsx (3)
web/src/routes/groups.tsx (3)
web/src/routes/device.tsx (3)
web/src/routes/activity.tsx (3)
web/src/pictures/picture-setting.tsx (3)
web/src/clients/preset-panel.tsx (3)
web/src/users/linked-accounts-dialog.tsx (2)
web/src/upstreams/upstream-form-dialog.tsx (2)
web/src/routes/setup.tsx (2)
web/src/routes/index.tsx (2)
web/src/mail/forgot-password.tsx (2)
web/src/apis/api-form-dialog.tsx (2)
web/src/account/linked-accounts.tsx (2)
web/src/users/sessions-dialog.tsx (1)
web/src/users/password-dialog.tsx (1)
web/src/sites/site-form-dialog.tsx (1)
web/src/sites/proxy-snippet.tsx (1)
web/src/routes/set-password.tsx (1)
web/src/routes/logout.tsx (1)
web/src/groups/rename-group-dialog.tsx (1)
```

### R38 [sweep] — apply P16 across the web: GraphQL enum members by name

Fixing P16. `'PAIRED'`, `'GITHUB'`, `'OIDC'`, `'JWT'`, `'USER'`, `'CLIENT_SECRET_BASIC'` are
compared and built as strings; `codegen.ts` sets `enumsAsTypes: true`, so no names exist. The
fix is codegen's `enumsAsConst`, which changes generated output.

```
hits - 15 comparisons, plus defaults and fallbacks
-- files --
web/src/upstreams/upstream-form-dialog.tsx (6)
web/src/routes/settings.tsx (2)
web/src/routes/clients.tsx (2)
web/src/mail/mail-section.tsx (2)
web/src/core/admin.ts (2)
web/src/routes/apis.tsx (1)
```

### R39 [sweep] — apply P22 across the web: a defaults module

Fixing P22. The web has no defaults module. Tunables: `OFFER_POLL_MS`, `OFFER_POLLS`
(`web/src/core/admin.ts:352,354`), `RESUBSCRIBE_MS` (`web/src/core/gql.ts:94`),
`AUDIT_PAGE_SIZE` (`web/src/core/admin.ts:650`, see R28), `QR_SIZE`
(`web/src/account/two-factor.tsx:33`). Target: groups in `web/src/core/defaults.ts`.

```
hits - 5
-- files --
web/src/core/admin.ts (3)
web/src/core/gql.ts (1)
web/src/account/two-factor.tsx (1)
```

### R40 [sweep] — P4 on components: `@param props`, after a ruling

`cubicecho_typescript` asks every component for `@param` and `@returns`; P4 (declined
alternative, 2026-10-02) says a component takes its summary alone. The repo follows the org
skill. Decide which wins first.

```
hits - 35 `@param props -` lines (more as `@param props.x`)
-- files --
web/src/clients/pair-dialog.tsx (4)
web/src/account/two-factor.tsx (4)
web/src/clients/preset-panel.tsx (4)
web/src/routes/sites.tsx (3)
web/src/upstreams/upstream-form-dialog.tsx (2)
web/src/mail/mail-section.tsx (1)
web/src/pictures/picture-setting.tsx (1)
web/src/core/brand.tsx (1)
web/src/mail/forgot-password.tsx (1)
web/src/users/password-link-dialog.tsx (1)
web/src/clients/client-form-dialog.tsx (1)
web/src/users/user-form-dialog.tsx (1)
web/src/users/picture-dialog.tsx (1)
web/src/sites/proxy-snippet.tsx (1)
web/src/routes/__root.tsx (1)
web/src/users/sessions-dialog.tsx (1)
web/src/users/password-dialog.tsx (1)
web/src/users/linked-accounts-dialog.tsx (1)
web/src/routes/apis.tsx (1)
web/src/backup/backup-section.tsx (1)
web/src/groups/rename-group-dialog.tsx (1)
web/src/routes/clients.tsx (1)
web/src/routes/index.tsx (1)
```

### T16 [reuse] — `newSecretKeys()`

`newKey` in `tests/core/secret-box.test.ts`, `tests/core/sealed-data.test.ts`,
`tests/store/backup.test.ts`; `randomBytes(SECRET_KEY_BYTES)` 10 more times in 6 files.

### T17 [reuse] — `createTestUser(app, overrides?)`

`users.create({ …, email: '', name: '', groups: [] })` 24 times in 22 files.

### T18 [readability] — The local `postJson`

`tests/admin/account.test.ts:39` returns `{ status, body }`; `tests/oidc/browser.ts:31`'s
returns a `Response`.

### T19 [reuse] — One `locationOf`

`tests/oidc/device-flow.test.ts:84-90` throws without a redirect; `tests/oidc/pages.test.ts:18-21`
asserts a 303 and falls back to `''`. Decide whether the 303 check is wanted everywhere.

### T20 [consistency] — Document names by constant

`tests/store/backup.test.ts:155-166,172,181,194,297,302`, `tests/admin/backup.test.ts:71`
write `'users.json'` and the like; `tests/db/data-set.test.ts` uses `DOCUMENT_FILES`.

### T21 [consistency] — `isSealed()` instead of `'enc:v1:'`

`tests/core/sealed-data.test.ts:15,93`, `tests/store/upstreams.test.ts:157`,
`tests/store/factors.test.ts:95`, `tests/mail/mail.test.ts:89`, `tests/store/backup.test.ts:160-162`.

### T22 [readability] — vitest's message text

`tests/oidc/audit.test.ts:212` (`rejects.toThrow(/expected 401 to be 200/)`).

### T23 [readability] — Casts in `catch`

`tests/backup.test.ts:43`, `tests/store/backup.test.ts:142`.

### T24 [consistency] — Test files mirror their modules

`tests/web/presets.test.ts`, `tests/web/proxy-snippets.test.ts` (sources in
`web/src/clients/`, `web/src/sites/`), `tests/core/sealed-data.test.ts` (tests
`server/store/sealed-document.ts` and services), `tests/store/backup.test.ts:186-196` (the
directory reader, which R7 moves). Paths only. Needs: R7 for the last.

### T25 [consistency] — `tests/oidc/browser.ts` to `tests/browser.ts`

Imported from 11 folders.

### T26 [readability] — Proxy snippet test titles

`tests/web/proxy-snippets.test.ts:58-126` ("HAProxy: …"). Verb first.
