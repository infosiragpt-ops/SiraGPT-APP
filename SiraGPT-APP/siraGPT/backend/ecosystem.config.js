// ──────────────────────────────────────────────────────────────
// siraGPT — PM2 Ecosystem File (Production)
// ──────────────────────────────────────────────────────────────
// Use PM2 as the production process manager for:
//   1. Automatic restart on crash (uncaught exceptions, OOM kills)
//   2. Log rotation (keeps logs from filling the disk)
//   3. Graceful shutdown via SIGTERM forwarding to Node
//   4. Cluster mode (optional, when SCALE=true)
//
// Usage:
//   pm2 start ecosystem.config.js               # single instance
//   SCALE=true pm2 start ecosystem.config.js    # cluster mode
//   pm2 restart ecosystem.config.js             # zero-downtime reload
//
// Metrics (optional): pm2 install pm2-metrics
// Monitoring (optional): pm2 install pm2-server-monit
// ──────────────────────────────────────────────────────────────

module.exports = {
  apps: [
    {
      name: 'siraGPT-api',
      script: 'index.js',
      cwd: __dirname,

      // ─── Process Behavior ───────────────────────────────
      // Single instance by default; cluster mode with SCALE=true
      exec_mode: process.env.SCALE === 'true' ? 'cluster' : 'fork',
      instances: process.env.SCALE === 'true' ? (parseInt(process.env.INSTANCES, 10) || 'max') : 1,

      // ─── Restart Policy ─────────────────────────────────
      // Restart on crash with exponential backoff
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,

      // Kill timeout: give the graceful shutdown handler 10s
      kill_timeout: 10000,
      listen_timeout: 30000,

      // ─── Environment ────────────────────────────────────
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },

      // ─── Logging ─────────────────────────────────────────
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      log_file: 'logs/combined.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,

      // ─── Resource Limits ─────────────────────────────────
      // Prevent memory leaks from taking down the whole server
      max_memory_restart: '2G',

      // ─── Watch Mode (development only) ──────────────────
      watch: process.env.NODE_ENV !== 'production',
      ignore_watch: ['node_modules', 'logs', 'uploads', '.git'],

      // ─── Error Handling ─────────────────────────────────
      // Log uncaught exceptions before PM2 restarts
      log_type: 'json',
    },
  ],
};
