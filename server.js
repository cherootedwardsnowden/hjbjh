const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'strangertext_secret_2024';
const ADMIN_IP = process.env.ADMIN_IP || '176.42.131.129';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch(e) { console.error('writeJSON error:', e.message); }
}

let users         = readJSON(USERS_FILE, {});
let counters      = readJSON(COUNTERS_FILE, { userNumber: 0, totalMessages: 0 });
let reports       = readJSON(REPORTS_FILE, []);
let announcements = readJSON(ANNOUNCEMENTS_FILE, []);

const saveUsers         = () => writeJSON(USERS_FILE, users);
const saveCounters      = () => writeJSON(COUNTERS_FILE, counters);
const saveReports       = () => writeJSON(REPORTS_FILE, reports);
const saveAnnouncements = () => writeJSON(ANNOUNCEMENTS_FILE, announcements);

const userByUsername = (u) => Object.values(users).find(x => x.username.toLowerCase() === u.toLowerCase());
const userByEmail    = (e) => Object.values(users).find(x => x.email.toLowerCase() === e.toLowerCase());
const userById       = (id) => users[id];

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm'];
    cb(null, ok.includes(file.mimetype));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const BADGE_DEFS = [
  { id:'msg10',    name:'Rookie',       icon:'💬', color:'#8E8E93', threshold:10,    stat:'messageCount',   description:'İlk 10 mesajını gönder' },
  { id:'msg50',    name:'Chatter',      icon:'🗣️', color:'#34C759', threshold:50,    stat:'messageCount',   description:'50 mesaj gönder' },
  { id:'msg100',   name:'Talkative',    icon:'🔥', color:'#FF9500', threshold:100,   stat:'messageCount',   description:'100 mesaj gönder' },
  { id:'msg250',   name:'Social',       icon:'🌟', color:'#5AC8FA', threshold:250,   stat:'messageCount',   description:'250 mesaj gönder' },
  { id:'msg500',   name:'Veteran',      icon:'⭐', color:'#007AFF', threshold:500,   stat:'messageCount',   description:'500 mesaj gönder' },
  { id:'msg1000',  name:'Legend',       icon:'👑', color:'#FFD700', threshold:1000,  stat:'messageCount',   description:'1000 mesaj gönder' },
  { id:'msg5000',  name:'Immortal',     icon:'💎', color:'#AF52DE', threshold:5000,  stat:'messageCount',   description:'5000 mesaj gönder' },
  { id:'msg10000', name:'Godlike',      icon:'🚀', color:'#FF2D55', threshold:10000, stat:'messageCount',   description:'10000 mesaj gönder' },
  { id:'chats10',  name:'Connector',   icon:'🤝', color:'#30D158', threshold:10,    stat:'totalChats',     description:'10 sohbet tamamla' },
  { id:'chats50',  name:'Socialite',   icon:'🌐', color:'#64D2FF', threshold:50,    stat:'totalChats',     description:'50 sohbet tamamla' },
  { id:'chats100', name:'Ambassador',  icon:'🏛️', color:'#FFD60A', threshold:100,   stat:'totalChats',     description:'100 sohbet tamamla' },
  { id:'media10',  name:'Photographer',icon:'📸', color:'#FF6B6B', threshold:10,    stat:'totalMediaSent', description:'10 medya gönder' },
  { id:'media50',  name:'Director',    icon:'🎬', color:'#C77DFF', threshold:50,    stat:'totalMediaSent', description:'50 medya gönder' },
  { id:'early',    name:'Early Bird',  icon:'🐦', color:'#5AC8FA', threshold:null,  stat:null,             description:'İlk 100 kullanıcıdan biri' },
  { id:'verified', name:'Verified',    icon:'✅', color:'#30D158', threshold:null,  stat:null,             description:'Onaylı hesap' },
  { id:'og',       name:'OG',          icon:'🎖️', color:'#FFD700', threshold:null,  stat:null,             description:'Kurucu üye' },
];

