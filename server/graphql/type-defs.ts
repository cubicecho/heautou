import { AUDIT_DEFAULTS } from '../core/defaults.ts';
import { AUDIT_TYPES, AuditTargetKind } from '../store/audit.ts';

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
    "Whether the operator added it or an app paired itself."
    source: ClientSource!
    "The logo the app gave when it paired. Null for none."
    logoUri: String
    "Its redirect and post-logout URIs the redirect rule refuses now. Saved before the rule applied, they still work; saving the client again needs them changed."
    refusedRedirectUris: [String!]!
    "When it was added, as an ISO 8601 string."
    createdAt: String!
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
    "When they were added, as an ISO 8601 string."
    createdAt: String!
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
    "A pairing. Null once it has expired or been cancelled."
    pairing(id: ID!): Pairing
    """
    The audit log, newest first. first is at most ${AUDIT_DEFAULTS.maxPageSize}; after is the nextCursor of the page
    before. userId keeps entries done by that user or to them.
    """
    auditLog(first: Int, after: String, type: AuditType, userId: ID): AuditPage!
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
    "May be empty for a client that only uses client credentials."
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
    allowedGroups: [String!]
    groupsClaim: String
    allowClientCredentials: Boolean
  }

  "What the client of an app that pairs gets."
  input PairingInput {
    allowedGroups: [String!]
    groupsClaim: String
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
    "Makes a setup URL an app registers itself with (OAuth 2.0 Dynamic Client Registration). It works once, for a few minutes."
    startPairing(input: PairingInput!): StartedPairing!
    "Stops a setup URL working. False when it had already expired or been used."
    cancelPairing(id: ID!): Boolean!
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
  }
`;
