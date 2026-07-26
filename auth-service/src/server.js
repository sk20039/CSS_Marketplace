require('dotenv').config();
const { buildApp } = require('./app');

const PORT = process.env.PORT || 3001;
const app = buildApp();
app.listen(PORT, () => console.log(`[auth-service] listening on port ${PORT}`));