function updateBadges(user) {
  const earned = [];
  for (const b of BADGE_DEFS) {
    if (!b.threshold || !b.stat) continue;
    if ((user[b.stat] || 0) >= b.threshold) {
      if (!user.badges.find(x => x.id === b.id)) {
        earned.push({ ...b, earnedAt: new Date().toISOString() });
      }
    }
  }
  if (earned.length) { user.badges.push(...earned); saveUsers(); }
  return earned;
}

function sanitize(u) {
  return {
    _id:u._id, username:u.username, email:u.email, avatar:u.avatar, bio:u.bio,
    badges:u.badges, messageCount:u.messageCount||0, totalChats:u.totalChats||0,
    totalMediaSent:u.totalMediaSent||0, isAdmin:u.isAdmin, isDeveloper:u.isDeveloper,
    isModerator:u.isModerator, isBanned:u.isBanned, banReason:u.banReason,
    isVerified:u.isVerified, status:u.status, statusEmoji:u.statusEmoji,
    statusText:u.statusText, accentColor:u.accentColor,
    notificationsEnabled:u.notificationsEnabled, soundEnabled:u.soundEnabled,
    userNumber:u.userNumber, pinnedBadge:u.pinnedBadge,
    profileViews:u.profileViews||0, createdAt:u.createdAt
  };
}

function authMiddleware(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Geçersiz token' }); }
}
function adminOnly(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace('::ffff:','');
  if (ip === ADMIN_IP || ip === '127.0.0.1' || ip === '::1') return next();
  res.status(403).json({ error: 'Forbidden' });
}
function adminAuthMiddleware(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const d = jwt.verify(t, JWT_SECRET);
    const u = userById(d.id);
    if (!u || (!u.isAdmin && !u.isModerator)) return res.status(403).json({ error: 'Forbidden' });
    req.user = d; req.adminUser = u; next();
  } catch { res.status(401).json({ error: 'Geçersiz token' }); }
}

// AUTH ROUTES
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Tüm alanları doldur' });
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Kullanıcı adı 3-24 karakter olmalı' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Sadece harf, rakam ve _ kullan' });
    if (password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
    if (userByUsername(username)) return res.status(409).json({ error: 'Kullanıcı adı alınmış' });
    if (userByEmail(email)) return res.status(409).json({ error: 'Email zaten kayıtlı' });
    counters.userNumber = (counters.userNumber || 0) + 1;
    saveCounters();
    const userNumber = counters.userNumber;
    const isFirst = userNumber === 1;
    const id = uuidv4();
    const initBadges = [];
    if (userNumber <= 100) initBadges.push({ ...BADGE_DEFS.find(b => b.id === 'early'), earnedAt: new Date().toISOString() });
    if (isFirst) initBadges.push({ ...BADGE_DEFS.find(b => b.id === 'og'), earnedAt: new Date().toISOString() });
    const user = {
      _id:id, username, email, password: await bcrypt.hash(password, 10),
      avatar:null, bio:'', status:'online', statusEmoji:'', statusText:'',
      badges:initBadges, messageCount:0, totalChats:0, totalMediaSent:0,
      isAdmin:isFirst, isDeveloper:isFirst, isModerator:false,
      isBanned:false, banReason:'', isVerified:false,
      accentColor:'#0a84ff', notificationsEnabled:true, soundEnabled:true,
      userNumber, pinnedBadge:null, profileViews:0,
      createdAt:new Date().toISOString(), lastActive:new Date().toISOString()
    };
    users[id] = user;
    saveUsers();
    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = userByUsername(username) || userByEmail(username);
    if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre yanlış' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Kullanıcı adı veya şifre yanlış' });
    if (user.isBanned) return res.status(403).json({ error: `Banlandın${user.banReason ? ': ' + user.banReason : ''}` });
    user.lastActive = new Date().toISOString();
    saveUsers();
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = userById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(sanitize(user));
});

