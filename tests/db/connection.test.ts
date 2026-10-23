import { DATABASE_DEFAULTS } from '../../server/core/defaults.ts';
import { requiresSsl } from '../../server/db/ssl.ts';
import { waitForDatabase } from '../../server/db/wait.ts';

/**
 * Makes an error as a driver throws one.
 *
 * @param code - Its code.
 * @returns The error.
 */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('requiresSsl', () => {
  it('leaves hosts on the machine or the local network alone', () => {
    const local = [
      'postgres://u:p@localhost/db',
      'postgres://u:p@postgres/db',
      'postgres://u:p@127.0.0.1/db',
      'postgres://u:p@10.0.0.5/db',
      'postgres://u:p@172.20.0.2:5432/db',
      'postgres://u:p@192.168.1.10/db',
      'postgres://u:p@[::1]/db',
      'postgres://u:p@[fd12::1]/db',
      'postgres://u:p@db.home.lan/db',
      'postgres://u:p@nas.local/db',
    ];
    expect(local.filter(requiresSsl)).toEqual([]);
  });

  it('requires TLS to a host across the internet', () => {
    expect(requiresSsl('postgres://u:p@db.example.com/db')).toBe(true);
    expect(requiresSsl('postgresql://u:p@8.8.8.8/db')).toBe(true);
  });

  it('respects an sslmode the URL sets itself', () => {
    expect(requiresSsl('postgres://u:p@db.example.com/db?sslmode=disable')).toBe(false);
  });
});

describe('waitForDatabase', () => {
  const quick = { firstRetryDelayMs: 1, maxRetryDelayMs: 1 };

  it('retries while Postgres is starting, then goes on', async () => {
    let attempts = 0;
    const db = {
      execute: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw failure('ECONNREFUSED');
        }
      },
    };
    await waitForDatabase(db, quick, () => {});
    expect(attempts).toBe(3);
  });

  it('gives up at once on a wrong password', async () => {
    let attempts = 0;
    const db = {
      execute: async () => {
        attempts += 1;
        throw failure('28P01');
      },
    };
    await expect(waitForDatabase(db, quick, () => {})).rejects.toThrow('28P01');
    expect(attempts).toBe(1);
  });

  it('gives up once its time is up', async () => {
    const db = {
      execute: async () => {
        throw failure('ECONNREFUSED');
      },
    };
    const settings = { ...quick, connectTimeoutMs: DATABASE_DEFAULTS.firstRetryDelayMs };
    await expect(waitForDatabase(db, settings, () => {})).rejects.toThrow('ECONNREFUSED');
  });
});
