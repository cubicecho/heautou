import type Provider from 'oidc-provider';
import type { KoaContextWithOIDC } from 'oidc-provider';
import { ADMIN_CLIENT_NAME } from '../admin/admin-client.ts';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import {
  AppSignInVia,
  type AuditEvent,
  type AuditLog,
  type AuditTarget,
  AuditTargetKind,
  AuditType,
  actorOf,
} from '../store/audit.ts';
import type { ClientStore } from '../store/clients.ts';
import type { UserStore } from '../store/users.ts';
import { AuthMethod } from './provider.ts';

/** What the provider's audit listeners read and write. */
export interface ProviderAuditDeps {
  audit: AuditLog;
  users: UserStore;
  clients: ClientStore;
}

/**
 * The errors an application asks for when it checks for a session with `prompt=none`. They are the answer it
 * expected, not a failure, so they are not logged.
 */
const SILENT_CHECK_ERRORS = new Set(['login_required', 'consent_required', 'interaction_required']);

/** The grant whose tokens are for the client itself, with no user. */
const CLIENT_CREDENTIALS_GRANT = 'client_credentials';

/** The part of a provider error the log keeps. */
interface ProviderError {
  error?: string;
  error_description?: string;
}

/**
 * Reads a request parameter that is a string.
 *
 * @param ctx - The provider's context.
 * @param name - The parameter.
 * @returns Its value, or undefined when it is missing or not a string.
 */
