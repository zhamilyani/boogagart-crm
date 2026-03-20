const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3009;
const COLLECTIONS = ['leads', 'contests', 'hosts', 'locations', 'equipment', 'inventory', 'scenarios', 'djs', 'users'];

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Initialize DB: create table + seed from JSON defaults
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (name)
    )
  `);
  // Seed empty collections from local JSON files
  for (const col of COLLECTIONS) {
    const { rows } = await pool.query('SELECT 1 FROM collections WHERE name=$1', [col]);
    if (rows.length === 0) {
      let defaultData = [];
      try {
        defaultData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', col + '.json'), 'utf-8'));
      } catch {}
      await pool.query('INSERT INTO collections (name, data) VALUES ($1, $2)', [col, JSON.stringify(defaultData)]);
      console.log(`Initialized collection: ${col} (${defaultData.length} items)`);
    }
  }
  console.log('Database ready');
}

// Read/Write via PostgreSQL
async function readJSON(name) {
  const { rows } = await pool.query('SELECT data FROM collections WHERE name=$1', [name]);
  return rows.length ? rows[0].data : [];
}

async function writeJSON(name, data) {
  await pool.query('UPDATE collections SET data=$2 WHERE name=$1', [name, JSON.stringify(data)]);
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

// CRUD helpers for any collection (now async)
async function handleCRUD(collection, req, res, idParam) {
  const items = await readJSON(collection);

  if (req.method === 'GET') {
    if (idParam) {
      const item = items.find(i => i.id === idParam);
      return item ? json(res, item) : json(res, { error: 'Not found' }, 404);
    }
    return json(res, items);
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);
    body.id = genId();
    body.createdAt = new Date().toISOString();
    items.push(body);
    await writeJSON(collection, items);
    return json(res, body, 201);
  }

  if (req.method === 'PUT' && idParam) {
    const body = await parseBody(req);
    const idx = items.findIndex(i => i.id === idParam);
    if (idx === -1) return json(res, { error: 'Not found' }, 404);
    items[idx] = { ...items[idx], ...body, id: idParam };
    await writeJSON(collection, items);
    return json(res, items[idx]);
  }

  if (req.method === 'DELETE' && idParam) {
    const idx = items.findIndex(i => i.id === idParam);
    if (idx === -1) return json(res, { error: 'Not found' }, 404);
    items.splice(idx, 1);
    await writeJSON(collection, items);
    return json(res, { ok: true });
  }

  json(res, { error: 'Method not allowed' }, 405);
}

const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // API routes: /api/{collection}/{id?}
    if (parts[0] === 'api' && COLLECTIONS.includes(parts[1])) {
      return await handleCRUD(parts[1], req, res, parts[2] || null);
    }

    // Check equipment availability for a date
    if (parts[0] === 'api' && parts[1] === 'availability' && req.method === 'POST') {
      const body = await parseBody(req);
      const { date, excludeLeadId } = body;
      if (!date) return json(res, { error: 'date required' }, 400);
      const leads = await readJSON('leads');
      const equipment = await readJSON('equipment');
      const inventory = await readJSON('inventory');
      const sameDateLeads = leads.filter(l =>
        l.eventDate === date && l.id !== excludeLeadId && l.status !== 'cancelled'
      );
      const bookedEq = {};
      const bookedInv = {};
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
    if (parts[0] === 'api' && parts[1] === 'proposal' && req.method === 'POST') {
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
