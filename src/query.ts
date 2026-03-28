import 'dotenv/config';
import { openDb } from './db.js';
import { embed } from './embeddings.js';

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: npx tsx src/query.ts "your query" [options]');
  console.log('       npx tsx src/query.ts --from "grant" [--limit 20]');
  console.log('');
  console.log('Options:');
  console.log('  --limit N         Number of results (default: 10)');
  console.log('  --channel NAME    Filter by channel name');
  console.log('  --from NAME       Filter by person (name or @handle, fuzzy match)');
  console.log('  --keyword TEXT    Keyword search instead of semantic (faster, no embeddings needed)');
  process.exit(0);
}

let query = '';
let limit = 10;
let channel: string | undefined;
let fromPerson: string | undefined;
let keyword: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
  else if (args[i] === '--channel' && args[i + 1]) channel = args[++i];
  else if (args[i] === '--from' && args[i + 1]) fromPerson = args[++i];
  else if (args[i] === '--keyword' && args[i + 1]) keyword = args[++i];
  else if (!args[i].startsWith('--')) query = args[i];
}

async function main() {
  const db = openDb();

  // --from without a query: just list recent messages from that person
  if (fromPerson && !query && !keyword) {
    const rows = db.prepare(`
      SELECT channel_name, username, ts, text FROM messages
      WHERE lower(username) LIKE lower(?) OR lower(user_id) LIKE lower(?)
      ORDER BY ts DESC LIMIT ?
    `).all(`%${fromPerson}%`, `%${fromPerson}%`, limit) as any[];

    if (rows.length === 0) {
      console.log(`No messages found from "${fromPerson}"`);
      // Show who's in the DB
      const people = db.prepare(`SELECT DISTINCT username FROM messages WHERE username != 'bot' ORDER BY username LIMIT 30`).all() as any[];
      console.log('\nPeople in DB:', people.map((p: any) => p.username).join(', '));
    } else {
      console.log(`Messages from "${fromPerson}":\n`);
      for (const r of rows) {
        const date = new Date(parseFloat(r.ts) * 1000).toLocaleString();
        console.log(`[#${r.channel_name}] ${date}`);
        console.log((r.text || '').slice(0, 300).replace(/\n/g, ' '));
        console.log('');
      }
    }
    db.close();
    return;
  }

  // Keyword search (no embeddings needed)
  if (keyword) {
    let sql = `
      SELECT channel_name, username, ts, text FROM messages
      WHERE text LIKE ?
    `;
    const params: any[] = [`%${keyword}%`];
    if (channel) { sql += ` AND channel_name = ?`; params.push(channel); }
    if (fromPerson) { sql += ` AND (lower(username) LIKE lower(?) OR lower(user_id) LIKE lower(?))`; params.push(`%${fromPerson}%`, `%${fromPerson}%`); }
    sql += ` ORDER BY ts DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    if (rows.length === 0) { console.log('No results.'); }
    else {
      for (const r of rows) {
        const date = new Date(parseFloat(r.ts) * 1000).toLocaleString();
        console.log(`[#${r.channel_name}] @${r.username} | ${date}`);
        console.log((r.text || '').slice(0, 300).replace(/\n/g, ' '));
        console.log('');
      }
    }
    db.close();
    return;
  }

  if (!query) { console.error('Provide a query or use --keyword / --from'); process.exit(1); }

  // Semantic vector search
  const queryEmbedding = await embed(query);
  const embeddingBuffer = Buffer.from(queryEmbedding.buffer);

  let sql = `
    SELECT m.channel_name, m.username, m.ts, m.text, me.distance
    FROM message_embeddings me
    JOIN messages m ON m.id = me.id
    WHERE me.embedding MATCH ? AND k = ?
  `;
  const params: any[] = [embeddingBuffer, limit * 3];
  if (channel) { sql += ` AND m.channel_name = ?`; params.push(channel); }
  if (fromPerson) { sql += ` AND (lower(m.username) LIKE lower(?) OR lower(m.user_id) LIKE lower(?))`; params.push(`%${fromPerson}%`, `%${fromPerson}%`); }
  sql += ` ORDER BY me.distance LIMIT ?`;
  params.push(limit);

  const results = db.prepare(sql).all(...params) as any[];

  if (results.length === 0) { console.log('No results.'); db.close(); return; }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = new Date(parseFloat(r.ts) * 1000).toLocaleString();
    console.log(`[${i+1}] #${r.channel_name} | @${r.username} | ${date}`);
    console.log((r.text || '').slice(0, 400).replace(/\n/g, ' '));
    console.log('');
  }

  db.close();
}

main().catch(console.error);
