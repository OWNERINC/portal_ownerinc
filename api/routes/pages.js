const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { createPagesRouter } = require('../pages/router');
module.exports = createPagesRouter({ pool, authenticate: authMiddleware });
