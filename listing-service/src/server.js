require('dotenv').config();
require('./config').assertProductionEnv();
const { buildApp } = require('./app');

const PORT = process.env.PORT || 3002;
const app = buildApp();
app.listen(PORT, () => console.log(`[listing-service] listening on port ${PORT}`));
