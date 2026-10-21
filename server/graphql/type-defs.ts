import { API_DEFAULTS, AUDIT_DEFAULTS } from '../core/defaults.ts';
import { AUDIT_TYPES, AuditTargetKind } from '../store/audit.ts';
import { MAX_PASSWORD_SCORE } from '../store/settings.ts';

/** The admin API the web app uses to set up clients and users. */
export const TYPE_DEFS = /* GraphQL */ `
  "How a client proves who it is at the token endpoint."
  enum ClientAuthMethod {
    "The secret in an HTTP Basic header. What most server-side apps send."
    CLIENT_SECRET_BASIC
    "The secret in the form body."
    CLIENT_SECRET_POST
    "No secret: a public client such as a single-page or native app. PKCE is required."
    NONE
  }

  "How a client came to be."
  enum ClientSource {
    "The operator added it."
    ADMIN
    "An app registered itself with a setup URL."
    PAIRED
  }

  "An application that signs its users in through this provider."
  type Client {
    "What the application is configured with as its client ID."
    clientId: ID!
    "What the operator calls it."
    name: String!
    "The client secret. Null for a public client."
    clientSecret: String
    authMethod: ClientAuthMethod!
    "Where the provider may send the user back with a code. Matched exactly."
    redirectUris: [String!]!
    "Where the provider may send the user after signing out."
    postLogoutRedirectUris: [String!]!
    "Only users in one of these groups may sign in to it. Empty lets every user in."
    allowedGroups: [String!]!
    "The claim the user's groups are released in. groups unless the application reads another name."
    groupsClaim: String!
    "Whether it may get tokens for itself with the client credentials grant."
    allowClientCredentials: Boolean!
    "Whether it may sign users in with the device flow (RFC 8628): a device with no browser of its own shows a code, and the user signs in on another device. It also gets refresh tokens."
    allowDeviceFlow: Boolean!
    "Whether the operator added it or an app paired itself."
    source: ClientSource!
    "The logo the app gave when it paired. Null for none."
    logoUri: String
    "How long its tokens stay valid, where the operator changed it."
    tokenLifetimes: ClientTokenLifetimes!
    "Where the provider posts a logout token when one of its users signs out (back-channel logout). Null for none."
    backchannelLogoutUri: String
    "Whether the logout token, and its ID tokens, carry the session ID (sid) the app can match its session by."
    backchannelLogoutSessionRequired: Boolean!
    "The preset the operator started it from, such as mealie. Null for none."
    preset: String
    "Its redirect and post-logout URIs the redirect rule refuses now. Saved before the rule applied, they still work; saving the client again needs them changed."
    refusedRedirectUris: [String!]!
    "The app it belongs to, which groups the clients one app paired. Null for a client the operator added."
    app: ClientApp
    "The APIs that list it, which it may ask for access tokens to with a resource indicator. It can get tokens to no other API."
    apis: [Api!]!
    "When it was added, as an ISO 8601 string."
    createdAt: String!
  }

  "The app a paired client belongs to. Its clients share the id."
  type ClientApp {
    "The pairing that registered its clients, or, for clients paired before that was recorded, the address of the API they are allowed on."
    id: ID!
    "The app's address: the client_uri it paired with, or that API's origin. Null when it gave none."
    uri: String
  }

  "How long one client's tokens stay valid, in seconds. Null is the server's default."
  type ClientTokenLifetimes {
    "Its access tokens, for a user or, with client credentials, for itself."
    accessTokenSeconds: Int
    "Its ID tokens."
    idTokenSeconds: Int
    "Its refresh tokens."
    refreshTokenSeconds: Int
  }

  "How long tokens stay valid when their client does not say, in seconds, and the bounds a client's own must keep to."
  type TokenLifetimeDefaults {
    accessTokenSeconds: Int!
    "An access token a client gets for itself with client credentials."
    clientCredentialsSeconds: Int!
    idTokenSeconds: Int!
    refreshTokenSeconds: Int!
    "Shortest lifetime a client may give its tokens."
    minSeconds: Int!
    "Longest lifetime a client may give its tokens."
    maxSeconds: Int!
  }

  "Where a setup URL is."
  enum PairingStatus {
    "No app has registered with it yet."
    WAITING
    "An app has, and is the pairing's client."
    PAIRED
  }

  "A setup URL handed out for an app to register itself with."
  type Pairing {
    id: ID!
    status: PairingStatus!
    "When the URL stops working, and the pairing is forgotten, as an ISO 8601 string."
    expiresAt: String!
    "The allowed groups the app's client gets."
    allowedGroups: [String!]!
    "The groups claim the app's client gets."
    groupsClaim: String!
    "The client the app registered as. Null while WAITING."
    client: Client
    "Whether the operator has chosen what else to set up for the app."
    finished: Boolean!
    "What the app offers to set up besides its sign-in. Null while WAITING, and once finished."
    offers: PairingOffers
  }

  "What a paired app offers to set up besides its sign-in, for the operator to turn on or leave off."
  type PairingOffers {
    "The client the app registered for its devices (the device flow), waiting for the flow to be turned on. Null when it asked for none."
    deviceClient: Client
    "The API the app describes in its protected resource metadata (RFC 9728), found under its client_uri. Null when it describes none heautou can add."
    api: OfferedApi
  }

  "An API a paired app describes, for the operator to add."
  type OfferedApi {
    "The resource indicator apps send, and the aud of its access tokens."
    identifier: String!
    "What the app calls it."
    name: String!
    "The scopes it lists."
    scopes: [String!]!
    "The API already added with this identifier, which the app's clients would join. Null when it is new."
    existing: Api
  }

  "A pairing just started, with the URL to paste into the app. The URL is shown only this once."
  type StartedPairing {
    pairing: Pairing!
    "The issuer, with a single-use initial access token in the fragment."
    setupUrl: String!
  }

  "A claim of the operator's own, released with the profile scope."
  type Claim {
    name: String!
    value: String!
  }

  "A browser signed in to the provider."
  type Session {
    id: ID!
    "When they signed in, as an ISO 8601 string."
    signedInAt: String
    "When it ends unless used, as an ISO 8601 string."
    expiresAt: String
    "The names of the clients it signed in to."
    clientNames: [String!]!
  }

  "Someone who can sign in through the provider."
  type User {
    "The stable sub claim clients see."
    id: ID!
    "What they type to sign in, and the preferred_username claim."
    username: String!
    "The email claim. Empty when they have none."
    email: String!
    "The name claim. Empty when they have none."
    name: String!
    "The groups claim."
    groups: [String!]!
    "Claims of the operator's own."
    claims: [Claim!]!
    "A disabled user cannot sign in."
    disabled: Boolean!
    "False for an invited user who has not set a password yet."
    hasPassword: Boolean!
    "The browsers signed in as them, newest first."
    sessions: [Session!]!
    "What they can give as a second factor after their password."
    secondFactors: SecondFactors!
    "The upstream identities they sign in with, such as a Google or GitHub account."
    upstreamLinks: [UpstreamLink!]!
    "When they were added, as an ISO 8601 string."
    createdAt: String!
    "The URL of their profile picture, which the picture claim holds. Null when they have none or pictures are off."
    pictureUrl: String
  }

  "Whether profile pictures can be set, which needs an S3 bucket."
  type ProfilePictures {
    "True when the server has a bucket configured."
    isEnabled: Boolean!
    "The largest upload, in bytes."
    maxBytes: Int!
  }

  "A user's second factors, without any secret."
  type SecondFactors {
    "Whether an authenticator app is set up."
    hasTotp: Boolean!
    "How many unused recovery codes they have."
    recoveryCodesLeft: Int!
    "How many passkeys they registered."
    passkeyCount: Int!
  }

  "How an upstream provider signs users in."
  enum UpstreamKind {
    "An OpenID Connect provider, found by discovery from its issuer: Google, Microsoft, GitLab, Authentik..."
    OIDC
    "GitHub, which is plain OAuth 2.0. Who signed in is read from its API."
    GITHUB
  }

  "What happens to an upstream identity no user here is linked to."
  enum UnknownIdentity {
    "It is turned away. A user links it from their account page first."
    REFUSE
    "A user is made for it and linked, when its verified address is in createDomains (or any, when that is empty)."
    CREATE
  }

  "An upstream group that gives a group here."
  type GroupMapping {
    "A value of the provider's groups claim."
    upstream: String!
    "The group here."
    local: String!
  }

  "A provider users may sign in through instead of with a password. Its client secret is never sent back."
  type Upstream {
    "Lower-case letters, digits and dashes. Part of its redirect URI, so it never changes."
    id: ID!
    "What the sign-in button says after Sign in with."
    name: String!
    kind: UpstreamKind!
    "The OpenID Connect issuer. Null for GitHub."
    issuer: String
    clientId: String!
    "Whether a client secret is saved."
    hasClientSecret: Boolean!
    scopes: [String!]!
    unknownIdentity: UnknownIdentity!
    "Email domains a user it creates must have a verified address at. Empty creates one for anybody."
    createDomains: [String!]!
    "The groups a user it creates starts in."
    createGroups: [String!]!
    "Whether a sign-in through it counts as both factors, so no second factor is asked here."
    countsAsBothFactors: Boolean!
    "The claim its groups are in, for groupMappings."
    groupsClaim: String
    "Upstream groups that put a user in a group here each time they sign in. Mapped groups they lose upstream are taken away."
    groupMappings: [GroupMapping!]!
    "The redirect URI to register at the provider."
    redirectUri: String!
    "How many users have an identity linked through it."
    linkCount: Int!
    "When it was added, as an ISO 8601 string."
    createdAt: String!
  }

  "An upstream identity a user signs in with."
  type UpstreamLink {
    providerId: ID!
    providerName: String!
    "The address or username it shows as."
    label: String!
    "When it was linked, as an ISO 8601 string."
    linkedAt: String!
    "When it last signed in, as an ISO 8601 string. Null when it never has."
    lastUsedAt: String
  }

  "A name users hold in their groups claim and clients may be limited to."
  type Group {
    name: String!
    "Its users."
    members: [User!]!
    "The clients limited to it, among other groups."
    clients: [Client!]!
    "Whether it is the admin group, which cannot be renamed or removed."
    isProtected: Boolean!
  }

  "A link a user opens to set their password."
  type PasswordLink {
    url: String!
    "When it stops working, as an ISO 8601 string."
    expiresAt: String!
  }

  "One key tokens are signed with."
  type SigningKey {
    kid: ID!
    "Whether it signs new tokens. The others only verify older ones."
    isCurrent: Boolean!
  }

  "The provider's signing and cookie keys."
  type Keys {
    "When they were last made, as an ISO 8601 string."
    rotatedAt: String
    signingKeys: [SigningKey!]!
  }

  "Whether redirect URIs may be plain http on any host. https, loopback http and a native app's own scheme are always allowed."
  type HttpRedirects {
    isAllowed: Boolean!
    "False while the operator has not chosen, so it follows the issuer: allowed when the issuer is plain http."
    isSet: Boolean!
    "Whether ISSUER_URL is plain http."
    isIssuerHttp: Boolean!
  }

  "What a new password must pass besides its length. Existing passwords keep working."
  type PasswordRules {
    "The lowest zxcvbn score a new password may have, from 0 (anything) to ${MAX_PASSWORD_SCORE} (very hard to guess)."
    minScore: Int!
    "Whether a new password is looked up in Have I Been Pwned, by the first 5 characters of its SHA-1."
    checkBreaches: Boolean!
  }

  "What the sign-in page and the sidebar show the provider as."
  type Branding {
    name: String!
    "Where the logo is served. Null when there is none."
    logoUrl: String
  }

  "What an application needs to be pointed at this provider."
  type ProviderInfo {
    "The issuer URL."
    issuer: String!
    "The OpenID discovery document."
    discoveryUrl: String!
    "The scopes clients may ask for."
    scopes: [String!]!
    "The token introspection endpoint."
    introspectionUrl: String!
  }

  "What an audit log entry records."
  enum AuditType {
    ${AUDIT_TYPES.map((type) => type.toUpperCase()).join('\n    ')}
  }

  "What kind of thing an audit log entry is about."
  enum AuditTargetKind {
    ${Object.values(AuditTargetKind)
      .map((kind) => kind.toUpperCase())
      .join('\n    ')}
  }

  "Who did it: the signed-in user, or for a sign-in the account it was for."
  type AuditActor {
    userId: ID!
    "Their username at the time."
    username: String!
  }

  "What it was done to."
  type AuditTarget {
    kind: AuditTargetKind!
    id: ID!
    "Its name at the time, so the entry still reads after a rename or delete."
    name: String!
  }

  "One fact an entry keeps, such as the username a failed sign-in tried."
  type AuditDetail {
    name: String!
    value: String!
  }

  "One thing that happened."
  type AuditEntry {
    id: ID!
    "When, as an ISO 8601 string."
    at: String!
    type: AuditType!
    "Null when nobody is known, such as a sign-in with an unknown username or an app managing its own registration."
    actor: AuditActor
    "The client's address."
    ip: String
    target: AuditTarget
    detail: [AuditDetail!]!
  }

  "A page of the audit log, newest first."
  type AuditPage {
    entries: [AuditEntry!]!
    "Pass as after for the next page. Null at the end."
    nextCursor: String
  }

  "How an API's access tokens are written."
  enum TokenFormat {
    "A JWT signed with the provider's keys, which the API checks itself with the JWKS."
    JWT
    "A random string the API checks with the introspection endpoint."
    OPAQUE
  }

  "An API (a resource server) apps ask for access tokens to with the resource parameter (RFC 8707)."
  type Api {
    "The resource indicator apps send, and the aud of its access tokens."
    identifier: ID!
    "What the operator calls it."
    name: String!
    "The scopes it understands. Its tokens carry only those of the ones asked for."
    scopes: [String!]!
    tokenFormat: TokenFormat!
    "How long its access tokens stay valid, in seconds. Null leaves it to the client's own, then the server's."
    accessTokenSeconds: Int
    "The clients that may ask for tokens to it."
    allowedClients: [Client!]!
    "When it was added, as an ISO 8601 string."
    createdAt: String!
  }

  "The bounds on an API's own access token lifetime, in seconds."
  type ApiLifetimeBounds {
    minSeconds: Int!
    maxSeconds: Int!
  }

  type Query {
    "The provider's own URLs."
    provider: ProviderInfo!
    "The admin signed in to this UI."
    viewer: User!
    "Every client, oldest first."
    clients: [Client!]!
    "One client."
    client(clientId: ID!): Client!
    "Every user, oldest first."
    users: [User!]!
    "One user."
    user(id: ID!): User!
    "Every group a user or client names, by name."
    groups: [Group!]!
    "The signing keys."
    keys: Keys!
    "The provider's name and logo."
    branding: Branding!
    "Whether redirect URIs may be plain http."
    httpRedirects: HttpRedirects!
    passwordRules: PasswordRules!
    "The providers users may sign in through, oldest first."
    upstreams: [Upstream!]!
    "The redirect URI a provider with this id is given, to register before it is saved."
    upstreamRedirectUri(id: ID!): String!
    "The token lifetimes a client gets unless it is given its own."
    tokenLifetimeDefaults: TokenLifetimeDefaults!
    "A pairing. Null once it has expired or been cancelled."
    pairing(id: ID!): Pairing
    """
    The audit log, newest first. first is at most ${AUDIT_DEFAULTS.maxPageSize}; after is the nextCursor of the page
    before. userId keeps entries done by that user or to them.
    """
    auditLog(first: Int, after: String, type: AuditType, userId: ID): AuditPage!
    "Whether profile pictures can be set."
    profilePictures: ProfilePictures!
    "Every API apps may ask for access tokens to, oldest first."
    apis: [Api!]!
    "One API."
    api(identifier: ID!): Api!
    "The bounds on an API's own access token lifetime."
    apiLifetimeBounds: ApiLifetimeBounds!
  }

  "An API to add. Lists left out are empty; a null lifetime leaves it to the client's own, then the server's."
  input NewApiInput {
    "An absolute URI with no fragment, such as https://photos-api.home.lan. It can't be changed later."
    identifier: String!
    name: String!
    "At most ${API_DEFAULTS.maxScopes}, none of them the provider's own."
    scopes: [String!]
    "JWT when left out."
    tokenFormat: TokenFormat
    accessTokenSeconds: Int
    allowedClientIds: [ID!]
  }

  "An API's new settings. A field left out keeps its value; accessTokenSeconds null clears it."
  input ApiInput {
    name: String
    scopes: [String!]
    tokenFormat: TokenFormat
    accessTokenSeconds: Int
    allowedClientIds: [ID!]
  }

  input GroupMappingInput {
    upstream: String!
    local: String!
  }

  "An upstream provider's settings. Lists left out are empty."
  input UpstreamInput {
    name: String!
    kind: UpstreamKind!
    "Required for OIDC; ignored for GitHub."
    issuer: String
    clientId: String!
    "Left out, null or blank keeps the saved secret. Leave it out for a public client."
    clientSecret: String
    "Empty asks for openid, profile and email (OIDC) or read:user and user:email (GitHub)."
    scopes: [String!]
    unknownIdentity: UnknownIdentity
    createDomains: [String!]
    createGroups: [String!]
    countsAsBothFactors: Boolean
    groupsClaim: String
    groupMappings: [GroupMappingInput!]
  }

  input ClaimInput {
    name: String!
    value: String!
  }

  "A client to add. A blank clientId gets a random one."
  input NewClientInput {
    clientId: String
    name: String!
    authMethod: ClientAuthMethod!
    "May be empty for a client that only uses client credentials or the device flow."
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
    allowedGroups: [String!]
    groupsClaim: String
    allowClientCredentials: Boolean
    allowDeviceFlow: Boolean
    tokenLifetimes: ClientTokenLifetimesInput
    "Where the provider posts a logout token when one of its users signs out. An empty string removes it."
    backchannelLogoutUri: String
    backchannelLogoutSessionRequired: Boolean
    "The preset it was started from. Left out keeps it; an empty string removes it."
    preset: String
  }

  "How long one client's tokens stay valid, in seconds. A lifetime left out or null is the server's default."
  input ClientTokenLifetimesInput {
    accessTokenSeconds: Int
    idTokenSeconds: Int
    refreshTokenSeconds: Int
  }

  "What the client of an app that pairs gets."
  input PairingInput {
    allowedGroups: [String!]
    groupsClaim: String
  }

  "What the operator sets up for a paired app, from what it offers."
  input FinishPairingInput {
    "Turn its device client's device flow on. False removes the device client."
    deviceFlow: Boolean!
    "Add its API with its clients allowed, or allow them on the API when it is there already."
    api: Boolean!
  }

  "A client's new settings. A field left out keeps its value."
  input ClientInput {
    name: String!
    authMethod: ClientAuthMethod!
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
    allowedGroups: [String!]
    groupsClaim: String
    allowClientCredentials: Boolean
    allowDeviceFlow: Boolean
    tokenLifetimes: ClientTokenLifetimesInput
    "Where the provider posts a logout token when one of its users signs out. An empty string removes it."
    backchannelLogoutUri: String
    backchannelLogoutSessionRequired: Boolean
    "The preset it was started from. Left out keeps it; an empty string removes it."
    preset: String
  }

  "A user to add. Without a password they are invited, and set one through createPasswordLink's link."
  input NewUserInput {
    username: String!
    password: String
    email: String!
    name: String!
    groups: [String!]!
    claims: [ClaimInput!]
  }

  "A user's new details. The password is changed with setUserPassword; claims left out are kept."
  input UserInput {
    username: String!
    email: String!
    name: String!
    groups: [String!]!
    claims: [ClaimInput!]
  }

  type Mutation {
    "Adds a client. A confidential one is given a secret."
    createClient(input: NewClientInput!): Client!
    "Changes a client. Switching to NONE drops its secret; switching away makes one."
    updateClient(clientId: ID!, input: ClientInput!): Client!
    "Replaces a confidential client's secret. The old one stops working at once."
    rotateClientSecret(clientId: ID!): Client!
    "Removes a client. Its users are signed out of it at their next token refresh."
    deleteClient(clientId: ID!): Client!
    "Makes a setup URL an app registers itself with (OAuth 2.0 Dynamic Client Registration): its client, and optionally a device client. It works for a few minutes."
    startPairing(input: PairingInput!): StartedPairing!
    "Stops a setup URL working. False when it had already expired or been used."
    cancelPairing(id: ID!): Boolean!
    "Sets up what a paired app offers besides its sign-in, as the operator chose. Once per pairing."
    finishPairing(id: ID!, input: FinishPairingInput!): Pairing!
    "Adds a user."
    createUser(input: NewUserInput!): User!
    "Changes a user's details."
    updateUser(id: ID!, input: UserInput!): User!
    "Sets a user's password."
    setUserPassword(id: ID!, password: String!): User!
    "Removes a user, and ends their sessions and tokens."
    deleteUser(id: ID!): User!
    "Disables or enables a user. Disabling ends their sessions and tokens."
    setUserDisabled(id: ID!, disabled: Boolean!): User!
    "Ends one of a user's sessions, and the tokens it gave clients."
    endUserSession(id: ID!, sessionId: ID!): User!
    "Ends every session and token of a user."
    signOutUser(id: ID!): User!
    "Removes every second factor a user has, as for a lost phone. They sign in with their password alone until they add one again."
    resetSecondFactors(id: ID!): User!
    "Makes a link that sets a user's password, for an invite or a reset. Their previous link stops working."
    createPasswordLink(id: ID!): PasswordLink!
    "Renames a group in every user and client."
    renameGroup(name: String!, newName: String!): Group!
    "Takes a group off every user. Refused while a client is limited to it. Returns how many users had it."
    deleteGroup(name: String!): Int!
    "Makes new signing and cookie keys. The previous ones keep verifying what they signed."
    rotateKeys: Keys!
    "Names the provider on the sign-in page and in the sidebar."
    setBrandingName(name: String!): Branding!
    "Sets the logo from a base64 data URL (PNG, JPEG, WebP or SVG), or removes it with null."
    setBrandingLogo(dataUrl: String): Branding!
    "Allows or refuses plain http redirect URIs for clients saved from now on. Null follows the issuer again."
    setHttpRedirects(allowed: Boolean): HttpRedirects!
    "Changes what a new password must pass. A rule left out keeps its value."
    setPasswordRules(minScore: Int, checkBreaches: Boolean): PasswordRules!
    "Adds a provider users may sign in through."
    createUpstream(id: ID!, input: UpstreamInput!): Upstream!
    "Changes an upstream provider. Its id stays."
    updateUpstream(id: ID!, input: UpstreamInput!): Upstream!
    "Removes an upstream provider and unlinks every identity linked through it."
    deleteUpstream(id: ID!): Upstream!
    "Unlinks a user's identity at an upstream provider."
    unlinkUserUpstream(id: ID!, providerId: ID!): User!
    "Adds an API apps may ask for access tokens to."
    createApi(input: NewApiInput!): Api!
    "Changes an API. Its identifier stays."
    updateApi(identifier: ID!, input: ApiInput!): Api!
    "Removes an API. Tokens already issued to it work until they expire; no new ones are."
    deleteApi(identifier: ID!): Api!
  }

  "Live updates, over server-sent events. The admin session is checked when the stream opens."
  type Subscription {
    "Each entry recorded from now on that passes the filters, the way auditLog filters."
    auditEntryAdded(type: AuditType, userId: ID): AuditEntry!
    "The pairing now, then again each time it changes. Null once it has expired or been cancelled, and the stream ends."
    pairingChanged(id: ID!): Pairing
  }
`;
