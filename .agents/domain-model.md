# Domain model

What heautou is made of: its concepts, who may change them, and what always holds. This
file lives at `.agents/domain-model.md` and describes the code **as it is on this branch**.
Proposed changes are `M` items in `.agents/coding-standards-todos.md` and in the pull
request that makes them; they are written in here by the commit that makes them true. The
one exception is an approved rename: the glossary uses the new word at once and says, after
`Owner:`, what the code still calls it and which item renames it. Use these terms, and
only these, in code, tests, docs and reviews.

## Purpose

Heautou gives the apps on a self-hosted network one shared sign-in: an OpenID Connect
provider with an admin UI for its operator, an account page for each user, and forward auth
for sites that can't speak OpenID Connect themselves.

## Flow

```
app → /oidc/auth → interaction → sign-in page → (password | passkey | upstream) → second factor → grant → code → app
admin UI → web sign-in (built-in client heautou-admin) → web session → /graphql → store → document → tables
reverse proxy → /auth/verify → proxy session → grant still stands? user allowed? → 200 + Remote-* headers
app (setup URL) → /oidc/reg with the pairing's token → registration policy → client store (source: paired)
store change → document in memory → write queue → tables;  audit.record → write queue → audit_entries
backup: data set → archive (files) → restore: check → data set replaces all → stores reload → provider rebuilt
```

Dependencies point from the HTTP doors (`http/`, `admin/`, `account/`, `oidc/`,
`forward-auth/`, `upstream/`, `mail/`, `graphql/`) to the stores (`store/`), and from the stores to the
document layer (`db/`). `core/services.ts` builds everything and is the only module that
knows every store. The provider reads stores from memory on every request.

## Actors

Who can change things, and through what. Read from the guards, not the docs.

| Actor | Is | Reaches the system through | May change |
|---|---|---|---|
| Operator (admin) | A user in the `ADMIN_DEFAULTS.group` group | A web session, `requireAdmin` on `/graphql` and `/admin/backup`, `/admin/restore` | Every client, user, group, API, upstream, protected site, key, setting, branding and mail setting; backups and restores |
| Signed-in user | Any enabled user with a web session | `/admin/account/*` routes (`requireSignedIn`) | Their own profile, password, second factors, profile picture, sessions and upstream links |
| Anyone in a browser | Nobody signed in | The interaction routes, `/setup`, `/set-password`, forgot password | Sign in; make the first admin while `setup.ts` allows; set a password with a valid password link; ask for a reset link when it is on |
| App (client) | A registered OIDC client | `/oidc/*` (oidc-provider) | Its own grants and tokens; with a setup URL's token its own registration (RFC 7591), then its registration through RFC 7592 |
| Reverse proxy | An address `createProxyTrust` believes | `/auth/verify`, `/auth/sign-in`, `/auth/callback`, `/auth/sign-out` | Proxy sessions (by signing a user in or out) |
| Upstream provider | Another OIDC provider or GitHub | `/upstream/:id/callback` | Nothing itself; its answer may create a user or link an identity, as the upstream's settings allow |
| The server | The running process | Boot and timers | Makes keys on first boot, rotates them at boot when due, imports an older data directory once, prunes the audit log |
| Shell operator | Someone with the data, the server stopped | `npm run backup`, `npm run db:migrate` | Replaces all data from an archive; applies migrations |

## Lifecycles

### User

```
invited (no password) --password link used, by the user--> active
active --disabled, by an admin--> disabled --enabled--> active
any --deleted, by an admin--> gone (picture deleted, sessions ended, logout tokens sent)
```

An admin may also create a user with a password. A disabled user's sessions and tokens are
ended when they are disabled. Owner: `server/store/users.ts`.

### Client

```
created by an admin (source admin) | registered through a setup URL (source paired)
--updated by an admin, or by the app through RFC 7592--> ... --deleted by either--> gone
```

A removed client is taken off every API (`onRemove`). Clients saved before a stricter
redirect URI rule keep working and are flagged (`refusedRedirectUris`).

