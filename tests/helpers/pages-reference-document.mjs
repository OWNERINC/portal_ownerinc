// Test-only v3 draft. Copy transcribed from the six original Editor V2 boards.
// No product template, upload, database or validator is invoked here.
const id = number => `e2d00000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

export const referenceIds = Object.freeze({
  coverSection: id(1), introductionSection: id(2), orientationsSection: id(3),
  gallerySection: id(4), faqSection: id(5),
  coverBlock: id(101), introductionBlock: id(102), dailyBlock: id(103), meetingsBlock: id(104),
  imageBlock: id(105), galleryBlock: id(106), guideButton: id(107), faqBlock: id(108), audioBlock: id(109),
  faqItem: id(201), officialPolicyItem: id(202), galleryItem: id(203),
  syntheticImageMedia: id(401), jobTitle: id(501),
});

const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const paragraph = value => ({ type: 'paragraph', content: value ? [text(value)] : [] });
const heading = (value, marks) => ({ type: 'heading', attrs: { level: 2 }, content: [text(value, marks)] });
const prose = (...content) => ({ type: 'doc', content });
const rich = (blockId, ...content) => ({ id: blockId, type: 'rich_text', content: prose(...content) });
const row = (number, ...columns) => ({
  id: id(number), layout: columns.length === 2 ? 'two_equal' : 'single',
  columns: columns.map((blocks, index) => ({ id: id(number + 100 + index), blocks })),
});
const section = (sectionId, label, ...rows) => ({ id: sectionId, label, rows });

export function referenceDocument() {
  const ids = referenceIds;
  return {
    schema_version: 3,
    template: { id: 'guia-interno', version: 1 },
    metadata: {
      title: 'Código de vestimenta',
      summary: 'Um guia para combinar conforto, identidade e cuidado no nosso dia a dia.',
      category: 'Pessoas e cultura', tags: ['Cultura', 'Guia'],
      audience: { type: 'job_titles', job_title_ids: [ids.jobTitle] },
    },
    presentation: { theme: 'conecta', defaults: {
      font: 'manrope', scale: 'standard', align: 'start', palette: 'conecta',
      foreground: '#26204A', background: '#FFFFFF', accent: '#E84F1C',
    } },
    sections: [
      section(ids.coverSection, 'Capa', row(601, [
        { ...rich(ids.coverBlock,
          { type: 'heading', attrs: { level: 2 }, content: [text('Vestir-se bem é'), { type: 'hard_break' }, text('sentir-se à vontade.')] },
          paragraph('Um guia para combinar conforto, identidade e cuidado no nosso dia a dia.')),
        appearance: { foreground: '#2A275E', icon: 'shirt' } },
      ])),
      section(ids.introductionSection, 'Introdução', row(602, [
        { ...rich(ids.introductionBlock,
          heading('Para cada momento, uma escolha', [{ type: 'strong' }, { type: 'text_color', attrs: { color: '#E84F1C' } }]),
          paragraph('Este exemplo mostra como criar orientações claras sem começar do zero. Troque os textos, escolha as imagens e adapte cada seção à sua equipe.')),
        tags: ['Cultura', 'Guia'], appearance: { foreground: '#2A275E' } },
      ])),
      section(ids.orientationsSection, 'Orientações', row(603,
        [{ ...rich(ids.dailyBlock, heading('No dia a dia'), paragraph('Combine peças confortáveis e adequadas à sua rotina.')),
          appearance: { foreground: '#2A275E', background: '#F7F6F2', icon: 'coffee' } }],
        [{ ...rich(ids.meetingsBlock, heading('Em encontros'), paragraph('Considere o contexto e o público de cada ocasião.')),
          appearance: { foreground: '#2A275E', background: '#F7F6F2', icon: 'users' } }],
      )),
      // Preserve navigation/structural IDs without adding unpictured content.
      section(ids.gallerySection, 'Galeria', row(605, [])),
      section(ids.faqSection, 'Dúvidas frequentes', { ...row(607,
        [{ id: ids.faqBlock, type: 'faq', appearance: { foreground: '#2A275E' }, items: [
          { id: ids.faqItem, question: 'Posso adaptar as orientações à minha rotina?', answer: prose(paragraph('')) },
          { id: ids.officialPolicyItem, question: 'Onde encontro a política oficial?', answer: prose(paragraph('')) },
        ] }],
        [{ id: ids.audioBlock, type: 'audio', media_id: null, title: 'Prefere ouvir?', transcript: '',
          appearance: { foreground: '#2A275E', background: '#E8E6EB', icon: 'headphones' } }],
      ), layout: 'aside_right' }),
    ],
  };
}

// Functional coverage only, not the visual golden. These media IDs must be
// registered with referenceMedia() by the disposable harness before rendering;
// an in-memory reference is not an upload receipt or a publishing assertion.
export function featureDocument() {
  const document = referenceDocument();
  const ids = referenceIds;
  const gallery = document.sections.find(section => section.id === ids.gallerySection);
  gallery.rows[0].columns[0].blocks.push(
    { id: ids.imageBlock, type: 'image', media_id: ids.syntheticImageMedia, alt: '', caption: '', credit: '' },
    { id: ids.galleryBlock, type: 'gallery', items: [
      { id: ids.galleryItem, kind: 'image', media_id: ids.syntheticImageMedia, alt: '', caption: '', credit: '' },
    ] },
    { id: ids.guideButton, type: 'button', label: 'Ver guia completo', preset: 'primary',
      action: { type: 'section', value: ids.orientationsSection } },
  );
  return document;
}

// Optional bytes for isolated harness registration/interaction tests, NOT a
// claimed upload in the source-matching draft. Fresh descriptors/buffers per call.
// Same generated 1×1 PNG already used by dependency-free API tests in this repo.
export function referenceMedia() {
  return [{
    id: referenceIds.syntheticImageMedia, kind: 'image', mime_type: 'image/png',
    file_name: 'synthetic-reference.png', width: 1, height: 1, duration_ms: null, synthetic: true,
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  }];
}
