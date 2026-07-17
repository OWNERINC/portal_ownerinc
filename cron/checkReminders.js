const pool = require('./db');
const { sendEmail } = require('./sendEmail');

async function checkReminders() {
  const today = new Date();
  const day = today.getDate();

  const { rows: reminders } = await pool.query(
    'SELECT * FROM reminders WHERE active = true AND trigger_day = $1',
    [day]
  );

  if (reminders.length === 0) {
    console.log(`[checkReminders] Nenhum lembrete para o dia ${day}`);
    return;
  }

  const { rows: allUsers } = await pool.query('SELECT * FROM users');
  const usersMap = Object.fromEntries(allUsers.map(u => [u.uid, u]));

  for (const reminder of reminders) {
    const targetUsers = reminder.target_users;
    let targets = [];

    if (targetUsers === 'all') {
      targets = allUsers;
    } else if (targetUsers === 'pj') {
      targets = allUsers.filter(u => u.contract_type === 'pj' || u.is_pj);
    } else if (targetUsers === 'clt') {
      targets = allUsers.filter(u => u.contract_type === 'clt' || !u.is_pj);
    } else if (Array.isArray(targetUsers)) {
      targets = targetUsers.map(uid => usersMap[uid]).filter(Boolean);
    }

    for (const user of targets) {
      if (!user.email) continue;

      const channel = reminder.channel || 'email';

      if (channel === 'email' || channel === 'both') {
        await sendEmail({
          to: user.email,
          subject: `🔔 ${reminder.title}`,
          text: `Olá, ${user.name || 'colaborador(a)'}!\n\n${reminder.description || reminder.title}\n\n— Portal Ownerinc`,
        });
      }

      // WhatsApp: desativado — descomentar quando Z-API estiver configurado
      // if (channel === 'whatsapp' || channel === 'both') {
      //   await sendWhatsApp({ phone: user.phone, message: `🔔 ${reminder.title}\n${reminder.description}` });
      // }

      await pool.query(
        `INSERT INTO notifications_log (reminder_id, user_uid, channel, status)
         VALUES ($1, $2, $3, 'sent')`,
        [reminder.id, user.uid, channel]
      );
    }
  }

  console.log(`[checkReminders] Dia ${day} processado.`);
}

module.exports = { checkReminders };
