import { pipeline, env } from '@xenova/transformers';
import path from 'path';
import os from 'os';

// Cache models locally
env.cacheDir = path.join(os.homedir(), 'projects', 'slack-sync', 'data', 'models');

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;

export async function getEmbedder() {
  if (!embedder) {
    console.log('Loading nomic-embed-text model (first run may download ~270MB)...');
    embedder = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1', {
      quantized: true,
    });
    console.log('Model loaded.');
  }
  return embedder;
}

export async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return result.data as Float32Array;
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const model = await getEmbedder();
  const results: Float32Array[] = [];
  // Process in batches of 32 to avoid memory issues
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const result = await model(text, { pooling: 'mean', normalize: true });
        return result.data as Float32Array;
      })
    );
    results.push(...batchResults);
  }
  return results;
}
