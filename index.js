const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

// =========================
// Stripe Setup
// =========================
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
  } else {
    console.log('⚠️ Stripe secret key not found');
  }
} catch (error) {
  console.log('⚠️ Stripe not available:', error.message);
}

// =========================
// Firebase Admin Setup
// =========================
let serviceAccount;
try {
  serviceAccount = require('./serviceAccountKey.json');
  console.log('✅ Firebase loaded from file');
} catch {
  serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
  console.log('✅ Firebase loaded from env vars');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
const port = process.env.PORT || 5000;

// =========================
// CORS
// =========================
app.use(
  cors({
    origin: true, // সব origin allow — Vercel এ কাজ করার জন্য
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

// =========================
// MongoDB — Cached Connection (Vercel serverless এর জন্য জরুরি)
// =========================
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5tiqofx.mongodb.net/eventhub?retryWrites=true&w=majority&appName=Cluster0`;

let cachedClient = null;
let cachedDb = null;

let eventsCollection;
let usersCollection;
let paymentsCollection;
let bookingsCollection;

async function connectDB() {
  // Already connected — reuse
  if (cachedClient && cachedDb) {
    eventsCollection = cachedDb.collection('events');
    usersCollection = cachedDb.collection('users');
    paymentsCollection = cachedDb.collection('payments');
    bookingsCollection = cachedDb.collection('bookings');
    return true;
  }

  try {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
      // Vercel serverless timeout settings
      connectTimeoutMS: 10000,
      socketTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();
    console.log('✅ MongoDB connected');

    const db = client.db('eventhub');

    // Cache করো
    cachedClient = client;
    cachedDb = db;

    eventsCollection = db.collection('events');
    usersCollection = db.collection('users');
    paymentsCollection = db.collection('payments');
    bookingsCollection = db.collection('bookings');

    // Indexes (silently ignore if already exist)
    try {
      await eventsCollection.createIndex({ createdAt: -1 });
      await eventsCollection.createIndex({ userId: 1 });
      await eventsCollection.createIndex({ category: 1 });
      await usersCollection.createIndex({ email: 1 });
      await paymentsCollection.createIndex({ userId: 1 });
      await paymentsCollection.createIndex({ createdAt: -1 });
    } catch (_) {}

    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    cachedClient = null;
    cachedDb = null;
    return false;
  }
}

// =========================
// DB middleware — প্রতিটা request এ connection নিশ্চিত করে
// =========================
app.use(async (req, res, next) => {
  if (!cachedDb) {
    const connected = await connectDB();
    if (!connected) {
      return res
        .status(503)
        .json({ message: 'Database connection failed. Please try again.' });
    }
  }
  next();
});

// =========================
// Firebase Auth Middleware
// =========================
const verifyFireBaseToken = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res
        .status(401)
        .json({ message: 'unauthorized access - no token' });
    }
    const token = authorization.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.token_email = decoded.email;
    req.token_uid = decoded.uid;
    next();
  } catch (error) {
    console.error('❌ Token error:', error.message);
    return res
      .status(401)
      .json({ message: 'unauthorized access - invalid token' });
  }
};

// =========================
// Admin Auth Middleware
// =========================
const verifyAdmin = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res
        .status(401)
        .json({ message: 'unauthorized access - no token' });
    }
    const token = authorization.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@eventhub.com';
    if (decoded.email !== adminEmail) {
      return res
        .status(403)
        .json({ message: 'forbidden - admin access required' });
    }
    req.admin_email = decoded.email;
    req.token_uid = decoded.uid;
    next();
  } catch (error) {
    console.error('❌ Admin auth error:', error.message);
    return res.status(401).json({ message: 'unauthorized access' });
  }
};

// =========================
// Public Routes
// =========================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 EventHub server is running',
    timestamp: new Date().toISOString(),
    status: 'healthy',
    version: '2.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    mongodb: cachedDb ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// =========================
// Event Routes
// =========================

// GET all events
app.get('/api/events', async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (category && category !== 'all') filter.category = category;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { shortDescription: { $regex: search, $options: 'i' } },
      ];
    }
    const total = await eventsCollection.countDocuments(filter);
    const events = await eventsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();
    res.json({
      data: events,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching events:', error);
    res.status(500).json({ message: 'Error fetching events' });
  }
});

// GET latest events — MUST be before /api/events/:id
app.get('/api/events/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 6;
    const events = await eventsCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(events);
  } catch (error) {
    console.error('❌ Error fetching latest events:', error);
    res.status(500).json({ message: 'Error fetching latest events' });
  }
});

// GET events by user — MUST be before /api/events/:id
app.get('/api/events/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'User ID required' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const total = await eventsCollection.countDocuments({ userId });
    const events = await eventsCollection
      .find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({ data: events, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('❌ Error fetching user events:', error);
    res.status(500).json({ message: 'Error fetching user events' });
  }
});

// GET single event
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: 'Invalid event ID' });
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event);
  } catch (error) {
    console.error('❌ Error fetching event:', error);
    res.status(500).json({ message: 'Error fetching event' });
  }
});

// POST create event
app.post('/api/events', verifyFireBaseToken, async (req, res) => {
  try {
    const { title, shortDescription, description, price, date, category } =
      req.body;
    if (
      !title ||
      !shortDescription ||
      !description ||
      !price ||
      !date ||
      !category
    ) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const newEvent = {
      title,
      shortDescription,
      description,
      price: parseFloat(price),
      date,
      category,
      image:
        req.body.image ||
        'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800',
      userId: req.token_uid,
      userEmail: req.token_email,
      createdAt: new Date(),
      updatedAt: new Date(),
      bookings: 0,
      revenue: 0,
    };
    const result = await eventsCollection.insertOne(newEvent);
    const createdEvent = await eventsCollection.findOne({
      _id: result.insertedId,
    });
    res.status(201).json(createdEvent);
  } catch (error) {
    console.error('❌ Error creating event:', error);
    res.status(500).json({ message: 'Error creating event' });
  }
});

// PUT update event
app.put('/api/events/:id', verifyFireBaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: 'Invalid event ID' });
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (event.userId !== req.token_uid)
      return res.status(403).json({ message: 'Not authorized' });

    const { _id, userId, userEmail, createdAt, ...updateFields } = req.body;
    const updatedEvent = await eventsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...updateFields, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    res.json(updatedEvent);
  } catch (error) {
    console.error('❌ Error updating event:', error);
    res.status(500).json({ message: 'Error updating event' });
  }
});

// DELETE event
app.delete('/api/events/:id', verifyFireBaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: 'Invalid event ID' });
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (event.userId !== req.token_uid)
      return res.status(403).json({ message: 'Not authorized' });
    await eventsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting event:', error);
    res.status(500).json({ message: 'Error deleting event' });
  }
});

// =========================
// Payment Routes
// =========================

// Create Payment Intent
app.post(
  '/api/create-payment-intent',
  verifyFireBaseToken,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.json({
          clientSecret: 'mock_secret_' + Date.now(),
          mock: true,
        });
      }
      const { eventId, amount, eventTitle } = req.body;
      if (!eventId || !amount)
        return res
          .status(400)
          .json({ message: 'Event ID and amount required' });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(parseFloat(amount) * 100),
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          eventId,
          eventTitle: eventTitle || '',
          userId: req.token_uid,
          userEmail: req.token_email,
        },
      });

      await paymentsCollection.insertOne({
        paymentIntentId: paymentIntent.id,
        eventId,
        eventTitle: eventTitle || '',
        amount: parseFloat(amount),
        status: 'pending',
        userId: req.token_uid,
        userEmail: req.token_email,
        createdAt: new Date(),
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      console.error('❌ Payment intent error:', error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Save Payment
app.post('/api/payments', verifyFireBaseToken, async (req, res) => {
  try {
    const { paymentIntentId, eventId, eventTitle, amount, status } = req.body;
    if (!paymentIntentId || !eventId || !amount) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const existing = await paymentsCollection.findOne({ paymentIntentId });
    if (existing)
      return res
        .status(200)
        .json({ message: 'Payment already saved', paymentId: existing._id });

    const result = await paymentsCollection.insertOne({
      paymentIntentId,
      eventId,
      eventTitle: eventTitle || '',
      amount: parseFloat(amount),
      status: status || 'succeeded',
      userId: req.token_uid,
      userEmail: req.token_email,
      createdAt: new Date(),
    });

    if (ObjectId.isValid(eventId)) {
      await eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { $inc: { bookings: 1, revenue: parseFloat(amount) } },
      );
    }
    res
      .status(201)
      .json({
        message: 'Payment saved successfully',
        paymentId: result.insertedId,
      });
  } catch (error) {
    console.error('❌ Error saving payment:', error);
    res.status(500).json({ message: 'Error saving payment' });
  }
});

// Get User Payments
app.get('/api/payments', verifyFireBaseToken, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await paymentsCollection.countDocuments({
      userId: req.token_uid,
    });
    const payments = await paymentsCollection
      .find({ userId: req.token_uid })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();
    res.json({
      data: payments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching payments:', error);
    res.status(500).json({ message: 'Error fetching payments' });
  }
});

// =========================
// User Management
// =========================
app.post('/api/users', async (req, res) => {
  try {
    const { uid, email, displayName, photoURL } = req.body;
    if (!uid || !email)
      return res.status(400).json({ message: 'uid and email required' });

    const existing = await usersCollection.findOne({ _id: uid });
    if (!existing) {
      await usersCollection.insertOne({
        _id: uid,
        email,
        displayName: displayName || '',
        photoURL: photoURL || '',
        createdAt: new Date(),
        lastActive: new Date(),
      });
    } else {
      await usersCollection.updateOne(
        { _id: uid },
        { $set: { lastActive: new Date(), displayName, photoURL } },
      );
    }
    res.json({ message: 'User synced successfully' });
  } catch (error) {
    console.error('❌ Error syncing user:', error);
    res.status(500).json({ message: 'Error syncing user' });
  }
});

// =========================
// Admin Routes
// =========================

app.get('/admin/api/stats', verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();
    const totalEvents = await eventsCollection.countDocuments();
    const totalPayments = await paymentsCollection.countDocuments();

    const revenueAgg = await paymentsCollection
      .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
      .toArray();
    const totalRevenue = revenueAgg[0]?.total || 0;

    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );
    const monthEnd = new Date(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      1,
    );

    const newUsersThisMonth = await usersCollection.countDocuments({
      createdAt: { $gte: monthStart, $lt: monthEnd },
    });
    const eventsThisMonth = await eventsCollection.countDocuments({
      createdAt: { $gte: monthStart, $lt: monthEnd },
    });

    const revMonthAgg = await paymentsCollection
      .aggregate([
        { $match: { createdAt: { $gte: monthStart, $lt: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray();
    const revenueThisMonth = revMonthAgg[0]?.total || 0;

    const activeUsers = await usersCollection.countDocuments({
      lastActive: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    res.json({
      totalUsers,
      totalEvents,
      totalPayments,
      totalRevenue,
      activeUsers,
      newUsersThisMonth,
      eventsThisMonth,
      revenueThisMonth,
    });
  } catch (error) {
    console.error('❌ Admin stats error:', error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

app.get('/admin/api/users', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = search ? { email: { $regex: search, $options: 'i' } } : {};
    const total = await usersCollection.countDocuments(filter);
    const users = await usersCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const usersWithStats = await Promise.all(
      users.map(async user => {
        const uid = user._id.toString();
        const eventCount = await eventsCollection.countDocuments({
          userId: uid,
        });
        const agg = await paymentsCollection
          .aggregate([
            { $match: { userId: uid } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ])
          .toArray();
        return { ...user, eventCount, totalSpent: agg[0]?.total || 0 };
      }),
    );

    res.json({
      users: usersWithStats,
      totalPages: Math.ceil(total / parseInt(limit)),
      total,
    });
  } catch (error) {
    console.error('❌ Admin users error:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

app.delete('/admin/api/users/:id', verifyAdmin, async (req, res) => {
  try {
    const result = await usersCollection.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0)
      return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('❌ Delete user error:', error);
    res.status(500).json({ message: 'Error deleting user' });
  }
});

app.get('/admin/api/events', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '', category = 'all' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (search)
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { shortDescription: { $regex: search, $options: 'i' } },
      ];
    if (category && category !== 'all') filter.category = category;
    const total = await eventsCollection.countDocuments(filter);
    const events = await eventsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();
    res.json({ events, totalPages: Math.ceil(total / parseInt(limit)), total });
  } catch (error) {
    console.error('❌ Admin events error:', error);
    res.status(500).json({ message: 'Error fetching events' });
  }
});

app.delete('/admin/api/events/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: 'Invalid event ID' });
    const result = await eventsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0)
      return res.status(404).json({ message: 'Event not found' });
    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('❌ Delete event error:', error);
    res.status(500).json({ message: 'Error deleting event' });
  }
});

app.get('/admin/api/payments', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 15, search = '', status = 'all' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (search)
      filter.$or = [
        { eventTitle: { $regex: search, $options: 'i' } },
        { userEmail: { $regex: search, $options: 'i' } },
      ];
    if (status && status !== 'all') filter.status = status;
    const total = await paymentsCollection.countDocuments(filter);
    const payments = await paymentsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();
    const agg = await paymentsCollection
      .aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray();
    res.json({
      payments,
      totalPages: Math.ceil(total / parseInt(limit)),
      total,
      totalAmount: agg[0]?.total || 0,
    });
  } catch (error) {
    console.error('❌ Admin payments error:', error);
    res.status(500).json({ message: 'Error fetching payments' });
  }
});

app.get('/admin/api/analytics', verifyAdmin, async (req, res) => {
  try {
    const { period = 'monthly' } = req.query;
    let days = period === 'weekly' ? 7 : period === 'yearly' ? 365 : 30;

    const points = 6;
    const step = Math.max(1, Math.floor(days / points));

    const userGrowth = [];
    const revenueGrowth = [];
    for (let i = days; i >= 0; i -= step) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const count = await usersCollection.countDocuments({
        createdAt: { $lte: date },
      });
      const agg = await paymentsCollection
        .aggregate([
          { $match: { createdAt: { $lte: date } } },
          { $group: { _id: null, amount: { $sum: '$amount' } } },
        ])
        .toArray();
      userGrowth.push({ period: date.toLocaleDateString(), count });
      revenueGrowth.push({
        period: date.toLocaleDateString(),
        amount: agg[0]?.amount || 0,
      });
    }

    const topEvents = await eventsCollection
      .find()
      .sort({ bookings: -1 })
      .limit(5)
      .toArray();
    const totalUsers = await usersCollection.countDocuments();
    const totalEvents = await eventsCollection.countDocuments();
    const revAgg = await paymentsCollection
      .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
      .toArray();
    const totalRevenue = revAgg[0]?.total || 0;
    const lastMonthUsers = await usersCollection.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    res.json({
      userGrowth,
      revenueGrowth,
      topEvents: topEvents.map(e => ({
        title: e.title,
        category: e.category,
        revenue: e.revenue || 0,
        bookings: e.bookings || 0,
      })),
      summary: {
        totalUsers,
        totalEvents,
        totalRevenue,
        growthRate:
          totalUsers > 0 ? Math.round((lastMonthUsers / totalUsers) * 100) : 0,
      },
    });
  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.status(500).json({ message: 'Error fetching analytics' });
  }
});

// =========================
// 404 & Error Handlers
// =========================
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found', path: req.originalUrl });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// =========================
// Start Server (local only — Vercel uses module.exports)
// =========================
async function startServer() {
  await connectDB();
  app.listen(port, () => {
    console.log(`🚀 EventHub running on port: ${port}`);
    console.log(`🔗 http://localhost:${port}/`);
  });
}

startServer();

// Vercel এর জন্য export
module.exports = app;

// Graceful Shutdown
async function gracefulShutdown() {
  console.log('\n🛑 Shutting down...');
  try {
    if (cachedClient) await cachedClient.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
