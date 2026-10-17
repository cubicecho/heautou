# Heautou

A minimal OpenID Connect provider for self-hosted setups. It gives your apps one shared sign-in
("Sign in with Heautou") without running Keycloak or Authentik.

- **An OIDC provider** for the authorization code flow, with a client secret or with PKCE. Apps find it
  through the standard discovery URL.
- **A small web UI** for adding the apps that sign in (clients) and the people who sign in (users), with
  groups, invite links, and a page where each user changes their own password.
- **Flat-file storage.** Everything is in a few JSON files in one folder. There is no database.

> [!WARNING]
> Heautou is built for a home or office network you trust. The admin UI needs a sign-in, but client secrets
> and signing keys are plain text in the data folder unless you set `SECRET_KEY`, and nothing has been audited. Don't expose
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

Your clients, users and keys are kept in the `heautou-data` volume, so they survive restarts and upgrades.
To upgrade, run `docker compose pull && docker compose up -d`.

### Without Compose

```sh
docker run -d --name heautou --restart unless-stopped \
  -p 3000:3000 -v heautou-data:/data \
  -e ISSUER_URL=http://192.168.1.10:3000/oidc \
  ghcr.io/cubicecho/heautou:latest
```

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

### Claims

| Scope     | Claims                                                                    |
| --------- | ------------------------------------------------------------------------- |
| `openid`  | `sub` (the user's ID)                                                     |
| `profile` | `name`, `preferred_username` (the username), and the user's custom claims |
| `email`   | `email`, `email_verified`                                                 |
| `groups`  | `groups`, or the client's own groups claim name                           |

Add `offline_access` to the scopes for a refresh token. Custom claims are set per user, one `name=value` per
line, and are sent as strings; the names the provider sets itself, such as `sub` or `email`, are refused.

## Managing users

- **Invites and password resets.** A user's link button makes a link to send them by chat or however you like:
  Heautou sends no email. The link sets their password and works once, for 24 hours. A new link replaces the
  old one.
- **Their own account.** Every user can open `/account` to see their details, change their password, and see
  or end where they are signed in. Signing in to the admin UI without being an admin lands there too.
- **Disable and sign out.** Disabling a user turns them away at once: their tokens stop working and they can't
  sign in again until you enable them. The sessions button lists where a user is signed in and ends one or all
  of them. Heautou refuses to disable or delete the last admin.
- **Groups.** The **Groups** page lists every group with its members and the clients limited to it. Renaming a
  group renames it on every user and client. A group a client is limited to can't be deleted, and nor can
  `heautou-admin`.

## Settings

- **Branding.** A name and a logo (PNG, JPEG, WebP or SVG, up to 256 KB) for the sign-in page, the account
  page and the sidebar, in place of "Heautou".
- **Signing keys.** Heautou rotates its signing key at start-up once it is 90 days old, and **Rotate now** does it
  at once. The previous key stays published, so tokens it signed still verify; tokens signed with keys older than
  that stop verifying, and those users sign in again.

## Configuration

Set these as environment variables, under `environment:` in Compose.

| Variable      | Default                       | What it does                                                                                     |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `ISSUER_URL`  | `http://localhost:3000/oidc`  | The public URL of Heautou plus `/oidc`. It must be reachable by your apps and your browser.        |
| `PORT`        | `3000`                        | The port the server listens on inside the container.                                              |
| `DATA_DIR`    | `/data` (Docker)              | Where the JSON files are written.                                                                 |
| `TRUST_PROXY` | `false`                       | Set to `1` behind one reverse proxy, so the forwarded `https` and host headers are believed.      |
| `SECRET_KEY`  | none                          | Seals client secrets and signing keys on disk. 32 bytes of base64: `openssl rand -base64 32`.     |
| `SECRET_KEY_FILE` | none                      | A file holding the key, such as a Docker secret. It wins over `SECRET_KEY`.                       |
| `SECRET_KEY_PREVIOUS` | none                  | The old key while changing keys (`_FILE` works too). Remove it after one start.                   |

### Sealing secrets at rest

Without `SECRET_KEY`, client secrets and the private signing keys are plain text in the data folder, and Heautou
logs a warning at start-up. Set the key and restart: the next start seals what is there, and everything written
after that is sealed (AES-256-GCM). Keep the key **outside** the data folder (an env file or a Docker secret, not the
volume), so a copy of the folder or a backup of it is not enough to read them.

**Losing the key loses the client secrets and the signing keys.** Heautou refuses to start with the wrong key,
and changes nothing, so put the right one back. If it is gone for good, delete `keys.json` (every app has to
sign in again), give each confidential client a new secret by hand in `clients.json`, then start and rotate them.

To change the key, set the new one as `SECRET_KEY` and the old one as `SECRET_KEY_PREVIOUS`, start once, then
remove `SECRET_KEY_PREVIOUS`.

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

Everything lives in the data folder, which is the `heautou-data` volume in Docker:

- `clients.json`: apps and their secrets (sealed with `SECRET_KEY`)
- `users.json`: users, with hashed passwords
- `keys.json`: the token signing and cookie keys (their private halves sealed with `SECRET_KEY`)
- `admin-sessions.json`: browsers signed in to the admin UI or the account page (hashed tokens)
- `password-links.json`: open invite and reset links (hashed tokens)
- `branding.json`: the name and logo
- `audit.jsonl`: the activity log, one entry a line; at 1 MB it moves to `audit.1.jsonl`, and two old files are kept
- `oidc/`: sessions, codes and tokens. These are not sealed: they are short-lived, and the provider looks
  tokens up by their value, so they sit in the clear until they expire.

Heautou makes its files readable by its own user only (mode 0600). Back up the folder to back up Heautou. Deleting `keys.json` makes new keys on the next start, and
every app has to sign in again.

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
- **Secrets can be sealed at rest.** With `SECRET_KEY` set, client secrets and the private signing and cookie
  keys are encrypted in the data folder, under a key kept outside it.
- **Redirect URIs must be `https`.** Plain `http` is allowed on `localhost`, `127.0.0.1` and `[::1]`, and a
  native app's own scheme (such as `com.example.app:/callback`) is allowed for a public client. To allow plain
  `http` on any host, turn on **Allow plain http** under Settings. Until you choose, it follows `ISSUER_URL`:
  allowed when that is `http://`, refused when it is `https://`. Clients saved before it was refused keep working
  and are marked in the client list.
- **Sign-ins and changes are logged.** Every sign-in, failed or refused one, admin change, password link use
  and account change goes in `audit.jsonl`, shown on the Activity page, which updates live while it is open; each
  user sees their own sign-ins on their account page. Each time Heautou sends someone back to an app, it logs
  "Signed in to an app" with the app, the redirect URI, and whether a password was typed or the session they
  already had let them straight through. Refused sign-in and token requests from apps, sign-outs, machine
  (client credentials) tokens and scheduled key rotations are logged too. Passwords, tokens, client secrets and setup URLs are never written to it.
- **The pages can't be framed**, send no referrer, and the web app runs only its own scripts.

What it does not do: seal anything without `SECRET_KEY` (then anyone who can read the data folder has the
signing keys and client secrets), seal the live sessions, codes and tokens in `oidc/`, or terminate TLS.

## Running from source

Needs Node.js 26.

```sh
npm install
npm run dev                    # UI on http://localhost:3000, API on :8787
npm run build && npm start     # production, one process on port 3000
npm run check && npm test
```

`AGENTS.md` describes how the code is laid out.
