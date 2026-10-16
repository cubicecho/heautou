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
    "When it was added, as an ISO 8601 string."
    createdAt: String!
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
    "When they were added, as an ISO 8601 string."
    createdAt: String!
  }

  "What an application needs to be pointed at this provider."
  type ProviderInfo {
    "The issuer URL."
    issuer: String!
    "The OpenID discovery document."
    discoveryUrl: String!
    "The scopes clients may ask for."
    scopes: [String!]!
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
  }

  "A client to add. A blank clientId gets a random one."
  input NewClientInput {
    clientId: String
    name: String!
    authMethod: ClientAuthMethod!
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
  }

  "A client's new settings."
  input ClientInput {
    name: String!
    authMethod: ClientAuthMethod!
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
  }

  "A user to add."
  input NewUserInput {
    username: String!
    password: String!
    email: String!
    name: String!
    groups: [String!]!
  }

  "A user's new details. The password is changed with setUserPassword."
  input UserInput {
    username: String!
    email: String!
    name: String!
    groups: [String!]!
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
    "Adds a user."
    createUser(input: NewUserInput!): User!
    "Changes a user's details."
    updateUser(id: ID!, input: UserInput!): User!
    "Sets a user's password."
    setUserPassword(id: ID!, password: String!): User!
    "Removes a user."
    deleteUser(id: ID!): User!
  }
`;
