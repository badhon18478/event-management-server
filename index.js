const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

// =========================
// Stripe Setup
// =========================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized');
}

// =========================
// Firebase Admin Setup
// =========================
if (!admin.apps.length) {
  let serviceAccount;
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Firebase loaded from file');
  } catch {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };
    console.log('✅ Firebase loaded from env vars');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
const port = process.env.PORT || 5000;

// =========================
// CORS Configuration
// =========================
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'https://event-managments-app.vercel.app',
      'https://eventhub-app.vercel.app',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

// =========================
// MongoDB Connection (Cached for Vercel)
// =========================
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5tiqofx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

let cachedClient = null;
let cachedDb = null;

async function connectDB() {
  if (cachedClient && cachedDb) {
    return cachedDb;
  }

  try {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
      connectTimeoutMS: 10000,
      socketTimeoutMS: 10000,
    });

    await client.connect();
    console.log('✅ MongoDB connected');

    cachedClient = client;
    cachedDb = client.db('eventhub');

    return cachedDb;
  } catch (error) {
    console.error('❌ MongoDB error:', error.message);
    return null;
  }
}

// =========================
// DB Middleware
// =========================
app.use(async (req, res, next) => {
  const db = await connectDB();
  if (!db) {
    return res
      .status(503)
      .json({ success: false, message: 'Database connection failed' });
  }
  req.db = db;
  req.eventsCollection = db.collection('events');
  req.usersCollection = db.collection('users');
  req.paymentsCollection = db.collection('payments');
  req.bookingsCollection = db.collection('bookings');
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
        .json({ success: false, message: 'unauthorized access - no token' });
    }
    const token = authorization.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.token_email = decoded.email;
    req.token_uid = decoded.uid;
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, message: 'unauthorized access - invalid token' });
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
        .json({ success: false, message: 'unauthorized access - no token' });
    }

    const token = authorization.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const userEmail = decoded.email;

    const db = await connectDB();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email: userEmail });

    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'forbidden - admin access required',
        yourEmail: userEmail,
        yourRole: user?.role || 'user',
      });
    }

    req.token_email = userEmail;
    req.token_uid = decoded.uid;
    next();
  } catch (error) {
    console.error('Admin verification error:', error);
    return res
      .status(401)
      .json({ success: false, message: 'unauthorized access' });
  }
};

// =========================
// USER ROUTES
// =========================

