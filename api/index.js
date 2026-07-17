require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Serve arquivos de upload (fotos de perfil)
app.use('/uploads', express.static('/app/uploads'));

// Rotas
app.use('/api/users',     require('./routes/users'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/academy',   require('./routes/academy'));
app.use('/api/benefits',  require('./routes/benefits'));
app.use('/api/ombudsman', require('./routes/ombudsman'));
app.use('/api/upload',    require('./routes/upload'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[api] Servidor rodando na porta ${PORT}`));
