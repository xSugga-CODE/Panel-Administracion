const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './jowadmin.db';
const db = new Database(path.resolve(dbPath));

// Enable foreign keys
db.pragma('foreign_keys = ON');

const ensureColumn = (tableName, columnName, definitionSql) => {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = cols.some(col => col.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql};`);
  }
};

const createTables = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE,
      username TEXT,
      name TEXT,
      nameLower TEXT,
      discriminator TEXT,
      avatar TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      points REAL NOT NULL DEFAULT 7,
      points_last_updated TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      pin TEXT,
      pinHash TEXT,
      pinSalt TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn('users', 'name', 'TEXT');
  ensureColumn('users', 'nameLower', 'TEXT');
  ensureColumn('users', 'pinHash', 'TEXT');
  ensureColumn('users', 'pinSalt', 'TEXT');
  ensureColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn('users', 'points', 'REAL NOT NULL DEFAULT 7');
  ensureColumn('users', 'pin', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cargos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cargo TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users(id),
      UNIQUE(user_id, cargo)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS point_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      change_value REAL NOT NULL,
      reason TEXT NOT NULL,
      changed_by INTEGER,
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS appeals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Abierta',
      deadline TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by INTEGER,
      resolution TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by) REFERENCES users(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS novelties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      account_role TEXT NOT NULL DEFAULT 'limited',
      discord_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (discord_id) REFERENCES users(discord_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
  `);
  insertConfig.run('points_decay_rate', '0.5');
  insertConfig.run('points_decay_interval_hours', '24');
  insertConfig.run('max_points', '7');
  insertConfig.run('min_points', '0');

  const rows = db.prepare('SELECT id, name, nameLower FROM users WHERE nameLower IS NULL OR nameLower = ?').all('');
  for (const row of rows) {
    const name = row.name || row.username || '';
    const normalized = String(name || '').trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '');
    if (normalized) {
      db.prepare('UPDATE users SET nameLower = ? WHERE id = ?').run(normalized, row.id);
    }
  }
};

createTables();

module.exports = db;
