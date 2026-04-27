const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
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
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://abdullahscofield34_db_user:kN6PES7uK!TJgzH@cluster0.rbmtxqt.mongodb.net/?appName=Cluster0';
const JWT_SECRET = process.env.JWT_SECRET || 'strangertext_secret_2024';
const ADMIN_IP = process.env.ADMIN_IP || '176.42.131.129';

mongoose.connect(MONGO_URI).catch(console.error);

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  password: String,
  avatar: { type: String, default: null },
  bio: { type: String, default: '' },
  status: { type: String, default: 'online', enum: ['online', 'away', 'busy', 'invisible'] },
  statusEmoji: { type: String, default: '' },
  statusText: { type: String, default: '' },
  badges: [{ id: String, name: String, icon: String, color: String, description: String, earnedAt: Date }],
  messageCount: { type: Number, default: 0 },
  totalChats: { type: Number, default: 0 },
  totalMediaSent: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  currentStreak: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  isAdmin: { type: Boolean, default: false },
  isDeveloper: { type: Boolean, default: false },
  isModerator: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  banReason: { type: String, default: '' },
  isVerified: { type: Boolean, default: false },
  theme: { type: String, default: 'dark' },
  accentColor: { type: String, default: '#0a84ff' },
  notificationsEnabled: { type: Boolean, default: true },
  soundEnabled: { type: Boolean, default: true },
  userNumber: Number,
  pinnedBadge: { type: String, default: null },
  profileViews: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Message log schema (for admin)
const messageLogSchema = new mongoose.Schema({
  from: String,
  text: String,
  hasMedia: Boolean,
  sessionId: String,
  createdAt: { type: Date, default: Date.now, expires: 86400 } // auto-delete after 24h
});
const MessageLog = mongoose.model('MessageLog', messageLogSchema);

// Report schema
const reportSchema = new mongoose.Schema({
  reporterId: String,
  reporterUsername: String,
  reason: String,
  description: String,
  sessionId: String,
  status: { type: String, default: 'pending', enum: ['pending', 'reviewed', 'dismissed'] },
  createdAt: { type: Date, default: Date.now }
});
const Report = mongoose.model('Report', reportSchema);

