const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const app = require('./app');
const { getDatabase, closeDatabase } = require('./database');

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}

async function start() {
  try {
    await getDatabase();
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`SkyAdvisor server running at http://127.0.0.1:${port}`);
      console.log('MongoDB Atlas connection established.');
    });

    const shutdown = async () => {
      server.close(async () => {
        await closeDatabase();
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Could not connect to MongoDB. Check MONGODB_URI, MONGODB_USERNAME, MONGODB_PASSWORD, Atlas network access, and database-user permissions.');
    console.error(`MongoDB connection error: ${error.name || 'Error'}`);
    process.exitCode = 1;
  }
}

start();
