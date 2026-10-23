// Descriptions for the types and fields drizzle-graphql generates from the tables, by table key and column key. `_`
// describes the table's type itself; a relation is described under the name it has in `server/db/relations.ts`.

/** One table's descriptions. */
type TableDocs = Readonly<Record<string, string>>;

/** The key a table's own description is kept under. */
export const TABLE_DESCRIPTION = '_';

export const TABLE_DOCS: Readonly<Record<string, TableDocs>> = {
  users: {
    _: 'Someone who can sign in through the provider.',
    id: 'The stable sub claim clients see.',
    username: 'What they type to sign in, and the preferred_username claim.',
    email: 'The email claim. Empty when they have none.',
    name: 'The name claim. Empty when they have none.',
    groups: 'The groups claim.',
    claims: "Claims of the operator's own, by name, released with the profile scope.",
    disabled: 'A disabled user cannot sign in.',
    createdAt: 'When they were added.',
    pictureVersion: 'Which profile picture they have, by a hash of its bytes. Null for none.',
    upstreamLinks: 'The upstream identities they sign in with, such as a Google or GitHub account.',
  },
  clients: {
    _: 'An application that signs its users in through this provider.',
    clientId: 'What the application is configured with as its client ID.',
    name: 'What the operator calls it.',
    authMethod: 'How it proves who it is at the token endpoint.',
    redirectUris: 'Where the provider may send the user back with a code. Matched exactly.',
    postLogoutRedirectUris: 'Where the provider may send the user after signing out.',
    allowedGroups: 'Only users in one of these groups may sign in to it. Empty lets every user in.',
    groupsClaim: "The claim the user's groups are released in. groups unless the application reads another name.",
    allowClientCredentials: 'Whether it may get tokens for itself with the client credentials grant.',
    allowDeviceFlow:
      'Whether it may sign users in with the device flow (RFC 8628): a device with no browser of its own shows a code, and the user signs in on another device. It also gets refresh tokens.',
    source: 'Whether the operator added it or an app paired itself.',
    logoUri: 'The logo the app gave when it paired. Null for none.',
    accessTokenSeconds: "How long its access tokens stay valid, in seconds. Null is the server's default.",
    idTokenSeconds: "How long its ID tokens stay valid, in seconds. Null is the server's default.",
    refreshTokenSeconds: "How long its refresh tokens stay valid, in seconds. Null is the server's default.",
    backchannelLogoutUri:
      'Where the provider posts a logout token when one of its users signs out (back-channel logout). Null for none.',
    backchannelLogoutSessionRequired:
      'Whether the logout token, and its ID tokens, carry the session ID (sid) the app can match its session by.',
    preset: 'The preset the operator started it from, such as mealie. Null for none.',
    pairingId: 'The pairing that registered it. Null for a client the operator added.',
    clientUri: 'The client_uri it paired with: the app’s address. Null for none.',
    createdAt: 'When it was added.',
    apis: 'The APIs that list it, which it may ask for access tokens to with a resource indicator.',
  },
  apis: {
    _: 'An API (a resource server) apps ask for access tokens to with the resource parameter (RFC 8707).',
    identifier: 'The resource indicator apps send, and the aud of its access tokens.',
    name: 'What the operator calls it.',
    scopes: 'The scopes it understands. Its tokens carry only those of the ones asked for.',
    tokenFormat: 'How its access tokens are written.',
    accessTokenSeconds:
      "How long its access tokens stay valid, in seconds. Null leaves it to the client's own, then the server's.",
    createdAt: 'When it was added.',
    allowedClients: 'The clients that may ask for tokens to it.',
  },
  upstreams: {
    _: 'A provider users may sign in through instead of with a password. Its client secret is never sent back.',
    id: 'Lower-case letters, digits and dashes. Part of its redirect URI, so it never changes.',
    name: 'What the sign-in button says after Sign in with.',
    kind: 'How it signs users in.',
    issuer: 'The OpenID Connect issuer. Null for GitHub.',
    clientId: 'The client ID the provider gave.',
    scopes: 'What it is asked for.',
    unknownIdentity: 'What happens to an identity no user here is linked to.',
    createDomains: 'Email domains a user it creates must have a verified address at. Empty creates one for anybody.',
    createGroups: 'The groups a user it creates starts in.',
    countsAsBothFactors: 'Whether a sign-in through it counts as both factors, so no second factor is asked here.',
    groupsClaim: 'The claim its groups are in, for groupMappings.',
    createdAt: 'When it was added.',
    groupMappings:
      'Upstream groups that put a user in a group here each time they sign in. Mapped groups they lose upstream are taken away.',
    links: 'The identities linked through it.',
  },
  upstreamGroupMappings: {
    _: 'An upstream group that gives a group here.',
    upstreamId: 'The provider.',
    position: 'Where it is in the provider’s list.',
    upstream: "A value of the provider's groups claim.",
    local: 'The group here.',
  },
  upstreamLinks: {
    _: 'An upstream identity a user signs in with.',
    providerId: 'The provider it is at.',
    issuer: 'The issuer that vouched for it.',
    subject: 'Who it is there.',
    userId: 'The user it signs in as.',
    label: 'The address or username it shows as.',
    linkedAt: 'When it was linked.',
    lastUsedAt: 'When it last signed in. Null when it never has.',
    provider: 'The provider it is at.',
    user: 'The user it signs in as.',
  },
  protectedSites: {
    _: 'A site behind the reverse proxy that only signed-in users may reach (forward auth).',
    name: 'What the operator calls it.',
    host: 'The host the proxy asks about, such as sonarr.home.lan.',
    pathPrefix: 'Only paths under this one, such as /admin. Empty for the whole host.',
    allowedGroups: 'Only users in one of these groups may reach it. Empty lets every enabled user in.',
    requireSecondFactor: 'Whether the user must have signed in with a second factor.',
    createdAt: 'When it was added.',
  },
  auditEntries: {
    _: 'One thing that happened: a sign-in, an admin change, an account change.',
    seq: 'The order it was recorded in. Newest first is seq descending.',
    at: 'When.',
    type: 'What happened.',
    actorUserId:
      'Who did it, or for a sign-in the account it was for. Null when nobody is known, such as a sign-in with an unknown username.',
    actorUsername: 'Their username at the time.',
    ip: "The client's address.",
    targetKind: 'What kind of thing it was done to.',
    targetId: 'What it was done to.',
    targetName: 'Its name at the time, so the entry still reads after a rename or delete.',
    detail: 'Facts it keeps, by name, such as the username a failed sign-in tried.',
  },
};