// Announcement schema
const announcementSchema = new mongoose.Schema({
  text: String,
  color: { type: String, default: '#0a84ff' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Announcement = mongoose.model('Announcement', announcementSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

async function getNextUserNumber() {
  const c = await Counter.findByIdAndUpdate(
    'userNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return c.seq;
}

// Total messages counter
async function getTotalMessages() {
  const c = await Counter.findById('totalMessages');
  return c ? c.seq : 0;
}
async function incTotalMessages() {
  await Counter.findByIdAndUpdate('totalMessages', { $inc: { seq: 1 } }, { upsert: true });
}

// Uploads dir
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer with sharp for image optimization
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const sessionMiddleware = session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI })
});
app.use(sessionMiddleware);

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Admin middleware (IP-based)
function adminOnly(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  const cleanIp = ip.replace('::ffff:', '');
  if (cleanIp === ADMIN_IP || cleanIp === '127.0.0.1' || cleanIp === '::1') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Admin OR auth middleware (for some routes)
async function adminAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || (!user.isAdmin && !user.isModerator)) return res.status(403).json({ error: 'Forbidden' });
    req.user = decoded;
    req.adminUser = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// --- BADGE DEFINITIONS ---
const BADGE_DEFS = [
  { id: 'msg10',    name: 'Rookie',      icon: '💬', color: '#8E8E93', threshold: 10,    stat: 'messageCount', description: 'Send your first 10 messages' },
  { id: 'msg50',    name: 'Chatter',     icon: '🗣️', color: '#34C759', threshold: 50,    stat: 'messageCount', description: 'Send 50 messages' },
  { id: 'msg100',   name: 'Talkative',   icon: '🔥', color: '#FF9500', threshold: 100,   stat: 'messageCount', description: 'Send 100 messages' },
  { id: 'msg250',   name: 'Social',      icon: '🌟', color: '#5AC8FA', threshold: 250,   stat: 'messageCount', description: 'Send 250 messages' },
  { id: 'msg500',   name: 'Veteran',     icon: '⭐', color: '#007AFF', threshold: 500,   stat: 'messageCount', description: 'Send 500 messages' },
  { id: 'msg1000',  name: 'Legend',      icon: '👑', color: '#FFD700', threshold: 1000,  stat: 'messageCount', description: 'Send 1000 messages' },
  { id: 'msg5000',  name: 'Immortal',    icon: '💎', color: '#AF52DE', threshold: 5000,  stat: 'messageCount', description: 'Send 5000 messages' },
  { id: 'msg10000', name: 'Godlike',     icon: '🚀', color: '#FF2D55', threshold: 10000, stat: 'messageCount', description: 'Send 10000 messages' },
  { id: 'chats10',  name: 'Connector',   icon: '🤝', color: '#30D158', threshold: 10,    stat: 'totalChats',   description: 'Complete 10 chats' },
  { id: 'chats50',  name: 'Socialite',   icon: '🌐', color: '#64D2FF', threshold: 50,    stat: 'totalChats',   description: 'Complete 50 chats' },
  { id: 'chats100', name: 'Ambassador',  icon: '🏛️', color: '#FFD60A', threshold: 100,   stat: 'totalChats',   description: 'Complete 100 chats' },
  { id: 'media10',  name: 'Photographer',icon: '📸', color: '#FF6B6B', threshold: 10,    stat: 'totalMediaSent', description: 'Send 10 media files' },
  { id: 'media50',  name: 'Director',    icon: '🎬', color: '#C77DFF', threshold: 50,    stat: 'totalMediaSent', description: 'Send 50 media files' },
  { id: 'early',    name: 'Early Bird',  icon: '🐦', color: '#5AC8FA', threshold: null,  stat: null,           description: 'One of the first 100 users' },
  { id: 'verified', name: 'Verified',    icon: '✅', color: '#30D158', threshold: null,  stat: null,           description: 'Verified account' },
  { id: 'og',       name: 'OG',          icon: '🎖️', color: '#FFD700', threshold: null,  stat: null,           description: 'Original founding member' },
];

async function updateBadges(user) {
  const earned = [];
  for (const b of BADGE_DEFS) {
    if (!b.threshold || !b.stat) continue;
    if (user[b.stat] >= b.threshold) {
      if (!user.badges.find(x => x.id === b.id)) {
        earned.push({ ...b, earnedAt: new Date() });
      }
    }
  }
  if (earned.length) {
    user.badges.push(...earned);
    await user.save();
  }
  return earned;
}

function sanitize(u) {
  return {
    _id: u._id, username: u.username, email: u.email,
    avatar: u.avatar, bio: u.bio, badges: u.badges,
    messageCount: u.messageCount, totalChats: u.totalChats,
    totalMediaSent: u.totalMediaSent, isAdmin: u.isAdmin,
    isDeveloper: u.isDeveloper, isModerator: u.isModerator,
    isBanned: u.isBanned, banReason: u.banReason,
    isVerified: u.isVerified, status: u.status,
    statusEmoji: u.statusEmoji, statusText: u.statusText,
    theme: u.theme, accentColor: u.accentColor,
    notificationsEnabled: u.notificationsEnabled, soundEnabled: u.soundEnabled,
    userNumber: u.userNumber, pinnedBadge: u.pinnedBadge,
    profileViews: u.profileViews, createdAt: u.createdAt,
    longestStreak: u.longestStreak
  };
}

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3-24 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(409).json({ error: 'Username or email taken' });
    const hashed = await bcrypt.hash(password, 10);
    const userNumber = await getNextUserNumber();
    const isFirst = userNumber === 1;
    const earlyBadges = userNumber <= 100 ? [{ ...BADGE_DEFS.find(b => b.id === 'early'), earnedAt: new Date() }] : [];
    if (isFirst) earlyBadges.push({ ...BADGE_DEFS.find(b => b.id === 'og'), earnedAt: new Date() });
    const user = await User.create({
      username, email, password: hashed, userNumber,
      isAdmin: isFirst, isDeveloper: isFirst,
      badges: earlyBadges
    });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ $or: [{ username }, { email: username }] });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ error: `Banned${user.banReason ? ': ' + user.banReason : ''}` });
    user.lastActive = new Date();
    await user.save();
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(sanitize(user));
});

