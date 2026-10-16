import { RATE_LIMIT_DEFAULTS } from '../../server/core/defaults.ts';
import { createLoginThrottle, createRateLimiter } from '../../server/http/rate-limit.ts';

describe('rate limiter', () => {
  it('blocks a key for the rest of its window', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowSeconds: 10, now: () => now });
    limiter.add('a');
    limiter.add('a');
    expect(limiter.isBlocked('a')).toBe(true);
    expect(limiter.isBlocked('b')).toBe(false);
    expect(limiter.retryAfter('a')).toBe(10);
    now = 10_000;
    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('forgets the oldest keys past its size', () => {
    const limiter = createRateLimiter({ limit: 1, windowSeconds: 10, maxKeys: 2 });
    limiter.add('a');
    limiter.add('b');
    limiter.add('c');
    expect(limiter.isBlocked('a')).toBe(false);
    expect(limiter.isBlocked('c')).toBe(true);
  });
});

describe('login throttle', () => {
  it('slows guessing one username from many addresses', () => {
    const throttle = createLoginThrottle();
    for (let attempt = 0; attempt < RATE_LIMIT_DEFAULTS.failuresPerUsername; attempt += 1) {
      throttle.fail(`10.0.0.${attempt}`, 'Ada');
    }
    expect(throttle.wait('10.0.0.99', 'ada')).toBeGreaterThan(0);
    throttle.succeed('ada');
    expect(throttle.wait('10.0.0.99', 'ada')).toBe(0);
  });

  it('slows one address guessing many usernames', () => {
    const throttle = createLoginThrottle();
    for (let attempt = 0; attempt < RATE_LIMIT_DEFAULTS.failuresPerIp; attempt += 1) {
      throttle.fail('10.0.0.1', `user${attempt}`);
    }
    expect(throttle.wait('10.0.0.1', 'someone')).toBeGreaterThan(0);
    expect(throttle.wait('10.0.0.2', 'someone')).toBe(0);
  });
});