### Pairing (setup URL)

```
started by an admin (WAITING, token valid PAIRING_DEFAULTS.linkSeconds)
--app registers with the token--> PAIRED --admin finishes it (sets up offers)--> finished
WAITING --expires | cancelled by an admin--> gone
```

Owner: `server/store/pairings.ts`, `server/oidc/pairing.ts`; the view's state is
`PAIRING_WAITING`/`PAIRING_PAIRED` in `server/graphql/resolvers.ts`.

### Keys

```
made on first boot --rotationDays old at boot, or rotated by an admin--> new current key, keptKeys older ones kept
```

Owner: `server/store/keys.ts`; the provider host rebuilds when the key ids change.

### Sign-in (interaction)

```
/oidc/auth --login prompt--> sign-in page --password ok--> (second factor asked --code|passkey ok-->) grant
--consent granted on the spot--> code to the app
```

Waiting sign-ins and passkey challenges live in memory only. Owner:
`server/oidc/interactions.ts`.

### Web session

```
web sign-in (PKCE, swapped in-process) --cookie heautou_admin--> live --expires | sign-out | restore--> gone
```

Owner: `server/store/web-sessions.ts` (`WebSessionStore`); it is held by every signed-in
user, admin or not.

### Proxy session

```
/auth/callback --> live --touched at most every touchSeconds--> ... --sessionSeconds | idleSeconds | grant gone--> refused
```

Owner: `server/store/proxy-sessions.ts`, `server/forward-auth/routes.ts`.

### Document write

```
store method changes the document in memory (before its first await)
--write queue runs the row difference--> saved | failed (document put back as the tables hold it,
later changes made on top of it dropped)
```

Owner: `server/db/document.ts`. A restore reloads every tracked document
(`services.ts`, `tracked`).

### Audit entry

```
recorded (fire and forget, on the write queue) --> saved | logged as failed --past keptEntries--> pruned
```

Owner: `server/store/audit.ts`.

## Invariants

| Invariant | Enforced by |
|---|---|
| A username is unique | `server/store/users.ts` (`create`, `update`) |
| There is always an enabled admin once one exists | `server/store/users.ts` (`isLosingLastAdmin`) |
| A redirect or back-channel logout URI is https, loopback http or a public client's own scheme, unless Settings allow plain http | `server/store/redirect-uris.ts`, checked by the client store on save and by the pairing policy |
| With `SECRET_KEY`, client secrets, private keys, authenticator secrets, upstream secrets and the SMTP password are sealed in the tables | `server/store/sealed-document.ts`; boot's `checkSecrets` in `services.ts` refuses a wrong key before writing |
| Passwords, web and proxy session tokens, password-link tokens and recovery codes are stored hashed | each store (`users.ts`, `web-sessions.ts`, `proxy-sessions.ts`, `password-links.ts`, `factors.ts`) |
| The GraphQL schema never names a hash or sealed column | `SERVER_TABLES` and `SECRET_COLUMNS` in `server/graphql/build-schema.ts` |
| No generated GraphQL write: every change goes through a store | `features` in `server/graphql/build-schema.ts` |
| A store's check-then-change is atomic | each store changes its document before its first `await` (`document.ts` applies it synchronously) |
| Writes reach the tables in the order they were made, across stores | one `WriteQueue` per database (`createWriteQueue`, built once in `services.ts`) |
| One server process per database | PGlite only: the pid lock in `server/db/client.ts`. Nothing enforces it on Postgres (see the ledger) |
| `/graphql`, admin POSTs and the login POST take only same-origin JSON | `sameOriginJson` / `sameOriginPost` in `server/http/guards.ts` |
| A setup URL works once, for `PAIRING_DEFAULTS.linkSeconds` | `server/oidc/pairing.ts`, `server/store/pairings.ts` |
| A user outside a client's `allowedGroups`, or disabled, gets no code | `findAccount` in `server/oidc/provider.ts`, the `account_refused` policy check |
| A protected site that requires a second factor sees only `acr` `mfa` sessions | `server/forward-auth/routes.ts` |
| A restore writes nothing unless every file parses and every sealed value opens | `readBackup` in `server/store/backup.ts`, then one transaction in `server/db/data-set.ts` |

