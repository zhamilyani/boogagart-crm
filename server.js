const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3009;
const COLLECTIONS = ['leads', 'contests', 'hosts', 'locations', 'equipment', 'inventory', 'scenarios', 'djs', 'users'];
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h
const ALLOWED_ORIGINS = [
  'https://boogagart-crm-production-92d9.up.railway.app',
  'http://localhost:3009',
  'http://127.0.0.1:3009',
];

// PostgreSQL connection with tuned pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.startsWith('postgresql://') ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

// === PASSWORD HASHING ===
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored.includes(':')) return password === stored; // legacy plaintext
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === test;
}

// === RATE LIMITING ===
const rateLimits = new Map();
function rateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { count: 1, start: now };
    rateLimits.set(ip, entry);
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}
// Cleanup old entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) {
    if (now - e.start > 120000) rateLimits.delete(ip);
  }
}, 300000);

// === INIT DB ===
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      user_name TEXT NOT NULL,
      linked_id TEXT DEFAULT '',
      created_at BIGINT NOT NULL
    )
  `);
  // Seed collections
  for (const col of COLLECTIONS) {
    const { rows } = await pool.query('SELECT 1 FROM collections WHERE name=$1', [col]);
    if (rows.length === 0) {
      let defaultData = [];
      try { defaultData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', col + '.json'), 'utf-8')); } catch {}
      // Hash passwords for users collection
      if (col === 'users') {
        defaultData = defaultData.map(u => ({ ...u, password: hashPassword(u.password) }));
      }
      await pool.query('INSERT INTO collections (name, data) VALUES ($1, $2)', [col, JSON.stringify(defaultData)]);
      console.log(`Seeded: ${col} (${defaultData.length})`);
    }
  }
  // Migrate plaintext passwords to hashed
  const { rows: userRows } = await pool.query("SELECT data FROM collections WHERE name='users'");
  if (userRows.length) {
    const users = userRows[0].data;
    let migrated = false;
    users.forEach(u => {
      if (u.password && !u.password.includes(':')) {
        u.password = hashPassword(u.password);
        migrated = true;
      }
    });
    if (migrated) {
      await pool.query("UPDATE collections SET data=$1 WHERE name='users'", [JSON.stringify(users)]);
      console.log('Migrated passwords to hashed');
    }
  }
  // Cleanup expired sessions
  await pool.query('DELETE FROM sessions WHERE created_at < $1', [Date.now() - SESSION_TTL]);
  console.log('Database ready');
}

// === READ/WRITE with transaction support ===
async function readJSON(name, client) {
  const q = client || pool;
  const { rows } = await q.query('SELECT data FROM collections WHERE name=$1', [name]);
  return rows.length ? rows[0].data : [];
}

async function writeJSON(name, data, client) {
  const q = client || pool;
  await q.query('UPDATE collections SET data=$2 WHERE name=$1', [name, JSON.stringify(data)]);
}

// Atomic read-modify-write with row lock
async function withTransaction(collection, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM collections WHERE name=$1 FOR UPDATE', [collection]);
    const items = await readJSON(collection, client);
    const result = await fn(items, client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': res._corsOrigin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(data));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// === AUTH MIDDLEWARE ===
async function authenticate(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token=$1', [token]);
  if (!rows.length) return null;
  const session = rows[0];
  if (Date.now() - session.created_at > SESSION_TTL) {
    await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
    return null;
  }
  return { id: session.user_id, role: session.role, name: session.user_name, linkedId: session.linked_id };
}

// Role check helper
const ROLE_LEVELS = { dj: 1, host: 1, admin: 2, ceo: 3 };
function requireRole(user, minRole) {
  return (ROLE_LEVELS[user.role] || 0) >= (ROLE_LEVELS[minRole] || 3);
}

// === CRUD with auth + transactions ===
async function handleCRUD(collection, req, res, idParam, user) {
  // Role-based access
  if (collection === 'users' && !requireRole(user, 'admin')) {
    return json(res, { error: 'Forbidden' }, 403);
  }

  if (req.method === 'GET') {
    const items = await readJSON(collection);
    if (collection === 'users') {
      // Never expose passwords
      const safe = items.map(u => ({ ...u, password: undefined }));
      if (idParam) {
        const item = safe.find(i => i.id === idParam);
        return item ? json(res, item) : json(res, { error: 'Not found' }, 404);
      }
      return json(res, safe);
    }
    if (idParam) {
      const item = items.find(i => i.id === idParam);
      return item ? json(res, item) : json(res, { error: 'Not found' }, 404);
    }
    return json(res, items);
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);
    if (collection === 'users' && body.password) {
      body.password = hashPassword(body.password);
    }
    return await withTransaction(collection, async (items, client) => {
      body.id = genId();
      body.createdAt = new Date().toISOString();
      items.push(body);
      await writeJSON(collection, items, client);
      const resp = { ...body };
      if (collection === 'users') delete resp.password;
      return json(res, resp, 201);
    });
  }

  if (req.method === 'PUT' && idParam) {
    const body = await parseBody(req);
    if (collection === 'users' && body.password) {
      body.password = hashPassword(body.password);
    }
    return await withTransaction(collection, async (items, client) => {
      const idx = items.findIndex(i => i.id === idParam);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      items[idx] = { ...items[idx], ...body, id: idParam };
      await writeJSON(collection, items, client);
      const resp = { ...items[idx] };
      if (collection === 'users') delete resp.password;
      return json(res, resp);
    });
  }

  if (req.method === 'DELETE' && idParam) {
    return await withTransaction(collection, async (items, client) => {
      const idx = items.findIndex(i => i.id === idParam);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      items.splice(idx, 1);
      await writeJSON(collection, items, client);
      return json(res, { ok: true });
    });
  }

  json(res, { error: 'Method not allowed' }, 405);
}

const server = http.createServer(async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    // CORS
    const origin = req.headers.origin;
    res._corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': res._corsOrigin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // Health check (no auth needed)
    if (parts[0] === 'health') {
      try {
        await pool.query('SELECT 1');
        return json(res, { status: 'ok', uptime: process.uptime() });
      } catch {
        return json(res, { status: 'db_error' }, 503);
      }
    }

    // Rate limiting for API
    if (parts[0] === 'api') {
      const limit = (parts[1] === 'login') ? 10 : 60; // stricter for login
      if (!rateLimit(ip, limit)) {
        return json(res, { error: 'Too many requests' }, 429);
      }
    }

    // Login (no auth needed)
    if (parts[0] === 'api' && parts[1] === 'login' && req.method === 'POST') {
      const { username, password } = await parseBody(req);
      if (!username || !password) return json(res, { error: 'Credentials required' }, 400);
      const users = await readJSON('users');
      const user = users.find(u => u.username === username);
      if (!user || !verifyPassword(password, user.password)) {
        return json(res, { error: 'Invalid credentials' }, 401);
      }
      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO sessions (token, user_id, role, user_name, linked_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [token, user.id, user.role, user.name, user.linkedId || '', Date.now()]
      );
      return json(res, { token, name: user.name, role: user.role, linkedId: user.linkedId || '' });
    }

    // Logout (auth needed)
    if (parts[0] === 'api' && parts[1] === 'logout' && req.method === 'POST') {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        await pool.query('DELETE FROM sessions WHERE token=$1', [auth.slice(7)]);
      }
      return json(res, { ok: true });
    }

    // All other API routes require auth
    if (parts[0] === 'api') {
      const user = await authenticate(req);
      if (!user) return json(res, { error: 'Unauthorized' }, 401);

      // CRUD: /api/{collection}/{id?}
      if (COLLECTIONS.includes(parts[1])) {
        return await handleCRUD(parts[1], req, res, parts[2] || null, user);
      }

      // Availability check
      if (parts[1] === 'availability' && req.method === 'POST') {
        const body = await parseBody(req);
        const { date, excludeLeadId } = body;
        if (!date) return json(res, { error: 'date required' }, 400);
        const leads = await readJSON('leads');
        const equipment = await readJSON('equipment');
        const inventory = await readJSON('inventory');
        const sameDateLeads = leads.filter(l =>
          l.eventDate === date && l.id !== excludeLeadId && l.status !== 'cancelled'
        );
        const bookedEq = {}, bookedInv = {};
        sameDateLeads.forEach(l => {
          (l.bookedEquipment || []).forEach(id => { bookedEq[id] = (bookedEq[id] || 0) + 1; });
          (l.bookedInventory || []).forEach(id => { bookedInv[id] = (bookedInv[id] || 0) + 1; });
        });
        const eqAvail = equipment.map(e => ({
          ...e, booked: bookedEq[e.id] || 0, available: (e.quantity || 1) - (bookedEq[e.id] || 0),
        }));
        const invAvail = inventory.map(i => ({
          ...i, booked: bookedInv[i.id] || 0, available: (i.quantity || 1) - (bookedInv[i.id] || 0),
        }));
        return json(res, {
          equipment: eqAvail, inventory: invAvail,
          sameDateLeads: sameDateLeads.map(l => ({ id: l.id, name: l.name, eventType: l.eventType })),
        });
      }

      // Proposal generator
      if (parts[1] === 'proposal' && req.method === 'POST') {
        const body = await parseBody(req);
        const contests = await readJSON('contests');
        const hosts = await readJSON('hosts');
        const locations = await readJSON('locations');
        const guests = parseInt(body.guests) || 10;
        const venue = body.venue || 'both';
        const budget = parseInt(body.budget) || 999999;
        const duration = parseInt(body.duration) || 120;
        const suitable = contests.filter(c => {
          if (guests < (c.minParticipants || 0)) return false;
          if (guests > (c.maxParticipants || 999)) return false;
          if (venue !== 'both' && c.venue !== 'both' && c.venue !== venue) return false;
          return true;
        });
        suitable.sort((a, b) => (a.cost || 0) - (b.cost || 0));
        let totalDuration = 0, totalCost = 0;
        const selected = [];
        for (const c of suitable) {
          const cd = c.duration || 15;
          if (totalDuration + cd <= duration && totalCost + (c.cost || 0) <= budget) {
            selected.push(c);
            totalDuration += cd;
            totalCost += c.cost || 0;
          }
        }
        const suitableHosts = hosts.filter(h => h.rate && h.rate <= budget * 0.3);
        const suitableLocations = locations.filter(l => {
          if (venue !== 'both' && l.type !== 'both' && l.type !== venue) return false;
          if (l.capacity && l.capacity < guests) return false;
          return true;
        });
        return json(res, {
          contests: selected, hosts: suitableHosts, locations: suitableLocations,
          totalDuration, totalCost,
          totalProps: [...new Set(selected.flatMap(c => c.props || []))],
        });
      }

      return json(res, { error: 'Not found' }, 404);
    }

    // Static files
    let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    serveStatic(res, filePath);
  } catch (err) {
    console.error('Request error:', err);
    json(res, { error: 'Internal server error' }, 500);
  }
});

// Start server after DB init
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`CRM running at http://0.0.0.0:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

// Graceful shutdown with drain
process.on('SIGTERM', () => {
  console.log('SIGTERM received, draining...');
  server.close(async () => {
    await new Promise(r => setTimeout(r, 1000));
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000);
});
