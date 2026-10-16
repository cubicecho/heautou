# Heautou

A minimal OpenID Connect provider for self-hosted setups. It gives your apps one shared sign-in
("Sign in with Heautou") without running Keycloak or Authentik.

- **An OIDC provider** for the authorization code flow, with a client secret or with PKCE. Apps find it
  through the standard discovery URL.
- **A small web UI** for adding the apps that sign in (clients) and the people who sign in (users).
- **Flat-file storage.** Everything is in a few JSON files in one folder. There is no database.

> [!WARNING]
> Heautou is built for a home or office network you trust. The admin UI needs a sign-in, but client secrets
> and signing keys are stored as plain text in the data folder, and nothing has been audited. Don't expose
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

1. **Add a user.** Under **Users**, choose **New user** and set a username and password. Name, email and
   groups are optional; they are put into the user's tokens. Only users in the `heautou-admin` group can
   use the admin UI; everyone else can only sign in to your apps.
2. **Add a client.** Under **Clients**, choose **New client**:
   - **Name:** what the sign-in page shows, such as "Grafana".
   - **Redirect URIs:** the app's callback URL. The app's OIDC docs give it, and it must match exactly.
   - **Client authentication:** keep **Secret, Basic header** unless the app says otherwise. Choose
     **Public (PKCE)** for browser-only or mobile apps that cannot keep a secret.
3. **Copy the settings into the app.** Open the client's row on the Clients page:

   | The app asks for            | Use                                                           |
   | --------------------------- | ------------------------------------------------------------- |
   | Discovery / well-known URL  | `<ISSUER_URL>/.well-known/openid-configuration`               |
   | Issuer                      | `<ISSUER_URL>`, for example `http://192.168.1.10:3000/oidc`   |
   | Client ID                   | The client's row, **Client ID**                               |
   | Client secret               | The client's row, **Client secret**                           |
   | Scopes                      | `openid profile email` (add `groups` for group-based roles)   |

   The **Overview** page shows the issuer and discovery URL with copy buttons. If an app wants each
   endpoint entered separately, they are `<ISSUER_URL>/auth`, `/token`, `/me` (userinfo), `/jwks`
   and `/session/end` (logout).

Signing in from the app sends you to Heautou's sign-in page and then back to the app. There is no
consent screen: the apps you added are trusted.

### Claims

| Scope     | Claims                                      |
| --------- | ------------------------------------------- |
| `openid`  | `sub` (the user's ID)                       |
| `profile` | `name`, `preferred_username` (the username) |
| `email`   | `email`, `email_verified`                   |
| `groups`  | `groups`                                    |

Add `offline_access` to the scopes for a refresh token.

## Configuration

Set these as environment variables, under `environment:` in Compose.

| Variable      | Default                       | What it does                                                                                     |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `ISSUER_URL`  | `http://localhost:3000/oidc`  | The public URL of Heautou plus `/oidc`. It must be reachable by your apps and your browser.        |
| `PORT`        | `3000`                        | The port the server listens on inside the container.                                              |
| `DATA_DIR`    | `/data` (Docker)              | Where the JSON files are written.                                                                 |
| `TRUST_PROXY` | `false`                       | Set to `1` behind one reverse proxy, so the forwarded `https` and host headers are believed.      |

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

## Your data

Everything lives in the data folder, which is the `heautou-data` volume in Docker:

- `clients.json`: apps and their secrets
- `users.json`: users, with hashed passwords
- `keys.json`: the token signing keys
- `admin-sessions.json`: signed-in admin browsers (hashed tokens)
- `oidc/`: sessions, codes and tokens

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
- **Password guessing is slowed.** Sign-ins are limited to 5 failures per username and 10 per address in
  15 minutes, and sign-in routes to 120 requests a minute per address. Unknown usernames take as long to
  refuse as wrong passwords.
- **The pages can't be framed**, send no referrer, and the web app runs only its own scripts.

What it does not do: encrypt the data folder (anyone who can read it has the signing keys and client
secrets), terminate TLS, keep an audit log, or limit redirect URIs to `https`.

## Running from source

Needs Node.js 26.

```sh
npm install
npm run dev                    # UI on http://localhost:3000, API on :8787
npm run build && npm start     # production, one process on port 3000
npm run check && npm test
```

`AGENTS.md` describes how the code is laid out.
