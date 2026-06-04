import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
}

function initSchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      client TEXT,
      provider TEXT,
      model TEXT,
      intent TEXT,
      tokens_in_raw INTEGER,
      tokens_in_sent INTEGER,
      tokens_in_cached INTEGER,
      tokens_out_raw INTEGER,
      tokens_out_returned INTEGER,
      cache_hit_type TEXT,
      latency_ms INTEGER,
      cost_usd_raw REAL,
      cost_usd_actual REAL,
      cost_usd_saved REAL,
      techniques_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(ts);
    CREATE INDEX IF NOT EXISTS idx_prompts_model ON prompts(model);

    CREATE TABLE IF NOT EXISTS daily_rollup (
      date TEXT PRIMARY KEY,
      prompts INTEGER,
      tokens_saved INTEGER,
      cost_saved_usd REAL,
      cache_hit_rate REAL
    );

    CREATE TABLE IF NOT EXISTS memory_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_hash TEXT UNIQUE,
      embedding BLOB,
      canonical_question TEXT,
      canonical_answer TEXT,
      hit_count INTEGER DEFAULT 1,
      last_seen INTEGER,
      promoted_to_faq INTEGER DEFAULT 0,
      user_confirmed INTEGER DEFAULT 0,
      tokens_saved_total INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memory_hits ON memory_patterns(hit_count DESC);

    CREATE TABLE IF NOT EXISTS semantic_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT UNIQUE,
      prompt_text TEXT,
      embedding BLOB,
      response_text TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      hits INTEGER DEFAULT 0,
      created_at INTEGER,
      last_hit INTEGER
    );

    CREATE TABLE IF NOT EXISTS command_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      command TEXT,
      preset TEXT,
      bytes_in INTEGER,
      bytes_out INTEGER,
      tokens_saved_estimate INTEGER
    );
  `);
}
