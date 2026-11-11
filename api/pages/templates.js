const { randomUUID } = require('node:crypto');
function createTemplate(templateId = 'comunicado') {
  if (templateId === 'owner-news') return createNews();
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
const templates = [{ id: 'comunicado', version: 1, name: 'Comunicado', description: 'Exemplo de vestimenta ilustrativo, não oficial.' },
  { id: 'owner-news', version: 1, name: 'Owner News · demonstração sintética', description: 'Capa, índice, matéria, entrevista e reconhecimentos fictícios. Não oficial.' }];
module.exports = { createTemplate, templates };
