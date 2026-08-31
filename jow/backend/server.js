const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let db = null;

try {
  db = require('./database/db');
} catch (error) {
  console.warn('SQLite no disponible, arrancando solo con el frontend.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jow-local-dev-secret-change-me';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin || ''), String(salt || ''), 200000, 32, 'sha256').toString('hex');
}

function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function issueToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      uid: String(user.id),
      name: user.name || user.username || '',
      role: String(user.role || 'user').toLowerCase(),
      sessionVersion: 1,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getUserById(id) {
  if (!db || !id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function findUserByName(name) {
  if (!db) return null;
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM users WHERE nameLower = ? LIMIT 1').get(normalized);
}

function initAdmin() {
  if (!db) return;
  const account = db.prepare('SELECT * FROM admin_accounts WHERE username = ?').get('admin');
  if (!account) {
    db.prepare('INSERT INTO admin_accounts (username, password_hash, account_role) VALUES (?, ?, ?)')
      .run('admin', hashPassword('admin123'), 'admin');
    console.log('Default admin account created: username=admin, password=admin123');
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'ok', message: 'JowAdmin API is running' });
});

app.post('/api/login', (req, res) => {
  if (!db) return res.status(503).json({ error: 'La base local no está disponible' });

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
  }

  const account = db.prepare('SELECT * FROM admin_accounts WHERE username = ?').get(username);
  if (!account) return res.status(401).json({ error: 'Credenciales inválidas' });

  const hashedPassword = hashPassword(password);
  if (hashedPassword !== account.password_hash) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  const token = jwt.sign({ sub: String(account.id), kind: 'admin', username: account.username }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ ok: true, token, user: { id: account.id, username: account.username, role: account.account_role } });
});

app.post('/api/login-pin', (req, res) => {
  if (!db) return res.status(503).json({ error: 'La base local no está disponible' });

  const { name, pin } = req.body || {};
  const safePin = String(pin || '');
  const user = findUserByName(name);

  if (!name || !safePin || !/^[0-9]{4}$/.test(safePin)) {
    return res.status(400).json({ error: 'Nombre y PIN válidos son requeridos' });
  }

  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  const status = String(user.status || 'active').toLowerCase();
  if (status === 'inactive' || status === 'inactivo') {
    return res.status(403).json({ error: 'Cuenta inactiva' });
  }

  const pinHash = user.pinHash ? String(user.pinHash) : '';
  const pinSalt = user.pinSalt ? String(user.pinSalt) : '';
  const legacyPin = user.pin ? String(user.pin) : '';

  let ok = false;
  if (pinHash && pinSalt) {
    ok = safeEq(hashPin(safePin, pinSalt), pinHash);
  } else if (legacyPin) {
    ok = safeEq(legacyPin, safePin);
    if (ok) {
      const salt = makeSalt();
      const nextHash = hashPin(safePin, salt);
      db.prepare('UPDATE users SET pinHash = ?, pinSalt = ?, pin = NULL, nameLower = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(nextHash, salt, normalizeName(user.name || user.username || name), user.id);
    }
  }

  if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = issueToken(user);
  return res.json({
    ok: true,
    token,
    user: {
      uid: user.id,
      id: user.id,
      name: user.name || user.username || name,
      role: String(user.role || 'user').toLowerCase(),
      points: Number(user.points || 0),
      status: String(user.status || 'active'),
    },
  });
});

app.post('/api/session/validate', (req, res) => {
  const token = req.body?.token || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida' });

  const user = getUserById(payload.uid || payload.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  if (String(user.status || 'active').toLowerCase() === 'inactive' || String(user.status || 'active').toLowerCase() === 'inactivo') {
    return res.status(403).json({ error: 'Cuenta inactiva' });
  }

  return res.json({
    ok: true,
    user: {
      uid: user.id,
      id: user.id,
      name: user.name || user.username || '',
      role: String(user.role || 'user').toLowerCase(),
      points: Number(user.points || 0),
      status: String(user.status || 'active'),
    },
  });
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

initAdmin();

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
  if (db) {
    console.log('📌 Modo SQLite + token JWT activo');
    console.log('📌 Cuenta admin por defecto: admin / admin123\n');
  } else {
    console.log('📌 Modo frontend-only activo\n');
  }
});
