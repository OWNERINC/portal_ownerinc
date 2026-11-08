// Visual fixtures only: never imported by public code or production services.
export const user = {
  uid: 'visual-preview', name: 'Marina Costa', email: 'marina@example.test', role: 'admin',
  active: true, contract_type: 'CLT', job_title: 'Analista de DHO', job_title_id: 'dho',
  autocard_access: true, pos_cards_access: true, permissions: { superAdmin: true },
  phone: '(11) 99999-0100', birthday: '1992-05-12', hire_date: '2024-02-01',
};
const courses = [
  ['culture', 'Conheça a Ownerinc', 'Cultura', 'initial', 'icon-02'],
  ['tools', 'Ferramentas para o dia a dia', 'Integração', 'initial', 'icon-04'],
  ['service', 'Relacionamento com o cliente', 'Atendimento', 'role', 'icon-06'],
].map(([id, title, category, learning_group, icon_key]) => ({
  id, title, category, learning_group, icon_key, delivery_mode: 'internal', active: true,
  description: 'Conheça as práticas e os recursos que apoiam o trabalho da nossa equipe.',
  total_lessons: 5, completed_lessons: 3, progress_percent: 60, resume_lesson_id: `${id}-4`,
  instructor_name: 'Equipe Ownerinc', audience: 'all',
}));
const articles = [
  ['Primeiros passos na Ownerinc', 'Integração'], ['Ferramentas de trabalho', 'Tecnologia'],
  ['Como solicitar apoio ao DHO', 'Pessoas'],
].map(([title, category], i) => ({ id: `article-${i + 1}`, title, category, content: 'Este é um conteúdo demonstrativo para conferir leitura, hierarquia e navegação.\n\nConsulte os recursos da equipe e acompanhe seus próximos passos no Portal.', created_at: '2026-11-03T12:00:00Z' }));
const reminders = ['Encontro de boas-vindas', 'Atualização cadastral', 'Integração da equipe'].map((title, i) => ({
  id: `550e8400-e29b-41d4-a716-44665544000${i}`, title, description: 'Reserve este momento para se conectar com a equipe.',
  next_date: `2026-11-${10 + i}`, next_occurrence: `2026-11-${10 + i}`, trigger_day: 10 + i,
  active: true, target_users: 'all', channel: 'email', created_at: '2026-11-01T12:00:00Z',
}));

export function fixtureData(url) {
  const path = url.pathname;
  if (path === '/api/users/me') return user;
  if (path === '/api/users') return [user, { ...user, uid: 'visual-second', name: 'Rafael Almeida', email: 'rafael@example.test', role: 'viewer', job_title: 'Consultor' }];
  if (path === '/api/job-titles' || path === '/api/academy/job-titles') return [{ id: 'dho', name: 'Analista de DHO', active: true }];
  if (path === '/api/knowledge/categories') return ['Integração', 'Tecnologia', 'Pessoas'];
  if (path === '/api/knowledge') return articles.filter(item => !url.searchParams.get('category') || item.category === url.searchParams.get('category'));
  if (path.startsWith('/api/knowledge/')) return articles.find(item => path.endsWith(item.id));
  if (path === '/api/reminders/cron-status') return { status: 'ok', last_run: '2026-11-08T12:00:00Z' };
  if (path === '/api/reminders/deliveries') return [];
  if (path === '/api/reminders' || path === '/api/reminders/upcoming') return reminders;
  if (path.startsWith('/api/reminders/')) return reminders.find(item => path.endsWith(item.id));
  if (path === '/api/academy/categories') return ['Cultura', 'Integração', 'Atendimento'];
  if (path === '/api/academy/continue') return [courses[0]];
  if (path === '/api/academy') return courses.filter(item => !url.searchParams.get('group') || item.learning_group === url.searchParams.get('group'));
  if (path.startsWith('/api/academy/lessons/')) {
    const id = path.split('/').at(-1);
    return { course_id: 'culture', lesson: { id, title: 'Nosso jeito de trabalhar', media_version: 1 }, media: null,
      progress: { lesson_id: id, media_version: 1, completed: false, position_seconds: 0, version: 0 }, next_lesson_id: null,
      description: 'Conteúdo demonstrativo. A reprodução real é validada em ambiente autenticado.' };
  }
  if (path.startsWith('/api/academy/')) {
    const course = courses.find(item => path.endsWith(item.id));
    if (course) return { course, modules: [{ id: 'module-intro', title: 'Primeiros passos', lessons: ['Boas-vindas', 'Nossa história', 'Nossos valores', 'Nosso jeito de trabalhar', 'Próximos passos'].map((title, i) => ({ id: `${course.id}-${i + 1}`, title, media_version: 1, completed: i < 3 })) }] };
  }
  if (path === '/api/solides/admin/status') return { enabled: false, available: false };
  if (path === '/api/solides/me/status') return { linked: true };
  if (path.startsWith('/api/solides/me/')) return {};
  if (['/api/benefits', '/api/benefits/categories', '/api/audit', '/api/audit-log', '/api/registrations', '/api/autocard/cards', '/api/pos-cards/cards'].includes(path)) return [];
  return undefined;
}
