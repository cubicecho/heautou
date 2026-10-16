import type { YogaLogger } from 'graphql-yoga';

const TAG = '[graphql]';

/** Yoga's log lines, tagged. It is how a masked error leaves a trace, so it is never switched off. */
export const graphqlLogger: YogaLogger = {
  debug: () => {},
  info: (...args: unknown[]) => console.info(TAG, ...args),
  warn: (...args: unknown[]) => console.warn(TAG, ...args),
  error: (...args: unknown[]) => console.error(TAG, ...args),
};
