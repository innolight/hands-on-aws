import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';

export const CSV_PATH = path.join(__dirname, 'data', 'fine_food_reviews_with_embeddings_1k.csv');

export interface ReviewRow {
  rowIndex: number;
  ProductId: string;
  Score: number;
  Summary: string;
  Text: string;
  embedding: number[];
}

// CSV columns: index,ProductId,UserId,Score,Summary,Text,combined,n_tokens,embedding
// csv-parse handles quoting and comma escaping; we just pick the columns we need.
export async function parseCSV(csvPath: string = CSV_PATH): Promise<ReviewRow[]> {
  return new Promise((resolve, reject) => {
    const rows: ReviewRow[] = [];
    fs.createReadStream(csvPath)
      .pipe(parse({ columns: true, cast: true, skip_empty_lines: true }))
      .on('data', (record: Record<string, unknown>) => {
        rows.push({
          rowIndex: rows.length,
          ProductId: String(record['ProductId']),
          Score: Number(record['Score']),
          Summary: String(record['Summary']),
          Text: String(record['Text']),
          // The embedding column is stored as a JSON array string
          embedding: JSON.parse(String(record['embedding'])),
        });
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}
