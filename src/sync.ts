import 'dotenv/config';
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
import { embed } from './embeddings.js';
import Database from 'better-sqlite3';

const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
if (!token) throw new Error('SLACK_USER_TOKEN or SLACK_BOT_TOKEN not set');

const client = createClient(token);

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

  const text = msg.text || '';
  if (text.trim()) {
    try {
      const embedding = await embed(text);
      db.prepare(`
        INSERT OR REPLACE INTO message_embeddings (id, embedding)
        VALUES (?, ?)
      `).run(id, Buffer.from(embedding.buffer));
    } catch {
      // Non-fatal
    }
  }

  return true;
}

async function syncConversation(db: Database.Database, convo: ConversationInfo) {
  const state = db.prepare('SELECT last_ts FROM sync_state WHERE channel_id = ?').get(convo.id) as { last_ts: string } | undefined;
  const oldest = state?.last_ts;

  const label = convo.type === 'channel' ? `#${convo.name}` : convo.name;
  console.log(`  Syncing ${label}${oldest ? ` from ${oldest}` : ' (full)'}`);

  let messages: any[];
  try {
    messages = await getChannelHistory(client, convo.id, { oldest });
  } catch (err: any) {
    if (err?.data?.error === 'not_in_channel' || err?.data?.error === 'channel_not_found') {
      return;
    }
    throw err;
  }

  if (messages.length === 0) return;

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

async function main() {
  console.log('Starting Slack sync (all channels + DMs + group DMs)...');
  const db = openDb();

  const conversations = await getAllConversations(client);
  await resolveDmNames(client, conversations);
  console.log(`Found ${conversations.length} conversations`);

  for (const convo of conversations) {
    try {
      await syncConversation(db, convo);
    } catch (err) {
      console.error(`Error syncing ${convo.name}:`, err);
    }
  }

  const total = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
  console.log(`\nSync complete. Total messages in DB: ${total}`);
  db.close();
}

main().catch(console.error);