app.put('/api/me', authMiddleware, (req, res) => {
  const user = userById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const { bio, username, status, statusEmoji, statusText, accentColor, notificationsEnabled, soundEnabled, pinnedBadge } = req.body;
  if (bio !== undefined) user.bio = String(bio).slice(0, 200);
  if (status && ['online','away','busy','invisible'].includes(status)) user.status = status;
  if (statusEmoji !== undefined) user.statusEmoji = String(statusEmoji).slice(0, 4);
  if (statusText !== undefined) user.statusText = String(statusText).slice(0, 60);
  if (accentColor !== undefined) user.accentColor = accentColor;
  if (notificationsEnabled !== undefined) user.notificationsEnabled = !!notificationsEnabled;
  if (soundEnabled !== undefined) user.soundEnabled = !!soundEnabled;
  if (pinnedBadge !== undefined) user.pinnedBadge = pinnedBadge;
  if (username && username !== user.username) {
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Kullanıcı adı 3-24 karakter olmalı' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Geçersiz kullanıcı adı' });
    if (userByUsername(username)) return res.status(409).json({ error: 'Kullanıcı adı alınmış' });
    user.username = username;
  }
  saveUsers();
  res.json(sanitize(user));
});

app.post('/api/me/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = userById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ error: 'Mevcut şifre yanlış' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Şifre çok kısa' });
    user.password = await bcrypt.hash(newPassword, 10);
    saveUsers();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yok' });
  const user = userById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (user.avatar) { try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(user.avatar))); } catch {} }
  user.avatar = '/uploads/' + req.file.filename;
  saveUsers();
  res.json({ avatar: user.avatar });
});

app.post('/api/upload', authMiddleware, upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yok' });
  res.json({
    url: '/uploads/' + req.file.filename,
    thumbUrl: '/uploads/' + req.file.filename,
    type: req.file.mimetype,
    name: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size
  });
});

app.get('/api/stats', (req, res) => {
  res.json({ totalUsers: Object.keys(users).length, totalMessages: counters.totalMessages || 0 });
});

app.get('/api/badges', (req, res) => res.json(BADGE_DEFS));

app.post('/api/report', authMiddleware, (req, res) => {
  const user = userById(req.user.id);
  const { reason, description, sessionId } = req.body;
  reports.push({ id:uuidv4(), reporterId:req.user.id, reporterUsername:user?.username||'?', reason, description, sessionId, status:'pending', createdAt:new Date().toISOString() });
  saveReports();
  res.json({ ok: true });
});

// ADMIN
app.get('/api/admin/users', adminAuthMiddleware, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  let list = Object.values(users);
  if (search) list = list.filter(u => u.username.toLowerCase().includes(search) || u.email.toLowerCase().includes(search));
  list.sort((a, b) => (a.userNumber||0) - (b.userNumber||0));
  const total = list.length;
  res.json({ users: list.slice((page-1)*limit, page*limit).map(sanitize), total, page, pages: Math.ceil(total/limit) });
});

app.post('/api/admin/ban', adminAuthMiddleware, (req, res) => {
  const { userId, ban, reason } = req.body;
  const user = userById(userId);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.isBanned = !!ban; user.banReason = reason || '';
  saveUsers(); res.json({ ok: true });
});

app.post('/api/admin/role', adminOnly, (req, res) => {
  const { userId, role, value } = req.body;
  if (!['isAdmin','isDeveloper','isModerator','isVerified'].includes(role)) return res.status(400).json({ error: 'Geçersiz rol' });
  const user = userById(userId);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user[role] = !!value; saveUsers(); res.json({ ok: true });
});

app.post('/api/admin/badge', adminAuthMiddleware, (req, res) => {
  const { userId, badge } = req.body;
  const user = userById(userId);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (!user.badges.find(b => b.id === badge.id)) { user.badges.push({ ...badge, earnedAt: new Date().toISOString() }); saveUsers(); }
  res.json(sanitize(user));
});

app.delete('/api/admin/badge', adminAuthMiddleware, (req, res) => {
  const { userId, badgeId } = req.body;
  const user = userById(userId);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.badges = user.badges.filter(b => b.id !== badgeId); saveUsers(); res.json({ ok: true });
});

