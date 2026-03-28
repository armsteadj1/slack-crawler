import { WebClient } from '@slack/web-api';

export interface ConversationInfo {
  id: string;
  name: string;
  type: 'channel' | 'im' | 'mpim';
  is_private: boolean;
  member_count?: number;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  [key: string]: unknown;
}

export function createClient(token: string): WebClient {
  return new WebClient(token);
}

/**
 * Get ALL conversations the user is a member of.
 * Uses users.conversations (NOT conversations.list).
 *
 * conversations.list only returns open IMs and misses most DMs.
 * users.conversations returns everything: public/private channels, DMs, group DMs.
 */
export async function getAllConversations(client: WebClient): Promise<ConversationInfo[]> {
  const conversations: ConversationInfo[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.users.conversations({
      types: 'public_channel,private_channel,im,mpim',
      limit: 200,
      exclude_archived: false,
      cursor,
    });

    if (resp.channels) {
      for (const ch of resp.channels as any[]) {
        if (!ch.id) continue;

        let name: string;
        let type: ConversationInfo['type'];

        if (ch.is_im) {
          name = `dm:${ch.user || ch.id}`;
          type = 'im';
        } else if (ch.is_mpim) {
          name = ch.name || ch.purpose?.value || `group-dm:${ch.id}`;
          type = 'mpim';
        } else {
          name = ch.name || ch.id;
          type = 'channel';
        }

        conversations.push({
          id: ch.id,
          name,
          type,
          is_private: !!(ch.is_private || ch.is_im || ch.is_mpim),
          member_count: ch.num_members,
        });
      }
    }

    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  return conversations;
}

/**
 * Resolve DM conversation names from user IDs to real names.
 */
export async function resolveDmNames(
  client: WebClient,
  conversations: ConversationInfo[]
): Promise<void> {
  const dmConvos = conversations.filter((c) => c.type === 'im' && c.name.startsWith('dm:U'));
  const userIds = dmConvos.map((c) => c.name.replace('dm:', ''));
  const usernameMap = await getUsernames(client, userIds);

  for (const convo of dmConvos) {
    const uid = convo.name.replace('dm:', '');
    const username = usernameMap.get(uid);
    if (username) {
      convo.name = `dm:${username}`;
    }
  }
}

export async function getChannelHistory(
  client: WebClient,
  channelId: string,
  opts: { oldest?: string; latest?: string } = {}
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.conversations.history({
      channel: channelId,
      limit: 200,
      oldest: opts.oldest,
      latest: opts.latest,
      cursor,
    });

    if (resp.messages) {
      messages.push(...(resp.messages as SlackMessage[]));
    }

    // Always follow has_more/cursor — never truncate history
    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  return messages;
}

export async function getThreadReplies(
  client: WebClient,
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });

    if (resp.messages) {
      messages.push(...(resp.messages as SlackMessage[]));
    }

    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  return messages;
}

export async function getUsernames(
  client: WebClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(userIds)].filter(Boolean);

  for (const uid of unique) {
    try {
      const resp = await client.users.info({ user: uid });
      if (resp.user) {
        map.set(uid, resp.user.real_name || resp.user.name || uid);
      }
    } catch {
      map.set(uid, uid);
    }
    await sleep(300);
  }

  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
