import { EventEmitter } from 'node:events';
import { DatabaseLockErrorCode, holdPostgresLock, type LockSession } from '../../server/db/lock.ts';

const LABEL = 'postgres://db:5432/heautou';
/** Where the fake Postgres says the holder connects from. */
const HOLDER_ADDRESS = '172.18.0.5';
/** Lock waits short enough for a test, still long enough for a few tries. */
const QUICK = { lockWaitMs: 50, lockRetryDelayMs: 5 };
/** A wait that outlasts the test's own steps, for a holder that lets go during it. */
const PATIENT_WAIT_MS = 10_000;

/** One Postgres server's advisory lock, shared by the sessions connected to it. */
interface FakePostgres {
  holder: FakeSession | null;
}

/** A connection to the fake server: node-postgres's `Client` as `holdPostgresLock` uses it. */
class FakeSession extends EventEmitter implements LockSession {
  isOpen = false;
  private readonly server: FakePostgres;

  /**
   * Makes a connection that is not yet open.
   *
   * @param server - The server it connects to.
   */
  constructor(server: FakePostgres) {
    super();
    this.server = server;
  }

  connect = async (): Promise<void> => {
    this.isOpen = true;
  };

  query = async (text: string): Promise<{ rows: Record<string, unknown>[] }> => {
    if (text.includes('pg_try_advisory_lock')) {
      const isFree = this.server.holder === null || this.server.holder === this;
      if (isFree) {
        this.server.holder = this;
      }
      return { rows: [{ isTaken: isFree }] };
    }
    return { rows: this.server.holder === null ? [] : [{ pid: 4242, address: HOLDER_ADDRESS }] };
  };

  end = async (): Promise<void> => {
    this.letGo();
    this.emit('end');
  };

  /** Drops the connection as a Postgres restart would: the lock goes with it. */
  drop(): void {
    this.letGo();
    this.emit('error', new Error('terminating connection due to administrator command'));
    this.emit('end');
  }

  /** Ends the session's hold on the server. */
  private letGo(): void {
    this.isOpen = false;
    if (this.server.holder === this) {
      this.server.holder = null;
    }
  }
}

describe('holdPostgresLock', () => {
  const quiet = (): void => {};
  const neverLost = (): void => {
    throw new Error('The lock was reported lost.');
  };

  it('takes a free lock, and lets it go on release so another process may take it', async () => {
    const server: FakePostgres = { holder: null };
    const first = new FakeSession(server);
    const release = await holdPostgresLock(first, LABEL, neverLost, QUICK, quiet);
    expect(server.holder).toBe(first);

    await release();
    const second = new FakeSession(server);
    await holdPostgresLock(second, LABEL, neverLost, QUICK, quiet);
    expect(server.holder).toBe(second);
  });

  it('refuses a second process with DATABASE_IN_USE, naming where the holder connects from', async () => {
    const server: FakePostgres = { holder: null };
    await holdPostgresLock(new FakeSession(server), LABEL, neverLost, QUICK, quiet);
    const second = new FakeSession(server);
    const refusal = holdPostgresLock(second, LABEL, neverLost, QUICK, quiet);
    await expect(refusal).rejects.toMatchObject({ code: DatabaseLockErrorCode.InUse });
    await expect(refusal).rejects.toThrow(HOLDER_ADDRESS);
    expect(second.isOpen).toBe(false);
  });

  it('waits for a holder that is shutting down', async () => {
    const server: FakePostgres = { holder: null };
    const release = await holdPostgresLock(new FakeSession(server), LABEL, neverLost, QUICK, quiet);
    const waiting: string[] = [];
    const second = new FakeSession(server);
    const patient = { ...QUICK, lockWaitMs: PATIENT_WAIT_MS };
    const taking = holdPostgresLock(second, LABEL, neverLost, patient, (line) => waiting.push(line));
    await vi.waitFor(() => expect(waiting).toHaveLength(1), { interval: 1 });
    await release();
    await taking;
    expect(server.holder).toBe(second);
  });

  it('reports the lock lost once when its connection drops, and not when it is released', async () => {
    const server: FakePostgres = { holder: null };
    const lost = vi.fn();
    const dropped = new FakeSession(server);
    await holdPostgresLock(dropped, LABEL, lost, QUICK, quiet);
    dropped.drop();
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0]?.[0]).toMatchObject({ code: DatabaseLockErrorCode.Lost });

    const released = new FakeSession(server);
    const release = await holdPostgresLock(released, LABEL, neverLost, QUICK, quiet);
    await release();
  });
});
