// const express = require('express');
// const cors = require('cors');
// const helmet = require('helmet');
// const morgan = require('morgan');
// const compression = require('compression');
// const cookieParser = require('cookie-parser');
// const rateLimit = require('express-rate-limit');
// const session = require('express-session');
// const passport = require('./config/passport');
// require('dotenv').config();

// const authRoutes = require('./routes/auth');
// const chatRoutes = require('./routes/chats');
// const fileRoutes = require('./routes/files');
// const aiRoutes = require('./routes/ai');
// const paymentRoutes = require('./routes/payments');
// const adminRoutes = require('./routes/admin');
// const userRoutes = require('./routes/users');

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Security middleware
// app.use(helmet({
//   crossOriginResourcePolicy: { policy: "cross-origin" }
// }));

// // Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again later.'
// });
// app.use('/api/', limiter);

// // CORS configuration
// // const corsOptions = {
// //   origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000'],
// //   credentials: true,
// //   optionsSuccessStatus: 200
// // };
// // app.use(cors(corsOptions));

// const corsOptions = {
//   origin: function (origin, callback) {
//     callback(null, true); // allow any origin
//   },
//   credentials: true,
//   optionsSuccessStatus: 200
// };
// app.use(cors(corsOptions));

// // Body parsing middleware
// app.use(compression());
// app.use(express.json({ limit: '50mb' }));
// app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// app.use(cookieParser());

// // Session configuration for Google OAuth
// app.use(session({
//   secret: process.env.SESSION_SECRET || 'your-session-secret',
//   resave: false,
//   saveUninitialized: false,
//   cookie: { secure: process.env.NODE_ENV === 'production' }
// }));

// // Passport middleware
// app.use(passport.initialize());
// app.use(passport.session());

// // Logging
// if (process.env.NODE_ENV !== 'production') {
//   app.use(morgan('dev'));
// }

// // Static files
// app.use('/uploads', express.static('uploads'));

// // Health check
// app.get('/health', (req, res) => {
//   res.json({
//     status: 'OK',
//     timestamp: new Date().toISOString(),
//     environment: process.env.NODE_ENV
//   });
// });

// // API Routes
// app.use('/api/auth', authRoutes);
// app.use('/api/chats', chatRoutes);
// app.use('/api/files', fileRoutes);
// app.use('/api/ai', aiRoutes);
// app.use('/api/payments', paymentRoutes);
// app.use('/api/admin', adminRoutes);
// app.use('/api/users', userRoutes);

// // Error handling middleware
// app.use((err, req, res, next) => {
//   console.error('Error:', err);

//   if (err.type === 'entity.too.large') {
//     return res.status(413).json({ error: 'File too large' });
//   }

//   res.status(err.status || 500).json({
//     error: process.env.NODE_ENV === 'production'
//       ? 'Internal server error'
//       : err.message
//   });
// });

// // 404 handler
// app.use('*', (req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`🚀 Backend server running on port ${PORT}`);
//   console.log(`📊 Environment: ${process.env.NODE_ENV}`);
//   console.log(`🔗 Health check: http://localhost:${PORT}/health`);
// });

// module.exports = app;