import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BASE_DIR } from './accounts.js';
import { gmailFor, callGmail } from './gmail.js';

const SCHEDULE_PATH = path.join(BASE_DIR, 'scheduled-sends.json');
const WORKER_LOCK_PATH = path.join(BASE_DIR, 'scheduled-sends.lock');
const STALE_LOCK_MS = 5 * 60 * 1000;

export type ScheduledSendStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledSend {
  id: string;
  account: string;
  email: string;
  draftId: string;
  sendAt: string;
  createdAt: string;
  status: ScheduledSendStatus;
  updatedAt: string;
  sentMessageId?: string;
  sentThreadId?: string;
  error?: string;
}

function loadJobs(): ScheduledSend[] {
  if (!fs.existsSync(SCHEDULE_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${SCHEDULE_PATH} is not a JSON array.`);
  return parsed as ScheduledSend[];
}

function saveJobs(jobs: ScheduledSend[]): void {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SCHEDULE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs.slice(-500), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, SCHEDULE_PATH);
}

function parseSendAt(sendAt: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(sendAt)) {
    throw new Error('sendAt must include an explicit timezone, for example 2026-07-24T17:30:00-04:00.');
  }
  const timestamp = Date.parse(sendAt);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid sendAt timestamp: ${sendAt}`);
  if (timestamp <= Date.now()) throw new Error('sendAt must be in the future.');
  return new Date(timestamp).toISOString();
}

export async function scheduleDraftSend(
  accountParam: string,
  draftId: string,
  sendAt: string
): Promise<ScheduledSend> {
  const ctx = gmailFor(accountParam);
  await callGmail(ctx, 'verify draft before scheduling', () =>
    ctx.gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'metadata' })
  );
  const jobs = loadJobs();
  const duplicate = jobs.find((job) => job.draftId === draftId && job.status === 'scheduled');
  if (duplicate) {
    throw new Error(`Draft ${draftId} is already scheduled as ${duplicate.id} for ${duplicate.sendAt}.`);
  }
  const now = new Date().toISOString();
  const job: ScheduledSend = {
    id: `send_${crypto.randomUUID()}`,
    account: ctx.alias,
    email: ctx.email,
    draftId,
    sendAt: parseSendAt(sendAt),
    createdAt: now,
    updatedAt: now,
    status: 'scheduled',
  };
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

export function listScheduledSends(accountParam?: string, includeCompleted = false): ScheduledSend[] {
  const wanted = accountParam?.trim().toLowerCase();
  return loadJobs()
    .filter((job) => !wanted || job.account.toLowerCase() === wanted || job.email.toLowerCase() === wanted)
    .filter((job) => includeCompleted || job.status === 'scheduled' || job.status === 'sending')
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

export function cancelScheduledSend(scheduleId: string): ScheduledSend {
  const jobs = loadJobs();
  const job = jobs.find((candidate) => candidate.id === scheduleId);
  if (!job) throw new Error(`Unknown scheduled send "${scheduleId}".`);
  if (job.status !== 'scheduled') {
    throw new Error(`Scheduled send ${scheduleId} is ${job.status} and cannot be cancelled.`);
  }
  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  saveJobs(jobs);
  return job;
}

let processing = false;

function acquireWorkerLock(): number | null {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  try {
    return fs.openSync(WORKER_LOCK_PATH, 'wx', 0o600);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const age = Date.now() - fs.statSync(WORKER_LOCK_PATH).mtimeMs;
      if (age > STALE_LOCK_MS) {
        fs.unlinkSync(WORKER_LOCK_PATH);
        return fs.openSync(WORKER_LOCK_PATH, 'wx', 0o600);
      }
    } catch {
      // Another process may have released or replaced the lock; the next interval will retry.
    }
    return null;
  }
}

export async function processDueScheduledSends(): Promise<void> {
  if (processing) return;
  const lockFd = acquireWorkerLock();
  if (lockFd === null) return;
  processing = true;
  try {
    const jobs = loadJobs();
    const due = jobs.filter((job) => job.status === 'scheduled' && Date.parse(job.sendAt) <= Date.now());
    for (const job of due) {
      job.status = 'sending';
      job.updatedAt = new Date().toISOString();
      saveJobs(jobs);
      try {
        const ctx = gmailFor(job.account);
        if (ctx.email.toLowerCase() !== job.email.toLowerCase()) {
          throw new Error(`Account alias "${job.account}" now resolves to ${ctx.email}, expected ${job.email}.`);
        }
        const result = await callGmail(ctx, 'send scheduled draft', () =>
          ctx.gmail.users.drafts.send({ userId: 'me', requestBody: { id: job.draftId } })
        );
        job.status = 'sent';
        job.sentMessageId = result.data.id ?? undefined;
        job.sentThreadId = result.data.threadId ?? undefined;
        delete job.error;
      } catch (error) {
        // Do not auto-retry an ambiguous send failure; that could duplicate an email.
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = new Date().toISOString();
      saveJobs(jobs);
    }
  } finally {
    processing = false;
    try {
      fs.closeSync(lockFd);
      fs.unlinkSync(WORKER_LOCK_PATH);
    } catch {
      // A stale-lock recovery by another process may already have removed it.
    }
  }
}

export function startScheduledSendWorker(intervalMs = 30_000): void {
  void processDueScheduledSends().catch((error) =>
    console.error('gmail-multi scheduled-send startup check failed:', error)
  );
  setInterval(() => {
    void processDueScheduledSends().catch((error) =>
      console.error('gmail-multi scheduled-send check failed:', error)
    );
  }, intervalMs).unref();
}
