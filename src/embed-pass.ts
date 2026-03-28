/**
 * embed-pass.ts — Generate embeddings for messages that don't have them yet.
 * Run this separately after backfill to build the vector search index.
 * Can be interrupted and restarted — picks up where it left off.
 */
import 'dotenv/config';
import { openDb } from './db.js';
import { embed } from './embeddings.js';

async function main() {
  const db = openDb();

  const pending = (db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    LEFT JOIN message_embeddings e ON m.id = e.id
    WHERE e.id IS NULL AND m.text != ''
  `).get() as { n: number }).n;

  console.log(`Generating embeddings for ${pending} messages without them...`);
  console.log('(Can be interrupted — will resume from where it left off)\n');

  let done = 0;
  let errors = 0;
  const batchSize = 100;

  while (true) {
    const batch = db.prepare(`
      SELECT m.id, m.text FROM messages m
      LEFT JOIN message_embeddings e ON m.id = e.id
      WHERE e.id IS NULL AND m.text != ''
      LIMIT ?
    `).all(batchSize) as { id: string; text: string }[];

    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const embedding = await embed(row.text);
        db.prepare('INSERT OR REPLACE INTO message_embeddings (id, embedding) VALUES (?, ?)')
          .run(row.id, Buffer.from(embedding.buffer));
        done++;
      } catch {
        errors++;
      }

      if (done % 100 === 0) {
        const pct = Math.round((done / pending) * 100);
        process.stdout.write(`\r  ${done}/${pending} (${pct}%) — ${errors} errors`);
      }
    }
  }

  console.log(`\n\nDone. ${done} embeddings generated, ${errors} errors.`);
  db.close();
}

main().catch(console.error);
