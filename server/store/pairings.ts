import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PAIRING_DEFAULTS } from '../core/defaults.ts';
import { parseInput } from '../core/validation.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { DataDocument } from '../db/document.ts';
import { DEFAULT_GROUPS_CLAIM, groupsClaimSchema } from './claims.ts';

/**
 * One setup URL handed out: what the app that registers with it gets, whether one has, and what the operator chose
 * to set up for it afterwards.
 */
interface PairingRecord {
  /** The SHA-256 of the initial access token in the setup URL. */
  tokenHash: string;
  /** The allowed groups the paired client gets. */
  allowedGroups: string[];
  /** The groups claim the paired client gets. */
  groupsClaim: string;
  /** In epoch milliseconds. Past it the record is dropped, paired or not. */
  expiresAt: number;
  /** The client the app registered as, or null while it has not. */
  clientId: string | null;
  /** The `client_uri` the app registered with, where its protected resource metadata is looked for. Null for none. */
  clientUri?: string | null;
  /** The public client the app registered second, for its devices to use the device flow with. Null for none. */
  deviceClientId?: string | null;
  /** Whether the operator has chosen what else to set up for the app. */
  isFinished?: boolean;
}

/** Pairings by id. */
export type PairingDocument = Record<string, PairingRecord>;

/** A pairing, with its id. */
export interface Pairing extends Omit<PairingRecord, 'tokenHash' | 'clientUri' | 'deviceClientId' | 'isFinished'> {
  id: string;
  clientUri: string | null;
  deviceClientId: string | null;
  isFinished: boolean;
}

/** What the operator chooses before handing out a setup URL. */
const pairingInputSchema = z.object({
  allowedGroups: z
    .array(z.string().trim().min(1))
    .transform((groups) => [...new Set(groups)])
    .default([]),
  groupsClaim: groupsClaimSchema.default(DEFAULT_GROUPS_CLAIM),
});
export type PairingInput = z.input<typeof pairingInputSchema>;

/** Setup URLs waiting for an app to register with them, and the ones it has. */
export interface PairingStore {
  /**
   * Records a setup URL just handed out.
   *
   * @param token - The initial access token in the URL. Only its hash is kept.
   * @param input - What the paired client gets.
   * @returns The pairing.
   * @throws BAD_USER_INPUT when the groups or the claim name are not allowed.
   */
  start: (token: string, input: PairingInput) => Promise<Pairing>;
  /**
   * Looks a pairing up.
   *
   * @param id - The pairing's id.
   * @returns It, or null once it has expired or been cancelled.
   */
  find: (id: string) => Pairing | null;
  /**
   * Finds the pairing an app is registering its client with.
   *
   * @param token - The initial access token the app sent.
   * @returns The pairing, or null when it is unknown, expired, cancelled or already used.
   */
  waitingFor: (token: string) => Pairing | null;
  /**
   * Finds the pairing an app is registering its device client with: one the app has registered its client with,
   * and no device client yet, that the operator has not finished.
   *
   * @param token - The initial access token the app sent.
   * @returns The pairing, or null.
   */
  waitingForDevice: (token: string) => Pairing | null;
  /**
   * Marks a pairing paired, and gives the operator `PAIRING_DEFAULTS.reviewSeconds` from now to finish it.
   *
   * @param id - The pairing's id.
   * @param clientId - The client the app registered as.
   * @param clientUri - The `client_uri` it registered with, or null.
   */
  complete: (id: string, clientId: string, clientUri: string | null) => Promise<void>;
  /**
   * Records the device client an app registered second.
   *
   * @param id - The pairing's id.
   * @param clientId - The device client.
   */
  addDeviceClient: (id: string, clientId: string) => Promise<void>;
  /**
   * Marks a pairing finished: the operator has chosen what else to set up.
   *
   * @param id - The pairing's id.
   */
  finish: (id: string) => Promise<void>;
  /**
   * Cancels a pairing, so its setup URL stops working.
   *
   * @param id - The pairing's id.
   * @returns True when there was one to cancel.
   */
  cancel: (id: string) => Promise<boolean>;
}

/**
 * Hashes an initial access token for storage.
 *
 * @param token - The token.
 * @returns Its SHA-256, base64url.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Drops the token hash from a record, and fills in what a file written by an older version lacks.
 *
 * @param id - The pairing's id.
 * @param record - The stored record.
 * @returns The pairing.
 */
function toPairing(id: string, record: PairingRecord): Pairing {
  const { tokenHash: _tokenHash, clientUri, deviceClientId, isFinished, ...rest } = record;
  return {
    id,
    ...rest,
    clientUri: clientUri ?? null,
    deviceClientId: deviceClientId ?? null,
    isFinished: isFinished ?? false,
  };
}

/**
 * Opens the pairing store on its file.
 *
 * @param file - The file holding the pairings.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Expired pairings are dropped whenever it writes.
 */
export function createPairingStore(file: DataDocument<PairingDocument>, now: () => number = Date.now): PairingStore {
  const live = (): [string, PairingRecord][] =>
    Object.entries(file.read()).filter(([, record]) => record.expiresAt > now());

  const write = async (change: (entries: [string, PairingRecord][]) => [string, PairingRecord][]): Promise<void> => {
    await file.update(() => Object.fromEntries(change(live())));
  };

  const change = async (id: string, edit: (record: PairingRecord) => PairingRecord): Promise<void> => {
    await write((entries) => entries.map(([key, record]) => [key, key === id ? edit(record) : record]));
  };

  const findBy = (token: string, matches: (record: PairingRecord) => boolean): Pairing | null => {
    const tokenHash = digest(token);
    const found = live().find(([, record]) => record.tokenHash === tokenHash && matches(record));
    return found === undefined ? null : toPairing(...found);
  };

  return {
    start: async (token, input) => {
      const fields = parseInput(pairingInputSchema, input);
      const id = randomUUID();
      const record: PairingRecord = {
        ...fields,
        tokenHash: digest(token),
        expiresAt: now() + PAIRING_DEFAULTS.linkSeconds * MS_PER_SECOND,
        clientId: null,
        clientUri: null,
        deviceClientId: null,
        isFinished: false,
      };
      await write((entries) => [...entries, [id, record]]);
      return toPairing(id, record);
    },
    find: (id) => {
      const found = live().find(([key]) => key === id);
      return found === undefined ? null : toPairing(...found);
    },
    waitingFor: (token) => findBy(token, (record) => record.clientId === null),
    waitingForDevice: (token) =>
      findBy(
        token,
        (record) => record.clientId !== null && (record.deviceClientId ?? null) === null && record.isFinished !== true,
      ),
    complete: async (id, clientId, clientUri) => {
      const reviewUntil = now() + PAIRING_DEFAULTS.reviewSeconds * MS_PER_SECOND;
      await change(id, (record) => ({
        ...record,
        clientId,
        clientUri,
        expiresAt: Math.max(record.expiresAt, reviewUntil),
      }));
    },
    addDeviceClient: async (id, clientId) => {
      await change(id, (record) => ({ ...record, deviceClientId: clientId }));
    },
    finish: async (id) => {
      await change(id, (record) => ({ ...record, isFinished: true }));
    },
    cancel: async (id) => {
      const isWaiting = live().some(([key]) => key === id);
      if (isWaiting) {
        await write((entries) => entries.filter(([key]) => key !== id));
      }
      return isWaiting;
    },
  };
}
