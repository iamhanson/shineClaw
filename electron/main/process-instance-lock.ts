import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_SCHEMA = 'shan-instance-lock';
const LOCK_VERSION = 2;
const STALE_THRESHOLD_MS = 500;

export interface ProcessInstanceFileLock {
  acquired: boolean;
  lockPath: string;
  ownerPid?: number;
  ownerFormat?: 'legacy' | 'structured' | 'unknown';
  release: () => void;
}

export interface ProcessInstanceFileLockOptions {
  userDataDir: string;
  lockName: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return errno !== 'ESRCH';
  }
}

interface StructuredLockContent {
  schema: string;
  version: number;
  pid: number;
  sessionId: string;
  startedAt: number;
}

function parseLockContent(
  raw: string
): { pid: number; sessionId?: string; startedAt?: number } | null {
  const trimmed = raw.trim();

  // Try structured JSON first (v2)
  try {
    const parsed = JSON.parse(trimmed) as Partial<StructuredLockContent>;
    if (parsed?.schema === LOCK_SCHEMA && typeof parsed?.pid === 'number' && parsed.pid > 0) {
      return { pid: parsed.pid, sessionId: parsed.sessionId, startedAt: parsed.startedAt };
    }
  } catch {
    // not JSON
  }

  // Legacy: bare PID number
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isFinite(pid) && pid > 0) return { pid };
  }

  return null;
}

function isLockStale(lockPath: string, isPidAlive: (pid: number) => boolean): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const content = parseLockContent(raw);

    if (!content) return true;

    // If PID is dead, lock is definitely stale
    if (!isPidAlive(content.pid)) return true;

    // PID is alive — but might be reused. Check startedAt if available.
    if (content.startedAt) {
      const lockFileAge = Date.now() - content.startedAt;
      // If the lock claims to have started in the future or > 7 days ago, stale
      if (lockFileAge < -60_000 || lockFileAge > 7 * 24 * 60 * 60 * 1000) return true;
    }

    // Check lock file mtime — if it hasn't been touched in a while and the
    // process start time doesn't match, it's likely a PID reuse situation.
    // On macOS, we can cross-check with the file's mtime vs process uptime.
    const stat = statSync(lockPath);
    const fileAgeMs = Date.now() - stat.mtimeMs;

    // If file is very fresh (< 500ms), another instance just wrote it — not stale
    if (fileAgeMs < STALE_THRESHOLD_MS) return false;

    // If we have startedAt and the PID is alive, trust it
    if (content.startedAt) return false;

    // Legacy lock with alive PID — can't distinguish PID reuse, assume not stale
    return false;
  } catch {
    // Can't read lock → treat as stale
    return true;
  }
}

export function acquireProcessInstanceFileLock(
  options: ProcessInstanceFileLockOptions
): ProcessInstanceFileLock {
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  mkdirSync(options.userDataDir, { recursive: true });
  const lockPath = join(options.userDataDir, `${options.lockName}.instance.lock`);

  let ownerPid: number | undefined;
  let ownerFormat: ProcessInstanceFileLock['ownerFormat'] = 'unknown';

  // If lock file exists, check staleness first
  if (existsSync(lockPath)) {
    if (isLockStale(lockPath, isPidAlive)) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // best-effort
      }
    } else {
      // Lock is held by a live process
      const raw = readFileSync(lockPath, 'utf8');
      const content = parseLockContent(raw);
      if (content) {
        ownerPid = content.pid;
        ownerFormat = content.sessionId ? 'structured' : 'legacy';
      }
      return { acquired: false, lockPath, ownerPid, ownerFormat, release: () => {} };
    }
  }

  // Try to create the lock file
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      const lockContent: StructuredLockContent = {
        schema: LOCK_SCHEMA,
        version: LOCK_VERSION,
        pid,
        sessionId: randomUUID(),
        startedAt: Date.now(),
      };
      writeFileSync(fd, JSON.stringify(lockContent), 'utf8');
    } finally {
      closeSync(fd);
    }

    let released = false;
    return {
      acquired: true,
      lockPath,
      release: () => {
        if (released) return;
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // best-effort
        }
      },
    };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'EEXIST') {
      // Race: another process created it between our check and open
      const raw = readFileSync(lockPath, 'utf8').trim();
      const content = parseLockContent(raw);
      if (content) {
        ownerPid = content.pid;
        ownerFormat = content.sessionId ? 'structured' : 'legacy';
      }
    }
    return { acquired: false, lockPath, ownerPid, ownerFormat, release: () => {} };
  }
}
