require('dotenv').config();
require('./config').assertProductionEnv();

const { buildApp } = require('./app');
const { startScheduler } = require('./scheduler');

const PORT = Number(process.env.PORT || 3000);

const app = buildApp();

app.listen(PORT, () => {
  console.log(`[server] Escrow service listening on http://localhost:${PORT}`);
  console.log(`[server] Demo UI: http://localhost:${PORT}/index.html`);
  startScheduler();
});
