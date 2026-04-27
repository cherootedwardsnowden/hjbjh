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
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'strangertext_secret_2024';
const ADMIN_IP = process.env.ADMIN_IP || '176.42.131.129';

if (!MONGO_URI) {
  console.error('❌ MONGO_URI environment variable is not set!');
  process.exit(1);
}

let dbReady = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
})
.then(() => { dbReady = true; console.log('✅ MongoDB connected'); })
.catch(err => { console.error('❌ MongoDB connection error:', err.message); process.exit(1); });

mongoose.connection.on('disconnected', () => { dbReady = false; console.warn('⚠️ MongoDB disconnected'); });
mongoose.connection.on('reconnected', () => { dbReady = true; console.log('✅ MongoDB reconnected'); });

// DB ready check middleware
app.use((req, res, next) => {
  if (!dbReady && req.path.startsWith('/api')) {
    return res.status(503).json({ error: 'Database not ready, please retry in a moment' });
  }
  next();
});

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  password: String,
  avatar: { type: String, default: null },
  bio: { type: String, default: '' },
  badges: [{ id: String, name: String, icon: String, color: String }],
  messageCount: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  isDeveloper: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  userNumber: Number,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

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

// Uploads dir
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
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
  store: MongoStore.create({ mongoUrl: MONGO_URI, autoRemove: 'native' })
});
app.use(sessionMiddleware);

// Wrap async route handlers
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
    console.error('Route error:', err.message);
    res.status(500).json({ error: err.message });
  });
}

// Admin IP middleware
function adminOnly(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  const cleanIp = ip.replace('::ffff:', '');
  if (cleanIp === ADMIN_IP || cleanIp === '127.0.0.1' || cleanIp === '::1') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Badge definitions
const BADGE_DEFS = [
  { id: 'msg10', name: 'Rookie', icon: '💬', color: '#8E8E93', threshold: 10 },
  { id: 'msg50', name: 'Chatter', icon: '🗣️', color: '#34C759', threshold: 50 },
  { id: 'msg100', name: 'Talkative', icon: '🔥', color: '#FF9500', threshold: 100 },
  { id: 'msg500', name: 'Veteran', icon: '⭐', color: '#007AFF', threshold: 500 },
  { id: 'msg1000', name: 'Legend', icon: '👑', color: '#FFD700', threshold: 1000 },
  { id: 'msg5000', name: 'Immortal', icon: '💎', color: '#AF52DE', threshold: 5000 },
  { id: 'msg10000', name: 'Godlike', icon: '🚀', color: '#FF2D55', threshold: 10000 },
  { id: 'early', name: 'Early Bird', icon: '🐦', color: '#5AC8FA', threshold: null },
];

async function updateBadges(user) {
  const earned = [];
  for (const b of BADGE_DEFS) {
    if (b.threshold && user.messageCount >= b.threshold) {
      if (!user.badges.find(x => x.id === b.id)) earned.push(b);
    }
  }
  if (earned.length) {
    user.badges.push(...earned);
    await user.save();
  }
  return earned;
}

// --- AUTH ROUTES ---
app.post('/api/register', asyncHandler(async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(409).json({ error: 'Username or email taken' });
    const hashed = await bcrypt.hash(password, 10);
    const userNumber = await getNextUserNumber();
    const isFirst = userNumber === 1;
    const user = await User.create({
      username, email, password: hashed, userNumber,
      isAdmin: isFirst, isDeveloper: isFirst,
      badges: userNumber <= 100 ? [BADGE_DEFS.find(b => b.id === 'early')] : []
    });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ $or: [{ username }, { email: username }] });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ error: 'Banned' });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}));

app.get('/api/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(sanitize(user));
}));

app.put('/api/me', authMiddleware, asyncHandler(async (req, res) => {
  const { bio, username } = req.body;
  const user = await User.findById(req.user.id);
  if (bio !== undefined) user.bio = bio.slice(0, 200);
  if (username && username !== user.username) {
    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username taken' });
    user.username = username;
  }
  await user.save();
  res.json(sanitize(user));
}));

app.post('/api/avatar', authMiddleware, upload.single('avatar'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const user = await User.findById(req.user.id);
  if (user.avatar) {
    const old = path.join(UPLOADS_DIR, path.basename(user.avatar));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  user.avatar = '/uploads/' + req.file.filename;
  await user.save();
  res.json({ avatar: user.avatar });
}));

// Media upload (chat)
app.post('/api/upload', authMiddleware, upload.single('media'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, type: req.file.mimetype, name: req.file.originalname, filename: req.file.filename });
}));

// --- ADMIN ROUTES ---
app.get('/api/admin/users', adminOnly, asyncHandler(async (req, res) => {
  const users = await User.find().sort({ userNumber: 1 });
  res.json(users.map(sanitize));
}));