// Register/Sync User
app.post('/api/users/register', async (req, res) => {
  try {
    const { uid, email, displayName, photoURL } = req.body;

    if (!uid || !email) {
      return res
        .status(400)
        .json({ success: false, message: 'uid and email are required' });
    }

    const existingUser = await req.usersCollection.findOne({
      email: email.toLowerCase(),
    });

    if (!existingUser) {
      const newUser = {
        _id: uid,
        email: email.toLowerCase(),
        displayName: displayName || email.split('@')[0],
        photoURL:
          photoURL ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(email)}&background=random`,
        role: 'user',
        status: 'active',
        createdAt: new Date(),
        lastActive: new Date(),
      };

      await req.usersCollection.insertOne(newUser);

      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        user: {
          email: newUser.email,
          displayName: newUser.displayName,
          role: newUser.role,
        },
      });
    } else {
      await req.usersCollection.updateOne(
        { email: email.toLowerCase() },
        { $set: { lastActive: new Date(), displayName, photoURL } },
      );

      return res.json({
        success: true,
        message: 'User logged in successfully',
        user: {
          email: existingUser.email,
          displayName: existingUser.displayName,
          role: existingUser.role || 'user',
        },
      });
    }
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get user by email
app.get('/api/users/:email', verifyFireBaseToken, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await req.usersCollection.findOne({ email });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: user.role || 'user',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get user role
app.get('/api/users/role/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await req.usersCollection.findOne({ email });

    res.json({
      success: true,
      role: user?.role || 'user',
      isAdmin: user?.role === 'admin',
    });
  } catch (error) {
    res.json({ success: true, role: 'user', isAdmin: false });
  }
});

// =========================
// EVENT ROUTES
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

    const total = await req.eventsCollection.countDocuments(filter);
    const events = await req.eventsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    res.json({
      success: true,
      data: events,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET latest events
app.get('/api/events/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 6;
    const events = await req.eventsCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ success: true, data: events });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET single event
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid event ID' });
    }
    const event = await req.eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: 'Event not found' });
    }
    res.json({ success: true, data: event });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET user events (এই route টি গুরুত্বপূর্ণ)
app.get('/api/events/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log('📡 Fetching events for user:', userId);

    const events = await req.eventsCollection
      .find({ userId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    console.log(`✅ Found ${events.length} events for user ${userId}`);
    res.json({ success: true, data: events });
  } catch (error) {
    console.error('Error fetching user events:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create event
app.post('/api/events', verifyFireBaseToken, async (req, res) => {
  try {
    const {
      title,
      shortDescription,
      description,
      price,
      date,
      category,
      image,
    } = req.body;

    if (
      !title ||
      !shortDescription ||
      !description ||
      !price ||
      !date ||
      !category
    ) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing required fields' });
    }

    const newEvent = {
      title,
      shortDescription,
      description,
      price: parseFloat(price),
      date: new Date(date),
      category,
      image:
        image ||
        'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800',
      userId: req.token_uid,
      userEmail: req.token_email,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending',
      bookings: 0,
      revenue: 0,
    };

    const result = await req.eventsCollection.insertOne(newEvent);
    res
      .status(201)
      .json({ success: true, data: { ...newEvent, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update event
app.put('/api/events/:id', verifyFireBaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid event ID' });
    }

    const event = await req.eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: 'Event not found' });
    }
    if (event.userId !== req.token_uid) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

    const { _id, userId, userEmail, createdAt, ...updateFields } = req.body;
    const result = await req.eventsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...updateFields, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE event
app.delete('/api/events/:id', verifyFireBaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid event ID' });
    }

    const event = await req.eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: 'Event not found' });
    }
    if (event.userId !== req.token_uid) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

    await req.eventsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// =========================
// PAYMENT ROUTES
// =========================

// Create payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { eventId, amount, eventTitle } = req.body;

    if (!eventId || !amount) {
      return res
        .status(400)
        .json({ success: false, message: 'eventId and amount required' });
    }

    // Mock mode if no Stripe key
    if (!stripe) {
      const mockSecret = 'mock_secret_' + Date.now();
      await req.paymentsCollection.insertOne({
        paymentIntentId: mockSecret,
        eventId,
        eventTitle: eventTitle || '',
        amount: parseFloat(amount),
        status: 'pending',
        userId: req.token_uid,
        userEmail: req.token_email,
        createdAt: new Date(),
      });
      return res.json({
        success: true,
        clientSecret: mockSecret,
        mock: true,
      });
    }

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

    await req.paymentsCollection.insertOne({
      paymentIntentId: paymentIntent.id,
      eventId,
      eventTitle: eventTitle || '',
      amount: parseFloat(amount),
      status: 'pending',
      userId: req.token_uid,
      userEmail: req.token_email,
      createdAt: new Date(),
    });

    res.json({ success: true, clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Save payment record (এই route টি গুরুত্বপূর্ণ)
app.post('/api/payments', verifyFireBaseToken, async (req, res) => {
  try {
    const { paymentIntentId, eventId, eventTitle, amount, status } = req.body;

    if (!paymentIntentId || !eventId || !amount) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing fields' });
    }

    const existing = await req.paymentsCollection.findOne({ paymentIntentId });
    if (existing) {
      return res.json({
        success: true,
        message: 'Payment already saved',
        paymentId: existing._id,
      });
    }

    const result = await req.paymentsCollection.insertOne({
      paymentIntentId,
      eventId,
      eventTitle: eventTitle || '',
      amount: parseFloat(amount),
      status: status || 'succeeded',
      userId: req.token_uid,
      userEmail: req.token_email,
      createdAt: new Date(),
    });

    // Update event bookings and revenue
    if (ObjectId.isValid(eventId)) {
      await req.eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { $inc: { bookings: 1, revenue: parseFloat(amount) } },
      );
    }

    res.status(201).json({
      success: true,
      message: 'Payment saved',
      paymentId: result.insertedId,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get user payments (এই route টি গুরুত্বপূর্ণ)
app.get('/api/payments', verifyFireBaseToken, async (req, res) => {
  try {
    console.log('📡 Fetching payments for user:', req.token_uid);

    const payments = await req.paymentsCollection
      .find({ userId: req.token_uid })
      .sort({ createdAt: -1 })
      .toArray();

    console.log(
      `✅ Found ${payments.length} payments for user ${req.token_uid}`,
    );
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =========================
// ADMIN ROUTES
// =========================

// Get all users (admin only)
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const users = await req.usersCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    const safeUsers = users.map(user => ({
      _id: user._id,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: user.role || 'user',
      status: user.status || 'active',
      createdAt: user.createdAt,
      lastActive: user.lastActive,
    }));

    res.json({ success: true, users: safeUsers, total: safeUsers.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Block user (admin only)
app.post('/api/admin/users/:id/block', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await req.usersCollection.updateOne(
      { _id: id },
      { $set: { status: 'blocked', updatedAt: new Date() } },
    );
    res.json({ success: true, message: 'User blocked successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Make user admin (admin only)
app.post('/api/admin/users/:id/make-admin', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await req.usersCollection.updateOne(
      { _id: id },
      { $set: { role: 'admin', updatedAt: new Date() } },
    );
    res.json({ success: true, message: 'User promoted to admin' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all events (admin only)
app.get('/api/admin/events', verifyAdmin, async (req, res) => {
  try {
    const events = await req.eventsCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, data: events });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Approve event (admin only)
app.post('/api/admin/events/:id/approve', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await req.eventsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'approved', approvedAt: new Date() } },
    );
    res.json({ success: true, message: 'Event approved successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject event (admin only)
app.post('/api/admin/events/:id/reject', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await req.eventsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'rejected', rejectedAt: new Date() } },
    );
    res.json({ success: true, message: 'Event rejected' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete event (admin only)
app.delete('/api/admin/events/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await req.eventsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all payments (admin only)
app.get('/api/admin/payments', verifyAdmin, async (req, res) => {
  try {
    const payments = await req.paymentsCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    const totalAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    res.json({ success: true, data: payments, totalAmount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get admin stats
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await req.usersCollection.countDocuments();
    const totalEvents = await req.eventsCollection.countDocuments();
    const totalPayments = await req.paymentsCollection.countDocuments();
    const payments = await req.paymentsCollection.find().toArray();
    const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const pendingEvents = await req.eventsCollection.countDocuments({
      status: 'pending',
    });
    const approvedEvents = await req.eventsCollection.countDocuments({
      status: 'approved',
    });
    const activeUsers = await req.usersCollection.countDocuments({
      status: 'active',
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalEvents,
        totalPayments,
        totalRevenue,
        pendingEvents,
        approvedEvents,
        activeUsers,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// =========================
// Health Check Routes
// =========================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 EventHub API is running',
    timestamp: new Date().toISOString(),
    endpoints: {
      user: '/api/events, /api/payments',
      admin: '/api/admin/users, /api/admin/events, /api/admin/payments',
    },
  });
});

app.get('/health', async (req, res) => {
  const db = await connectDB();
  res.json({
    success: true,
    status: 'OK',
    mongodb: db ? 'connected' : 'disconnected',
    stripe: stripe ? 'configured' : 'mock mode',
  });
});

// =========================
// 404 Handler
// =========================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// =========================
// Error Handler
// =========================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// =========================
// Export for Vercel
// =========================
module.exports = app;

// Local development
if (require.main === module) {
  connectDB()
    .then(() => {
      app.listen(port, () => {
        console.log(`🚀 EventHub server running on port: ${port}`);
        console.log(`🔗 http://localhost:${port}/`);
        console.log(`📋 API Endpoints:`);
        console.log(`   GET  /api/events`);
        console.log(`   GET  /api/events/user/:userId`);
        console.log(`   GET  /api/payments`);
        console.log(`   POST /api/events`);
        console.log(`   POST /api/payments`);
        console.log(`   POST /api/create-payment-intent`);
        console.log(`   ADMIN routes under /api/admin/*`);
      });
    })
    .catch(err => {
      console.error('Failed to start server:', err);
    });
}
