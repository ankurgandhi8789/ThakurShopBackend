require('dotenv').config();
const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const cors           = require('cors');
const mongoose       = require('mongoose');
const jwt            = require('jsonwebtoken');
const helmet         = require('helmet');
const rateLimit      = require('express-rate-limit');
const mongoSanitize  = require('express-mongo-sanitize');

const Request = require('./models/Request');
const Admin   = require('./models/Admin');
const auth    = require('./middleware/auth');

const app        = express();
const httpServer = http.createServer(app);

const FRONTEND_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin || FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  },
});

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));   // prevent large payload attacks
app.use(mongoSanitize());                   // strip $ and . from req.body/query

// Rate limiter — 100 requests per 15 min per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Stricter limiter for login — 10 attempts per 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', loginLimiter);

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─── Stats helper ─────────────────────────────────────────────────────────────
async function getStats() {
  const [total, pending, inProgress, completed] = await Promise.all([
    Request.countDocuments(),
    Request.countDocuments({ status: 'pending' }),
    Request.countDocuments({ status: 'in-progress' }),
    Request.countDocuments({ status: 'completed' }),
  ]);
  return { total, pending, inProgress, completed };
}

// ─── Health check (Railway uses this to verify deployment) ──────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Auth Routes (public) ─────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });

  const admin = await Admin.findOne({ username: username.toLowerCase().trim() });
  if (!admin)
    return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const match = await admin.comparePassword(password);
  if (!match)
    return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  res.json({ success: true, token, admin: admin.toJSON() });
});

// GET /api/auth/me  — verify token & return admin info
app.get('/api/auth/me', auth, (req, res) => {
  res.json({ success: true, admin: req.admin });
});

// ─── Public Route ─────────────────────────────────────────────────────────────

// POST /api/requests  — customer submits a service request (NO auth needed)
app.post('/api/requests', async (req, res) => {
  const { name, phone, address, landmark, location, serviceType, description } = req.body;
  if (!name || !phone || !address || !description)
    return res.status(400).json({ success: false, message: 'Name, phone, address and description are required' });

  const request = await Request.create({
    name: name.trim(),
    phone: phone.trim(),
    address: address.trim(),
    landmark: landmark?.trim() || '',
    serviceType: serviceType?.trim() || 'Other',
    description: description?.trim() || '',
    location: location || { lat: null, lng: null },
  });

  const stats = await getStats();
  io.emit('new_request', { request: request.toJSON(), stats });
  res.status(201).json({ success: true, data: request.toJSON() });
});

// ─── Protected Admin Routes (require JWT) ─────────────────────────────────────

// GET /api/requests
app.get('/api/requests', auth, async (req, res) => {
  const { status, search } = req.query;
  const filter = {};

  if (status && status !== 'all') filter.status = status;
  if (search) {
    const q = new RegExp(search, 'i');
    filter.$or = [{ name: q }, { phone: q }, { address: q }, { serviceType: q }, { description: q }];
  }

  const requests = await Request.find(filter).sort({ createdAt: -1 });
  const stats    = await getStats();
  res.json({ success: true, data: requests.map(r => r.toJSON()), stats });
});

// GET /api/requests/:id
app.get('/api/requests/:id', auth, async (req, res) => {
  const request = await Request.findById(req.params.id);
  if (!request) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, data: request.toJSON() });
});

// PATCH /api/requests/:id/status
app.patch('/api/requests/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'in-progress', 'completed'].includes(status))
    return res.status(400).json({ success: false, message: 'Invalid status' });

  const request = await Request.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true }
  );
  if (!request) return res.status(404).json({ success: false, message: 'Not found' });

  const stats = await getStats();
  io.emit('request_updated', { request: request.toJSON(), stats });
  res.json({ success: true, data: request.toJSON() });
});

// PATCH /api/requests/:id/assign
app.patch('/api/requests/:id/assign', auth, async (req, res) => {
  const { technicianName } = req.body;

  const request = await Request.findByIdAndUpdate(
    req.params.id,
    { assignedTo: technicianName, status: 'in-progress' },
    { new: true }
  );
  if (!request) return res.status(404).json({ success: false, message: 'Not found' });

  const stats = await getStats();
  io.emit('request_updated', { request: request.toJSON(), stats });
  res.json({ success: true, data: request.toJSON() });
});

// PATCH /api/requests/:id/notes
app.patch('/api/requests/:id/notes', auth, async (req, res) => {
  const { notes } = req.body;

  const request = await Request.findByIdAndUpdate(
    req.params.id,
    { notes },
    { new: true }
  );
  if (!request) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, data: request.toJSON() });
});

// DELETE /api/requests/:id
app.delete('/api/requests/:id', auth, async (req, res) => {
  const request = await Request.findByIdAndDelete(req.params.id);
  if (!request) return res.status(404).json({ success: false, message: 'Not found' });

  const stats = await getStats();
  io.emit('request_deleted', { id: req.params.id, stats });
  res.json({ success: true, message: 'Deleted successfully' });
});

// GET /api/stats
app.get('/api/stats', auth, async (req, res) => {
  const stats = await getStats();
  res.json({ success: true, data: stats });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[Socket] Disconnected: ${socket.id}`));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`\n⚡ Thakur Electronics Backend → http://localhost:${PORT}`);
  console.log(`📋 API  → http://localhost:${PORT}/api/requests`);
  console.log(`🔐 Auth → http://localhost:${PORT}/api/auth/login\n`);
});