app.put('/api/me', authMiddleware, async (req, res) => {
  const { bio, username, status, statusEmoji, statusText, theme, accentColor, notificationsEnabled, soundEnabled, pinnedBadge } = req.body;
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (bio !== undefined) user.bio = bio.slice(0, 200);
  if (status !== undefined && ['online', 'away', 'busy', 'invisible'].includes(status)) user.status = status;
  if (statusEmoji !== undefined) user.statusEmoji = statusEmoji.slice(0, 4);
  if (statusText !== undefined) user.statusText = statusText.slice(0, 60);
  if (theme !== undefined) user.theme = theme;
  if (accentColor !== undefined) user.accentColor = accentColor;
  if (notificationsEnabled !== undefined) user.notificationsEnabled = !!notificationsEnabled;
  if (soundEnabled !== undefined) user.soundEnabled = !!soundEnabled;
  if (pinnedBadge !== undefined) user.pinnedBadge = pinnedBadge;
  if (username && username !== user.username) {
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3-24 chars' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Invalid username format' });
    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username taken' });
    user.username = username;
  }
  await user.save();
  res.json(sanitize(user));
});

app.post('/api/me/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Wrong current password' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const user = await User.findById(req.user.id);
  if (user.avatar) {
    const old = path.join(UPLOADS_DIR, path.basename(user.avatar));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  user.avatar = '/uploads/' + req.file.filename;
  await user.save();
  res.json({ avatar: user.avatar });
});

// Media upload (chunked support via simple multipart)
app.post('/api/upload', authMiddleware, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  
  // Try to generate thumbnail for images using sharp if available
  let thumbUrl = null;
  try {
    const sharp = require('sharp');
    if (req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'image/gif') {
      const thumbName = 'thumb_' + req.file.filename;
      const thumbPath = path.join(UPLOADS_DIR, thumbName);
      await sharp(req.file.path).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumbPath);
      thumbUrl = '/uploads/' + thumbName;
    }
  } catch {}
  
  res.json({
    url: '/uploads/' + req.file.filename,
    thumbUrl: thumbUrl || ('/uploads/' + req.file.filename),
    type: req.file.mimetype,
    name: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size
  });
});

// Public user profile
app.get('/api/user/:id', authMiddleware, async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.profileViews = (user.profileViews || 0) + 1;
  await user.save();
  res.json({
    username: user.username, avatar: user.avatar, bio: user.bio,
    badges: user.badges, messageCount: user.messageCount,
    totalChats: user.totalChats, isAdmin: user.isAdmin,
    isDeveloper: user.isDeveloper, isModerator: user.isModerator,
    isVerified: user.isVerified, status: user.status,
    statusEmoji: user.statusEmoji, statusText: user.statusText,
    userNumber: user.userNumber, pinnedBadge: user.pinnedBadge,
    profileViews: user.profileViews, createdAt: user.createdAt,
    longestStreak: user.longestStreak
  });
});