## Glossary

### Signing in

- **Provider (issuer):** heautou itself, as apps see it: the OpenID Connect provider at the
  issuer URL ending in `/oidc`. Owner: `server/oidc/provider.ts`, `server/oidc/host.ts`
  (`ProviderHost`, rebuilt when keys or claim names change).
- **App (client):** an application that signs its users in through heautou. It has a client
  ID, redirect URIs and, unless it is public, a secret. Owner: `server/store/clients.ts`
  (`OidcClient`); `source` says whether an admin added it or it paired.
- **Built-in client:** a client heautou registers for itself and that never shows in the
  client list: `heautou-admin` for the web app and `heautou-proxy` for forward auth. Owner:
  `server/admin/admin-client.ts`, `server/forward-auth/client.ts`.
- **Preset:** a ready-made starting point for adding a common app as a client: its callback
  paths, auth method and what to set in the app. Owner: `web/src/clients/presets.ts`;
  the client keeps its `preset` id.
- **Sign-in (interaction):** one attempt to sign a user in for an app: the password, passkey
  or upstream step, then a second factor when the user has one. Owner:
  `server/oidc/interactions.ts`, `web/src/routes/login.$uid.tsx`.
- **Second factor:** a second proof after the password: an authenticator app code, a
  recovery code, or a passkey. Owner: `server/store/factors.ts` (`factors`), `server/core/totp.ts`,
  `server/core/webauthn.ts`.
- **Passkey:** a WebAuthn credential; it is a second factor, or with user verification signs
  a user in alone. Owner: `server/store/factors.ts`, `server/account/factors.ts`.
- **Upstream (sign-in provider):** another provider, such as Google or GitHub, that users may
  sign in through. Owner: `server/store/upstreams.ts`, `server/upstream/`.
- **Linked account (link, identity):** an upstream identity tied to one local user; heautou
  finds users only through links, never by email. Owner: `server/store/upstreams.ts`
  (`links`), `server/upstream/accounts.ts`.
- **Grant:** what a user allowed an app; consent is given on the spot, since the operator
  added the app. Owner: oidc-provider, `grantEverythingAsked` in `server/oidc/interactions.ts`.
- **Session (provider session):** a browser's sign-in at the provider, which apps share.
  Ending it sends a logout token to each app it signed in to. Owner: `server/oidc/sessions.ts`,
  `server/oidc/backchannel.ts`.
- **Logout token (back-channel logout):** the signed notice an app is POSTed when a session
  it signed in through ends. Owner: `server/oidc/backchannel.ts`.
- **Device flow:** signing a device without a browser in with a code the user types on
  another screen (RFC 8628). Owner: `server/oidc/device-flow.ts`, `web/src/routes/device.tsx`.
- **API (resource):** a service apps ask access tokens for, named by an absolute URI, with
  its scopes and the clients allowed to ask. Owner: `server/store/apis.ts`,
  `server/oidc/resources.ts`.
- **Machine client:** a client allowed the client credentials grant, which gets tokens with
  no user. Owner: `allowClientCredentials` on `OidcClient`.
- **Keys:** the token signing keys and cookie keys; made on first boot and rotated. Owner:
  `server/store/keys.ts` (`ProviderKeys`).

### People and access

- **User:** a person who can sign in, with a username, email, name, groups and custom
  claims. An invited user has no password yet. Owner: `server/store/users.ts`.
- **Admin (operator):** a user in the admin group, who may use the admin UI. Owner:
  `isAdmin` in `server/store/users.ts`, `ADMIN_DEFAULTS.group`.
- **Group:** a name on users that apps read in the groups claim and clients and sites may
  require. Groups have no record of their own; they are what users and clients name. Owner:
  `server/store/groups.ts`.
