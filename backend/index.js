const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('./src/config/passport');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const chatRoutes = require('./src/routes/chats');
const fileRoutes = require('./src/routes/files');
const aiRoutes = require('./src/routes/ai');
const paymentRoutes = require('./src/routes/payments');
const adminRoutes = require('./src/routes/admin');
const userRoutes = require('./src/routes/users');
const publicRoutes = require('./src/routes/public');
const downloadRoutes = require('./src/routes/download');
const elevenlabsRoutes = require('./src/routes/elevenlabs');
const searchRoutes = require('./src/routes/search');
const videoRoutes = require('./src/routes/video');
const gptsRoutes = require('./src/routes/gpts');
const libraryRoutes = require('./src/routes/library');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // limit each IP to 100 requests per windowMs for testing
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// CORS configuration
// const corsOptions = {
//   origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000'],
//   credentials: true,
//   optionsSuccessStatus: 200
// };
// app.use(cors(corsOptions));

const corsOptions = {
    origin: function (origin, callback) {
        callback(null, true); // allow any origin
    },
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsing middleware
app.use(compression({
    filter: (req, res) => {
        // Agar response 'text/event-stream' ya 'video/mp4' hai, to usse compress mat karo
        const contentType = res.getHeader('Content-Type');
        if (contentType === 'text/event-stream' || contentType === 'video/mp4') {
            return false;
        }
        // Baaki sab responses ko compress karo
        return compression.filter(req, res);
    }
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Session configuration for Google OAuth
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// Logging
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
}

// Static files
app.use('/uploads', express.static('uploads'));


// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/elevenlabs', elevenlabsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/gpts', gptsRoutes); // Add GPTs API routes
app.use('/api/library', libraryRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);

    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'File too large' });
    }

    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
