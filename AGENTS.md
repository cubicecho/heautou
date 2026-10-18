# heautou

Heautou: a minimal OpenID Connect provider for self-hosted environments. A Node server runs
[oidc-provider](https://github.com/panva/node-oidc-provider) under `/oidc` and keeps everything in flat
JSON files; a React app built from the cubeui registry is the admin UI (clients, users, groups, settings), each
user's `/account` page, and the sign-in page the provider sends browsers to.

## Run

```
cp .env.example .env    # set ISSUER_URL to the public URL + /oidc when other machines use it
npm install
npm run dev             # web on http://localhost:3000 (proxying /graphql, /oidc, /interaction), API on :8787
npm run check && npm test
npm run build && npm start   # one process on PORT (default 3000) serving dist/
docker compose up -d --build # the same, in a container, with the data in a named volume
```

`.env.example` documents `ISSUER_URL`, `PORT`, `DATA_DIR` and `TRUST_PROXY`. While there is no admin the app
shows `/setup`: a new admin needs nothing for 10 minutes after boot (`ADMIN_DEFAULTS.setupWindowSeconds`); after that,
or to promote an existing user, it needs the token the boot log prints.

## CI and releases

`.github/workflows/ci.yml` lints, typechecks and tests, then builds the image and boots it with compose. When CI passes on
`main`, `release.yml` runs semantic-release (conventional commits decide the version; `.releaserc.json`) and pushes
`ghcr.io/cubicecho/heautou:<version>` and `:latest`, the tag `docker-compose.yml` pulls. Docker Hub is not published to yet.

## Layout

- `server/core/` config getters, `defaults.ts` groups (token lifetimes, key sizes and rotation, link lifetimes, branding limits), coded errors, preflight, `services.ts` (opens the stores and builds the provider)
- `server/store/` flat-file stores: `json-file.ts` (atomic whole-file writes, mode 0600), `backup.ts` (the backup archive: every `.json`/`.jsonl` in `DATA_DIR` as on disk, gzipped JSON, `admin-sessions.json` never and `oidc/` on request; a restore checks every file and that sealed values open before writing any), `clients.ts` (its back-channel logout URI too), `users.ts` (scrypt password hashes, custom claims, disabled, the last-admin rule), `keys.ts` (signing and cookie keys, made on first boot, rotated every `KEY_DEFAULTS.rotationDays` keeping `keptKeys`), `admin-sessions.ts`, `password-links.ts` (invite and reset tokens, stored hashed), `branding.ts`, `settings.ts` (operator settings: plain http redirect URIs, the password rules), `redirect-uris.ts` (the redirect URI rule), `groups.ts` (groups derived from users and clients: list, rename, delete), `claims.ts` (claim name rules)
- `server/admin/` the admin UI as a built-in client (`admin-client.ts`), `backup.ts` (`/admin/backup` downloads an archive, `/admin/restore` takes one as `application/gzip`, reloads the stores, rebuilds the provider and signs every admin out; `npm run backup -- export|restore <file>` is the same code from the shell, with the server stopped), its sign-in, callback, logout and setup routes and `requireAdmin` (`routes.ts`), the first-admin token (`setup.ts`), `factors.ts` (`/admin/account/totp/*`, `/recovery-codes`, `/passkeys/*`: a user sets up their own second factors; removing one needs the password), and `account.ts`: `/admin/account` (any signed-in user: profile, password, sessions), the password-link routes, and the public `/admin/branding`, `/admin/logo` and `/admin/password-rules` (the minimum score, for the meters)
- `server/oidc/` `provider.ts` (oidc-provider config: scopes, claims, TTLs, each read per token so a client's own `tokenLifetimes` win over `TOKEN_LIFETIME_DEFAULTS`; back-channel logout with oidc-provider's private-address guard dropped so apps on the LAN are reached, within `BACKCHANNEL_LOGOUT_DEFAULTS.timeoutMs`; each read per token so a client's own `tokenLifetimes` win over `TOKEN_LIFETIME_DEFAULTS`; `findAccount` turns away disabled users and those outside a client's `allowedGroups`), `host.ts` (rebuilds the provider when the keys or claim names change; read `services.host.current()` per request), `sessions.ts` (a user's sessions and tokens in the model files; ending them tells the apps they signed in to), `backchannel.ts` (posts logout tokens for sessions ended outside the provider: an admin, `/account`, disabling or deleting a user), `adapter.ts` (oidc-provider models as JSON files under `oidc/`; clients come from the client store), `interactions.ts` (login and automatic consent)
- `server/graphql/` SDL, schema, operation limits, logger; `write-schema.ts` prints `schema.graphql`
- `server/http/` `createApp(services)`, health, shutdown, `guards.ts` (same-origin JSON POSTs), `rate-limit.ts`, `headers.ts` (security headers, the web app's CSP), `cookies.ts`; `server/index.ts` only boots
- `web/src/components/` vendored cubeui and shadcn code: do not edit, reinstall with `npx shadcn@latest add @cubeui/<item>`
- `web/src/core/` typed GraphQL helper (a 403 sends the browser to `/account`), query client, admin hooks, `account.ts` (the REST hooks for `/account` and `/set-password`), `brand.tsx` (the branded name and icon), list helpers, extra icons
- `web/src/passwords/` the strength meter under every new-password field (zxcvbn loaded with `import()`)
- `web/src/clients/`, `web/src/users/`, `web/src/groups/` the dialogs (edit, invite or reset link, sessions, rename)
- `web/src/routes/` TanStack file routes (`/`, `/clients`, `/users`, `/groups`, `/settings`, `/account`, `/set-password`, `/login/$uid`, `/setup` and the provider's pages); the tree is generated by `npm run codegen`
- `tests/` mirrors `server/`; `tests/oidc/code-flow.test.ts` runs the whole authorization code flow (secret and PKCE) against a real server

## How a sign-in goes

1. An application sends the browser to `/oidc/auth`. The provider sends it to `/interaction/:uid`.
2. A login prompt is redirected to the web app's `/login/:uid`, which reads `/interaction/:uid/details` and posts the
   username and password as JSON to `/interaction/:uid/login`. The reply says where the browser goes next.
   A user with a second factor gets `{ secondFactor }` back instead, and the page posts an authenticator or recovery
   code to `/interaction/:uid/second-factor`, or a passkey to `/interaction/:uid/passkey` (after
   `/interaction/:uid/passkey/options`). The same passkey routes, with no password first, sign a user in with a passkey
   alone (user verification required). Waiting sign-ins and challenges are kept in memory; the ID token's `amr`
   (`pwd`, `otp`, `hwk`, `user`, `mfa`) and `acr` (`pwd` or `mfa`) say how the user signed in.
3. A consent prompt is granted on the spot: the operator added the client, so there is no consent screen.

A user the client refuses (disabled, or in none of its `allowedGroups`) gets a 403 from the login POST. One already
signed in is caught by the `account_refused` policy check and asked to sign in again rather than given a code.

The admin UI signs in the same way, as the built-in public client `heautou-admin`: a 401 from `/graphql` sends the
browser to `/admin/login`, which starts a PKCE flow back to `/admin/callback`. The callback swaps the code in-process
(`provider.AuthorizationCode.find`), sets the `heautou_admin` session cookie. Any enabled user may sign in this way: `requireAdmin` gives a
non-admin a 403 on `/graphql`, and the web app sends them on to `/account`. An invite or reset link is
`/set-password#token=…`; setting the password through it signs nobody in, the page then sends the browser to the
sign-in. Tests sign in with `signInAsAdmin` in `tests/oidc/browser.ts`.

## Security model

Built for a trusted network. The admin UI and `/graphql` need an admin session, and `/graphql`, the admin POSTs and
the login POST take only same-origin `application/json` POSTs (`sameOriginJson`); Yoga's CORS is off. Login failures
are throttled per IP and per username. Client secrets and the private signing keys are still plain text in
`DATA_DIR`; only user passwords, admin session tokens and password-link tokens are hashed. There is no TLS in the server: run it behind a
proxy with `ISSUER_URL=https://…` and `TRUST_PROXY`. Redirect URIs must be https (or plain http on loopback, or an app's own scheme for a public client) unless the
operator allows plain http under Settings (`settings.json`; unset, it follows `ISSUER_URL`). The client store checks
this on save, pairing answers `invalid_redirect_uri`, and clients saved before keep working but are flagged.
New passwords (admin create and set, invite or reset links, the account page, `/setup`) go through
`services.passwordPolicy` (`server/core/password-policy.ts`) before the user store saves them: the length, a zxcvbn
score of at least the operator's minimum (Settings, `settings.json`; `PASSWORD_RULE_DEFAULTS.minScore` 3 unset; the
username, name and email count against it) and, when the operator turns it on (off by default), Have I Been Pwned's
range API with only the first 5 hex characters of the SHA-1 sent. A breach check that fails or passes
`breachTimeoutMs` lets the password through and logs a `[passwords]` line. Existing passwords keep working. A client's `backchannelLogoutUri` is held to the same rule. When a user signs out at `/oidc/session/end`, or an admin or `/account` ends their sessions, each app the session signed in to that has one is POSTed a signed `logout_token` (OpenID Connect Back-Channel Logout); an app that can't be reached never fails the sign-out. Not done
yet: an audit log.
