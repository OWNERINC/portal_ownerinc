const { randomUUID } = require('node:crypto');
function createTemplate(templateId = 'comunicado') {
  if (templateId === 'owner-news') return createNews();
  if (templateId === 'guia-interno') return createGuide();
  return {
    schema_version: 1, template: { id: 'comunicado', version: 1 },
    metadata: { title: 'Exemplo de comunicado: vestimenta no trabalho', summary: 'Modelo ilustrativo. Não é uma política oficial; substitua e valide o conteúdo antes de publicar.', tags: [], audience: { type: 'job_titles', job_title_ids: [] } },
    presentation: { theme: 'conecta', font: 'manrope', text_scale: 'standard' },
    sections: [{ id: randomUUID(), label: 'Comunicado', rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [
      { id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Modelo ilustrativo — não é política oficial' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Use este espaço para explicar orientações de vestimenta da sua equipe. Confirme as regras com a área responsável e substitua todo o exemplo antes de publicar.' }] },
      ] } },
    ] }] }] }],
  };
}
function createNews() {
  const rich = (heading, text) => ({ id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
    { type: 'paragraph', content: [{ type: 'text', text }] },
  ] } });
  const contents = [
    ['Capa', 'Owner News — demonstração sintética', 'Edição fictícia para experimentar o editor Conecta. Não é uma comunicação oficial. Todas as pessoas e iniciativas citadas são inventadas.'],
    ['Índice', 'Nesta demonstração', 'Explore as seções deste modelo. Os links usam os identificadores estáveis das seções.'],
    ['Matéria', 'Uma biblioteca de ideias compartilhadas', 'Na equipe fictícia Horizonte, colegas organizaram uma biblioteca de boas práticas. O projeto imaginário começou com uma roda de conversa e um caderno coletivo. Este relato é apenas um exemplo de composição editorial.'],
    ['Entrevista', 'Conversa com Lia Monte Claro (pessoa fictícia)', 'Pergunta: como nasceu a ideia? Lia: reunimos perguntas do cotidiano e criamos um espaço para aprender juntos. Pergunta: qual é o próximo passo? Lia: ouvir outras equipes e registrar o que funcionar. Entrevista inteiramente sintética.'],
    ['Reconhecimentos', 'Obrigado por construir em conjunto', 'Reconhecimento demonstrativo a Caio Vale Sereno e Nina Sol Nascente, pessoas fictícias, pela colaboração na iniciativa imaginária. Substitua todo este conteúdo antes de qualquer publicação oficial.'],
  ];
  const sections = contents.map(([label, title, text]) => ({ id: randomUUID(), label, rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [rich(title, text)] }] }] }));
  sections[1].rows[0].columns[0].blocks.push(...sections.filter((_, i) => i !== 1).map(section => ({ id: randomUUID(), type: 'button', label: section.label, preset: 'secondary', destination: { type: 'section', value: section.id } })));
  return { schema_version: 2, template: { id: 'owner-news', version: 1 }, metadata: { title: 'Owner News — piloto sintético, não oficial', summary: 'Demonstração com conteúdo e pessoas fictícias. Não é uma edição histórica nem comunicação oficial.', tags: ['demonstração'], audience: { type: 'job_titles', job_title_ids: [] } }, presentation: { theme: 'conecta', font: 'manrope', text_scale: 'standard' }, sections };
}
// Product recipe: generic validated blocks only. No test fixture, media import or
// audience grant. Every creation allocates a new graph of stable UUIDs.
function createGuide() {
  const text = value => ({ type: 'text', text: value });
  const paragraph = value => ({ type: 'paragraph', content: value ? [text(value)] : [] });
  const heading = value => ({ type: 'heading', attrs: { level: 2 }, content: [text(value)] });
  const rich = (title, copy, appearance) => ({ id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [heading(title), paragraph(copy)] }, appearance });
  const row = (layout, ...blocks) => ({ id: randomUUID(), layout, columns: blocks.map(items => ({ id: randomUUID(), blocks: items })) });
  const section = (label, ...rows) => ({ id: randomUUID(), label, rows });
  const intro = rich('Para cada momento, uma escolha', 'Este exemplo mostra como criar orientações claras sem começar do zero. Troque os textos, escolha as imagens e adapte cada seção à sua equipe.', { foreground: '#2A275E' });
  intro.content.content[0].content[0].marks = [{ type: 'strong' }, { type: 'text_color', attrs: { color: '#E84F1C' } }];
  intro.tags = ['Cultura', 'Guia'];
  const cover = rich('Vestir-se bem é', 'Um guia para combinar conforto, identidade e cuidado no nosso dia a dia.', { foreground: '#2A275E', icon: 'shirt' });
  cover.content.content[0].content.push({ type: 'hard_break' }, text('sentir-se à vontade.'));
  return { schema_version: 3, template: { id: 'guia-interno', version: 1 },
    metadata: { title: 'Código de vestimenta', summary: 'Modelo ilustrativo de guia interno. Não é uma política oficial; confira e substitua o exemplo antes de publicar.', category: 'Pessoas e cultura', tags: ['Cultura', 'Guia'], audience: { type: 'job_titles', job_title_ids: [] } },
    presentation: { theme: 'conecta', defaults: { font: 'manrope', scale: 'standard', align: 'start', palette: 'conecta', foreground: '#26204A', background: '#FFFFFF', accent: '#E84F1C' } },
    sections: [section('Capa', row('single', [cover])), section('Introdução', row('single', [intro])),
      section('Orientações', row('two_equal',
        [rich('No dia a dia', 'Combine peças confortáveis e adequadas à sua rotina.', { foreground: '#2A275E', background: '#F7F6F2', icon: 'coffee' })],
        [rich('Em encontros', 'Considere o contexto e o público de cada ocasião.', { foreground: '#2A275E', background: '#F7F6F2', icon: 'users' })])),
      section('Galeria', row('single', [])),
      section('Dúvidas frequentes', row('aside_right', [{ id: randomUUID(), type: 'faq', appearance: { foreground: '#2A275E' }, items: ['Posso adaptar as orientações à minha rotina?', 'Onde encontro a política oficial?'].map(question => ({ id: randomUUID(), question, answer: { type: 'doc', content: [paragraph('')] } })) }],
        [{ id: randomUUID(), type: 'audio', media_id: null, title: 'Prefere ouvir?', transcript: '', appearance: { foreground: '#2A275E', background: '#E8E6EB', icon: 'headphones' } }]))] };
}
const templates = [{ id: 'comunicado', version: 1, schema_version: 1, name: 'Comunicado', description: 'Exemplo de vestimenta ilustrativo, não oficial.' },
  { id: 'owner-news', version: 1, schema_version: 2, name: 'Owner News · demonstração sintética', description: 'Capa, índice, matéria, entrevista e reconhecimentos fictícios. Não oficial.' },
  { id: 'guia-interno', version: 1, schema_version: 3, name: 'Guia interno', description: 'Guia ilustrativo com capa, orientações e dúvidas frequentes. Não é uma política oficial. Cria um novo rascunho, sem audiência ou mídia enviada.' }];
function listTemplates({ v3WritesEnabled = false } = {}) {
  return templates.filter(template => [1,2].includes(template.schema_version) || (template.schema_version === 3 && v3WritesEnabled === true));
}
module.exports = { createTemplate, templates, listTemplates };
