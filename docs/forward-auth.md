# Forward auth: protecting sites behind a reverse proxy

Many self-hosted apps have no sign-in of their own, or a weak one: the *arr apps, dashboards, admin panels. With
forward auth, the reverse proxy in front of them asks Heautou about every request. Heautou answers "let it
through, and here is who it is", "send the browser to sign in", or "refuse". The app itself does nothing.

Heautou follows the shape Authelia and Authentik use, so the usual `auth_request` and `forward_auth` recipes work.
This page has a snippet for HAProxy, nginx, Caddy and Traefik.

## How it works

1. The browser asks for `https://sonarr.home.lan/`. The proxy first calls Heautou's verify endpoint, passing the
   original request's host, path and method in headers and the browser's cookies.
2. Nobody is signed in, so Heautou answers with the sign-in address,
   `https://auth.home.lan/auth/sign-in?rd=https://sonarr.home.lan/`, and the proxy sends the browser there.
3. The browser signs in on Heautou's usual sign-in page: password, second factor, passkey or an upstream provider,
   whatever the user has. Heautou signs in as a built-in app, **Protected sites** (`heautou-proxy`).
4. Heautou sets its proxy session cookie, `heautou_proxy`, on the **cookie domain** (say `home.lan`), so the
   browser sends it to every site under it, and sends the browser back to `rd`.
5. The proxy asks again. This time Heautou answers 200 with the user in `Remote-User`, `Remote-Name`,
   `Remote-Email` and `Remote-Groups`, and the proxy passes the request on to the app with those headers.

## Setting it up

1. **Put Heautou under the same parent domain as the sites**, such as `auth.home.lan` next to `sonarr.home.lan`.
   A browser only takes a cookie for a parent of the host that sets it.
2. **Set the cookie domain** to that parent, `home.lan`, under **Protected sites**, or with
   `FORWARD_AUTH_COOKIE_DOMAIN=home.lan` (which wins). Without one, only sites on Heautou's own host share the
   sign-in.
3. **Tell Heautou which callers are proxies.** Only a trusted proxy may say which request it is asking about. Set
   `FORWARD_AUTH_TRUSTED_PROXIES` to the proxy's address or range, such as `192.168.1.2` or `172.18.0.0/16` for a
   Docker network. Unset, Heautou believes loopback and whatever `TRUST_PROXY` trusts. Any other caller gets 403,
   and the log says so once every few minutes.
4. **Add each site** under **Protected sites**: its host, an optional path prefix (`/admin` covers `/admin` and
   `/admin/users`, not `/administrator`), the groups that may reach it, and whether it needs a second factor.
   The proxy is refused for anything not listed, so add a site for each host the proxy asks about.
5. **Configure the proxy** with one of the snippets below. Use the address the proxy reaches Heautou at, such as
   `http://heautou:3000` on a Docker network.

## The endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /auth/verify` | 200 with the `Remote-*` headers for a signed-in user who may reach the site; 401 when nobody is signed in, with the sign-in URL in `Location`; 403 when the user may not reach it, the host is not a protected site, or the caller is not a trusted proxy; 400 when the forwarded headers are missing or disagree. |
| `GET /auth/verify?redirect=1` | The same, except that a browser's `GET` or `HEAD` gets a 302 to the sign-in URL instead of a 401. Other methods still get 401, since a redirected `POST` loses its body. |
| `GET /auth/sign-in?rd=<url>` | Signs in and returns to `rd`. Add `&mfa=1` to ask for the password again, for a second factor. |
| `GET /auth/sign-out` | Ends the proxy session and goes on to Heautou's own sign-out. Link an app's "log out" here. |

Which form each proxy wants:

| Proxy | Endpoint | Why |
| --- | --- | --- |
| HAProxy (haproxy-auth-request) | `/auth/verify?redirect=1` | The Lua script hands a 302's `Location` to HAProxy, which redirects. |
| nginx (`auth_request`) | `/auth/verify` | nginx only takes 2xx, 401 and 403 from an auth subrequest, and turns the 401 into a redirect itself. |
| Caddy (`forward_auth`) | `/auth/verify?redirect=1` | Caddy passes any non-2xx answer, 302 included, back to the browser. |
| Traefik (`forwardAuth`) | `/auth/verify?redirect=1` | The same as Caddy. |

### What the proxy must send

The original request, described either way:

- `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Uri` (the path and query), as Traefik, Caddy and the
  HAProxy recipe send; or
- `X-Original-URL`, the whole URL, as nginx recipes send.

Also `X-Forwarded-Method` (or `X-Original-Method`), and the browser's `Cookie` header. Sent together, the two forms
must name the same host and path, or Heautou answers 400: a header the client set and the proxy passed on can't
point the check at another site. A header with several comma-separated values is refused too. Have the proxy set
these headers, never append to them.

### What the app receives

| Header | Value |
| --- | --- |
| `Remote-User` | The username |
| `Remote-Name` | The display name, possibly empty |
| `Remote-Email` | The email address, possibly empty |
| `Remote-Groups` | The groups, comma-separated |

