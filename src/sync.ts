import 'dotenv/config';
import fs from 'node:fs';
import { openDb } from './db.js';
import {
  createClient,
  getAllConversations,
  resolveDmNames,
  getChannelHistory,
  getThreadReplies,
  getUsernames,
  type ConversationInfo,
} from './slack.js';
import Database from 'better-sqlite3';

const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
if (!token) throw new Error('SLACK_USER_TOKEN or SLACK_BOT_TOKEN not set');

const client = createClient(token);

const FULL_BACKFILL = process.env.SLACK_SYNC_FULL_BACKFILL === '1';
const LOCK_PATH = '/tmp/com.hedwig.slack-sync.lock';
const INITIAL_LOOKBACK_SECONDS = 14 * 24 * 60 * 60;
const STALE_LOCK_SECONDS = 3 * 60 * 60;
const RECENT_ACTIVITY_SECONDS = 30 * 24 * 60 * 60;
const INCREMENTAL_RECENT_LIMIT = 25;
const INCREMENTAL_STALE_LIMIT = 5;
const INCREMENTAL_BOOTSTRAP_LIMIT = 3;
const BACKFILL_LIMIT = 120;
const PRIORITY_NAME_MATCHES = [
  'dm:james',
  'dm:colin luce',
  'dm:casey clegg',
  'dm:lucas chociay',
  'hedwig-chat',
  'tesouro-acquisition',
  'proj-openclaw',
  'proj-scg',
  'partnerships',
  'senior-leadership',
] as const;

type SyncStateRow = {
  last_ts: string | null;
  last_sync: number | null;
};

type ConvoWithState = {
  convo: ConversationInfo;
  state?: SyncStateRow;
};

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function computeSyncCadenceSeconds(lastTs?: string): number {
  if (!lastTs) return 6 * 60 * 60;
  const ageSeconds = nowUnix() - Math.floor(Number(lastTs));
  if (ageSeconds <= 7 * 24 * 60 * 60) return 15 * 60;
  if (ageSeconds <= 30 * 24 * 60 * 60) return 6 * 60 * 60;
  return 24 * 60 * 60;
}

async function upsertMessage(
  db: Database.Database,
  convo: ConversationInfo,
  msg: any,
  usernameMap: Map<string, string>
): Promise<boolean> {
  const id = `${convo.id}:${msg.ts}`;
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(id);
  if (existing) return false;

  const username = msg.user ? (usernameMap.get(msg.user) || msg.user) : 'bot';

  db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, channel_id, channel_name, user_id, username, ts, thread_ts, is_thread_root, reply_count, text, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    convo.id,
    convo.name,
    msg.user || null,
    username,
    msg.ts,
    msg.thread_ts || null,
    msg.thread_ts === msg.ts ? 1 : 0,
    msg.reply_count || 0,
    msg.text || '',
    JSON.stringify(msg)
  );

  return true;
}

