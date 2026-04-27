const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'strangertext_dev_secret_change_me';
const ADMIN_IP = process.env.ADMIN_IP || '176.42.131.129';
const ENC_KEY = (process.env.ENC_KEY || 'strangertext_enc_key_32chars_000').slice(0, 32);

// ============================================================
// DIRS
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

// ============================================================
// ENCRYPTED JSON STORAGE
// ============================================================
function encrypt(obj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(raw) {
  const [ivHex, dataHex] = raw.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY), Buffer.from(ivHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

const USERS_FILE = path.join(DATA_DIR, 'users.dat');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.dat');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return decrypt(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, encrypt(users), 'utf8');
}

function nextUserNumber() {
  let n = 1;
  if (fs.existsSync(COUNTER_FILE)) {
    try { n = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8')) + 1; } catch {}
  }
  fs.writeFileSync(COUNTER_FILE, String(n), 'utf8');
  return n;
}

function findById(id) { return loadUsers().find(u => u._id === id) || null; }

function createUser(data) {
  const users = loadUsers();
  const user = {
    _id: uuidv4(),
    username: data.username,
    email: data.email,
    password: data.password,
    avatar: null,
    bio: '',
    badges: data.badges || [],
    messageCount: 0,
    isAdmin: !!data.isAdmin,
    isDeveloper: !!data.isDeveloper,
    isBanned: false,
    userNumber: data.userNumber,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function patchUser(id, patch) {
  const users = loadUsers();
  const i = users.findIndex(u => u._id === id);
  if (i === -1) return null;
  users[i] = { ...users[i], ...patch };
  saveUsers(users);
  return users[i];
}

// ============================================================
// MULTER
// ============================================================
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm'];
    cb(null, ok.includes(file.mimetype));
  }
});

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next))
    .catch(err => { console.error(err.message); res.status(500).json({ error: err.message }); });
}

function adminOnly(req, res, next) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const ip = raw.replace('::ffff:', '');
  if (ip === ADMIN_IP || ip === '127.0.0.1' || ip === '::1') return next();
  res.status(403).json({ error: 'Forbidden' });
}

function auth(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ============================================================
// BADGES
// ============================================================
const BADGE_DEFS = [
  { id: 'msg10',    name: 'Rookie',     icon: '💬', color: '#8E8E93', threshold: 10 },
  { id: 'msg50',    name: 'Chatter',    icon: '🗣️', color: '#34C759', threshold: 50 },
  { id: 'msg100',   name: 'Talkative',  icon: '🔥', color: '#FF9500', threshold: 100 },
  { id: 'msg500',   name: 'Veteran',    icon: '⭐',  color: '#007AFF', threshold: 500 },
  { id: 'msg1000',  name: 'Legend',     icon: '👑', color: '#FFD700', threshold: 1000 },
  { id: 'msg5000',  name: 'Immortal',   icon: '💎', color: '#AF52DE', threshold: 5000 },
  { id: 'msg10000', name: 'Godlike',    icon: '🚀', color: '#FF2D55', threshold: 10000 },
  { id: 'early',    name: 'Early Bird', icon: '🐦', color: '#5AC8FA', threshold: null },
];

function checkBadges(user) {
  const earned = [];
  for (const b of BADGE_DEFS) {
    if (b.threshold && user.messageCount >= b.threshold && !user.badges.find(x => x.id === b.id)) {
      earned.push(b);
    }
  }
  if (earned.length) patchUser(user._id, { badges: [...user.badges, ...earned] });
  return earned;
}

function sanitize(u) {
  return {
    _id: u._id, username: u.username, email: u.email,
    avatar: u.avatar, bio: u.bio, badges: u.badges,
    messageCount: u.messageCount, isAdmin: u.isAdmin,
    isDeveloper: u.isDeveloper, isBanned: u.isBanned,
    userNumber: u.userNumber, createdAt: u.createdAt
  };
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/register', wrap(async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const users = loadUsers();
  if (users.find(u => u.username === username || u.email === email)) {
    return res.status(409).json({ error: 'Username or email already taken' });
  }
  const hashed = await bcrypt.hash(password, 10);
  const userNumber = nextUserNumber();
  const isFirst = userNumber === 1;
  const earlyBird = BADGE_DEFS.find(b => b.id === 'early');
  const user = createUser({
    username, email,
    password: hashed,
    userNumber,
    isAdmin: isFirst,
    isDeveloper: isFirst,
    badges: userNumber <= 100 ? [earlyBird] : []
  });
  const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitize(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.username === username || u.email === username);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.isBanned) return res.status(403).json({ error: 'You are banned' });
  const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitize(user) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const user = findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(sanitize(user));
}));

app.put('/api/me', auth, wrap(async (req, res) => {
  const user = findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (req.body.bio !== undefined) patch.bio = String(req.body.bio).slice(0, 200);
  if (req.body.username && req.body.username !== user.username) {
    const users = loadUsers();
    if (users.find(u => u.username === req.body.username && u._id !== user._id)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    patch.username = req.body.username;
  }
  const updated = patchUser(user._id, patch);
  res.json(sanitize(updated));
}));

app.post('/api/avatar', auth, upload.single('avatar'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const user = findById(req.user.id);
  if (user?.avatar) {
    const old = path.join(UPLOADS_DIR, path.basename(user.avatar));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const avatarPath = '/uploads/' + req.file.filename;
  patchUser(req.user.id, { avatar: avatarPath });
  res.json({ avatar: avatarPath });
}));

app.post('/api/upload', auth, upload.single('media'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    type: req.file.mimetype,
    name: req.file.originalname,
    filename: req.file.filename
  });
}));

