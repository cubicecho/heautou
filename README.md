# Heautou

A minimal OpenID Connect provider for self-hosted setups. It gives your apps one shared sign-in
("Sign in with Heautou") without running Keycloak or Authentik.

- **An OIDC provider** for the authorization code flow, with a client secret or with PKCE. Apps find it
  through the standard discovery URL.
- **A small web UI** for adding the apps that sign in (clients) and the people who sign in (users).
- **Flat-file storage.** Everything is in a few JSON files in one folder. There is no database.

> [!WARNING]
> This is insecure on purpose. The admin UI has no login, and client secrets and signing keys are stored
> as plain text. Run it only on a network you trust, and never expose the admin UI to the internet.

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

4. Open `http://<your-host>:3000`.

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
   groups are optional; they are put into the user's tokens.
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

Point the proxy at port 3000, set `ISSUER_URL` to the HTTPS address, for example
`https://auth.example.home/oidc`, and set `TRUST_PROXY=1`. Some apps refuse an `http` issuer, so
HTTPS is worth setting up even at home.

## Your data

Everything lives in the data folder, which is the `heautou-data` volume in Docker:

- `clients.json`: apps and their secrets
- `users.json`: users, with hashed passwords
- `keys.json`: the token signing keys
- `oidc/`: sessions, codes and tokens

Back up the folder to back up Heautou. Deleting `keys.json` makes new keys on the next start, and
every app has to sign in again.

## Running from source

Needs Node.js 26.

```sh
npm install
npm run dev                    # UI on http://localhost:3000, API on :8787
npm run build && npm start     # production, one process on port 3000
npm run check && npm test
```

`AGENTS.md` describes how the code is laid out.
