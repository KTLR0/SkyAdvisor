const path = require('node:path');
const app = require('./app');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const port = Number(process.env.PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}

app.listen(port, '127.0.0.1', () => {
  console.log(`SkyAdvisor server running at http://127.0.0.1:${port}`);
});
