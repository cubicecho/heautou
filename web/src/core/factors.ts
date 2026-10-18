import { type PublicKeyCredentialCreationOptionsJSON, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { jsonReply, postJson } from '@/core/json-reply';

const KEY = ['account', 'factors'] as const;

const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
const summarySchema = z.object({
  hasTotp: z.boolean(),
  recoveryCodesLeft: z.number(),
  passkeys: z.array(passkeySchema),
});
const factorsSchema = summarySchema.extend({ passkeysAvailable: z.boolean() });
const totpSetupSchema = z.object({ secret: z.string(), uri: z.string() });
const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });
/** A reply that hands back recovery codes only when it made the first ones. */
const maybeCodesSchema = z.object({ recoveryCodes: z.array(z.string()).nullable() });
// The options are WebAuthn's own JSON, which the browser library checks as it reads them.
const passkeyOptionsSchema = z.object({
  options: z.custom<PublicKeyCredentialCreationOptionsJSON>(
    (value) => typeof value === 'object' && value !== null && 'challenge' in value,
  ),
});

/** A passkey the user registered. */
export type PasskeyInfo = z.infer<typeof passkeySchema>;

/**
 * Reads the signed-in user's second factors, and whether passkeys work on this site.
 *
 * @returns The query.
 */
export function useFactors() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => jsonReply(await fetch('/admin/account/factors'), factorsSchema),
    retry: false,
  });
}

/**
 * Builds a mutation's `onSuccess` that reads the factors again.
 *
 * @returns The handler.
 */
function useRefetchFactors() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: KEY });
}

/**
 * Makes a new authenticator app secret to scan. Nothing changes until it is confirmed.
 *
 * @returns The mutation; it resolves to the secret and the `otpauth://` URI for the QR code.
 */
export function useStartTotp() {
  return useMutation({
    mutationFn: async () => jsonReply(await postJson('/admin/account/totp/start', {}), totpSetupSchema),
  });
}

/**
 * Turns the authenticator app on with a code from it.
 *
 * @returns The mutation; it resolves to the first recovery codes, or null when the user had some already.
 */
export function useConfirmTotp() {
  const onSuccess = useRefetchFactors();
  return useMutation({
    mutationFn: async (code: string) =>
      (await jsonReply(await postJson('/admin/account/totp/confirm', { code }), maybeCodesSchema)).recoveryCodes,
    onSuccess,
  });
}

/**
 * Turns the authenticator app off.
 *
 * @returns The mutation, given the user's password.
 */
export function useRemoveTotp() {
  const onSuccess = useRefetchFactors();
  return useMutation({
    mutationFn: async (password: string) =>
      jsonReply(await postJson('/admin/account/totp/remove', { password }), summarySchema),
    onSuccess,
  });
}

/**
 * Makes new recovery codes, ending the old ones.
 *
 * @returns The mutation, given the user's password; it resolves to the codes.
 */
export function useNewRecoveryCodes() {
  const onSuccess = useRefetchFactors();
  return useMutation({
    mutationFn: async (password: string) =>
      (await jsonReply(await postJson('/admin/account/recovery-codes', { password }), recoveryCodesSchema))
        .recoveryCodes,
    onSuccess,
  });
}

/**
 * Registers a passkey: asks the server for options, lets the browser make the passkey, and sends it back.
 *
 * @returns The mutation, given a name; it resolves to the first recovery codes, or null when the user had some.
 */
export function useAddPasskey() {
  const onSuccess = useRefetchFactors();
  return useMutation({
    mutationFn: async (name: string) => {
      const { options } = await jsonReply(await postJson('/admin/account/passkeys/options', {}), passkeyOptionsSchema);
      const response = await startRegistration({ optionsJSON: options });
      return (await jsonReply(await postJson('/admin/account/passkeys', { name, response }), maybeCodesSchema))
        .recoveryCodes;
    },
    onSuccess,
  });
}

/**
 * Removes a passkey.
 *
 * @returns The mutation, given the passkey and the user's password.
 */
export function useRemovePasskey() {
  const onSuccess = useRefetchFactors();
  return useMutation({
    mutationFn: async (body: { id: string; password: string }) =>
      jsonReply(await postJson('/admin/account/passkeys/remove', body), summarySchema),
    onSuccess,
  });
}
