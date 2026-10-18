import { type ProviderAuditDeps, recordAppLogoutFailed } from './audit-events.ts';
import type { ProviderHost } from './host.ts';

/** One application a session ended outside the provider had signed in to. */
export interface AppLogout {
  /** The user whose session ended. */
  accountId: string;
  clientId: string;
  /** The session ID the application was given in its ID token, if any. */
  sid: string | undefined;
}

/**
 * Tells applications that sessions ended, as OpenID Connect Back-Channel Logout does for a sign-out at the provider.
 *
 * @param logouts - The applications, each with the user and the session ID it knows.
 * @param ip - The address of the request that ended them, for the audit log.
 * @returns Once every application has answered or failed. It never rejects.
 */
export type LogoutNotifier = (logouts: readonly AppLogout[], ip: string | null) => Promise<void>;

/** What oidc-provider's `Client` does that its typings leave out. */
interface LogoutCapableClient {
  backchannelLogoutUri?: string;
  backchannelLogout: (sub: string, sid: string | undefined) => Promise<void>;
}

/**
 * Says whether a provider client can be sent a logout token.
 *
 * @param client - The provider's client, or undefined when it is gone.
 * @returns True when it has a back-channel logout URI and the method that posts to it.
 */
function canLogOut(client: object | undefined): client is LogoutCapableClient {
  return (
    client !== undefined &&
    'backchannelLogoutUri' in client &&
    typeof client.backchannelLogoutUri === 'string' &&
    'backchannelLogout' in client &&
    typeof client.backchannelLogout === 'function'
  );
}

/**
 * Builds the notifier the session tools call when an admin, or a user on their account page, ends sessions. The
 * provider tells applications itself only when a user signs out through it, at `/oidc/session/end`.
 *
 * @param host - The provider host; the current provider signs the logout tokens.
 * @param deps - The log and the stores that name users and clients, for a delivery that fails.
 * @returns The notifier.
 */
export function createLogoutNotifier(host: ProviderHost, deps: ProviderAuditDeps): LogoutNotifier {
  return async (logouts, ip) => {
    const provider = host.current();
    await Promise.all(
      logouts.map(async ({ accountId, clientId, sid }) => {
        try {
          const client = await provider.Client.find(clientId);
          if (canLogOut(client)) {
            await client.backchannelLogout(accountId, sid);
          }
        } catch (error) {
          recordAppLogoutFailed(deps, { clientId, accountId, error, ip });
        }
      }),
    );
  };
}