- **Claim:** a fact about the user released in tokens; the operator may add their own.
  Owner: `server/store/claims.ts`, `server/oidc/provider.ts` (`claimNamesIn`).
- **Allowed groups:** the groups a client, site or pairing lets in; empty means everyone.
  Owner: `allowedGroups` on clients, protected sites and pairings.
- **Password link (invite, reset link):** a one-time link to set a password, by email or
  copied by an admin. Owner: `server/store/password-links.ts`.
- **Password rules:** the minimum strength a new password must reach, and the optional
  breach check. Owner: `server/core/password-policy.ts`, `server/store/settings.ts`.
- **Setup (first admin):** making the first admin while none exists: free for ten minutes
  after boot, then with the token the boot log prints. Owner: `server/admin/setup.ts`.
- **Web session:** a browser signed in to heautou's own web app: the admin UI for an admin,
  the account page for anyone. Owner: `server/store/web-sessions.ts` (`services.webSessions`).
  Its stored and wire names keep "admin" (A1): the `admin_sessions` table, the
  `admin-sessions.json` document and archive path, the `heautou_admin` cookie.
- **Account page:** where any user changes their own profile, password, second factors,
  picture, sessions and linked accounts. Owner: `server/account/` (`routes.ts`,
  `factors.ts`; the picture routes are in `server/admin/pictures.ts`),
  `web/src/routes/account.tsx`.
- **Profile picture:** a user's square picture, kept in the S3 bucket and served publicly by
  user id. Owner: `server/core/pictures.ts`, `server/admin/pictures.ts`.

### Pairing

- **Pairing (setup URL):** a one-time link an admin hands an app so it registers itself as a
  client, with the groups the admin chose. Owner: `server/store/pairings.ts`,
  `server/oidc/pairing.ts`.
- **Offer:** what a paired app offers to set up besides its sign-in: its API, and a device
  client. Owner: `server/oidc/pairing-offers.ts`.

### Forward auth

- **Protected site:** a site behind the reverse proxy that heautou guards: a host and path
  prefix, the groups let in, and whether a second factor is needed. Owner:
  `server/store/protected-sites.ts`.
- **Cookie domain:** the domain the proxy session cookie is set on, so every protected site
  under it receives it. Owner: `server/store/protected-sites.ts`, `FORWARD_AUTH_COOKIE_DOMAIN`.
- **Proxy session:** a browser signed in to the protected sites. Owner:
  `server/store/proxy-sessions.ts`.
- **Verify:** the reverse proxy's per-request question "may this request through?". Owner:
  `/auth/verify` in `server/forward-auth/routes.ts`.

### Operating it

- **Settings:** the operator's choices: plain http redirect URIs, the password rules, email.
  Owner: `server/store/settings.ts`, `server/store/mail.ts`.
- **Branding:** the name and logo the pages and emails show. Owner: `server/store/branding.ts`.
- **Email:** optional mail for invites, resets, forgot password and notifications, through
  the SMTP server the environment or Settings names. Owner: `server/mail/`.
- **Activity (audit log):** the record of who did what: sign-ins, every admin change,
  account changes, pairing and registration changes. Owner: `server/store/audit.ts`,
  `server/store/audit-vocabulary.ts` (`AuditType`, `AuditTargetKind`).
- **Backup:** one gzipped file holding all of heautou's data, optionally with sessions, which
  a restore puts back whole. Owner: `exportArchive` and `restoreArchive` in
  `server/store/backup.ts`, which the server (`services.backup`, which then reloads the
  stores and rebuilds the provider) and the CLI (`server/backup.ts`) both call.
- **Secret key (`SECRET_KEY`):** the key secrets are sealed under in the database. Owner:
  `server/core/secret-box.ts`.

### Internals

- **Services:** everything the HTTP app is built from: each store, the provider host, the
  mailer. Owner: `server/core/services.ts` (`openServices`).
- **Context:** what a GraphQL resolver gets: a hand-picked subset of the services, the
  viewer and the address. Owner: `server/core/context.ts`, built in `server/http/app.ts`.