function paramOf(ctx: KoaContextWithOIDC, name: string): string | undefined {
  const value = ctx.oidc.params?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the API a request asked for a token to (RFC 8707), after any default the provider filled in.
 *
 * @param ctx - The provider's context.
 * @returns The resource indicator, several joined with spaces, or undefined when none was asked for.
 */
function resourceOf(ctx: KoaContextWithOIDC): string | undefined {
  const value: unknown = ctx.oidc.params?.resource;
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value.join(' ');
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Keeps the strings of a detail that are set.
 *
 * @param detail - The detail, some of it unset.
 * @returns The detail without the unset values.
 */
function definedDetail(detail: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * Says how an app sign-in was made.
 *
 * @param login - The sign-in the interaction finished with, or undefined when the session was reused.
 * @returns The `via` detail.
 */
function viaOf(login: { amr?: string[] } | undefined): AppSignInVia {
  if (login === undefined) {
    return AppSignInVia.Session;
  }
  if (login.amr?.includes(AuthMethod.Federated)) {
    return AppSignInVia.Upstream;
  }
  return login.amr?.includes(AuthMethod.Password) === false ? AppSignInVia.Passkey : AppSignInVia.Password;
}

/**
 * Names a client the way the admin knows it.
 *
 * @param clients - The client store.
 * @param clientId - The client.
 * @param [fallback] - The name the request gave, for a client the store doesn't have.
 * @returns The target.
 */
function clientTargetIn(clients: ClientStore, clientId: string, fallback?: string): AuditTarget {
  return {
    kind: AuditTargetKind.Client,
    id: clientId,
    name:
      clientId === ADMIN_DEFAULTS.clientId ? ADMIN_CLIENT_NAME : (clients.find(clientId)?.name ?? fallback ?? clientId),
  };
}

/** A logout token an application did not take. */
export interface AppLogoutFailure {
  clientId: string;
  /** The user who signed out. */
  accountId: string;
  /** Why: the app was unreachable, too slow, or answered with an error. */
  error: unknown;
  /** The address of the request that ended the session, or null when the server ended it itself. */
  ip: string | null;
}

/**
 * Logs and records a back-channel logout an application did not take. The logout token is never part of it.
 *
 * @param deps - The log and the stores that name users and clients.
 * @param failure - The client, the user and the error.
 */
export function recordAppLogoutFailed({ audit, users, clients }: ProviderAuditDeps, failure: AppLogoutFailure): void {
  const { clientId, accountId, error, ip } = failure;
  const reason = errorMessage(error);
  console.error(`[oidc] back-channel logout to client "${clientId}" failed: ${reason}`);
  const user = users.find(accountId);
  audit.record({
    type: AuditType.AppLogoutFailed,
    actor: user === null ? null : actorOf(user),
    ip,
    target: clientTargetIn(clients, clientId),
    detail: { error: reason },
  });
}

/**
 * Records what the provider does that the operator wants to see: each code handed back to an app, sign-in
 * requests and token requests it refused, sign-outs from apps, logout tokens apps did not take, and machine tokens.
 *
 * @param provider - The provider, freshly built.
 * @param deps - The log and the stores that name users and clients.
 *
 * @remarks
 * The admin UI's own sign-ins and sign-outs are left out: its routes record them as `WebSignedIn` and
 * `WebSignedOut`. Its refused requests are kept, since they are as worth knowing about as any app's.
 */
export function recordProviderEvents(provider: Provider, { audit, users, clients }: ProviderAuditDeps): void {
  /**
   * Names a client the way the admin knows it.
   *
   * @param clientId - The client.
   * @param [fallback] - The name the request gave, for a client the store doesn't have.
   * @returns The target.
   */
  const clientTarget = (clientId: string, fallback?: string): AuditTarget =>
    clientTargetIn(clients, clientId, fallback);
  /**
   * Names the request's client: the one the provider found, else the `client_id` it was sent.
   *
   * @param ctx - The provider's context.
   * @returns The target, or undefined when no client was named.
   */
  const targetOf = (ctx: KoaContextWithOIDC): AuditTarget | undefined => {
    const { client } = ctx.oidc;
    if (client !== undefined) {
      return clientTarget(client.clientId, client.clientName);
    }
    const clientId = paramOf(ctx, 'client_id');
    return clientId === undefined ? undefined : clientTarget(clientId);
  };
  /**
   * Names the user the provider session is for.
   *
   * @param ctx - The provider's context.
   * @returns The actor, or null when there is no session or its user is gone.
   */
  const actorIn = (ctx: KoaContextWithOIDC): AuditEvent['actor'] => {
    const accountId = ctx.oidc.session?.accountId;
    const user = accountId === undefined ? null : users.find(accountId);
    return user === null ? null : actorOf(user);
  };
  const isAdminClient = (ctx: KoaContextWithOIDC): boolean => ctx.oidc.client?.clientId === ADMIN_DEFAULTS.clientId;

  provider.on('authorization.success', (ctx) => {
    if (ctx.oidc.client === undefined || isAdminClient(ctx)) {
      return;
    }
    audit.record({
      type: AuditType.AppSignedIn,
      actor: actorIn(ctx),
      ip: ctx.ip,
      target: targetOf(ctx),
      detail: definedDetail({
        via: viaOf(ctx.oidc.result?.login),
        redirectUri: paramOf(ctx, 'redirect_uri'),
        resource: resourceOf(ctx),
      }),
    });
  });

  provider.on('authorization.error', (ctx, error: ProviderError) => {
    if (error.error !== undefined && SILENT_CHECK_ERRORS.has(error.error) && paramOf(ctx, 'prompt') === 'none') {
      return;
    }
    audit.record({
      type: AuditType.AppSignInFailed,
      actor: actorIn(ctx),
      ip: ctx.ip,
      target: targetOf(ctx),
      detail: definedDetail({
        error: error.error,
        description: error.error_description,
        redirectUri: paramOf(ctx, 'redirect_uri'),
        resource: resourceOf(ctx),
      }),
    });
  });

  provider.on('grant.error', (ctx, error: ProviderError) => {
    audit.record({
      type: AuditType.AppTokenRefused,
      actor: null,
      ip: ctx.ip,
      target: targetOf(ctx),
      detail: definedDetail({
        error: error.error,
        description: error.error_description,
        grantType: paramOf(ctx, 'grant_type'),
        resource: resourceOf(ctx),
      }),
    });
  });

  provider.on('grant.success', (ctx) => {
    if (paramOf(ctx, 'grant_type') !== CLIENT_CREDENTIALS_GRANT) {
      return;
    }
    audit.record({
      type: AuditType.MachineTokenIssued,
      actor: null,
      ip: ctx.ip,
      target: targetOf(ctx),
      detail: definedDetail({ scope: paramOf(ctx, 'scope'), resource: resourceOf(ctx) }),
    });
  });

  provider.on('end_session.success', (ctx) => {
    if (isAdminClient(ctx)) {
      return;
    }
    audit.record({ type: AuditType.AppSignedOut, actor: actorIn(ctx), ip: ctx.ip, target: targetOf(ctx) });
  });

  // A sign-out at the provider tells each app the session was signed in to; one that misses it is worth knowing.
  provider.on('backchannel.error', (ctx, error, client, accountId) => {
    recordAppLogoutFailed({ audit, users, clients }, { clientId: client.clientId, accountId, error, ip: ctx.ip });
  });
}
