import 'dotenv/config';
import { openDb } from './db.js';
import {
  createClient,
  getAllConversations,
  resolveDmNames,
  getChannelHistory,
  getUsernames,
  type ConversationInfo,
} from './slack.js';
import Database from 'better-sqlite3';

const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
if (!token) throw new Error('SLACK_USER_TOKEN or SLACK_BOT_TOKEN not set');

const client = createClient(token);

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function storeMessages(
  db: Database.Database,
  convo: ConversationInfo,
  messages: any[],
  usernameMap: Map<string, string>
): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, channel_id, channel_name, user_id, username, ts, thread_ts, is_thread_root, reply_count, text, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((msgs: any[]) => {
    let count = 0;
    for (const msg of msgs) {
      if (msg.subtype && !['bot_message', 'me_message'].includes(msg.subtype)) continue;
      const id = `${convo.id}:${msg.ts}`;
      const username = msg.user ? (usernameMap.get(msg.user) || msg.user) : 'bot';
      const result = insert.run(
        id, convo.id, convo.name,
        msg.user || null, username,
        msg.ts,
        msg.thread_ts || null,
        msg.thread_ts === msg.ts ? 1 : 0,
        msg.reply_count || 0,
        msg.text || '',
        JSON.stringify(msg)
      );
      if (result.changes > 0) count++;
    }
    return count;
  });

  return insertMany(messages);
}

async function backfillConversation(db: Database.Database, convo: ConversationInfo) {
  let messages: any[];
  try {
    messages = await getChannelHistory(client, convo.id);
  } catch (err: any) {
    const code = err?.data?.error;
    if (['not_in_channel', 'channel_not_found', 'missing_scope', 'user_not_in_channel'].includes(code)) {
      return { stored: 0, skipped: true };
    }
    throw err;
  }

  if (messages.length === 0) return { stored: 0, skipped: false };

  // Batch resolve usernames
  const userIds = [...new Set(messages.map((m: any) => m.user).filter(Boolean))] as string[];
  const usernameMap = await getUsernames(client, userIds);

  // Store all messages in a single transaction (fast)
  const stored = storeMessages(db, convo, messages, usernameMap);

  // Update sync cursor
  const latestTs = messages.reduce((max: string, m: any) => m.ts > max ? m.ts : max, '');
  if (latestTs) {
    db.prepare(`INSERT OR REPLACE INTO sync_state (channel_id, last_ts, last_sync) VALUES (?, ?, unixepoch())`)
      .run(convo.id, latestTs);
  }

  return { stored, skipped: false };
}

async function main() {
  const startTime = Date.now();
  console.log('Starting Slack backfill (user token — all channels, DMs, group DMs)...');
  console.log('NOTE: Thread replies skipped for speed — run threads-pass.ts separately\n');

  const db = openDb();

  console.log('Fetching all conversations...');
  const conversations = await getAllConversations(client);

  const channels = conversations.filter((c) => c.type === 'channel');
  const dms = conversations.filter((c) => c.type === 'im');
  const groupDms = conversations.filter((c) => c.type === 'mpim');

  console.log(`Found ${conversations.length} total conversations`);
  console.log(`  Channels: ${channels.length} | DMs: ${dms.length} | Group DMs: ${groupDms.length}`);

  console.log('Resolving DM names...');
  await resolveDmNames(client, conversations);
  console.log('Done resolving. Starting message fetch...\n');

  let totalNew = 0;
  let skipped = 0;

  const all = [...channels, ...dms, ...groupDms];

  for (let i = 0; i < all.length; i++) {
    const convo = all[i];
    const label = convo.type === 'channel' ? `#${convo.name}` : convo.name;

    process.stdout.write(`\r[${i+1}/${all.length}] ${label}                                    `);

    try {
      const result = await backfillConversation(db, convo);
      if (!result.skipped) totalNew += result.stored;
      else skipped++;
    } catch {
      // Non-fatal
    }

    // Post checkpoint every ~10%
    if ((i + 1) % Math.floor(all.length / 10) === 0) {
      const total = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
      const pct = Math.round(((i + 1) / all.length) * 100);
      process.stdout.write('\n');
      console.log(`📊 ${pct}% — ${i+1}/${all.length} convos | +${totalNew} new | DB: ${total} total`);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const total = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
  const convoCount = (db.prepare("SELECT COUNT(DISTINCT channel_id) as n FROM messages").get() as { n: number }).n;

  process.stdout.write('\n');
  console.log('\n' + '='.repeat(60));
  console.log(`Done in ${Math.round(elapsed/60)}m ${elapsed%60}s`);
  console.log(`New messages: ${totalNew} | Skipped convos: ${skipped}`);
  console.log(`Total in DB: ${total} across ${convoCount} conversations`);
  console.log('='.repeat(60));

  db.close();
}

main().catch(console.error);