The proxy must drop these headers from the browser's own request, so nobody can claim to be someone else to an
app the proxy lets them reach. Every snippet below does.

## HAProxy

HAProxy has no forward auth of its own. Use [haproxy-auth-request](https://github.com/TimWolla/haproxy-auth-request),
a Lua script, as Authelia does. It needs [haproxy-lua-http](https://github.com/haproxytech/haproxy-lua-http) and
[json.lua](https://github.com/rxi/json.lua). The official `haproxy` Docker image has Lua built in.

```sh
mkdir -p lua
curl -fsSL -o lua/auth-request.lua \
  https://raw.githubusercontent.com/TimWolla/haproxy-auth-request/9fe6049577cfcb5c159ed7d3a2bb72465a5c11ab/auth-request.lua
curl -fsSL -o lua/haproxy-lua-http.lua \
  https://raw.githubusercontent.com/haproxytech/haproxy-lua-http/670d0d278182902f252faffc17eeb51a7ecb4b9d/http.lua
curl -fsSL -o lua/json.lua https://raw.githubusercontent.com/rxi/json.lua/v0.1.2/json.lua
```

A complete `haproxy.cfg`, with Heautou at `auth.home.lan` and two protected sites:

```haproxy
global
    # HAProxy 3.1 and later; remove this line on older versions.
    tune.lua.bool-sample-conversion normal
    lua-prepend-path /usr/local/etc/haproxy/lua/?.lua
    lua-load /usr/local/etc/haproxy/lua/auth-request.lua

defaults
    mode http
    timeout connect 5s
    timeout client  30s
    timeout server  30s

frontend web
    bind :80
    bind :443 ssl crt /usr/local/etc/haproxy/certs/
    http-request redirect scheme https unless { ssl_fc }

    acl host_heautou hdr(host),field(1,:) -i auth.home.lan
    acl host_sonarr  hdr(host),field(1,:) -i sonarr.home.lan
    acl host_wiki    hdr(host),field(1,:) -i wiki.home.lan
    # Every host Heautou guards. Each needs a site under Protected sites too.
    acl protected    hdr(host),field(1,:) -i sonarr.home.lan wiki.home.lan

    # Only Heautou says who the user is.
    http-request del-header Remote-User
    http-request del-header Remote-Name
    http-request del-header Remote-Email
    http-request del-header Remote-Groups
    http-request del-header X-Original-URL

    # Describe the request, for Heautou and for TRUST_PROXY.
    http-request set-header X-Forwarded-For %[src]
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    http-request set-header X-Forwarded-Proto http unless { ssl_fc }
    http-request set-header X-Forwarded-Host %[req.hdr(host)]
    http-request set-header X-Forwarded-Uri %[pathq]
    http-request set-header X-Forwarded-Method %[method]

    # Ask Heautou, sending only the X-Forwarded-* headers and the cookies. On 200 the Remote-* headers are copied
    # onto the request; otherwise a sign-in redirect, a 401 or a 403. If Heautou is down, the request is refused.
    http-request lua.auth-intercept be_heautou /auth/verify?redirect=1 HEAD x-forwarded-*,cookie remote-user,remote-name,remote-email,remote-groups - if protected
    http-request redirect location %[var(txn.auth_response_location)] code 302 if protected !{ var(txn.auth_response_successful) -m bool } { var(txn.auth_response_location) -m found }
    http-request deny deny_status 401 if protected !{ var(txn.auth_response_successful) -m bool } { var(txn.auth_response_code) -m int 401 }
    http-request deny deny_status 403 if protected !{ var(txn.auth_response_successful) -m bool }

    use_backend be_heautou if host_heautou
    use_backend be_sonarr  if host_sonarr
    use_backend be_wiki    if host_wiki

backend be_heautou
    server heautou heautou:3000

backend be_sonarr
    server sonarr sonarr:8989

backend be_wiki
    server wiki wiki:3000
```

And the services, with HAProxy and Heautou on one Docker network:

```yaml
services:
  haproxy:
    image: haproxy:3.2
    ports: ["80:80", "443:443"]
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - ./lua:/usr/local/etc/haproxy/lua:ro
      - ./certs:/usr/local/etc/haproxy/certs:ro
    networks: [proxy]
  heautou:
    image: ghcr.io/cubicecho/heautou:latest
    environment:
      ISSUER_URL: https://auth.home.lan/oidc
      TRUST_PROXY: "1"
      FORWARD_AUTH_COOKIE_DOMAIN: home.lan
      FORWARD_AUTH_TRUSTED_PROXIES: 172.30.0.0/24
    volumes: [heautou-data:/data]
    networks: [proxy]
networks:
  proxy:
    ipam:
      config: [{ subnet: 172.30.0.0/24 }]
volumes:
  heautou-data:
```

Heautou is reached through HAProxy for sign-in, and HAProxy calls `/auth/verify` on it directly. Don't publish
Heautou's port: only the proxy should reach it.

This configuration was run end to end with HAProxy 3.2 and the Lua scripts above (plain http on one port in
place of the TLS lines): an unsigned browser got the 302 to sign in, signed in and came back, the app received
the `Remote-*` headers, a `Remote-User` the client sent was replaced, a user outside the site's groups got 403, a
`POST` without a session got 401, a second site under the cookie domain shared the sign-in, `/auth/sign-out`
ended it, and with Heautou stopped or the proxy not trusted every request was refused.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name sonarr.home.lan;

    location = /internal/heautou-verify {
        internal;
        proxy_pass http://heautou:3000/auth/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
        proxy_set_header X-Forwarded-Method $request_method;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Uri $request_uri;
    }

    location / {
        auth_request /internal/heautou-verify;
        auth_request_set $heautou_sign_in $upstream_http_location;
        auth_request_set $heautou_user $upstream_http_remote_user;
        auth_request_set $heautou_groups $upstream_http_remote_groups;
        auth_request_set $heautou_name $upstream_http_remote_name;
        auth_request_set $heautou_email $upstream_http_remote_email;
        error_page 401 =302 $heautou_sign_in;

        # Set, so whatever the browser sent is replaced.
        proxy_set_header Remote-User $heautou_user;
        proxy_set_header Remote-Groups $heautou_groups;
        proxy_set_header Remote-Name $heautou_name;
        proxy_set_header Remote-Email $heautou_email;
        proxy_pass http://sonarr:8989;
    }
}
```

This was run end to end with nginx 1.29 too: the redirect to sign in, the sign-in, and the `Remote-*` headers.

## Caddy

```caddy
sonarr.home.lan {
    forward_auth heautou:3000 {
        uri /auth/verify?redirect=1
        copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy sonarr:8989
}
```

Caddy sends `X-Forwarded-Method`, `X-Forwarded-Uri`, `X-Forwarded-Host` and `X-Forwarded-Proto` itself, and
`copy_headers` replaces any `Remote-*` header the browser sent. Untested here; it is the same shape as Authelia's.

## Traefik

```yaml
http:
  middlewares:
    heautou:
      forwardAuth:
        address: http://heautou:3000/auth/verify?redirect=1
        trustForwardHeader: false
        authResponseHeaders: [Remote-User, Remote-Groups, Remote-Name, Remote-Email]
  routers:
    sonarr:
      rule: Host(`sonarr.home.lan`)
      middlewares: [heautou]
      service: sonarr
```

Or as Docker labels:
`traefik.http.middlewares.heautou.forwardauth.address=http://heautou:3000/auth/verify?redirect=1` and
`traefik.http.middlewares.heautou.forwardauth.authResponseHeaders=Remote-User,Remote-Groups,Remote-Name,Remote-Email`.
Keep `trustForwardHeader` off unless another proxy sits in front of Traefik. Untested here.

## Sessions and signing out

- A proxy session lasts 12 hours, or 2 hours without a request (`FORWARD_AUTH_DEFAULTS`). The cookie is
  `HttpOnly`, `SameSite=Lax`, and `Secure` when the issuer is https. Only its SHA-256 is stored, in
  `proxy-sessions.json`, which backups leave out.
- Each check also asks whether the provider grant it was made under still stands and the user is still enabled.
  So signing out at Heautou (`/oidc/session/end`), an admin ending the user's sessions or signing them out,
  disabling or deleting the user, or **Sign out everywhere** on `/account` all end it at the next request.
- A site set to **Require a second factor** sends a user who signed in with a password alone back to sign in
  again (`mfa=1`), where they give their authenticator code or passkey. A user with no second factor is refused
  with 403 and told to set one up.

## What goes in the activity log

Sign-ins to the protected sites (with the site), sign-outs, and refusals of a signed-in user (not in the site's
groups, or no second factor), each user and site at most once every 5 minutes, so a page and its assets are one
entry. Allowed requests are not logged: there is one for every request the proxy makes. Changes to sites and to
the cookie domain are logged like any admin change.

## Not yet

- Basic auth on the verify endpoint, for API clients behind the proxy.
- Rules per path with their own groups beyond one prefix per site, and wildcard hosts (`*.home.lan`).

## Security notes

- The proxy session cookie goes to every host under the cookie domain, apps included, and the proxy passes it on
  to them. An app you don't trust could replay it against the other protected sites. Keep untrusted apps off the
  cookie domain, or strip the `heautou_proxy` cookie in the proxy before the request reaches them.
- `rd` is checked when the sign-in starts and again when it ends: an `http` or `https` URL with no user or
  password in it, on a protected site's host or under the cookie domain. Anything else shows an error page.
- Path prefixes are matched on the URL as the proxy describes it, after `..` segments are resolved. An app that
  treats `%2F` as `/`, or paths as case-insensitive, can be reached past a prefix; give a sensitive part its own
  host where you can.
