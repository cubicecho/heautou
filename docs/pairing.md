# Pairing an app with Heautou

This is the app side of pairing, written for whoever adds it to an app, person or agent. An app that does it lets an
operator connect it to Heautou by pasting one URL. The operator copies no client ID or secret and edits no config.

Nothing here is specific to Heautou on the wire. Pairing is OAuth 2.0 Dynamic Client Registration
([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) with an initial access token, found through
[OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html), and
[RFC 7592](https://www.rfc-editor.org/rfc/rfc7592) to update or remove the registration later. The only
Heautou-specific part is the setup URL format. An app needs no client library for this: two `fetch` calls do it.

## What the operator does

1. In Heautou, **Clients → Pair an app**. They choose the allowed groups and the groups claim, then **Make setup URL**.
2. They paste the URL into the app's sign-in setup.
3. The app registers itself. Heautou's dialog shows "Paired with *your app*" and the client is listed as **Paired**.

The setup URL works once, for 10 minutes. The operator can cancel it before then.

## 1. Read the setup URL

```
<issuer>#setup=<initial access token>&name=<provider name>
```

For example `https://id.example.com/oidc#setup=k3Jd…&name=Heautou`.

- **Issuer:** everything before `#`. It is the OIDC issuer, and it ends in `/oidc`.
- **`setup`:** the initial access token. Treat it as a secret. Do not log it or store it after registering.
- **`name`:** the provider's branded name, for the app's "Sign in with …" button. It is optional; fall back to
  something generic such as "SSO".

The token is in the fragment so it never reaches a server's access log when someone opens the URL. Parse it with
`new URLSearchParams(url.hash.slice(1))`. Refuse a URL with no `setup` parameter, or one that is not `http(s)`.

## 2. Discover the registration endpoint

`GET <issuer>/.well-known/openid-configuration`

- Check the document's `issuer` is exactly the issuer from the URL. If it isn't, stop.
- Read `registration_endpoint`. If there is none, the provider doesn't support pairing; tell the operator to set the
  app up by hand.

## 3. Register

```http
POST <registration_endpoint>
Authorization: Bearer <initial access token>
Content-Type: application/json

{
  "client_name": "Telos",
  "redirect_uris": ["https://telos.example.com/api/auth/callback/oidc"],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code"],
  "response_types": ["code"]
}
```

What Heautou accepts:

| Field                       | Values                                                           | If left out             |
| --------------------------- | ---------------------------------------------------------------- | ----------------------- |
| `redirect_uris`             | One or more absolute URIs, matched exactly. `http://` is allowed | Required                |
| `client_name`               | Shown in Heautou's client list and session lists                 | The first redirect host |
| `token_endpoint_auth_method`| `client_secret_basic`, `client_secret_post`, `none` (public, PKCE) | `client_secret_basic` |
| `grant_types`               | Any of `authorization_code`, `refresh_token`, `client_credentials` | `authorization_code`  |
| `response_types`            | `code`                                                           | `code`                  |
| `post_logout_redirect_uris` | Absolute URIs                                                    | None                    |
| `logo_uri`                  | An `http(s)` URL                                                 | None                    |
| `backchannel_logout_uri`    | An `http(s)` URL with no fragment, held to the same https rule as redirect URIs | None     |
| `backchannel_logout_session_required` | `true` to get the session ID (`sid`) in logout and ID tokens | `false`        |

With a `backchannel_logout_uri`, Heautou POSTs a `logout_token` form field there (OpenID Connect Back-Channel Logout
1.0) when a user signs out at Heautou or an admin ends their sessions. It is a JWT signed with the provider's keys, with
`aud` the client ID, `sub`, `sid` when asked for, and the `http://schemas.openid.net/event/backchannel-logout` event.
Check it like an ID token, end the matching session, and answer `200`.

The groups the client lets in and the claim it gets them in are the operator's choice in Heautou. The app doesn't send
them, and Heautou ignores them if it does.

**201 Created** gives back the registered metadata and:

| Field                       | What to do with it                                                                |
| --------------------------- | --------------------------------------------------------------------------------- |
| `client_id`                 | Store it. It is the client ID for sign-in.                                        |
| `client_secret`             | Store it as a secret. There is none for a public (`none`) client.                 |
| `registration_access_token` | Store it as a secret. It updates or removes the registration (step 5).            |
| `registration_client_uri`   | Store it. It is where step 5's requests go.                                       |

Store the issuer and the provider name with them. Then the app signs in as an ordinary OIDC client: the authorization
code flow (with PKCE if it likes; a public client must), scopes `openid profile email`, plus `groups` for group-based
roles and `offline_access` for a refresh token. Ideally the app starts offering "Sign in with *name*" straight away,
without a restart.

## 4. Errors

| Response                              | Meaning                                                              | Tell the operator                  |
| ------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `401` `invalid_token`                 | The setup URL expired, was used already, was cancelled, or is wrong | Make a new setup URL in Heautou    |
| `400` `invalid_client_metadata`       | Heautou can't hold what was sent; `error_description` says why       | Show the description; it is an app bug |
| `400` `invalid_redirect_uri`          | A redirect URI is missing or not an absolute URI                     | Check the app's public URL         |
| `429`                                 | Too many requests from this address                                  | Try again in a minute              |
| Network error, or a discovery mismatch| The URL doesn't point at a provider                                  | Check the URL                      |

A 400 does not spend the setup URL, so the operator can retry once the app is fixed.

## 5. Update or remove the registration (RFC 7592)

Every request is sent to `registration_client_uri` with `Authorization: Bearer <registration_access_token>`.

- **Read:** `GET` gives the current metadata.
- **Update:** `PUT` with the whole metadata again, including `client_id`, for example when the app's public URL
  changes. `200 OK` gives the metadata back. The `client_secret` stays the same.
- **Remove:** `DELETE` gives `204 No Content`. Do it when the operator disconnects the app, then forget the stored
  values.

Heautou **rotates the registration access token** on every PUT. Store the new `registration_access_token` from
the response, or the next request fails. A GET gives back the same one.

If the operator deleted the client in Heautou, these requests get `401 invalid_token`. On a disconnect, treat that as
done and clear the stored values.

## Checklist

- [ ] Accept a setup URL somewhere the operator can reach before any user exists, if the app has no other sign-in.
- [ ] Parse the fragment; never log the token.
- [ ] Discover, and check the issuer matches.
- [ ] POST the registration with `Bearer <token>`.
- [ ] Store the client ID, secret, registration access token and URI, issuer and name; secrets as secrets.
- [ ] Turn on OIDC sign-in without a restart.
- [ ] Offer a disconnect that sends the DELETE.
- [ ] Keep the rotated registration access token after every PUT.
