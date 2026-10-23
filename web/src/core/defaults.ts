/** How the pair dialog waits for a paired app to describe the API it offers. */
export interface PairDialogSettings {
  /** How long it waits between two asks, in seconds. */
  offerPollSeconds: number;
  /** How many times it asks before it stops. */
  offerPolls: number;
}

export const PAIR_DIALOG_DEFAULTS: Readonly<PairDialogSettings> = Object.freeze({
  offerPollSeconds: 3,
  offerPolls: 10,
});

/** How a GraphQL subscription keeps its stream open. */
export interface SubscriptionSettings {
  /** How long a dropped stream waits before it opens again, in seconds. */
  resubscribeSeconds: number;
}

export const SUBSCRIPTION_DEFAULTS: Readonly<SubscriptionSettings> = Object.freeze({
  resubscribeSeconds: 3,
});

/** The QR code an authenticator app scans. */
export interface QrCodeSettings {
  /** Its width and height, in CSS pixels. */
  sizePixels: number;
}

export const QR_CODE_DEFAULTS: Readonly<QrCodeSettings> = Object.freeze({
  sizePixels: 192,
});

/** The Activity page's list of audit entries. */
export interface ActivitySettings {
  /** How many entries one page shows. */
  pageSize: number;
}

export const ACTIVITY_DEFAULTS: Readonly<ActivitySettings> = Object.freeze({
  pageSize: 50,
});
