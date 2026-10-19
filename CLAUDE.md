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

`.env.example` documents the `S3_` variables (profile pictures; each with a `_FILE` form), `ISSUER_URL`, `PORT`, `DATA_DIR`, `TRUST_PROXY` and `SECRET_KEY` (and its `_FILE` and `_PREVIOUS` forms), and the optional `SMTP_URL` (or `SMTP_HOST` and its parts) and `SMTP_FROM`. While there is no admin the app
shows `/setup`: a new admin needs nothing for 10 minutes after boot (`ADMIN_DEFAULTS.setupWindowSeconds`); after that,
or to promote an existing user, it needs the token the boot log prints.

## CI and releases

`.github/workflows/ci.yml` lints, typechecks and tests, then builds the image and boots it with compose. When CI passes on
`main`, `release.yml` runs semantic-release (conventional commits decide the version; `.releaserc.json`) and pushes
`ghcr.io/cubicecho/heautou:<version>` and `:latest`, the tag `docker-compose.yml` pulls. Docker Hub is not published to yet.

## Layout

- `server/core/` config getters, `defaults.ts` groups (token lifetimes, key sizes and rotation, link lifetimes, branding limits), coded errors, preflight (and the S3 bucket check, which only warns), `secret-box.ts` (AES-256-GCM `enc:v1:` envelopes under `SECRET_KEY`), `totp.ts` (RFC 6238 codes and base32), `webauthn.ts` (the passkey relying party: the issuer's host, available on https or loopback only), `expiring-map.ts`, `object-storage.ts` (the S3 client: one bucket, path-style, SigV4 by aws4fetch, fetch injectable), `pictures.ts` (profile pictures: the type by its bytes, sharp crops to a square PNG, one object per version under `PROFILE_DEFAULTS.keyPrefix`), `services.ts` (opens the stores, sealing their secrets, and builds the provider)
- `server/store/` flat-file stores: `json-file.ts` (atomic whole-file writes, mode 0600), `backup.ts` (the backup archive: every `.json`/`.jsonl` in `DATA_DIR` as on disk, gzipped JSON, `admin-sessions.json` never and `oidc/` on request; a restore checks every file and that sealed values open before writing any), `sealed-file.ts` (a JSON file whose secrets are sealed on disk and plain in memory; each store exports the `SecretMapper` that finds them), `clients.ts` (a client's own token lifetimes within `CLIENT_TOKEN_LIFETIME_DEFAULTS`, null for the server's; its back-channel logout URI), `users.ts` (scrypt password hashes, custom claims, disabled, the last-admin rule), `keys.ts` (signing and cookie keys, made on first boot, rotated every `KEY_DEFAULTS.rotationDays` keeping `keptKeys`), `admin-sessions.ts`, `password-links.ts` (invite and reset tokens, stored hashed), `branding.ts`, `settings.ts` (operator settings: plain http redirect URIs, the password rules), `redirect-uris.ts` (the redirect URI rule), `groups.ts` (groups derived from users and clients: list, rename, delete), `claims.ts` (claim name rules), `apis.ts` (the APIs apps ask for access tokens to, in `apis.json`: an absolute URI with no fragment as the identifier, scopes, JWT or opaque, a lifetime within `API_DEFAULTS`, the allowed clients; a removed client is taken off them through the client store's `onRemove`),`mail.ts` (the SMTP server saved under Settings, password sealed, and the email options, in `mail.json`), `factors.ts` (second factors in `factors.json`: authenticator app secrets sealed, recovery codes hashed, passkeys), `pairings.ts` (setup URLs waiting for an app, the token stored hashed), `audit.ts` (the append-only `audit.jsonl`, rotated by size under `AUDIT_DEFAULTS`; a failed write is logged, never thrown; `onRecord` tells subscriptions)
- `server/admin/` the admin UI as a built-in client (`admin-client.ts`), `backup.ts` (`/admin/backup` downloads an archive, `/admin/restore` takes one as `application/gzip`, reloads the stores, rebuilds the provider and signs every admin out; `npm run backup -- export|restore <file>` is the same code from the shell, with the server stopped), its sign-in, callback, logout and setup routes and `requireAdmin` (`routes.ts`), the first-admin token (`setup.ts`), `pictures.ts` (`/admin/account/picture` and `/admin/users/:id/picture` take the image as the body and `/remove`; the public `/users/:id/picture` streams it from the bucket with the version as ETag), `factors.ts` (`/admin/account/totp/*`, `/recovery-codes`, `/passkeys/*`: a user sets up their own second factors; removing one needs the password), and `account.ts`: `/admin/account` (any signed-in user: profile, password, sessions), the password-link routes, and the public `/admin/branding`, `/admin/logo` and `/admin/password-rules` (the minimum score, for the meters)
- `server/oidc/` `audit-events.ts` (the provider's events as audit entries), `provider.ts` (oidc-provider config: scopes, claims, TTLs, each read per token so a client's own `tokenLifetimes` win over `TOKEN_LIFETIME_DEFAULTS`; back-channel logout with oidc-provider's private-address guard dropped so apps on the LAN are reached, within `BACKCHANNEL_LOGOUT_DEFAULTS.timeoutMs`; each read per token so a client's own `tokenLifetimes` win over `TOKEN_LIFETIME_DEFAULTS`; `findAccount` turns away disabled users and those outside a client's `allowedGroups`), `host.ts` (rebuilds the provider when the keys or claim names change; read `services.host.current()` per request), `sessions.ts` (a user's sessions and tokens in the model files; ending them tells the apps they signed in to), `backchannel.ts` (posts logout tokens for sessions ended outside the provider: an admin, `/account`, disabling or deleting a user), `adapter.ts` (oidc-provider models as JSON files under `oidc/`; clients come from the client store), `interactions.ts` (login and automatic consent), `resources.ts` (`features.resourceIndicators` on the API store, read per request: `invalid_target` for a client an API doesn't list, the granted resource used when the token request leaves it out, a machine client's only API by default; an API's `accessTokenSeconds` wins over the client's own in `tokenLifetimesFor`), `pairing.ts` (setup URLs and the dynamic registration policy that writes paired clients to the client store)
- `server/mail/` optional email: `env.ts` (`SMTP_URL` or `SMTP_HOST` and its parts, `SMTP_FROM`; it wins over Settings and locks it), `mailer.ts` (the transport, nodemailer by default and a fake in tests through `ServiceSettings.mailTransport`; each email sent or failed is a `mail_sent` or `mail_failed` entry, never with the link), `messages.ts` (plain text and escaped HTML under the brand's name, the logo as a CID attachment), `notifications.ts` (follows `audit.onRecord` to email a user about a password or second-factor change, each kind behind its option) and `forgot-password.ts` (`/interaction/:uid/forgot-password`); `server/graphql/mail.ts` is its SDL and resolvers (`mail`, `setMailServer`, `setMailOptions`, `sendTestEmail`, `emailPasswordLink`)
- `server/graphql/` SDL, schema, `apis.ts` (the API resolvers, merged into the schema), operation limits, logger; `write-schema.ts` prints `schema.graphql`
- `server/forward-auth/` forward auth for sites behind a reverse proxy: `routes.ts` (`/auth/verify`, which a trusted proxy calls per request and answers 200 with `Remote-*` headers, 401 or with `?redirect=1` a 302 to sign in, 403 or 400; `/auth/sign-in`, `/auth/callback` and `/auth/sign-out`, signing in as the built-in public client `heautou-proxy`), `client.ts` (paths, cookies, the client's metadata), `request.ts` (the original request from `X-Forwarded-*` or `X-Original-URL`, which must agree), `returns.ts` (the `rd` allow list), `trust.ts` (`FORWARD_AUTH_TRUSTED_PROXIES`, else loopback and `TRUST_PROXY`); `server/store/protected-sites.ts` (the sites: host, path prefix, `allowedGroups`, require a second factor; and the cookie domain) and `server/store/proxy-sessions.ts` (hashed tokens, `FORWARD_AUTH_DEFAULTS` lifetime and idle limit); `server/graphql/forward-auth.ts` its SDL and resolvers; `docs/forward-auth.md` the proxy snippets
- `server/upstream/` signing in through another provider: `client.ts` (openid-client with discovery for OIDC issuers, fixed endpoints plus `/user` and `/user/emails` for GitHub; PKCE, state and nonce on every flow; requests through `fetchUpstream`), `flows.ts` (flows in flight, in memory, single use, bound to one interaction or one user), `accounts.ts` (finds the local user only through a link, never by email; refuses or creates one per provider, limited to listed email domains; maps upstream groups), `routes.ts` (`/upstream/:id/callback`, the URI to register upstream, and `/admin/account/upstreams` to link and unlink); the providers and links are in `upstreams.json` (`server/store/upstreams.ts`, client secrets sealed)
- `server/http/` `createApp(services)`, health, shutdown, `guards.ts` (same-origin JSON POSTs), `rate-limit.ts`, `headers.ts` (security headers, the web app's CSP), `cookies.ts`; `server/index.ts` only boots
- `web/src/components/` vendored cubeui and shadcn code: do not edit, reinstall with `npx shadcn@latest add @cubeui/<item>`
- `web/src/core/` typed GraphQL helper (a 403 sends the browser to `/account`), query client, admin hooks, `account.ts` (the REST hooks for `/account` and `/set-password`), `brand.tsx` (the branded name and icon), list helpers, extra icons
- `docs/pairing.md` the app side of pairing, for whoever adds it to an app
- `web/src/passwords/` the strength meter under every new-password field (zxcvbn loaded with `import()`)
- `web/src/mail/` the Settings section (server, test email, the options) and the sign-in page's forgot-password step; `web/src/core/mail.ts` their hooks
- `web/src/clients/`, `web/src/apis/`, `web/src/users/`, `web/src/groups/` the dialogs (edit, invite or reset link, sessions, rename, picture)
- `web/src/clients/presets.ts` the client presets: each app's callback paths, auth method and docs link, and what to set in the app (env vars, a file or its own fields) from the issuer and the client; adding an app is one entry, and `tests/web/presets.test.ts` checks them all. New client's **Start from** fills the form from one and the app's address; the client stores the preset's ID (`preset`) and its row shows `preset-panel.tsx`'s **Configure** panel
- `web/src/sites/`, `web/src/routes/sites.tsx`, `web/src/core/protected-sites.ts` the Protected sites page: the proxy setup, the cookie domain and the sites
- `web/src/pictures/` the profile picture row `/account` and the users page share; `web/src/core/pictures.ts` its hooks
- `web/src/routes/` TanStack file routes (`/`, `/clients`, `/apis`, `/users`, `/groups`, `/activity`, `/sites`, `/settings`, `/account`, `/set-password`, `/login/$uid`, `/setup` and the provider's pages); the tree is generated by `npm run codegen`
- `tests/` mirrors `server/`; `tests/oidc/code-flow.test.ts` runs the whole authorization code flow (secret and PKCE) against a real server

## How a sign-in goes

1. An application sends the browser to `/oidc/auth`. The provider sends it to `/interaction/:uid`.
2. A login prompt is redirected to the web app's `/login/:uid`, which reads `/interaction/:uid/details` and posts the
   username and password as JSON to `/interaction/:uid/login`. The reply says where the browser goes next.
   A user with a second factor gets `{ secondFactor }` back instead, and the page posts an authenticator or recovery
   code to `/interaction/:uid/second-factor`, or a passkey to `/interaction/:uid/passkey` (after
   `/interaction/:uid/passkey/options`). The same passkey routes, with no password first, sign a user in with a passkey
   alone (user verification required). Waiting sign-ins and challenges are kept in memory; the ID token's `amr`
   (`pwd`, `otp`, `hwk`, `user`, `fed`, `mfa`) and `acr` (`pwd` or `mfa`) say how the user signed in.
3. A **Sign in with …** button goes to `/interaction/:uid/upstream/:id`, which sends the browser to the provider; it comes back through `/upstream/:id/callback` to `/interaction/:uid/upstream-return`. The linked user goes through the same refusal checks as a password sign-in, and one with a second factor still gives it on `/login/:uid` unless the provider is set to count as both factors (`amr` `fed`, plus `mfa` when it does). Failures go back to `/login/:uid?error=`.
4. A consent prompt is granted on the spot: the operator added the client, so there is no consent screen.

A user the client refuses (disabled, or in none of its `allowedGroups`) gets a 403 from the login POST. One already
signed in is caught by the `account_refused` policy check and asked to sign in again rather than given a code.

The admin UI signs in the same way, as the built-in public client `heautou-admin`: a 401 from `/graphql` sends the
browser to `/admin/login`, which starts a PKCE flow back to `/admin/callback`. The callback swaps the code in-process
(`provider.AuthorizationCode.find`), sets the `heautou_admin` session cookie. Any enabled user may sign in this way: `requireAdmin` gives a
non-admin a 403 on `/graphql`, and the web app sends them on to `/account`. An invite or reset link is
`/set-password#token=…`; setting the password through it signs nobody in, the page then sends the browser to the
sign-in. Tests sign in with `signInAsAdmin` in `tests/oidc/browser.ts`.

## How pairing goes

The admin's **Pair an app** calls `startPairing`, which saves an oidc-provider initial access token (10 minutes,
`PAIRING_DEFAULTS.linkSeconds`, the `heautou-pairing` policy) and a pairing holding the groups the admin chose. The
setup URL is `<issuer>#setup=<token>&name=<brand>`. The app POSTs RFC 7591 metadata to `/oidc/reg` with the token as a
Bearer; the policy (`server/oidc/pairing.ts`) refuses what the client store can't hold, writes the client with
`source: paired` and the pairing's groups, marks the pairing done and destroys the token. The client adapter's
`upsert` only checks the client is in the store; `destroy` removes it, for an RFC 7592 DELETE. A PUT goes through the
same policy as an update. The host is rebuilt after each, so a new groups claim is released. The dialog follows
the `pairingChanged(id)` subscription until it is PAIRED.

## How forward auth goes

A reverse proxy calls `/auth/verify` with the original request in `X-Forwarded-Proto`/`-Host`/`-Uri`/`-Method` (or
`X-Original-URL`) and the browser's cookies, only from an address `createProxyTrust` believes. With no live
`heautou_proxy` session it answers 401 (or 302 with `?redirect=1` for a GET or HEAD) with
`/auth/sign-in?rd=<original URL>` in `Location`. The sign-in is the usual interaction flow for the built-in client
`heautou-proxy`, swapped in-process like the admin's; the callback stores a proxy session holding the user, the
provider grant and the code's `acr`/`amr`, and sets the cookie on the cookie domain. Each verify checks the session,
that its grant still exists (so `/oidc/session/end`, an admin ending sessions and `revokeAccount` end it), that the
user is enabled and in the site's `allowedGroups`, and for a site that requires a second factor that `acr` is `mfa`
(else a step-up sign-in with `prompt=login`, or 403 for a user with none). Sign-ins, sign-outs and refusals are
audited, refusals once per user and site per `refusalLogSeconds`; allowed requests are not.

## Security model

Built for a trusted network. The admin UI and `/graphql` need an admin session, and `/graphql`, the admin POSTs and
the login POST take only same-origin `application/json` POSTs (`sameOriginJson`); Yoga's CORS is off. Login failures,
wrong second factors included, are throttled per IP and per username; `/oidc/reg` shares the sign-in rate limit, and a setup URL is single use and
lasts 10 minutes (its token sits in `oidc/` like other provider tokens until then). With `SECRET_KEY` set, client secrets, the private
signing and cookie keys, authenticator app secrets and upstream providers' client secrets are sealed in `DATA_DIR` (re-sealed at boot when plain or under `SECRET_KEY_PREVIOUS`; a wrong
or missing key stops boot without writing); without it they are plain text and boot warns. User passwords, admin
session tokens, password-link tokens and recovery codes are hashed. The provider's own tokens in `oidc/` are neither: they are
looked up by value. There is no TLS in the server: run it behind a
proxy with `ISSUER_URL=https://…` and `TRUST_PROXY`. Redirect URIs must be https (or plain http on loopback, or an app's own scheme for a public client) unless the
operator allows plain http under Settings (`settings.json`; unset, it follows `ISSUER_URL`). The client store checks
this on save, pairing answers `invalid_redirect_uri`, and clients saved before keep working but are flagged.
New passwords (admin create and set, invite or reset links, the account page, `/setup`) go through
`services.passwordPolicy` (`server/core/password-policy.ts`) before the user store saves them: the length, a zxcvbn
score of at least the operator's minimum (Settings, `settings.json`; `PASSWORD_RULE_DEFAULTS.minScore` 3 unset; the
username, name and email count against it) and, when the operator turns it on (off by default), Have I Been Pwned's
range API with only the first 5 hex characters of the SHA-1 sent. A breach check that fails or passes
`breachTimeoutMs` lets the password through and logs a `[passwords]` line. Existing passwords keep working. A client's `backchannelLogoutUri` is held to the same rule. When a user signs out at `/oidc/session/end`, or an admin or `/account` ends their sessions, each app the session signed in to that has one is POSTed a signed `logout_token` (OpenID Connect Back-Channel Logout); an app that can't be reached never fails the sign-out. Sign-ins, every admin
mutation, password-link use, account changes, setup and DCR registration changes go in the audit log
(`services.audit.record`), never with a password, token, secret or setup URL; `auditLog` on `/graphql` reads it and
`/admin/account/activity` gives a user their own sign-ins. Every code the provider hands an app is an `app_signed_in`
entry (from `authorization.success`, with the redirect URI and `via` password or session), so a sign-in that
reused a session is logged too; the admin UI's own are `web_signed_in`. `server/oidc/audit-events.ts` also turns
`authorization.error` into `app_sign_in_failed` (not the silent `prompt=none` checks), `grant.error` into
`app_token_refused`, a client credentials `grant.success` into `machine_token_issued` and `end_session.success` into
`app_signed_out`; a logout token an app did not take (`backchannel.error`, or `backchannel.ts`) is an
`app_logout_failed` with the error, never the token; a key rotation due at boot is a `keys_rotated` with no actor.

Email is optional and off until an SMTP server is set (env or Settings). The SMTP password saved under Settings is sealed in `mail.json` like the other secrets, and boot's key check and the backup's sealed-value check cover it. A password link's token goes in the URL's fragment and the email only; logs and the audit log never hold it. **Forgot password?** (off by default) takes a username or an email address, ignoring case. It answers `{ ok: true }` for anyone once the sign-in is known and the limits pass (`MAIL_DEFAULTS.forgotPerIp` and `forgotPerIdentifier` an hour, counted whether or not anyone matches), then looks the user up and sends after the answer, so neither the reply nor its timing says who exists. Disabled users and users without an address get nothing. The link's fragment carries the interaction's uid, and `/set-password` goes back to `/login/:uid` when it is still open in that browser, and to the account page's sign-in otherwise.

Access tokens for an API (RFC 8707): an app sends `resource` with an identifier from `apis.json`; only the clients
the API lists get one (`invalid_target` otherwise, at sign-in, the token endpoint and each refresh), and the token's
`aud` is the API. A JWT access token is signed with the provider's keys, so the API checks it with the JWKS and it
can't be revoked before it expires (`API_DEFAULTS.maxAccessTokenSeconds`); oidc-provider won't introspect one. An
opaque one introspects with its `aud`. The provider is not rebuilt when APIs change. `app_signed_in`,
`app_sign_in_failed`, `app_token_refused` and `machine_token_issued` carry the `resource` asked for, and admin
changes are `api_created`, `api_updated` and `api_deleted`.
Profile pictures (`picture`, with `profile`) are in the S3 bucket, never in `DATA_DIR` and so never in a backup; the bucket stays private and `/users/:id/picture` is public by the user's id, as apps show it. An upload is same-origin only (`image/*` is not a type a cross-site form can send), at most `PROFILE_DEFAULTS.maxPictureBytes`, checked by its magic bytes against its `Content-Type`, decoded within `maxInputPixels` and re-encoded as PNG, so no metadata or trailing bytes survive; it is served with `nosniff` and a `sandbox` CSP. Deleting a user deletes their picture; a bucket that fails then is logged. `picture_set` and `picture_removed` go in the audit log.

Subscriptions are Yoga's server-sent events on the same `/graphql` POST (`Accept: text/event-stream`), behind the same
guards, and the admin session is checked only when a stream opens. `auditEntryAdded` follows `audit.onRecord`;
`pairingChanged` replaces polling in the pair dialog. The web app opens them with `subscribe` in `web/src/core/gql.ts`,
which reopens a dropped stream; `useAuditFeed` puts new entries at the top of the Activity page's cached first page.

Forward auth's `/auth/verify` believes forwarded headers only from `FORWARD_AUTH_TRUSTED_PROXIES` (else loopback and
`TRUST_PROXY`), refuses `X-Original-URL` and `X-Forwarded-*` that disagree or hold several values, refuses hosts no
protected site covers, and is not rate limited (the proxy calls it per request). `rd` must be an http(s) URL without
credentials on a protected site's host or under the cookie domain, checked when the sign-in starts and ends. The
`heautou_proxy` cookie is `HttpOnly`, `SameSite=Lax`, `Secure` on an https issuer and set on the cookie domain
(`FORWARD_AUTH_COOKIE_DOMAIN`, else the admin's), so every app under it receives it; its token is stored hashed in
`proxy-sessions.json`, which backups skip.
