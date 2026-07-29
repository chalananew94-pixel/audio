'use strict';
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 5000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads', { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static('public'));

const storage = multer.diskStorage({
  destination: 'public/uploads',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── DB init ───────────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      short_id VARCHAR(12) UNIQUE NOT NULL,
      title TEXT DEFAULT '',
      image TEXT DEFAULT '',
      dest_url TEXT NOT NULL,
      ad1_url TEXT NOT NULL,
      ad2_url TEXT NOT NULL,
      enabled BOOLEAN DEFAULT true,
      views INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      site_name TEXT DEFAULT 'LinkGen',
      logo TEXT DEFAULT '',
      favicon TEXT DEFAULT '',
      description TEXT DEFAULT 'Protected Link Generator',
      primary_color TEXT DEFAULT '#a855f7',
      bg_color TEXT DEFAULT '#050510',
      footer_text TEXT DEFAULT '© 2024 LinkGen. All rights reserved.',
      logo_size INTEGER DEFAULT 48,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    INSERT INTO site_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
}

function genShortId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from({ length: 8 }, (_, i) => chars[bytes[i] % chars.length]).join('');
}

const auth = (req, res, next) => req.session.admin ? next() : res.status(401).json({ error: 'Unauthorized' });

// ── Public ────────────────────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM site_settings WHERE id = 1');
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve go page for /go/:shortId
app.get('/go/:shortId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'go.html'));
});

app.get('/api/go/:shortId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, short_id, title, image, ad1_url, ad2_url, dest_url, enabled FROM links WHERE short_id = $1',
      [req.params.shortId.toUpperCase()]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
    if (!rows[0].enabled) return res.status(410).json({ error: 'This link has been disabled' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/go/:shortId/view', async (req, res) => {
  try {
    await pool.query('UPDATE links SET views = views + 1 WHERE short_id = $1', [req.params.shortId.toUpperCase()]);
    res.json({ ok: true });
  } catch (_) { res.json({ ok: false }); }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/auth/check', (req, res) => res.json({ authenticated: !!req.session.admin }));

app.post('/login', (req, res) => {
  const pass = process.env.ADMIN_PASS;
  if (!pass) return res.redirect('/login.html?error=config');
  if (req.body.password === pass) {
    req.session.admin = true;
    return res.redirect('/admin.html');
  }
  res.redirect('/login.html?error=1');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login.html')));

// ── Admin: Links ──────────────────────────────────────────────────────────────
app.get('/api/links', auth, async (req, res) => {
  try {
    const q = req.query.q;
    const { rows } = q
      ? await pool.query("SELECT * FROM links WHERE title ILIKE $1 OR short_id ILIKE $1 ORDER BY created_at DESC", [`%${q}%`])
      : await pool.query('SELECT * FROM links ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/links/stats', auth, async (req, res) => {
  try {
    const total  = await pool.query('SELECT COUNT(*) FROM links');
    const active = await pool.query('SELECT COUNT(*) FROM links WHERE enabled = true');
    const views  = await pool.query('SELECT COALESCE(SUM(views),0) AS total FROM links');
    res.json({
      total:  parseInt(total.rows[0].count),
      active: parseInt(active.rows[0].count),
      views:  parseInt(views.rows[0].total)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/links', auth, upload.single('image'), async (req, res) => {
  try {
    const { title, dest_url, ad1_url, ad2_url } = req.body;
    if (!dest_url || !ad1_url || !ad2_url) return res.status(400).json({ error: 'Missing required fields' });
    const image = req.file ? '/uploads/' + req.file.filename : '';
    let shortId, attempts = 0;
    do {
      shortId = genShortId();
      const { rows } = await pool.query('SELECT id FROM links WHERE short_id = $1', [shortId]);
      if (!rows.length) break;
    } while (++attempts < 10);
    const { rows } = await pool.query(
      'INSERT INTO links (short_id, title, image, dest_url, ad1_url, ad2_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [shortId, title || '', image, dest_url, ad1_url, ad2_url]
    );
    res.json({ success: true, link: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/links/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const { title, dest_url, ad1_url, ad2_url, old_image } = req.body;
    const image = req.file ? '/uploads/' + req.file.filename : (old_image || '');
    const { rows } = await pool.query(
      'UPDATE links SET title=$1, dest_url=$2, ad1_url=$3, ad2_url=$4, image=$5, updated_at=NOW() WHERE id=$6 RETURNING *',
      [title || '', dest_url, ad1_url, ad2_url, image, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, link: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/links/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT image FROM links WHERE id = $1', [req.params.id]);
    if (rows[0]?.image) try { fs.unlinkSync('public' + rows[0].image); } catch (_) {}
    await pool.query('DELETE FROM links WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/links/:id/toggle', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE links SET enabled = NOT enabled, updated_at=NOW() WHERE id=$1 RETURNING enabled',
      [req.params.id]
    );
    res.json({ success: true, enabled: rows[0].enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Settings ───────────────────────────────────────────────────────────
app.post('/api/settings', auth, upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'favicon', maxCount: 1 }]), async (req, res) => {
  try {
    const b = req.body;
    const logo    = b.remove_logo    === '1' ? '' : (req.files?.logo?.[0]    ? '/uploads/' + req.files.logo[0].filename    : (b.old_logo    || ''));
    const favicon = b.remove_favicon === '1' ? '' : (req.files?.favicon?.[0] ? '/uploads/' + req.files.favicon[0].filename : (b.old_favicon || ''));
    await pool.query(
      'UPDATE site_settings SET site_name=$1,description=$2,primary_color=$3,bg_color=$4,footer_text=$5,logo_size=$6,logo=$7,favicon=$8,updated_at=NOW() WHERE id=1',
      [b.site_name || 'LinkGen', b.description || '', b.primary_color || '#a855f7', b.bg_color || '#050510', b.footer_text || '', parseInt(b.logo_size) || 48, logo, favicon]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Home redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login.html'));

initDb().then(() => app.listen(PORT, () => console.log('LinkGen running on port ' + PORT)))
        .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