// ============================================================
// ADMIN ROUTES
// ============================================================
app.get('/api/admin/users', adminOnly, wrap(async (req, res) => {
  res.json(loadUsers().sort((a, b) => a.userNumber - b.userNumber).map(sanitize));
}));

app.post('/api/admin/ban', adminOnly, wrap(async (req, res) => {
  patchUser(req.body.userId, { isBanned: !!req.body.ban });
  res.json({ ok: true });
}));

app.post('/api/admin/badge', adminOnly, wrap(async (req, res) => {
  const user = findById(req.body.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.badges.find(b => b.id === req.body.badge.id)) {
    patchUser(user._id, { badges: [...user.badges, req.body.badge] });
  }
  res.json(sanitize(findById(user._id)));
}));

app.delete('/api/admin/user/:id', adminOnly, wrap(async (req, res) => {
  saveUsers(loadUsers().filter(u => u._id !== req.params.id));
  res.json({ ok: true });
}));

app.get('/api/admin/stats', adminOnly, wrap(async (req, res) => {
  const users = loadUsers();
  res.json({ total: users.length, banned: users.filter(u => u.isBanned).length, online: waitingPool.length + activePairs.size });
}));

// ============================================================
// SOCKET.IO
// ============================================================
const waitingPool = [];
const activePairs = new Map();

io.on('connection', (socket) => {
  const token = socket.handshake.auth.token;
  let me = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = findById(decoded.id);
      if (user && !user.isBanned) {
        me = { userId: user._id, username: user.username, avatar: user.avatar, badges: user.badges, isAdmin: user.isAdmin, isDeveloper: user.isDeveloper };
      }
    } catch {}
  }

  socket.on('find_partner', () => {
    if (activePairs.has(socket.id)) return;
    const si = waitingPool.findIndex(w => w.socketId === socket.id);
    if (si !== -1) waitingPool.splice(si, 1);

    const idx = waitingPool.findIndex(w => w.socketId !== socket.id);
    if (idx !== -1) {
      const partner = waitingPool.splice(idx, 1)[0];
      const pSock = io.sockets.sockets.get(partner.socketId);
      if (!pSock) { waitingPool.push({ socketId: socket.id, ...me }); socket.emit('waiting'); return; }
      activePairs.set(socket.id, { partnerId: partner.socketId, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      activePairs.set(partner.socketId, { partnerId: socket.id, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      socket.emit('matched', { partner: partnerInfo(partner) });
      pSock.emit('matched', { partner: partnerInfo(me) });
    } else {
      waitingPool.push({ socketId: socket.id, ...me });
      socket.emit('waiting');
    }
  });

  function partnerInfo(u) {
    return { username: u?.username || 'Stranger', avatar: u?.avatar || null, badges: u?.badges || [], isAdmin: !!u?.isAdmin, isDeveloper: !!u?.isDeveloper };
  }

  socket.on('message', (data) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const pSock = io.sockets.sockets.get(pair.partnerId);
    if (pSock) pSock.emit('message', { text: data.text, media: data.media, from: 'stranger' });
    if (me?.userId) {
      const user = findById(me.userId);
      if (user) {
        const newCount = (user.messageCount || 0) + 1;
        patchUser(user._id, { messageCount: newCount });
        user.messageCount = newCount;
        const earned = checkBadges(user);
        if (earned.length) socket.emit('badge_earned', earned);
      }
    }
  });

  socket.on('typing', (v) => {
    const pair = activePairs.get(socket.id);
    const pSock = pair && io.sockets.sockets.get(pair.partnerId);
    if (pSock) pSock.emit('typing', v);
  });

  socket.on('media_sent', (data) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    if (pair.mediaCount.me >= 10) { socket.emit('media_limit'); return; }
    const pPair = activePairs.get(pair.partnerId);
    if (pPair && pPair.mediaCount.them >= 10) { socket.emit('media_limit'); return; }
    pair.mediaCount.me++;
    if (pPair) pPair.mediaCount.them++;
    if (data.filename) pair.uploadedFiles.push(data.filename);
    const pSock = io.sockets.sockets.get(pair.partnerId);
    if (pSock) pSock.emit('message', { media: data, from: 'stranger' });
  });

  socket.on('skip', () => cleanup(socket));
  socket.on('disconnect', () => cleanup(socket));

  function cleanup(sock) {
    const wi = waitingPool.findIndex(w => w.socketId === sock.id);
    if (wi !== -1) waitingPool.splice(wi, 1);
    const pair = activePairs.get(sock.id);
    if (!pair) return;
    const del = (files) => files.forEach(fn => {
      const fp = path.join(UPLOADS_DIR, fn);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    });
    del(pair.uploadedFiles || []);
    const pPair = activePairs.get(pair.partnerId);
    if (pPair) del(pPair.uploadedFiles || []);
    const pSock = io.sockets.sockets.get(pair.partnerId);
    if (pSock) { pSock.emit('partner_disconnected'); activePairs.delete(pair.partnerId); }
    activePairs.delete(sock.id);
  }
});

// ============================================================
// START
// ============================================================
server.listen(PORT, () => console.log(`✅ StrangerText running on port ${PORT}`));
