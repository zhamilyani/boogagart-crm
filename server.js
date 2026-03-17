const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3009;
const DATA_DIR = path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readJSON(name) {
  const file = path.join(DATA_DIR, name + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

function writeJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2), 'utf-8');
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

// CRUD helpers for any collection
function handleCRUD(collection, req, res, idParam) {
  const items = readJSON(collection);

  if (req.method === 'GET') {
    if (idParam) {
      const item = items.find(i => i.id === idParam);
      return item ? json(res, item) : json(res, { error: 'Not found' }, 404);
    }
    return json(res, items);
  }

  if (req.method === 'POST') {
    return parseBody(req).then(body => {
      body.id = genId();
      body.createdAt = new Date().toISOString();
      items.push(body);
      writeJSON(collection, items);
      json(res, body, 201);
    });
  }

  if (req.method === 'PUT' && idParam) {
    return parseBody(req).then(body => {
      const idx = items.findIndex(i => i.id === idParam);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      items[idx] = { ...items[idx], ...body, id: idParam };
      writeJSON(collection, items);
      json(res, items[idx]);
    });
  }

  if (req.method === 'DELETE' && idParam) {
    const idx = items.findIndex(i => i.id === idParam);
    if (idx === -1) return json(res, { error: 'Not found' }, 404);
    items.splice(idx, 1);
    writeJSON(collection, items);
    return json(res, { ok: true });
  }

  json(res, { error: 'Method not allowed' }, 405);
}

const server = http.createServer(async (req, res) => {
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
  if (parts[0] === 'api' && ['leads', 'contests', 'hosts', 'locations', 'equipment', 'inventory', 'scenarios', 'djs'].includes(parts[1])) {
    return handleCRUD(parts[1], req, res, parts[2] || null);
  }

  // Check equipment availability for a date
  if (parts[0] === 'api' && parts[1] === 'availability' && req.method === 'POST') {
    const body = await parseBody(req);
    const { date, excludeLeadId } = body;
    if (!date) return json(res, { error: 'date required' }, 400);
    const leads = readJSON('leads');
    const equipment = readJSON('equipment');
    const inventory = readJSON('inventory');
    // Find all leads on the same date (exclude current lead)
    const sameDateLeads = leads.filter(l =>
      l.eventDate === date && l.id !== excludeLeadId &&
      l.status !== 'cancelled'
    );
    // Count booked equipment
    const bookedEq = {};
    const bookedInv = {};
    sameDateLeads.forEach(l => {
      (l.bookedEquipment || []).forEach(id => { bookedEq[id] = (bookedEq[id] || 0) + 1; });
      (l.bookedInventory || []).forEach(id => { bookedInv[id] = (bookedInv[id] || 0) + 1; });
    });
    // Build availability
    const eqAvail = equipment.map(e => ({
      ...e,
      booked: bookedEq[e.id] || 0,
      available: (e.quantity || 1) - (bookedEq[e.id] || 0),
    }));
    const invAvail = inventory.map(i => ({
      ...i,
      booked: bookedInv[i.id] || 0,
      available: (i.quantity || 1) - (bookedInv[i.id] || 0),
    }));
    return json(res, { equipment: eqAvail, inventory: invAvail, sameDateLeads: sameDateLeads.map(l => ({ id: l.id, name: l.name, eventType: l.eventType })) });
  }

  // Proposal generator
  if (parts[0] === 'api' && parts[1] === 'proposal' && req.method === 'POST') {
    const body = await parseBody(req);
    const contests = readJSON('contests');
    const hosts = readJSON('hosts');
    const locations = readJSON('locations');

    const guests = parseInt(body.guests) || 10;
    const venue = body.venue || 'both'; // indoor/outdoor/both
    const budget = parseInt(body.budget) || 999999;
    const duration = parseInt(body.duration) || 120; // minutes

    // Filter contests by params
    const suitable = contests.filter(c => {
      if (guests < (c.minParticipants || 0)) return false;
      if (guests > (c.maxParticipants || 999)) return false;
      if (venue !== 'both' && c.venue !== 'both' && c.venue !== venue) return false;
      return true;
    });

    // Sort by cost, pick to fill duration
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

    // Pick suitable hosts
    const suitableHosts = hosts.filter(h => {
      if (!h.rate || h.rate > budget * 0.3) return false;
      return true;
    });

    // Pick suitable locations
    const suitableLocations = locations.filter(l => {
      if (venue !== 'both' && l.type !== 'both' && l.type !== venue) return false;
      if (l.capacity && l.capacity < guests) return false;
      return true;
    });

    return json(res, {
      contests: selected,
      hosts: suitableHosts,
      locations: suitableLocations,
      totalDuration,
      totalCost,
      totalProps: [...new Set(selected.flatMap(c => c.props || []))],
    });
  }

  // Static files
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  serveStatic(res, filePath);
});

server.listen(PORT, () => console.log(`CRM running at http://localhost:${PORT}`));