// Report
app.post('/api/report', authMiddleware, async (req, res) => {
  try {
    const { reason, description, sessionId } = req.body;
    const user = await User.findById(req.user.id);
    await Report.create({ reporterId: req.user.id, reporterUsername: user.username, reason, description, sessionId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stats
app.get('/api/stats', async (req, res) => {
  const total = await User.countDocuments();
  const totalMsgs = await getTotalMessages();
  res.json({ totalUsers: total, totalMessages: totalMsgs });
});

// Badge definitions (public)
app.get('/api/badges', (req, res) => res.json(BADGE_DEFS));

// --- ADMIN ROUTES ---
app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const search = req.query.search || '';
  const filter = search ? { $or: [{ username: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }] } : {};
  const total = await User.countDocuments(filter);
  const users = await User.find(filter).sort({ userNumber: 1 }).skip((page-1)*limit).limit(limit);
  res.json({ users: users.map(sanitize), total, page, pages: Math.ceil(total/limit) });
});

app.post('/api/admin/ban', adminAuthMiddleware, async (req, res) => {
  const { userId, ban, reason } = req.body;
  await User.findByIdAndUpdate(userId, { isBanned: !!ban, banReason: reason || '' });
  res.json({ ok: true });
});

app.post('/api/admin/role', adminOnly, async (req, res) => {
  const { userId, role, value } = req.body;
  const allowed = ['isAdmin', 'isDeveloper', 'isModerator', 'isVerified'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await User.findByIdAndUpdate(userId, { [role]: !!value });
  res.json({ ok: true });
});

app.post('/api/admin/badge', adminAuthMiddleware, async (req, res) => {
  const { userId, badge } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.badges.find(b => b.id === badge.id)) {
    user.badges.push({ ...badge, earnedAt: new Date() });
    await user.save();
  }
  res.json(sanitize(user));
});

app.delete('/api/admin/badge', adminAuthMiddleware, async (req, res) => {
  const { userId, badgeId } = req.body;
  await User.findByIdAndUpdate(userId, { $pull: { badges: { id: badgeId } } });
  res.json({ ok: true });
});

app.delete('/api/admin/user/:id', adminOnly, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (user?.avatar) {
    const fp = path.join(UPLOADS_DIR, path.basename(user.avatar));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/message', adminAuthMiddleware, async (req, res) => {
  const { userId, message } = req.body;
  // Send system message to user's active socket
  const sockets = [...io.sockets.sockets.values()];
  for (const sock of sockets) {
    if (sock.userData?.userId === userId) {
      sock.emit('admin_message', { text: message });
    }
  }
  res.json({ ok: true });
});

app.post('/api/admin/announcement', adminOnly, async (req, res) => {
  const { text, color } = req.body;
  const ann = await Announcement.create({ text, color: color || '#0a84ff' });
  io.emit('announcement', { text, color: ann.color });
  res.json({ ok: true });
});

app.get('/api/admin/announcements', adminAuthMiddleware, async (req, res) => {
  const anns = await Announcement.find().sort({ createdAt: -1 }).limit(20);
  res.json(anns);
});

app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
  const total = await User.countDocuments();
  const banned = await User.countDocuments({ isBanned: true });
  const verified = await User.countDocuments({ isVerified: true });
  const totalMsgs = await getTotalMessages();
  const reports = await Report.countDocuments({ status: 'pending' });
  const today = new Date(); today.setHours(0,0,0,0);
  const newToday = await User.countDocuments({ createdAt: { $gte: today } });
  res.json({
    total, banned, verified, totalMessages: totalMsgs, pendingReports: reports, newToday,
    online: [...onlineUsers.values()].filter(u => u.status !== 'invisible').length,
    inChat: activePairs.size / 2
  });
});

app.get('/api/admin/reports', adminAuthMiddleware, async (req, res) => {
  const reports = await Report.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(50);
  res.json(reports);
});

app.post('/api/admin/report/:id', adminAuthMiddleware, async (req, res) => {
  const { status } = req.body;
  await Report.findByIdAndUpdate(req.params.id, { status });
  res.json({ ok: true });
});

app.get('/api/admin/leaderboard', adminAuthMiddleware, async (req, res) => {
  const top = await User.find().sort({ messageCount: -1 }).limit(20);
  res.json(top.map(u => ({ username: u.username, avatar: u.avatar, messageCount: u.messageCount, badges: u.badges.length })));
});

// Online users tracking (userId -> {username, status, avatar})
const onlineUsers = new Map();

// Real-time online count broadcast
function broadcastOnlineCount() {
  const visible = [...onlineUsers.values()].filter(u => u.status !== 'invisible').length;
  io.emit('online_count', visible);
}

// --- SOCKET.IO MATCHMAKING ---
io.use((socket, next) => { sessionMiddleware(socket.request, {}, next); });

const waitingPool = [];
const activePairs = new Map(); // socketId -> { partnerId, sessionId, mediaCount, uploadedFiles }

io.on('connection', async (socket) => {
  const token = socket.handshake.auth.token;
  let userData = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user && !user.isBanned) {
        userData = {
          userId: user._id.toString(), username: user.username,
          avatar: user.avatar, badges: user.badges,
          isAdmin: user.isAdmin, isDeveloper: user.isDeveloper,
          isModerator: user.isModerator, isVerified: user.isVerified,
          status: user.status, statusEmoji: user.statusEmoji, statusText: user.statusText
        };
        socket.userData = userData;
        onlineUsers.set(socket.id, { userId: user._id.toString(), username: user.username, status: user.status, avatar: user.avatar });
        broadcastOnlineCount();
        // Update lastActive
        await User.findByIdAndUpdate(user._id, { lastActive: new Date() });
        // Send active announcement
        const ann = await Announcement.findOne({ active: true }).sort({ createdAt: -1 });
        if (ann) socket.emit('announcement', { text: ann.text, color: ann.color });
      }
    } catch {}
  }

  socket.on('find_partner', () => {
    if (activePairs.has(socket.id)) return;
    const idx = waitingPool.findIndex(w => w.socketId !== socket.id);
    if (idx !== -1) {
      const partner = waitingPool.splice(idx, 1)[0];
      const pSocket = io.sockets.sockets.get(partner.socketId);
      if (!pSocket) {
        waitingPool.push({ socketId: socket.id, ...userData });
        socket.emit('waiting');
        return;
      }
      const sessionId = uuidv4();
      activePairs.set(socket.id, { partnerId: partner.socketId, sessionId, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      activePairs.set(partner.socketId, { partnerId: socket.id, sessionId, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      socket.emit('matched', { partner: { username: partner.username || 'Stranger', avatar: partner.avatar, badges: partner.badges || [], isAdmin: partner.isAdmin, isDeveloper: partner.isDeveloper, isModerator: partner.isModerator, isVerified: partner.isVerified, status: partner.status, statusEmoji: partner.statusEmoji, statusText: partner.statusText }, sessionId });
      pSocket.emit('matched', { partner: { username: userData?.username || 'Stranger', avatar: userData?.avatar, badges: userData?.badges || [], isAdmin: userData?.isAdmin, isDeveloper: userData?.isDeveloper, isModerator: userData?.isModerator, isVerified: userData?.isVerified, status: userData?.status, statusEmoji: userData?.statusEmoji, statusText: userData?.statusText }, sessionId });
    } else {
      waitingPool.push({ socketId: socket.id, ...userData });
      socket.emit('waiting');
    }
  });

  socket.on('message', async (data) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('message', { text: data.text, media: data.media, from: 'stranger' });
    await incTotalMessages();
    if (userData?.userId) {
      const user = await User.findByIdAndUpdate(
        userData.userId,
        { $inc: { messageCount: 1 } },
        { new: true }
      );
      const newBadges = await updateBadges(user);
      if (newBadges.length) {
        socket.emit('badge_earned', newBadges);
        // Update local userData badges
        userData.badges = user.badges;
      }
    }
    // Log message for admin
    if (userData?.userId) {
      await MessageLog.create({ from: userData.username, text: data.text?.slice(0, 500) || '', hasMedia: !!data.media, sessionId: pair.sessionId }).catch(() => {});
    }
  });

  socket.on('typing', (isTyping) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('typing', isTyping);
  });

  socket.on('media_sent', async (data) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    if (pair.mediaCount.me >= 10) { socket.emit('media_limit'); return; }
    pair.mediaCount.me++;
    const pPair = activePairs.get(pair.partnerId);
    if (pPair) pPair.mediaCount.them++;
    if (data.filename) pair.uploadedFiles.push(data.filename);
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('message', { media: data, from: 'stranger' });
    if (userData?.userId) {
      const user = await User.findByIdAndUpdate(userData.userId, { $inc: { totalMediaSent: 1 } }, { new: true });
      const newBadges = await updateBadges(user);
      if (newBadges.length) socket.emit('badge_earned', newBadges);
    }
  });

  socket.on('reaction', (data) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('reaction', data);
  });

  socket.on('skip', () => disconnectPair(socket, true));
  socket.on('disconnect', () => disconnectPair(socket, false));

  function disconnectPair(sock, requeue) {
    const idx = waitingPool.findIndex(w => w.socketId === sock.id);
    if (idx !== -1) waitingPool.splice(idx, 1);
    const pair = activePairs.get(sock.id);
    if (pair) {
      if (pair.uploadedFiles.length) {
        pair.uploadedFiles.forEach(fn => {
          const fp = path.join(UPLOADS_DIR, fn);
          if (fs.existsSync(fp)) fs.unlink(fp, () => {});
          const tp = path.join(UPLOADS_DIR, 'thumb_' + fn);
          if (fs.existsSync(tp)) fs.unlink(tp, () => {});
        });
      }
      const pPair = activePairs.get(pair.partnerId);
      if (pPair?.uploadedFiles?.length) {
        pPair.uploadedFiles.forEach(fn => {
          const fp = path.join(UPLOADS_DIR, fn);
          if (fs.existsSync(fp)) fs.unlink(fp, () => {});
          const tp = path.join(UPLOADS_DIR, 'thumb_' + fn);
          if (fs.existsSync(tp)) fs.unlink(tp, () => {});
        });
      }
      const pSocket = io.sockets.sockets.get(pair.partnerId);
      if (pSocket) { pSocket.emit('partner_disconnected'); activePairs.delete(pair.partnerId); }
      activePairs.delete(sock.id);

      // Update chat count
      if (userData?.userId) {
        User.findByIdAndUpdate(userData.userId, { $inc: { totalChats: 1 } })
          .then(async (user) => {
            if (user) {
              const newBadges = await updateBadges(user);
              if (newBadges.length) sock.emit('badge_earned', newBadges);
            }
          }).catch(() => {});
      }
    }
    onlineUsers.delete(sock.id);
    broadcastOnlineCount();
  }
});

server.listen(PORT, () => console.log(`StrangerText running on port ${PORT}`));
