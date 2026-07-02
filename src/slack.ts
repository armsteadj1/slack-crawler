import { WebClient } from '@slack/web-api';

export interface ConversationInfo {
  id: string;
  name: string;
  type: 'channel' | 'im' | 'mpim';
  is_private: boolean;
  is_member?: boolean;
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

function toConversationInfo(ch: any): ConversationInfo | null {
  if (!ch?.id) return null;

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

  return {
    id: ch.id,
    name,
    type,
    is_private: !!(ch.is_private || ch.is_im || ch.is_mpim),
    is_member: ch.is_member,
    member_count: ch.num_members,
  };
}

/**
 * Get every conversation visible to the token:
 * - users.conversations for membership-bound conversations, including DMs and private channels.
 * - conversations.list for all public channels, including public channels the user is not in.
 *
 * conversations.list only returns open IMs and misses most DMs, so never use it as the only source.
 */
export async function getAllConversations(client: WebClient): Promise<ConversationInfo[]> {
  const conversations = new Map<string, ConversationInfo>();
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
        const convo = toConversationInfo(ch);
        if (convo) conversations.set(convo.id, convo);
      }
    }

    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  cursor = undefined;
  do {
    const resp = await client.conversations.list({
      types: 'public_channel',
      limit: 200,
      exclude_archived: false,
      cursor,
    });

    if (resp.channels) {
      for (const ch of resp.channels as any[]) {
        const convo = toConversationInfo(ch);
        if (convo) conversations.set(convo.id, convo);
      }
    }

    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  return [...conversations.values()];
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

let workspaceUserCache: Map<string, string> | null = null;

async function getWorkspaceUserMap(client: WebClient): Promise<Map<string, string>> {
  if (workspaceUserCache) return workspaceUserCache;

  const map = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const resp = await client.users.list({ limit: 200, cursor });
    for (const user of (resp.members || []) as any[]) {
      if (!user?.id) continue;
      map.set(user.id, user.real_name || user.profile?.real_name || user.name || user.id);
    }

    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await sleep(1100);
  } while (cursor);

  workspaceUserCache = map;
  return map;
}

export async function getUsernames(
  client: WebClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return map;

  const workspaceUsers = await getWorkspaceUserMap(client);
  const missing: string[] = [];

  for (const uid of unique) {
    const name = workspaceUsers.get(uid);
    if (name) map.set(uid, name);
    else missing.push(uid);
  }

  for (const uid of missing) {
    try {
      const resp = await client.users.info({ user: uid });
      if (resp.user) {
        const name = resp.user.real_name || resp.user.profile?.real_name || resp.user.name || uid;
        map.set(uid, name);
        workspaceUsers.set(uid, name);
      } else {
        map.set(uid, uid);
      }
    } catch {
      map.set(uid, uid);
    }
  }

  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
