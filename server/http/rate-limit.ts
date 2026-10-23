import type { RequestHandler, Response } from 'express';
import { RATE_LIMIT_DEFAULTS } from '../core/defaults.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';

/** One key's count in its current window. */
interface Window {
  count: number;
  /** When the window ends, in epoch milliseconds. */
  endsAt: number;
}

/** Counts events per key in fixed windows. */
export interface RateLimiter {
  /** Whether a key has used up its window. */
  isBlocked: (key: string) => boolean;
  /** Counts one event for a key. */
  add: (key: string) => void;
  /** Forgets a key, as after a sign-in that worked. */
  reset: (key: string) => void;
  /** Seconds until a key's window ends, for `Retry-After`. */
  retryAfter: (key: string) => number;
}

/** How one limiter counts. */
export interface RateLimiterSettings {
  /** Events allowed per key in one window. */
  limit: number;
  windowSeconds: number;
  /** Keys kept at most; the oldest are forgotten first, so a flood of addresses cannot grow memory. */
  maxKeys?: number;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

/**
 * Makes an in-memory, fixed-window rate limiter. Counts are lost on restart, which is fine for slowing guesses.
 *
 * @param settings - The limit, the window and the clock.
 * @returns The limiter.
 */
export function createRateLimiter(settings: RateLimiterSettings): RateLimiter {
  const { limit, windowSeconds, maxKeys = RATE_LIMIT_DEFAULTS.maxKeys, now = Date.now } = settings;
  const windows = new Map<string, Window>();

  const current = (key: string): Window | null => {
    const window = windows.get(key);
    if (window === undefined) {
      return null;
    }
    if (window.endsAt <= now()) {
      windows.delete(key);
      return null;
    }
    return window;
  };

  const evict = (): void => {
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) {
        return;
      }
      windows.delete(key);
    }
  };

  return {
    isBlocked: (key) => (current(key)?.count ?? 0) >= limit,
    add: (key) => {
      const window = current(key);
      if (window === null) {
        evict();
        windows.set(key, { count: 1, endsAt: now() + windowSeconds * MS_PER_SECOND });
        return;
      }
      window.count += 1;
    },
    reset: (key) => {
      windows.delete(key);
    },
    retryAfter: (key) => {
      const window = current(key);
      return window === null ? 0 : Math.ceil((window.endsAt - now()) / MS_PER_SECOND);
    },
  };
}

/**
 * Refuses a request with 429 and says when to try again.
 *
 * @param res - The response.
 * @param seconds - The wait.
 */
export function sendTooMany(res: Response, seconds: number): void {
  res.set('Retry-After', String(seconds));
  res.status(HttpStatus.TooManyRequests).json({ error: `Too many attempts. Try again in ${seconds} seconds.` });
}

/**
 * Limits how many requests one address makes, for the routes that start sign-ins or write data.
 *
 * @param [limiter] - The limiter. One allowing `RATE_LIMIT_DEFAULTS.requestsPerIp` a window by default.
 * @returns The middleware.
 */
export function limitRequests(
  limiter: RateLimiter = createRateLimiter({
    limit: RATE_LIMIT_DEFAULTS.requestsPerIp,
    windowSeconds: RATE_LIMIT_DEFAULTS.requestWindowSeconds,
  }),
): RequestHandler {
  return (req, res, next) => {
    const key = req.ip ?? '';
    if (limiter.isBlocked(key)) {
      sendTooMany(res, limiter.retryAfter(key));
      return;
    }
    limiter.add(key);
    next();
  };
}

/** Slows password guessing: failures are counted per address and per username. */
export interface LoginThrottle {
  /**
   * Says whether an attempt may go ahead.
   *
   * @param ip - The caller's address.
   * @param username - The username tried.
   * @returns Seconds to wait, or 0 to go ahead.
   */
  wait: (ip: string, username: string) => number;
  /** Counts a failed attempt. */
  fail: (ip: string, username: string) => void;
  /** Clears a username after it signed in. The address keeps its count, so one good login does not reset guessing. */
  succeed: (username: string) => void;
}

/**
 * Makes a login throttle with the `RATE_LIMIT_DEFAULTS` limits.
 *
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The throttle.
 */
export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const windowSeconds = RATE_LIMIT_DEFAULTS.failureWindowSeconds;
  const byIp = createRateLimiter({ limit: RATE_LIMIT_DEFAULTS.failuresPerIp, windowSeconds, now });
  const byUsername = createRateLimiter({ limit: RATE_LIMIT_DEFAULTS.failuresPerUsername, windowSeconds, now });
  const userKey = (username: string): string => username.toLowerCase();
  return {
    wait: (ip, username) => {
      const ipWait = byIp.isBlocked(ip) ? byIp.retryAfter(ip) : 0;
      const userWait = byUsername.isBlocked(userKey(username)) ? byUsername.retryAfter(userKey(username)) : 0;
      return Math.max(ipWait, userWait);
    },
    fail: (ip, username) => {
      byIp.add(ip);
      byUsername.add(userKey(username));
    },
    succeed: (username) => byUsername.reset(userKey(username)),
  };
}
