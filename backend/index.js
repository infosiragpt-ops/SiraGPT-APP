const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('./src/config/passport');
const { bigintSerializerMiddleware } = require('./src/utils/bigint-serializer');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const chatRoutes = require('./src/routes/chats');
const fileRoutes = require('./src/routes/files');
const aiRoutes = require('./src/routes/ai');
const documentGenerateAiRoutes = require('./src/routes/generate-document');

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
const apiProxyRoutes = require('./src/routes/api');
const gmailRoutes = require('./src/routes/gmail');
const spotifyRoutes = require('./src/routes/spotify');
const figmaRoutes = require('./src/routes/figma');
const { router: computerUseRoutes, initializeWebSocketServer } = require('./src/routes/computer-use');
const thesisRoutes = require('./src/routes/thesis');
const researchRoutes = require('./src/routes/research');
const ragRoutes = require('./src/routes/rag');
const agentRoutes = require('./src/routes/agent');
const seAgentsRoutes = require('./src/routes/se-agents');
const searchBrainRoutes = require('./src/routes/search-brain');
const searchBrainUniversalRoutes = require('./src/routes/search-brain-universal');
const searchAgenticRoutes = require('./src/routes/search-agentic');
const artifactsRoutes = require('./src/routes/artifacts');
const hooksRoutes = require('./src/routes/hooks');
const agentKeysRoutes = require('./src/routes/agent-keys');
const projectsRoutes = require('./src/routes/projects');
const marcoTeoricoRoutes = require('./src/routes/marco-teorico');
const projectDocumentsRoutes = require('./src/routes/project-documents');
const designRoutes = require('./src/routes/design');
const planRoutes = require('./src/routes/plan');
const computeRoutes = require('./src/routes/compute');
const mathRoutes = require('./src/routes/math');
const vizRoutes = require('./src/routes/viz');
const docRoutes = require('./src/routes/doc');
const artifactRoutes = require('./src/routes/artifact');
const scheduler = require('./src/services/scheduler/scheduler');
const { runAgent } = require('./src/services/agents/agent-entry');

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1)

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

// BigInt serialization middleware
app.use(bigintSerializerMiddleware);

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
app.use('/api/search', searchAgenticRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/search-brain', searchBrainRoutes);
app.use('/api/search-brain/universal', searchBrainUniversalRoutes);
app.use('/api/gpts', gptsRoutes); // Add GPTs API routes
app.use('/api/library', libraryRoutes);
app.use('/api/proxy', apiProxyRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/figma', figmaRoutes);
app.use('/api/computer-use', computerUseRoutes);
app.use('/api/thesis', thesisRoutes);
app.use('/api/research', researchRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/se-agents', seAgentsRoutes);
app.use('/api/artifacts', artifactsRoutes);
app.use('/api/document-ai', documentGenerateAiRoutes);
app.use('/api/hooks', hooksRoutes);
app.use('/api/agent/keys', agentKeysRoutes);
app.use('/api/projects', projectsRoutes);
// Marco Teórico nested under project id — the router uses
// mergeParams:true to inherit :projectId from this mount path.
app.use('/api/projects/:projectId/marco-teorico', marcoTeoricoRoutes);
app.use('/api/projects/:projectId/documents', projectDocumentsRoutes);
app.use('/api/design', designRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/compute', computeRoutes);
app.use('/api/math', mathRoutes);
app.use('/api/viz', vizRoutes);
app.use('/api/doc', docRoutes);
app.use('/api/artifact', artifactRoutes);


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
const server = app.listen(PORT, () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

// Initialize WebSocket server for Computer Use
initializeWebSocketServer(server);

// Wire scheduler → agent: register the invoker so cron/webhook jobs
// can run the agent without the scheduler module importing the agent
// layer (which would circular-require via the skills registry).
scheduler.setInvoker(runAgent);
scheduler.start();

module.exports = app;
