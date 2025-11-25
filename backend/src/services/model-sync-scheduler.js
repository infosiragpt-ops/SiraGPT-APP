const cron = require('node-cron');
const modelSyncService = require('./model-sync-service');

class ModelSyncScheduler {
  constructor() {
    this.syncJob = null;
    this.isRunning = false;
  }

  /**
   * Start the model sync scheduler
   * Runs on the 1st day of every month at 2:00 AM
   */
  start(schedule = '0 2 1 * *') { // Monthly on 1st day at 2:00 AM
    if (this.syncJob) {
      console.log('⚠️ Model sync scheduler is already running');
      return;
    }

    console.log(`🔄 Starting model sync scheduler with schedule: ${schedule}`);
    
    this.syncJob = cron.schedule(schedule, async () => {
      if (this.isRunning) {
        console.log('⏭️ Skipping model sync - already running');
        return;
      }

      try {
        this.isRunning = true;
        console.log('🚀 Starting scheduled model sync...');
        
        const result = await modelSyncService.syncModelsToDatabase();
        
        console.log(`✅ Scheduled model sync completed: ${result.created} created, ${result.updated} updated, ${result.errors} errors`);
        
        // Log sync activity
        await this.logSyncActivity(result);
        
      } catch (error) {
        console.error('❌ Scheduled model sync failed:', error);
        await this.logSyncError(error);
      } finally {
        this.isRunning = false;
      }
    }, {
      scheduled: false,
      timezone: "UTC"
    });

    this.syncJob.start();
    console.log('✅ Model sync scheduler started');
  }

  /**
   * Stop the model sync scheduler
   */
  stop() {
    if (this.syncJob) {
      this.syncJob.stop();
      this.syncJob = null;
      console.log('🛑 Model sync scheduler stopped');
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isScheduled: !!this.syncJob,
      isRunning: this.isRunning,
      nextRun: this.syncJob ? this.getNextRun() : null
    };
  }

  /**
   * Get next scheduled run time
   */
  getNextRun() {
    if (!this.syncJob) return null;
    
    try {
      // Calculate next 1st of month at 2:00 AM
      const now = new Date();
      const nextMonth = new Date(now);
      
      if (now.getDate() === 1 && now.getHours() < 2) {
        // If it's the 1st and before 2 AM, next run is today at 2 AM
        nextMonth.setHours(2, 0, 0, 0);
      } else {
        // Otherwise, next run is 1st of next month at 2 AM
        nextMonth.setMonth(now.getMonth() + 1);
        nextMonth.setDate(1);
        nextMonth.setHours(2, 0, 0, 0);
      }
      
      return nextMonth;
    } catch (error) {
      console.error('Error getting next run time:', error);
      return null;
    }
  }

  /**
   * Run sync immediately (manual trigger)
   */
  async runImmediately() {
    if (this.isRunning) {
      throw new Error('Model sync is already running');
    }

    try {
      this.isRunning = true;
      console.log('🔄 Running manual model sync...');
      
      const result = await modelSyncService.syncModelsToDatabase();
      
      console.log(`✅ Manual model sync completed: ${result.created} created, ${result.updated} updated, ${result.errors} errors`);
      
      await this.logSyncActivity(result, 'manual');
      
      return result;
    } catch (error) {
      console.error('❌ Manual model sync failed:', error);
      await this.logSyncError(error, 'manual');
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Log sync activity to system settings for tracking
   */
  async logSyncActivity(result, trigger = 'scheduled') {
    try {
      const prisma = require('../config/database');
      
      const logData = {
        timestamp: new Date().toISOString(),
        trigger,
        result,
        status: 'success'
      };

      await prisma.systemSettings.upsert({
        where: { key: 'last_model_sync' },
        update: { value: JSON.stringify(logData) },
        create: { 
          key: 'last_model_sync', 
          value: JSON.stringify(logData) 
        }
      });

      // Keep a history of last 10 syncs
      const historyKey = 'model_sync_history';
      const existingHistory = await prisma.systemSettings.findUnique({
        where: { key: historyKey }
      });

      let history = [];
      if (existingHistory) {
        try {
          history = JSON.parse(existingHistory.value);
        } catch (e) {
          history = [];
        }
      }

      history.unshift(logData);
      history = history.slice(0, 10); // Keep only last 10

      await prisma.systemSettings.upsert({
        where: { key: historyKey },
        update: { value: JSON.stringify(history) },
        create: { 
          key: historyKey, 
          value: JSON.stringify(history) 
        }
      });

    } catch (error) {
      console.error('❌ Error logging sync activity:', error);
    }
  }

  /**
   * Log sync errors
   */
  async logSyncError(error, trigger = 'scheduled') {
    try {
      const prisma = require('../config/database');
      
      const logData = {
        timestamp: new Date().toISOString(),
        trigger,
        error: error.message,
        stack: error.stack,
        status: 'error'
      };

      await prisma.systemSettings.upsert({
        where: { key: 'last_model_sync_error' },
        update: { value: JSON.stringify(logData) },
        create: { 
          key: 'last_model_sync_error', 
          value: JSON.stringify(logData) 
        }
      });

    } catch (logError) {
      console.error('❌ Error logging sync error:', logError);
    }
  }

  /**
   * Get sync history
   */
  async getSyncHistory() {
    try {
      const prisma = require('../config/database');
      
      const [lastSync, syncHistory, lastError] = await Promise.all([
        prisma.systemSettings.findUnique({ where: { key: 'last_model_sync' } }),
        prisma.systemSettings.findUnique({ where: { key: 'model_sync_history' } }),
        prisma.systemSettings.findUnique({ where: { key: 'last_model_sync_error' } })
      ]);

      return {
        lastSync: lastSync ? JSON.parse(lastSync.value) : null,
        history: syncHistory ? JSON.parse(syncHistory.value) : [],
        lastError: lastError ? JSON.parse(lastError.value) : null,
        status: this.getStatus()
      };
    } catch (error) {
      console.error('❌ Error getting sync history:', error);
      return {
        lastSync: null,
        history: [],
        lastError: null,
        status: this.getStatus()
      };
    }
  }
}

// Create singleton instance
const modelSyncScheduler = new ModelSyncScheduler();

// Auto-start if in production and API keys are available
if (process.env.NODE_ENV === 'production') {
  const hasApiKeys = process.env.OPENAI_API_KEY || 
                     process.env.GEMINI_API_KEY || 
                     process.env.OPENROUTER_API_KEY;
  
  if (hasApiKeys) {
    // Wait a bit for the app to start up
    setTimeout(() => {
      modelSyncScheduler.start();
      console.log('🔄 Auto-started model sync scheduler in production mode');
    }, 30000); // 30 seconds delay
  }
}

module.exports = modelSyncScheduler;