app.post('/api/admin/ban', adminOnly, asyncHandler(async (req, res) => {
  const { userId, ban } = req.body;
  await User.findByIdAndUpdate(userId, { isBanned: !!ban });
  res.json({ ok: true });
}));

app.post('/api/admin/badge', adminOnly, asyncHandler(async (req, res) => {
  const { userId, badge } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.badges.find(b => b.id === badge.id)) {
    user.badges.push(badge);
    await user.save();
  }
  res.json(sanitize(user));
}));

app.delete('/api/admin/user/:id', adminOnly, asyncHandler(async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/admin/stats', adminOnly, asyncHandler(async (req, res) => {
  const total = await User.countDocuments();
  const banned = await User.countDocuments({ isBanned: true });
  res.json({ total, banned, online: waitingPool.length + activePairs.size });
}));

function sanitize(u) {
  return {
    _id: u._id, username: u.username, email: u.email,
    avatar: u.avatar, bio: u.bio, badges: u.badges,
    messageCount: u.messageCount, isAdmin: u.isAdmin,
    isDeveloper: u.isDeveloper, isBanned: u.isBanned,
    userNumber: u.userNumber, createdAt: u.createdAt
  };
}

// --- SOCKET.IO MATCHMAKING ---
io.use((socket, next) => { sessionMiddleware(socket.request, {}, next); });

const waitingPool = []; // { socketId, userId, username, avatar, badges }
const activePairs = new Map(); // socketId -> { partnerId, mediaCount: {me, them}, uploadedFiles }

io.on('connection', async (socket) => {
  const token = socket.handshake.auth.token;
  let userData = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user && !user.isBanned) {
        userData = { userId: user._id.toString(), username: user.username, avatar: user.avatar, badges: user.badges, isAdmin: user.isAdmin, isDeveloper: user.isDeveloper };
      }
    } catch {}
  }

  socket.on('find_partner', () => {
    if (activePairs.has(socket.id)) return;
    const idx = waitingPool.findIndex(w => w.socketId !== socket.id);
    if (idx !== -1) {
      const partner = waitingPool.splice(idx, 1)[0];
      const pSocket = io.sockets.sockets.get(partner.socketId);
      if (!pSocket) { socket.emit('waiting'); waitingPool.push({ socketId: socket.id, ...userData }); return; }
      activePairs.set(socket.id, { partnerId: partner.socketId, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      activePairs.set(partner.socketId, { partnerId: socket.id, mediaCount: { me: 0, them: 0 }, uploadedFiles: [] });
      socket.emit('matched', { partner: { username: partner.username || 'Stranger', avatar: partner.avatar, badges: partner.badges || [], isAdmin: partner.isAdmin, isDeveloper: partner.isDeveloper } });
      pSocket.emit('matched', { partner: { username: userData?.username || 'Stranger', avatar: userData?.avatar, badges: userData?.badges || [], isAdmin: userData?.isAdmin, isDeveloper: userData?.isDeveloper } });
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
    if (userData?.userId) {
      await User.findByIdAndUpdate(userData.userId, { $inc: { messageCount: 1 } });
      const user = await User.findById(userData.userId);
      const newBadges = await updateBadges(user);
      if (newBadges.length) socket.emit('badge_earned', newBadges);
    }
  });

  socket.on('typing', (isTyping) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('typing', isTyping);
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
    const pSocket = io.sockets.sockets.get(pair.partnerId);
    if (pSocket) pSocket.emit('message', { media: data, from: 'stranger' });
  });

  socket.on('skip', () => disconnectPair(socket, true));
  socket.on('disconnect', () => disconnectPair(socket, false));

  function disconnectPair(sock, requeue) {
    const idx = waitingPool.findIndex(w => w.socketId === sock.id);
    if (idx !== -1) waitingPool.splice(idx, 1);
    const pair = activePairs.get(sock.id);
    if (pair) {
      // Cleanup uploaded media files
      if (pair.uploadedFiles.length) {
        pair.uploadedFiles.forEach(fn => {
          const fp = path.join(UPLOADS_DIR, fn);
          if (fs.existsSync(fp)) fs.unlink(fp, () => {});
        });
      }
      const pPair = activePairs.get(pair.partnerId);
      if (pPair?.uploadedFiles?.length) {
        pPair.uploadedFiles.forEach(fn => {
          const fp = path.join(UPLOADS_DIR, fn);
          if (fs.existsSync(fp)) fs.unlink(fp, () => {});
        });
      }
      const pSocket = io.sockets.sockets.get(pair.partnerId);
      if (pSocket) {
        pSocket.emit('partner_disconnected');
        activePairs.delete(pair.partnerId);
      }
      activePairs.delete(sock.id);
    }
  }
});

// Start server only after DB is connected
mongoose.connection.once('open', () => {
  server.listen(PORT, () => console.log(`✅ StrangerText running on port ${PORT}`));
});