async function syncConversation(db: Database.Database, convo: ConversationInfo, state?: SyncStateRow) {
  const row = state ?? db.prepare('SELECT last_ts, last_sync FROM sync_state WHERE channel_id = ?').get(convo.id) as SyncStateRow | undefined;

  const cadenceSeconds = FULL_BACKFILL ? 0 : computeSyncCadenceSeconds(row?.last_ts ?? undefined);
  if (!FULL_BACKFILL && row?.last_sync && nowUnix() - row.last_sync < cadenceSeconds) {
    return;
  }

  const oldest = FULL_BACKFILL
    ? row?.last_ts ?? undefined
    : row?.last_ts ?? String(nowUnix() - INITIAL_LOOKBACK_SECONDS);

  const label = convo.type === 'channel' ? `#${convo.name}` : convo.name;
  const mode = FULL_BACKFILL ? 'backfill' : row?.last_ts ? 'incremental' : `bootstrap-${Math.floor(INITIAL_LOOKBACK_SECONDS / 86400)}d`;
  console.log(`  Syncing ${label} [${mode}]${oldest ? ` from ${oldest}` : ''}`);

  let messages: any[];
  try {
    messages = await getChannelHistory(client, convo.id, { oldest });
  } catch (err: any) {
    if (['not_in_channel', 'user_not_in_channel', 'channel_not_found', 'missing_scope'].includes(err?.data?.error)) {
      db.prepare(`
        INSERT OR REPLACE INTO sync_state (channel_id, last_ts, last_sync)
        VALUES (?, COALESCE((SELECT last_ts FROM sync_state WHERE channel_id = ?), NULL), unixepoch())
      `).run(convo.id, convo.id);
      return;
    }
    throw err;
  }

  if (messages.length === 0) {
    db.prepare(`
      INSERT OR REPLACE INTO sync_state (channel_id, last_ts, last_sync)
      VALUES (?, COALESCE((SELECT last_ts FROM sync_state WHERE channel_id = ?), ?), unixepoch())
    `).run(convo.id, convo.id, oldest ?? null);
    return;
  }

  const userIds = messages.map((m) => m.user).filter(Boolean) as string[];
  const usernameMap = await getUsernames(client, userIds);

  let newCount = 0;
  let latestTs = oldest || '';

  for (const msg of messages) {
    if (msg.subtype && !['bot_message', 'me_message'].includes(msg.subtype)) continue;

    const added = await upsertMessage(db, convo, msg, usernameMap);
    if (added) newCount++;
    if (msg.ts > latestTs) latestTs = msg.ts;

    if (convo.type === 'channel' && (msg.reply_count || 0) > 0 && msg.thread_ts === msg.ts) {
      try {
        const replies = await getThreadReplies(client, convo.id, msg.ts);
        const replyUserIds = replies.map((r) => r.user).filter(Boolean) as string[];
        const replyMap = await getUsernames(client, replyUserIds);
        for (const reply of replies) {
          if (reply.ts === msg.ts) continue;
          await upsertMessage(db, convo, reply, replyMap);
        }
      } catch {
        // Non-fatal
      }
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO sync_state (channel_id, last_ts, last_sync)
    VALUES (?, ?, unixepoch())
  `).run(convo.id, latestTs);

  if (newCount > 0) {
    console.log(`  ${label}: +${newCount} new messages`);
  }
}

function isDue(state?: SyncStateRow): boolean {
  if (FULL_BACKFILL) return true;
  if (!state?.last_sync) return true;
  return nowUnix() - state.last_sync >= computeSyncCadenceSeconds(state.last_ts ?? undefined);
}

function getLastTsNumber(state?: SyncStateRow): number {
  return state?.last_ts ? Math.floor(Number(state.last_ts)) : 0;
}

function priorityScore(convo: ConversationInfo): number {
  const name = convo.name.toLowerCase();
  const idx = PRIORITY_NAME_MATCHES.findIndex((part) => name.includes(part));
  return idx === -1 ? 999 : idx;
}

function selectConversations(conversations: ConversationInfo[], stateMap: Map<string, SyncStateRow>): ConvoWithState[] {
  const all = conversations.map((convo) => ({ convo, state: stateMap.get(convo.id) }));
  const due = all.filter((item) => isDue(item.state));

  if (FULL_BACKFILL) {
    const bootstrap = due
      .filter((item) => !item.state?.last_ts)
      .sort((a, b) => priorityScore(a.convo) - priorityScore(b.convo) || a.convo.name.localeCompare(b.convo.name));

    const stale = due
      .filter((item) => !!item.state?.last_ts)
      .sort((a, b) => priorityScore(a.convo) - priorityScore(b.convo) || (a.state?.last_sync ?? 0) - (b.state?.last_sync ?? 0));

    return [...bootstrap, ...stale].slice(0, BACKFILL_LIMIT);
  }

  const cutoff = nowUnix() - RECENT_ACTIVITY_SECONDS;

  const recent = due
    .filter((item) => item.state?.last_ts && getLastTsNumber(item.state) >= cutoff)
    .sort((a, b) => priorityScore(a.convo) - priorityScore(b.convo) || getLastTsNumber(b.state) - getLastTsNumber(a.state))
    .slice(0, INCREMENTAL_RECENT_LIMIT);

  const stale = due
    .filter((item) => item.state?.last_ts && getLastTsNumber(item.state) < cutoff)
    .sort((a, b) => priorityScore(a.convo) - priorityScore(b.convo) || (a.state?.last_sync ?? 0) - (b.state?.last_sync ?? 0))
    .slice(0, INCREMENTAL_STALE_LIMIT);

  const bootstrap = due
    .filter((item) => !item.state?.last_ts)
    .sort((a, b) => priorityScore(a.convo) - priorityScore(b.convo) || a.convo.name.localeCompare(b.convo.name))
    .slice(0, INCREMENTAL_BOOTSTRAP_LIMIT);

  const selected: ConvoWithState[] = [];
  const seen = new Set<string>();
  for (const item of [...recent, ...bootstrap, ...stale]) {
    if (seen.has(item.convo.id)) continue;
    seen.add(item.convo.id);
    selected.push(item);
  }
  return selected;
}

async function main() {
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), fullBackfill: FULL_BACKFILL }));
  } catch {
    try {
      const stat = fs.statSync(LOCK_PATH);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_SECONDS * 1000) {
        console.warn('Removing stale Slack sync lock.');
        fs.unlinkSync(LOCK_PATH);
        lockFd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), fullBackfill: FULL_BACKFILL }));
      } else {
        console.log('Slack sync already running, skipping overlapping launch.');
        return;
      }
    } catch {
      console.log('Slack sync already running, skipping overlapping launch.');
      return;
    }
  }

  console.log(`Starting Slack sync (${FULL_BACKFILL ? 'full backfill' : 'incremental'})...`);
  let db: Database.Database | null = null;

  try {
    db = openDb();
    const conversations = await getAllConversations(client);
    await resolveDmNames(client, conversations);
    const stateRows = db.prepare('SELECT channel_id, last_ts, last_sync FROM sync_state').all() as Array<{ channel_id: string; last_ts: string | null; last_sync: number | null }>;
    const stateMap = new Map(stateRows.map((row) => [row.channel_id, { last_ts: row.last_ts, last_sync: row.last_sync }]));
    const selected = selectConversations(conversations, stateMap);

    console.log(`Found ${conversations.length} conversations`);
    console.log(`Selected ${selected.length} for ${FULL_BACKFILL ? 'backfill' : 'incremental'} sync`);

    for (const item of selected) {
      try {
        await syncConversation(db, item.convo, item.state);
      } catch (err) {
        console.error(`Error syncing ${item.convo.name}:`, err);
      }
    }

    const total = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
    console.log(`\nSync complete. Total messages in DB: ${total}`);
  } finally {
    if (db) db.close();
    if (lockFd !== null) {
      fs.closeSync(lockFd);
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
    }
  }
}

main().catch(console.error);
