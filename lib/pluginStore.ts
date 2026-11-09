// @ts-nocheck
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import fs from 'fs';
import path from 'path';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;

interface Adapter {
  name:         string;
  ensureTable:  (table: string) => Promise<void>;
  get:          (table: string, key: string) => Promise<any>;
  set:          (table: string, key: string, value: any) => Promise<void>;
  del:          (table: string, key: string) => Promise<void>;
  getAll:       (table: string) => Promise<Record<string, any>>;
  getAllWithMeta?: (table: string) => Promise<Array<{ key: string; value: any; ts: number }>>;
}

interface PluginStore {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  getAll(): Promise<Record<string, any>>;
  has(key: string): Promise<boolean>;
  getOrDefault(key: string, defaultValue: any): Promise<any>;
  patch(key: string, patch: Record<string, any>): Promise<void>;
  mutate<T = any>(key: string, updater: (current: any) => T | Promise<T>): Promise<T>;
  table?(name: string): PluginStore;
  readonly namespace:     string;
  readonly tableName:     string | null;
  readonly physicalTable: string;
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

function physicalName(namespace: string, tableName?: string): string {
  return tableName ? `${sanitize(namespace)}_${sanitize(tableName)}` : sanitize(namespace);
}

let _adapter: Promise<Adapter> | null = null;

export function getAdapter(): Promise<Adapter> {
  if (!_adapter) {
    _adapter = _initAdapter();
  }
  return _adapter;
}

async function _initAdapter(): Promise<Adapter> {
  // ── MongoDB ────────────────────────────────────────────────────────────────
  if (MONGO_URL) {
    try {
      const mongoose = require('mongoose');

      await new Promise<void>((resolve, reject) => {
        if (mongoose.connection.readyState === 1) return resolve();
        if (mongoose.connection.readyState === 2) {
          mongoose.connection.once('connected', resolve);
          mongoose.connection.once('error', reject);
          return;
        }
        mongoose.connect(MONGO_URL).then(resolve).catch(reject);
      });

      const db = mongoose.connection.db;
      const verifiedTables = new Set<string>();

      return {
        name: 'mongo',
        async ensureTable(table) {
          if (verifiedTables.has(table)) return;
          const list = await db.listCollections({ name: table }).toArray();
          if (list.length === 0) await db.createCollection(table);
          verifiedTables.add(table);
        },
        async get(table, key) {
          await this.ensureTable(table);
          const doc = await db.collection(table).findOne({ _id: key });
          return doc ? doc.value : null;
        },
        async set(table, key, value) {
          await this.ensureTable(table);
          await db.collection(table).updateOne(
            { _id: key },
            { $set: { value, ts: Date.now() } },
            { upsert: true }
          );
        },
        async del(table, key) {
          await this.ensureTable(table);
          await db.collection(table).deleteOne({ _id: key });
        },
        async getAll(table) {
          await this.ensureTable(table);
          const docs = await db.collection(table).find({}).toArray();
          const result: Record<string, any> = {};
          for (const doc of docs) result[doc._id] = doc.value;
          return result;
        },
        async getAllWithMeta(table) {
          await this.ensureTable(table);
          const docs = await db.collection(table).find({}).toArray();
          return docs.map((doc: any) => ({ key: doc._id, value: doc.value, ts: doc.ts ?? 0 }));
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] MongoDB adapter initialization failed:', e.message);
    }
  }

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  if (POSTGRES_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: POSTGRES_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 20, // Expanded connection ceiling for multi-plugin safety
        idleTimeoutMillis: 30000,
      });

      const ready = new Set<string>();

      const ensureTableInternal = async (table: string) => {
        if (ready.has(table)) return;
        const client = await pool.connect();
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT   NOT NULL PRIMARY KEY,
              value TEXT,
              ts    BIGINT NOT NULL DEFAULT 0
            )
          `);
          ready.add(table);
        } finally {
          client.release();
        }
      };

      return {
        name: 'postgres',
        async ensureTable(table) {
          await ensureTableInternal(table);
        },
        async get(table, key) {
          await ensureTableInternal(table);
          const res = await pool.query(`SELECT value FROM "${table}" WHERE key=$1`, [key]);
          return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
        },
        async set(table, key, value) {
          await ensureTableInternal(table);
          await pool.query(
            `INSERT INTO "${table}"(key, value, ts) VALUES($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value=$2, ts=$3`,
            [key, JSON.stringify(value), Date.now()]
          );
        },
        async del(table, key) {
          await ensureTableInternal(table);
          await pool.query(`DELETE FROM "${table}" WHERE key=$1`, [key]);
        },
        async getAll(table) {
          await ensureTableInternal(table);
          const res = await pool.query(`SELECT key, value FROM "${table}"`);
          const result: Record<string, any> = {};
          for (const row of res.rows) result[row.key] = JSON.parse(row.value);
          return result;
        },
        async getAllWithMeta(table) {
          await ensureTableInternal(table);
          const res = await pool.query(`SELECT key, value, ts FROM "${table}"`);
          return res.rows.map((row: any) => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] PostgreSQL adapter initialization failed:', e.message);
    }
  }

  // ── MySQL ──────────────────────────────────────────────────────────────────
  if (MYSQL_URL) {
    try {
      const mysql = require('mysql2/promise');
      // Using a pool instead of a raw single connection for concurrency protection
      const pool = mysql.createPool({
        uri: MYSQL_URL,
        waitForConnections: true,
        connectionLimit: 15,
        queueLimit: 0
      });
      const ready = new Set<string>();

      const ensureTableInternal = async (table: string) => {
        if (ready.has(table)) return;
        await pool.execute(`
          CREATE TABLE IF NOT EXISTS \`${table}\` (
            \`key\`   VARCHAR(512) NOT NULL PRIMARY KEY,
            \`value\` LONGTEXT,
            \`ts\`    BIGINT NOT NULL DEFAULT 0
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        ready.add(table);
      };

      return {
        name: 'mysql',
        async ensureTable(table) {
          await ensureTableInternal(table);
        },
        async get(table, key) {
          await ensureTableInternal(table);
          const [rows] = await pool.execute(`SELECT \`value\` FROM \`${table}\` WHERE \`key\`=?`, [key]);
          return rows[0] ? JSON.parse((rows as any[])[0].value) : null;
        },
        async set(table, key, value) {
          await ensureTableInternal(table);
          await pool.execute(
            `INSERT INTO \`${table}\`(\`key\`, \`value\`, \`ts\`) VALUES(?, ?, ?)
             ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`ts\`=VALUES(\`ts\`)`,
            [key, JSON.stringify(value), Date.now()]
          );
        },
        async del(table, key) {
          await ensureTableInternal(table);
          await pool.execute(`DELETE FROM \`${table}\` WHERE \`key\`=?`, [key]);
        },
        async getAll(table) {
          await ensureTableInternal(table);
          const [rows] = await pool.execute(`SELECT \`key\`, \`value\` FROM \`${table}\``);
          const result: Record<string, any> = {};
          for (const row of (rows as any[])) {
            result[row.key] = JSON.parse(row.value);
          }
          return result;
        },
        async getAllWithMeta(table) {
          await ensureTableInternal(table);
          const [rows] = await pool.execute(`SELECT \`key\`, \`value\`, \`ts\` FROM \`${table}\``);
          return (rows as any[]).map(row => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] MySQL adapter initialization failed:', e.message);
    }
  }

  // ── SQLite ─────────────────────────────────────────────────────────────────
  if (SQLITE_URL) {
    try {
      const Database = require('better-sqlite3');
      const sqlite   = new Database(SQLITE_URL);
      sqlite.pragma('journal_mode = WAL');

      const ready = new Set<string>();

      return {
        name: 'sqlite',
        async ensureTable(table) {
          if (ready.has(table)) return;
          sqlite.prepare(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT NOT NULL PRIMARY KEY,
              value TEXT,
              ts    INTEGER NOT NULL DEFAULT 0
            )
          `).run();
          ready.add(table);
        },
        async get(table, key) {
          await this.ensureTable(table);
          const row = sqlite.prepare(`SELECT value FROM "${table}" WHERE key=?`).get(key);
          return row ? JSON.parse(row.value) : null;
        },
        async set(table, key, value) {
          await this.ensureTable(table);
          sqlite.prepare(`INSERT OR REPLACE INTO "${table}"(key, value, ts) VALUES(?, ?, ?)`).run(key, JSON.stringify(value), Date.now());
        },
        async del(table, key) {
          await this.ensureTable(table);
          sqlite.prepare(`DELETE FROM "${table}" WHERE key=?`).run(key);
        },
        async getAll(table) {
          await this.ensureTable(table);
          const rows = sqlite.prepare(`SELECT key, value FROM "${table}"`).all();
          const result: Record<string, any> = {};
          for (const row of rows) result[row.key] = JSON.parse(row.value);
          return result;
        },
        async getAllWithMeta(table) {
          await this.ensureTable(table);
          const rows = sqlite.prepare(`SELECT key, value, ts FROM "${table}"`).all();
          return rows.map((row: any) => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] SQLite adapter failed, falling back:', e.message);
    }
  }

  // ── File / memory fallback with Sequential Queue to prevent races ──────────
  const DATA_DIR = path.join(process.cwd(), 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const filePath = (table: string) => path.join(DATA_DIR, `${table}.json`);
  
  const fileQueues = new Map<string, Promise<any>>();
  const runSequentially = <T>(table: string, task: () => Promise<T> | T): Promise<T> => {
    const previous = fileQueues.get(table) || Promise.resolve();
    const next = previous.then(task, task); // keep execution moving even if tasks crash
    fileQueues.set(table, next);
    return next;
  };

  function readFile(table: string): Record<string, any> {
    const fp = filePath(table);
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
    catch { return {}; }
  }

  return {
    name: 'file',
    async ensureTable(_table) {},
    async get(table, key) {
      return runSequentially(table, () => readFile(table)[key] ?? null);
    },
    async set(table, key, value) {
      return runSequentially(table, () => {
        const data = readFile(table);
        data[key]  = value;
        fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
      });
    },
    async del(table, key) {
      return runSequentially(table, () => {
        const data = readFile(table);
        delete data[key];
        fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
      });
    },
    async getAll(table) {
      return runSequentially(table, () => readFile(table));
    },
    async getAllWithMeta(table) {
      return runSequentially(table, () => {
        const data = readFile(table);
        return Object.entries(data).map(([key, value]) => ({ key, value, ts: 0 }));
      });
    }
  };
}

// ── Per-key mutex to prevent lost updates on concurrent read→modify→write ────
// get() and set() are independent round trips to the adapter — even the file
// adapter's per-table queue only serializes individual calls, not a get+set
// PAIR as one unit. Two concurrent callers can both read the same key before
// either has written back, and whichever set() lands last silently overwrites
// the other's change (e.g. a debit getting reverted by an unrelated identity
// sync that read the wallet a moment earlier). mutate() — and patch(), which
// is now built on it — hold a lock for the full read-modify-write cycle so
// concurrent callers on the same key are serialized instead of racing.
const keyLocks = new Map<string, Promise<any>>();

function withKeyLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(lockKey) || Promise.resolve();
  const next = previous.then(task, task); // keep the chain moving even if a task throws
  keyLocks.set(lockKey, next);
  return next;
}

// ── Core store factory ────────────────────────────────────────────────────────
function makeStore(namespace: string, tableName: string | undefined, isRoot: boolean): PluginStore {
  const physical = physicalName(namespace, tableName);
  const tag      = `[pluginStore:${physical}]`;

  async function adapter(): Promise<Adapter> {
    return getAdapter();
  }

  const store: PluginStore = {
    async get(key) {
      try {
        const a = await adapter();
        return await a.get(physical, key);
      } catch (err: any) {
        console.error(`${tag} get("${key}"):`, err.message);
        return null;
      }
    },

    async set(key, value) {
      try {
        const a = await adapter();
        await a.set(physical, key, value);
      } catch (err: any) {
        console.error(`${tag} set("${key}"):`, err.message);
      }
    },

    async del(key) {
      try {
        const a = await adapter();
        await a.del(physical, key);
      } catch (err: any) {
        console.error(`${tag} del("${key}"):`, err.message);
      }
    },

    async getAll() {
      try {
        const a = await adapter();
        return await a.getAll(physical);
      } catch (err: any) {
        console.error(`${tag} getAll():`, err.message);
        return {};
      }
    },

    async has(key) {
      return (await this.get(key)) !== null;
    },

    async getOrDefault(key, defaultValue) {
      const value = await this.get(key);
      return value !== null ? value : defaultValue;
    },

    async patch(key, patch) {
      const lockKey = `${physical}::${key}`;
      await withKeyLock(lockKey, async () => {
        const existing = (await this.get(key)) || {};
        await this.set(key, { ...existing, ...patch });
      });
    },

    async mutate(key, updater) {
      // Same lock as patch() (keyed by physical table + key), so a patch()
      // call and a mutate() call on the same record can never interleave.
      const lockKey = `${physical}::${key}`;
      return withKeyLock(lockKey, async () => {
        const current = await this.get(key);
        const updated = await updater(current);
        await this.set(key, updated);
        return updated;
      });
    },

    get namespace()     { return namespace; },
    get tableName()     { return tableName ?? null; },
    get physicalTable() { return physical; },
  };

  if (isRoot) {
    store.table = (name: string): PluginStore => {
      if (!name || typeof name !== 'string' || /[^a-z0-9_]/i.test(name)) {
        throw new Error(`${tag} table name must be a non-empty alphanumeric string (got: "${name}")`);
      }
      return makeStore(namespace, name, false);
    };
  }

  return store;
}

export function createStore(namespace: string): PluginStore {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('[pluginStore] namespace must be a non-empty string');
  }
  if (/[^a-z0-9_]/i.test(namespace)) {
    throw new Error(`[pluginStore] namespace "${namespace}" must contain only letters, digits, or underscores`);
  }
  return makeStore(namespace, undefined, true);
}