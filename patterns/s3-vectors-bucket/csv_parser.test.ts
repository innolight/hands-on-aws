import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {parseCSV} from './csv_parser';

// Builds a minimal valid CSV string with the same columns as the real dataset.
// Embedding is stored as a JSON array in a quoted field, matching the real format.
function makeCSV(rows: Array<{productId: string; score: number; summary: string; text: string; embedding?: number[]}>): string {
  const header = 'index,ProductId,UserId,Score,Summary,Text,combined,n_tokens,embedding';
  const lines = rows.map((r, i) => {
    const emb = r.embedding ?? [0.1, -0.2];
    return `${i},${r.productId},U001,${r.score},"${r.summary}","${r.text}",combined,10,"${JSON.stringify(emb)}"`;
  });
  return [header, ...lines].join('\n') + '\n';
}

async function withTempCSV(content: string, fn: (p: string) => Promise<void>): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `test-reviews-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, content);
  try {
    await fn(tmpFile);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

describe('parseCSV', () => {
  test('parses a plain row', async () => {
    const csv = makeCSV([{productId: 'B001', score: 5, summary: 'Great', text: 'Loved it'}]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        rowIndex: 0,
        ProductId: 'B001',
        Score: 5,
        Summary: 'Great',
        Text: 'Loved it',
        embedding: [0.1, -0.2],
      });
    });
  });

  test('parses a summary containing a comma', async () => {
    const csv = makeCSV([{productId: 'B002', score: 4, summary: 'Good, but not great', text: 'Decent'}]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows[0].Summary).toBe('Good, but not great');
    });
  });

  test('parses text containing commas', async () => {
    const csv = makeCSV([{productId: 'B003', score: 3, summary: 'Ok', text: 'Fresh, crispy, and delicious'}]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows[0].Text).toBe('Fresh, crispy, and delicious');
    });
  });

  test('assigns rowIndex sequentially from 0', async () => {
    const csv = makeCSV([
      {productId: 'B001', score: 5, summary: 'First', text: 'A'},
      {productId: 'B002', score: 3, summary: 'Second', text: 'B'},
    ]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows[0].rowIndex).toBe(0);
      expect(rows[1].rowIndex).toBe(1);
    });
  });

  test('parses the embedding as a number array', async () => {
    const emb = [0.03599238, -0.02116263, -0.02902303];
    const csv = makeCSV([{productId: 'B001', score: 5, summary: 'Good', text: 'Yes', embedding: emb}]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows[0].embedding).toEqual(emb);
    });
  });

  test('skips the header row', async () => {
    const csv = makeCSV([{productId: 'B001', score: 5, summary: 'Good', text: 'Yes'}]);
    await withTempCSV(csv, async (p) => {
      const rows = await parseCSV(p);
      expect(rows).toHaveLength(1);
    });
  });
});