- **Store:** the module that owns one concept's data and its rules; reads are synchronous
  from memory, writes resolve once the tables hold them. Owner: `server/store/*.ts`.
- **Document:** a store's data in memory, written through to its tables as row differences.
  Owner: `server/db/document.ts` (`DataDocument`); each store takes its own as `document`.
- **Document mapping:** how one document is laid out as rows and read back, including an
  older version's JSON file. Owner: `server/db/documents.ts` (`DocumentMapping`; its `file`
  is both the `documents.name` row key and the archive path, such as `keys.json`).
- **Sealed document:** a document whose secrets are sealed in the tables and plain in
  memory. Owner: `server/store/sealed-document.ts`.
- **Write queue:** the one queue every write to the database waits in. Owner:
  `createWriteQueue` in `server/db/document.ts`.
- **Data set:** everything kept, as the files a backup holds. Owner: `server/db/data-set.ts`.
- **Archive file:** one entry of a backup, named as the data directory of a version before the
  database named it (`users.json`, `audit.jsonl`, `oidc/Session.json`). Owner:
  `DOCUMENT_FILES` in `server/db/documents.ts`, `AUDIT_FILE` in `server/store/audit.ts`.
- **Backup layout:** which archive files a backup skips and which it needs. Owner:
  `BACKUP_LAYOUT` in `server/store/backup.ts`.
- **Import:** the first boot on an older JSON data directory, which puts its files in the
  tables and moves them to `imported-json/`. Owner: `server/db/import.ts`
  (`readDataDirectory`), checking each file as a restore does (`parseDataFile` in
  `server/store/backup.ts`).
- **Model document:** one oidc-provider model's entries (sessions, codes, tokens), one
  document per model. Owner: `server/oidc/adapter.ts`.
- **Generated read:** a GraphQL query field drizzle-graphql builds from a table. Owner:
  `server/graphql/build-schema.ts`; hand-written fields that return one read it through
  `server/graphql/rows.ts`.
- **Audit target / actor:** who did it and what it was done to, named as they were then.
  Owner: `server/store/audit.ts`: `actorOf`, a builder per target kind (`userTarget`,
  `clientTarget`, `apiTarget`, `groupTarget`, `pairingTarget`, `siteTarget`,
  `upstreamTarget`) and the fixed ones (`KEYS_TARGET`, `SETTINGS_TARGET`, …);
  `clientTargetIn` in `server/oidc/audit-events.ts` names a client by its display name.
- **Admin change:** an entry for what the signed-in admin did through `/graphql`. Owner:
  `recordAdminChange` in `server/store/audit.ts`.
- **Client display name:** a client's name as people see it: the built-in client's own name,
  else the stored name, else the name a request gave, else its ID. Owner: `clientDisplayName`
  in `server/admin/admin-client.ts`; `sessionClientName` there names the web app by the brand.
- **Viewer:** the signed-in user a request is for. Owner: `requireSignedIn` (any enabled
  user) in `server/account/session.ts` and `requireAdmin` in `server/admin/routes.ts` find
  it; handlers read it with `viewerOf(res)`.
- **Defaults group:** a tunable group in `server/core/defaults.ts` (`<CONCEPT>_DEFAULTS`).
  Facts are in `server/core/wire.ts`.

## Explain test

An operator runs heautou as the provider for their network's apps. They add an app as a
client, from a preset or by handing it a setup URL so it pairs itself, and add users, whose
groups decide which clients and protected sites let them in. When an app sends a browser to
the provider, a sign-in asks for a password, a passkey or an upstream, then a second factor
when the user has one, and the grant is given on the spot; the provider session is shared
by every app and ending it sends each a logout token. Sites without OpenID Connect sit
behind the reverse proxy, which asks verify on each request and is answered from the proxy
session. Users manage themselves on the account page through a web session; an admin's web
session also opens the admin UI. Each store owns one concept's rules and keeps its document
in memory, written through the write queue to the tables; every change and sign-in goes in
the activity log, and a backup holds the whole data set as archive files that a restore
puts back at once.
