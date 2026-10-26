import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Dashboard } from '../shared/types.js';

export class Store {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'qa.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tests (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }
  latest(): Dashboard | null {
    const row = this.db.prepare('SELECT state FROM tests ORDER BY updated_at DESC, rowid DESC LIMIT 1').get() as {state: string} | undefined;
    return row ? JSON.parse(row.state) : null;
  }
  save(state: Dashboard) {
    this.db.prepare('INSERT INTO tests(id,state,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at')
      .run(state.testId, JSON.stringify(state), new Date().toISOString());
  }
  close() { this.db.close(); }
}
