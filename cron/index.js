require('dotenv').config();
const cron = require('node-cron');
const { checkReminders } = require('./checkReminders');

// Roda todo dia às 08:00 horário de Brasília
cron.schedule('0 8 * * *', async () => {
  console.log('[cron] Executando checkReminders...');
  try {
    await checkReminders();
  } catch (err) {
    console.error('[cron] Erro ao executar checkReminders:', err);
  }
}, { timezone: 'America/Sao_Paulo' });

console.log('[cron] Serviço de lembretes iniciado. Aguardando próximo disparo às 08:00 (Brasília).');