app.delete('/api/admin/user/:id', adminOnly, (req, res) => {
  const user = userById(req.params.id);
  if (user?.avatar) { try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(user.avatar))); } catch {} }
  delete users[req.params.id]; saveUsers(); res.json({ ok: true });
});

app.post('/api/admin/announcement', adminOnly, (req, res) => {
  const { text, color } = req.body;
  if (!text) return res.status(400).json({ error: 'Metin gerekli' });
  const ann = { id:uuidv4(), text, color:color||'#0a84ff', createdAt:new Date().toISOString() };
  announcements.unshift(ann);
  if (announcements.length > 50) announcements = announcements.slice(0, 50);
  saveAnnouncements();
  io.emit('announcement', { text, color: ann.color });
  res.json({ ok: true });
});

app.get('/api/admin/stats', adminAuthMiddleware, (req, res) => {
  const all = Object.values(users);
  const today = new Date(); today.setHours(0,0,0,0);
  res.json({
    total: all.length, banned: all.filter(u => u.isBanned).length,
    verified: all.filter(u => u.isVerified).length,
    totalMessages: counters.totalMessages || 0,
    pendingReports: reports.filter(r => r.status === 'pending').length,
    newToday: all.filter(u => new Date(u.createdAt) >= today).length,
    online: [...onlineUsers.values()].filter(u => u.status !== 'invisible').length,
    inChat: Math.floor(activePairs.size / 2)
  });
});

app.get('/api/admin/reports', adminAuthMiddleware, (req, res) => {
  res.json(reports.filter(r => r.status === 'pending').slice(0, 50));
});

app.post('/api/admin/report/:id', adminAuthMiddleware, (req, res) => {
  const r = reports.find(x => x.id === req.params.id);
  if (r) { r.status = req.body.status; saveReports(); }
  res.json({ ok: true });
});

app.get('/api/admin/leaderboard', adminAuthMiddleware, (req, res) => {
  const top = Object.values(users).sort((a, b) => (b.messageCount||0) - (a.messageCount||0)).slice(0, 20);
  res.json(top.map(u => ({ username:u.username, avatar:u.avatar, messageCount:u.messageCount||0, badges:(u.badges||[]).length })));
});

app.post('/api/admin/message', adminAuthMiddleware, (req, res) => {
  const { userId, message } = req.body;
  for (const [, sock] of io.sockets.sockets) {
    if (sock.userData?.userId === userId) sock.emit('admin_message', { text: message });
  }
  res.json({ ok: true });
});

// SOCKET.IO
const onlineUsers = new Map();
const waitingPool = [];
const activePairs = new Map();

function broadcastOnlineCount() {
  const n = [...onlineUsers.values()].filter(u => u.status !== 'invisible').length;
  io.emit('online_count', n);
}

