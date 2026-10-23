# Heautou

[Website](https://cubicecho.github.io/heautou/)

A minimal OpenID Connect provider for self-hosted setups. It gives your apps one shared sign-in
("Sign in with Heautou") without running Keycloak or Authentik.

- **An OIDC provider** for the authorization code flow, with a client secret or with PKCE. Apps find it
  through the standard discovery URL.
- **A small web UI** for adding the apps that sign in (clients) and the people who sign in (users), with
  groups, invite links, and a page where each user changes their own password.
- **Nothing else to run.** The data is in PGlite, a Postgres that runs inside the server, in one folder. Point
  `DATABASE_URL` at a Postgres server to keep it there instead.

> [!WARNING]
> Heautou is built for a home or office network you trust. The admin UI needs a sign-in, but client secrets
> and signing keys are plain text in the database unless you set `SECRET_KEY`, and nothing has been audited. Don't expose
> it to the internet. See [Security](#security).

## Quick start (Docker Compose)

1. Make a folder and save this as `docker-compose.yml` in it:

   ```yaml
   services:
     heautou:
       image: ghcr.io/cubicecho/heautou:latest
       restart: unless-stopped
       environment:
         # The address your apps AND your browser use to reach Heautou, followed by /oidc.
         ISSUER_URL: http://192.168.1.10:3000/oidc
       ports:
         - "3000:3000"
       volumes:
         - heautou-data:/data

   volumes:
     heautou-data:
   ```

2. Change `ISSUER_URL` to this machine's address, such as its LAN IP, hostname or domain, keeping
   `/oidc` on the end. Leave it as `localhost` only if everything runs on one machine.

3. Start it:

   ```sh
   docker compose up -d
   ```

4. Open `http://<your-host>:3000` within 10 minutes of starting it. While there is no admin, Heautou shows a
   **Set up Heautou** page: choose a username and password for the first admin, then sign in with them.

   After those 10 minutes, or to make a user that already exists the admin (when upgrading from a version
   before admin sign-in), the page needs the setup token from Heautou's log:

   ```sh
   docker compose logs heautou | grep setup
   ```

   The log line holds a link, `http://<your-host>:3000/setup#token=…`, that fills the token in. The token changes
   on every restart, so restarting also reopens the 10 minutes. Once there is an admin, the page is closed.

Your clients, users and keys are kept in the `heautou-data` volume (the database is in `/data/pg`), so they
survive restarts and upgrades. To upgrade, run `docker compose pull && docker compose up -d`; the new version
updates the database as it starts. Upgrading from a version that kept JSON files is covered in
[Your data](#upgrading-from-json-files).

### Without Compose

```sh
docker run -d --name heautou --restart unless-stopped \
  -p 3000:3000 -v heautou-data:/data \
  -e ISSUER_URL=http://192.168.1.10:3000/oidc \
  ghcr.io/cubicecho/heautou:latest
```

### On a Postgres server

Set `DATABASE_URL` to a `postgres://user:password@host:5432/database` URL (or `DATABASE_URL_FILE` to a file holding
it, such as a Docker secret). Heautou creates its tables on the first start, and waits up to `DB_CONNECT_TIMEOUT_MS`
(60 seconds) for Postgres to answer. To a host off your local network it requires TLS unless the URL sets `sslmode`.

From a clone of this repository, `docker-compose.postgres.yml` adds a Postgres of its own:

```sh
POSTGRES_PASSWORD=… docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

Only one Heautou may use a database at a time; a second one, or the backup CLI while the server runs, refuses to
start.

## Connecting an app

1. **Add a user.** Under **Users**, choose **New user** and set a username. Name, email, groups and custom
   claims are optional; they are put into the user's tokens. Leave the password empty to invite them instead:
   Heautou gives you a link to send them (see [Managing users](#managing-users)). Only users in the
   `heautou-admin` group can use the admin UI; everyone else can only sign in to your apps.
2. **Add a client.** Under **Clients**, choose **New client**:
   - **Name:** what the sign-in page shows, such as "Grafana".
   - **Redirect URIs:** the app's callback URL. The app's OIDC docs give it, and it must match exactly.
   - **Client authentication:** keep **Secret, Basic header** unless the app says otherwise. Choose
     **Public (PKCE)** for browser-only or mobile apps that cannot keep a secret.
   - **Allowed groups:** leave empty to let every user in. Otherwise only members of these groups may sign in
     to the app; anyone else is told it is not for them.
   - **Groups claim:** the claim the app reads groups from. It is `groups` unless the app wants another name,
     such as `roles`.
   - **Client credentials:** turn on for a service with no users, such as a backup job, that gets its own
     token with `grant_type=client_credentials`. Such a client needs no redirect URI.
   - **Allow the device flow:** turn on for a device with no browser of its own, such as Home Assistant or a TV,
     that shows a code for the user to confirm on another device (see [Devices](#devices-with-no-browser-device-flow)).
     Such a client needs no redirect URI.
3. **Copy the settings into the app.** Open the client's row on the Clients page:

   | The app asks for            | Use                                                           |
   | --------------------------- | ------------------------------------------------------------- |
   | Discovery / well-known URL  | `<ISSUER_URL>/.well-known/openid-configuration`               |
   | Issuer                      | `<ISSUER_URL>`, for example `http://192.168.1.10:3000/oidc`   |
   | Client ID                   | The client's row, **Client ID**                               |
   | Client secret               | The client's row, **Client secret**                           |
   | Scopes                      | `openid profile email` (add `groups` for group-based roles)   |

   The **Overview** page shows the issuer and discovery URL with copy buttons. If an app wants each
   endpoint entered separately, they are `<ISSUER_URL>/auth`, `/token`, `/me` (userinfo), `/jwks`,
   `/token/introspection` and `/session/end` (logout). An API can ask the introspection endpoint whether a
   token it was sent is still good, with a confidential client's ID and secret.

Signing in from the app sends you to Heautou's sign-in page and then back to the app. There is no
consent screen: the apps you added are trusted.

### Pairing an app

An app that supports pairing sets itself up. Under **Clients**, choose **Pair an app**, pick the allowed groups and
groups claim, and choose **Make setup URL**. Paste the URL into the app's sign-in setup. The app registers itself,
and the dialog shows when it has. The client is listed as **Paired**, and you can edit or delete it like any other.

The setup URL works once, for 10 minutes. Closing the dialog before the app registers cancels it. Under the hood this
is standard OAuth 2.0 Dynamic Client Registration with an initial access token, so any app that supports that with
a pasted token can use it too. [docs/pairing.md](docs/pairing.md) is the spec for adding pairing to an app.

### Apps with no sign-in of their own (forward auth)

For an app that can't use OIDC, such as Sonarr or a dashboard, your reverse proxy can ask Heautou about every request
and send the browser here to sign in. Under **Protected sites**, set the cookie domain (the parent domain Heautou and
the apps share, such as `home.lan`) and add each app's host, with the groups that may reach it and whether it needs a
second factor. Then point the proxy's forward auth at `/auth/verify`. The app receives the user in `Remote-User`,
`Remote-Name`, `Remote-Email` and `Remote-Groups`. [docs/forward-auth.md](docs/forward-auth.md) has a tested HAProxy
configuration and snippets for nginx, Caddy and Traefik.

### Claims

| Scope     | Claims                                                                    |
| --------- | ------------------------------------------------------------------------- |
| `openid`  | `sub` (the user's ID)                                                     |
| `profile` | `name`, `preferred_username` (the username), `picture`, and the user's custom claims |
| `email`   | `email`, `email_verified`                                                 |
| `groups`  | `groups`, or the client's own groups claim name                           |

Add `offline_access` to the scopes for a refresh token. Custom claims are set per user, one `name=value` per
line, and are sent as strings; the names the provider sets itself, such as `sub` or `email`, are refused.

### Access tokens for your own APIs

By default an app's access token is for Heautou's userinfo endpoint, and an API it is sent to has to ask the
introspection endpoint about it. To give an API tokens of its own (RFC 8707 resource indicators), add it under
**APIs**:

- **Identifier:** an absolute URI with no fragment, such as `https://photos-api.home.lan`. Apps send it as
  `resource`, and the token's `aud` is set to it, so a token for one API can't be replayed against another.
- **Scopes:** the scopes it understands, such as `photos:read`. A token carries only those the app asked for.
- **Token format:** **JWT** (the default), which the API checks itself against `<ISSUER_URL>/jwks` (check `iss`,
  `aud` and `exp`), or **Opaque**, which it checks with the introspection endpoint. A JWT can't be revoked: it is
  good until it expires.
- **Access token lifetime:** up to a day. It wins over the app's own access token lifetime, which wins over the
  server's.
- **Allowed clients:** only these clients may ask for it; any other gets `invalid_target`.

An app adds `resource=<identifier>` and the API's scopes to its sign-in request. The token request may leave
`resource` out and gets the API granted at sign-in. A machine client uses `grant_type=client_credentials` with
`resource`, or without it when it is allowed exactly one API.

### Devices with no browser (device flow)

A device such as Home Assistant can sign a user in with the OAuth 2.0 device flow (RFC 8628). Add a client with
**Client authentication** set to **Public (PKCE)**, no redirect URIs and **Allow the device flow** on; to give it
tokens for one of your APIs, add the client to that API's **Allowed clients**. The device then:

1. POSTs `client_id`, `scope` (add `offline_access` for a refresh token) and optionally `resource` to
   `<ISSUER_URL>/device/auth`, and shows the user the `user_code` and `verification_uri`
   (`https://<heautou>/device`, or `verification_uri_complete` with the code filled in, for a QR code).
2. Polls `<ISSUER_URL>/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` and the
   `device_code` every `interval` seconds (5). Until the user approves it is told `authorization_pending`, sooner
   than that `slow_down`, and then `access_denied` if they cancel or `expired_token` after 10 minutes.

The user opens `/device`, types the code, checks it against the device, signs in as usual (password, second factor,
passkey or another provider) and the device gets its tokens. The client's **Allowed groups** apply. Ending the
user's sessions from **Account** or **Users** revokes the device's refresh token.

## Managing users

- **Invites and password resets.** A user's link button makes a link to send them by chat or however you like.
  With email set up (see [Email](#email)) and an address on the user, the dialog can also **send it by email**.
  The link sets their password and works once, for 24 hours. A new link replaces the old one.
- **Their own account.** Every user can open `/account` to see their details, change their password, and see
  or end where they are signed in. Signing in to the admin UI without being an admin lands there too.
- **Disable and sign out.** Disabling a user turns them away at once: their tokens stop working and they can't
  sign in again until you enable them. The sessions button lists where a user is signed in and ends one or all
  of them. Heautou refuses to disable or delete the last admin.
- **Profile pictures.** With a bucket configured (see [Profile pictures](#profile-pictures)), users upload a
  picture on `/account` and admins set one from the user's row: PNG, JPEG or WebP, up to 5 MB, cropped to a
  256 px square. Apps get it as the `picture` claim. Without a bucket the feature is off and the pages say so.
- **Groups.** The **Groups** page lists every group with its members and the clients limited to it. Renaming a
  group renames it on every user and client. A group a client is limited to can't be deleted, and nor can
  `heautou-admin`.

### Sign-in providers

The **Sign-in providers** section of the **Users** page lets users sign in with an account they have elsewhere:
any OpenID Connect provider (Google, Microsoft, GitLab, Authentik, another Heautou…) found from its issuer URL, or
GitHub. Register Heautou at the provider with the redirect URI the dialog shows
(`<your-host>/upstream/<id>/callback`), then paste the client ID and secret. The sign-in page gets a
**Sign in with …** button for each.

- An account elsewhere is only ever matched to a user it is **linked** to, never by its email address. Each user
  links theirs under **Linked accounts** on `/account`; an admin can unlink one from the user's row.
- An account no one has linked is turned away, unless the provider is set to **make a user** for it: for
  anybody, or only for addresses at the domains you list (the provider must say the address is verified). New
  users start in the groups you pick and have no password.
- A user with a second factor here is still asked for it, unless you turn on **Counts as both factors** to trust
  the provider's own check. The ID token's `amr` says `fed` for these sign-ins.
- **Group mapping** reads a groups claim from the provider and, at each sign-in, puts the user in the groups
  mapped from theirs, and takes away mapped groups they no longer hold. `heautou-admin` can never come from a
  provider.

## Settings

**Settings** has four tabs.

- **Sign-in.** How hard to guess a new password must be (a zxcvbn score, "Hard to guess" by default), whether new
  passwords are looked up in Have I Been Pwned (off by default; only the first 5 characters of the SHA-1 hash are
  sent), and **Allow plain http** for redirect URIs (see [Security](#security)).
- **Email.** The SMTP server and what is sent; see [Email](#email).
- **Branding.** A name and a logo (PNG, JPEG, WebP or SVG, up to 256 KB) for the sign-in page, the account
  page and the sidebar, in place of "Heautou".
- **Keys and backup.** Heautou rotates its signing key at start-up once it is 90 days old, and **Rotate now** does
  it at once. The previous key stays published, so tokens it signed still verify; tokens signed with keys older
  than that stop verifying, and those users sign in again. The backup and restore are described in
  [Your data](#backup-and-restore).

### Email

Optional. Without it, everything works as before and links are copied by hand. Set the SMTP server under
**Settings → Email**, or with `SMTP_URL` (or `SMTP_HOST` and the rest) and `SMTP_FROM` in the environment, which
wins and locks the section. **Send a test email** checks it. A password saved under Settings is sealed under
`SECRET_KEY` like the other secrets. Emails carry the branding's name and logo.

Each of these is off until you turn it on:

- **Forgot password link.** The sign-in page gets **Forgot password?**: a user types their username or email
  address and a reset link goes to the address on file. The page answers the same whether or not an account
  matched, and disabled users get nothing. It is limited to 5 requests an hour per IP and 3 per username or
  address. After the new password is set, the link takes the browser back to the same sign-in when it is still
  open in that browser, and to the account page's sign-in otherwise.
- **Notifications.** Email a user when their password changes, when an authenticator app or passkey is added, or
  when a second factor is removed (by them, or by an admin's reset).

Every email sent or failed is in the activity log, with the error but never the link.

## Configuration

Set these as environment variables, under `environment:` in Compose.

| Variable      | Default                       | What it does                                                                                     |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `ISSUER_URL`  | `http://localhost:3000/oidc`  | The public URL of Heautou plus `/oidc`. It must be reachable by your apps and your browser.        |
| `PORT`        | `3000`                        | The port the server listens on inside the container.                                              |
| `DATA_DIR`    | `/data` (Docker), else `data` | Where the database is kept (PGlite, in `DATA_DIR/pg`) when `DATABASE_URL` is unset.              |
| `DATABASE_URL` | none                         | A `postgres://` URL to keep the data in a Postgres server instead. `DATABASE_URL_FILE` wins over it. |
| `DB_CONNECT_TIMEOUT_MS` | `60000`             | How long to wait at start-up for Postgres to answer, in milliseconds.                            |
| `TRUST_PROXY` | `false`                       | Set to `1` behind one reverse proxy, so the forwarded `https` and host headers are believed.      |
| `SECRET_KEY`  | none                          | Seals the secrets in the database. 32 bytes of base64: `openssl rand -base64 32`.     |
| `SECRET_KEY_FILE` | none                      | A file holding the key, such as a Docker secret. It wins over `SECRET_KEY`.                       |
| `SECRET_KEY_PREVIOUS` | none                  | The old key while changing keys (`_FILE` works too). Remove it after one start.                   |
| `SMTP_URL`    | none                          | Turns email on: `smtp://user:password@host:587` (STARTTLS) or `smtps://…:465`. `_FILE` works too. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | none | The same, one part each. `SMTP_PASSWORD_FILE` works too. |
| `SMTP_FROM`   | none                          | The sender, such as `Heautou <auth@example.home>`. Required with `SMTP_URL` or `SMTP_HOST`.      |
| `S3_ENDPOINT` | none                          | The S3-compatible store profile pictures go in, such as `http://rustfs:9000`. Unset, pictures are off. |
| `S3_BUCKET`   | none                          | The bucket. Keep it private: Heautou serves the pictures itself.                                  |
| `S3_REGION`   | `us-east-1`                   | The region requests are signed for. Most self-hosted stores take any.                             |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | The key Heautou uses the bucket with. Every `S3_` variable has a `_FILE` form too.     |
| `FORWARD_AUTH_COOKIE_DOMAIN` | none           | The parent domain of the protected sites, such as `home.lan`. Wins over the one set in the UI.    |
| `FORWARD_AUTH_TRUSTED_PROXIES` | loopback, `TRUST_PROXY` | The proxies that may call `/auth/verify`: addresses or CIDR ranges, comma-separated.  |

### Profile pictures

Pictures are kept in an S3-compatible bucket (RustFS, MinIO, Garage), addressed path-style, never in the
database. Make the bucket and a key that may read, write and delete in it, and set the `S3_` variables. Heautou checks
the bucket at start-up and logs a `[preflight]` warning when it can't reach it or is refused; sign-ins work either
way. Setting only some of them stops start-up with the names of the missing ones.

An upload is checked by its bytes (PNG, JPEG or WebP), cropped to a 256 px square and saved again as PNG, which
drops its metadata, such as where a photo was taken. The `picture` claim is
`<your-host>/users/<id>/picture?v=<version>`: Heautou streams it from the bucket to anyone who has the URL, so apps
need no access to the store, and a new picture gets a new `v`, so caches fetch it. Deleting a user deletes their
picture.

### Sealing secrets at rest

Without `SECRET_KEY`, client secrets, the private signing and cookie keys, authenticator app secrets, sign-in
providers' client secrets and the SMTP password saved under Settings are plain text in the database, and Heautou
logs a warning at start-up. Set the key and restart: the next start seals what is there, and everything written
after that is sealed (AES-256-GCM). Keep the key **outside** the data folder (an env file or a Docker secret, not the
volume), so a copy of the database or a backup of it is not enough to read them.

**Losing the key loses those secrets.** Heautou refuses to start with the wrong key, or with none once anything is
sealed, and changes nothing, so put the right one back. A backup is sealed under the same key, so it doesn't help.
There is no supported way to recover the data without the key: keep a copy of it somewhere safe.

To change the key, set the new one as `SECRET_KEY` and the old one as `SECRET_KEY_PREVIOUS`, start once (that
start seals everything again under the new key), then remove `SECRET_KEY_PREVIOUS`.

With Compose, a Docker secret keeps the key out of the environment:

```yaml
services:
  heautou:
    environment:
      SECRET_KEY_FILE: /run/secrets/heautou_secret_key
    secrets: [heautou_secret_key]
secrets:
  heautou_secret_key:
    file: ./secret_key   # openssl rand -base64 32 > secret_key && chmod 600 secret_key
```

### Behind a reverse proxy (HTTPS)

Over plain HTTP, passwords, session cookies and tokens cross your network readable, and some apps refuse
an `http` issuer. Heautou has no TLS of its own: put a reverse proxy in front that holds the certificate,
and point it at Heautou's port.

1. Set `ISSUER_URL` to the HTTPS address, for example `https://auth.example.home/oidc`. There is one issuer:
   apps, browsers and the admin UI all use this address, so stop using the plain `http://host:3000` one.
2. Set `TRUST_PROXY=1`, so Heautou believes the proxy's `X-Forwarded-Proto` and `X-Forwarded-For`. Without
   it, Heautou thinks every request comes from the proxy, and its rate limits lump everyone together.
3. Have the proxy pass the original `Host` header and set `X-Forwarded-Proto: https`.
4. Only the proxy should reach Heautou's port. Docker publishes ports past host firewalls such as `ufw`,
   so if the proxy is on the same machine, bind the port to loopback: `ports: ["127.0.0.1:3000:3000"]`.
   If it is on another machine, allow only the proxy's address to the port.

Heautou logs a warning at start-up while its issuer is `http://` on anything but `localhost`.

With HAProxy, using a certificate for the name (a DNS-01 certificate from Let's Encrypt works for a name only
your LAN resolves):

```haproxy
frontend https
    bind :443 ssl crt /etc/haproxy/certs/auth.example.home.pem
    http-request set-header X-Forwarded-Proto https
    use_backend heautou if { req.hdr(host) -i auth.example.home }

backend heautou
    option forwardfor
    server heautou 192.168.1.10:3000
```

The Activity page and the pair dialog follow the server with server-sent events on `/graphql`. A proxy that
buffers responses holds them back: HAProxy and Caddy pass them straight through; with nginx, set
`proxy_buffering off;` for `/graphql`.

## Your data

Everything is in one database: PGlite in `DATA_DIR/pg` (the `heautou-data` volume in Docker) by default, or the
Postgres server `DATABASE_URL` names. It holds the clients, users, groups, keys, second factors, sign-in providers
and linked accounts, APIs, protected sites, settings, branding, open invite and reset links, browser sessions, the
provider's sessions, codes and tokens, and the activity log (the newest 20,000 entries). Profile pictures are not in
it but in the S3 bucket: back the bucket up on its own.

Heautou updates the database's tables (its migrations) as it starts. `npm run db:migrate` does the same without
starting the server; with PGlite, stop the server first. Only one Heautou may use a database at a time; a second
one, or the backup CLI while the server runs, refuses to start.

### Backup and restore

**Settings → Keys and backup** downloads a backup (a `.json.gz` file) and restores one. A restore checks the whole
file first, and that its sealed secrets open under this server's `SECRET_KEY` (or `SECRET_KEY_PREVIOUS`), then
replaces all the data at once. Everyone is signed out, you too.

The same from the shell, with the server stopped and the same `DATA_DIR`, `DATABASE_URL` and `SECRET_KEY` as the
server:

```sh
npm run backup -- export heautou-backup.json.gz              # add --sessions to take the provider's sessions too
npm run backup -- restore heautou-backup.json.gz
```

In Docker, stop the server, run it in the image against the same volume, then start the server and copy the file out:

```sh
docker compose stop heautou
docker compose run --rm heautou npm run backup -- export /data/heautou-backup.json.gz
docker compose start heautou
docker compose cp heautou:/data/heautou-backup.json.gz .
```

A backup holds everything above except the browser sessions (for the admin UI, the account page and protected
sites; a restore signs everyone out) and, unless you ask for them, the provider's sessions, codes and tokens
(without them, users sign in to their apps again). Secrets go in sealed under `SECRET_KEY` as they are in the
database, so restoring needs the same key. Password hashes are in it too: keep it as safe as the database.

### Upgrading from JSON files

Versions before the database kept the data in JSON files in `DATA_DIR`. The first start of this version on such a
folder, with an empty database, puts the files in the database and moves them to `DATA_DIR/imported-json/`. Nothing
reads them after that; delete them once you are happy. This works for Postgres too: keep the old volume mounted at
`/data` for that first start. If a file can't be read, Heautou stops without importing or moving anything.

### Locked out of the admin UI

While there is no admin, Heautou prints a setup link with a token to its log at every start
(`docker compose logs heautou | grep setup`), and `/setup` takes it; see [Quick start](#quick-start-docker-compose).
Heautou refuses to remove the last admin, so that is mostly for a fresh or restored database. An admin who forgot
their password can be sent a reset link by another admin, or use **Forgot password?** when email is set up and it is
on. There is no supported way to edit the database by hand.

## Security

What Heautou does:

- **The admin UI signs in through Heautou itself.** It is a built-in client, and only users in the
  `heautou-admin` group get in. Taking someone out of the group signs them out of the admin UI. Heautou refuses
  to remove the last admin.
- **The admin API takes only same-origin JSON.** `/graphql` answers only `POST` with `Content-Type:
  application/json` from pages on the issuer's origin, so another website can't drive it through your browser.
  Open the admin UI at the issuer's address: requests from any other address are refused.
- **Users can be shut out at once.** Every sign-in, token refresh and userinfo call checks the user is
  enabled and in the client's allowed groups.
- **Password guessing is slowed.** Sign-ins are limited to 5 failures per username and 10 per address in
  15 minutes, and sign-in routes to 120 requests a minute per address. Unknown usernames take as long to
  refuse as wrong passwords.
- **Setup URLs are single use.** A pairing's token registers one client, lasts 10 minutes, and can be
  cancelled. Registration is rate-limited like sign-in.
- **Secrets can be sealed at rest.** With `SECRET_KEY` set, client secrets, the private signing and cookie
  keys and the other secrets listed under [Sealing secrets at rest](#sealing-secrets-at-rest) are encrypted in the
  database, under a key kept outside it. Passwords, recovery codes and the tokens of browser sessions and password
  links are stored hashed.
- **Redirect URIs must be `https`.** Plain `http` is allowed on `localhost`, `127.0.0.1` and `[::1]`, and a
  native app's own scheme (such as `com.example.app:/callback`) is allowed for a public client. To allow plain
  `http` on any host, turn on **Allow plain http** under **Settings → Sign-in**. Until you choose, it follows
  `ISSUER_URL`: allowed when that is `http://`, refused when it is `https://`. Clients saved before it was refused
  keep working and are marked in the client list.
- **Sign-ins and changes are logged.** Every sign-in, failed or refused one, admin change, password link use
  and account change goes in the activity log, shown on the Activity page, which updates live while it is open; each
  user sees their own sign-ins on their account page. Each time Heautou sends someone back to an app, it logs
  "Signed in to an app" with the app, the redirect URI, and whether a password was typed or the session they
  already had let them straight through. Refused sign-in and token requests from apps, sign-outs, machine
  (client credentials) tokens and scheduled key rotations are logged too. Passwords, tokens, client secrets and setup URLs are never written to it.
- **Tokens for an API name it.** An access token asked for with `resource` has that API as its `aud`, and only
  the clients an API lists can get one. The audit log names the API each sign-in and machine token was for.
- **The pages can't be framed**, send no referrer, and the web app runs only its own scripts.

What it does not do: seal anything without `SECRET_KEY` (then anyone who can read the database has the
signing keys and client secrets), seal the provider's live sessions, codes and tokens (they are short-lived, and
the provider looks tokens up by their value), or terminate TLS.

## Running from source

Needs Node.js 26.

```sh
npm install
npm run dev                    # UI on http://localhost:3000, API on :8787
npm run build && npm start     # production, one process on port 3000
npm run check && npm test
npm run db:migrate             # apply the migrations without starting the server
```

`AGENTS.md` describes how the code is laid out.
