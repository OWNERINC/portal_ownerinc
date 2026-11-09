import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

test('public pages and notification UI modules use Notificações without renaming technical contracts', async () => {
  const pages = (await readdir('public')).filter(name => name.endsWith('.html'));
  const paths = [
    ...pages.map(name => `public/${name}`),
    'public/js/reminders.js', 'public/js/dashboard.js', 'scripts/generate-public-shell.mjs',
  ];
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /lembretes?/i, `${path}: old user-facing name`);
    if (path.endsWith('.html') && source.includes('class="sidebar-nav"')) {
      assert.match(source, /href="\.\/reminders\.html"[^>]*title="Notificações"/);
      assert.match(source, /<span>Notificações<\/span>/);
    }
  }
  const page = await readFile('public/reminders.html', 'utf8');
  assert.match(page, /<title>Notificações — Conecta Ownerinc<\/title>/);
  assert.match(page, /<h1>Notificações<\/h1>/);
  assert.match(page, /id="btn-new-reminder"[^>]*>Nova notificação<\/button>/);
  assert.match(page, /id="modal-reminder-title">Nova notificação<\/span>/);
  assert.match(page, /id="reminders-tbody"/);
  const module = await readFile('public/js/reminders.js', 'utf8');
  for (const copy of [
    'Nenhuma notificação cadastrada.', 'Detalhe da notificação',
    'Esta notificação não está disponível para sua conta.',
    'Não foi possível carregar as notificações.', 'Editar notificação',
    'Excluir esta notificação?', 'Notificação excluída.',
    'Notificação atualizada.', 'Notificação criada.',
  ]) assert.ok(module.includes(copy), copy);
  assert.ok(module.includes("'/api/reminders'"));
  assert.ok(module.includes('filters.reminder_id'));
  const dashboard = await readFile('public/dashboard.html', 'utf8');
  assert.match(dashboard, /Próximas notificações/);
  const admin = await readFile('public/admin.html', 'utf8');
  assert.match(admin, /for="p-reminders">Gerenciar Notificações/);
});