io.on('connection', (socket) => {
  const token = socket.handshake.auth.token;
  let userData = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = userById(decoded.id);
      if (user && !user.isBanned) {
        userData = { userId:user._id, username:user.username, avatar:user.avatar, badges:user.badges, isAdmin:user.isAdmin, isDeveloper:user.isDeveloper, isModerator:user.isModerator, isVerified:user.isVerified, status:user.status, statusEmoji:user.statusEmoji, statusText:user.statusText, pinnedBadge:user.pinnedBadge };
        socket.userData = userData;
        onlineUsers.set(socket.id, { userId:user._id, username:user.username, status:user.status });
        broadcastOnlineCount();
        user.lastActive = new Date().toISOString(); saveUsers();
        if (announcements.length > 0) socket.emit('announcement', { text:announcements[0].text, color:announcements[0].color });
      }
    } catch {}
  }

  socket.on('find_partner', () => {
    if (activePairs.has(socket.id)) return;
    const idx = waitingPool.findIndex(w => w.socketId !== socket.id);
    if (idx !== -1) {
      const partner = waitingPool.splice(idx, 1)[0];
      const pSocket = io.sockets.sockets.get(partner.socketId);
      if (!pSocket) { waitingPool.push({ socketId:socket.id, ...(userData||{}) }); socket.emit('waiting'); return; }
      const sessionId = uuidv4();
      activePairs.set(socket.id, { partnerId:partner.socketId, sessionId, mediaCount:{me:0,them:0}, uploadedFiles:[] });
      activePairs.set(partner.socketId, { partnerId:socket.id, sessionId, mediaCount:{me:0,them:0}, uploadedFiles:[] });
      const me = userData || {};
      const them = partner;
      socket.emit('matched', { partner:{ username:them.username||'Yabancı', avatar:them.avatar, badges:them.badges||[], isAdmin:them.isAdmin, isDeveloper:them.isDeveloper, isModerator:them.isModerator, isVerified:them.isVerified, status:them.status, statusEmoji:them.statusEmoji, statusText:them.statusText, pinnedBadge:them.pinnedBadge }, sessionId });
      pSocket.emit('matched', { partner:{ username:me.username||'Yabancı', avatar:me.avatar, badges:me.badges||[], isAdmin:me.isAdmin, isDeveloper:me.isDeveloper, isModerator:me.isModerator, isVerified:me.isVerified, status:me.status, statusEmoji:me.statusEmoji, statusText:me.statusText, pinnedBadge:me.pinnedBadge }, sessionId });
    } else {
      waitingPool.push({ socketId:socket.id, ...(userData||{}) });
      socket.emit('waiting');
    }
  });

  socket.on('message', (data) => {
    const pair = activePairs.get(socket.id); if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('message', { text:data.text, media:data.media, from:'stranger' });
    counters.totalMessages = (counters.totalMessages||0) + 1; saveCounters();
    if (userData?.userId) {
      const user = userById(userData.userId);
      if (user) { user.messageCount = (user.messageCount||0)+1; const nb = updateBadges(user); if (nb.length) socket.emit('badge_earned', nb); }
    }
  });

  socket.on('typing', (v) => {
    const pair = activePairs.get(socket.id); if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('typing', v);
  });

  socket.on('media_sent', (data) => {
    const pair = activePairs.get(socket.id); if (!pair) return;
    if (pair.mediaCount.me >= 10) { socket.emit('media_limit'); return; }
    pair.mediaCount.me++;
    const pp = activePairs.get(pair.partnerId); if (pp) pp.mediaCount.them++;
    if (data.filename) pair.uploadedFiles.push(data.filename);
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('message', { media:data, from:'stranger' });
    if (userData?.userId) {
      const user = userById(userData.userId);
      if (user) { user.totalMediaSent = (user.totalMediaSent||0)+1; const nb = updateBadges(user); if (nb.length) socket.emit('badge_earned', nb); }
    }
  });

  socket.on('reaction', (data) => {
    const pair = activePairs.get(socket.id); if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('reaction', data);
  });

  socket.on('skip', () => disconnectPair(socket));
  socket.on('disconnect', () => disconnectPair(socket));

  function disconnectPair(sock) {
    const wi = waitingPool.findIndex(w => w.socketId === sock.id);
    if (wi !== -1) waitingPool.splice(wi, 1);
    const pair = activePairs.get(sock.id);
    if (pair) {
      const allFiles = [...pair.uploadedFiles, ...(activePairs.get(pair.partnerId)?.uploadedFiles||[])];
      allFiles.forEach(fn => { try { fs.unlinkSync(path.join(UPLOADS_DIR, fn)); } catch {} });
      const pSocket = io.sockets.sockets.get(pair.partnerId);
      if (pSocket) { pSocket.emit('partner_disconnected'); activePairs.delete(pair.partnerId); }
      activePairs.delete(sock.id);
      if (userData?.userId) {
        const user = userById(userData.userId);
        if (user) { user.totalChats = (user.totalChats||0)+1; const nb = updateBadges(user); if (nb.length) sock.emit('badge_earned', nb); }
      }
    }
    onlineUsers.delete(sock.id);
    broadcastOnlineCount();
  }
});

server.listen(PORT, () => console.log(`StrangerText calisiyor → http://localhost:${PORT}`));
