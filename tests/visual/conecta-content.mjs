// Local demonstration content only. Never imported by production code.
export const jobTitles = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Analista de DHO', active: true },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Consultor de relacionamento', active: true },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Analista de tecnologia', active: true },
  { id: '10000000-0000-4000-8000-000000000004', name: 'Assistente de operações', active: true },
  { id: '10000000-0000-4000-8000-000000000005', name: 'Assistente de eventos (exemplo)', active: false },
];

export const user = {
  uid: 'visual-preview', name: 'Marina Costa', email: 'marina@example.test', role: 'admin',
  active: true, state: 'active', contract_type: 'clt', job_title: jobTitles[0].name,
  job_title_id: jobTitles[0].id, job_title_active: true,
  autocard_access: true, pos_cards_access: true, permissions: { superAdmin: true },
  phone: '', birthday: '1992-05-12', hire_date: '2024-02-01',
};

export const users = [user, ...[
  ['rafael', 'Rafael Almeida', 1, 'clt', 'active'],
  ['beatriz', 'Beatriz Nunes', 2, 'pj', 'active'],
  ['lucas', 'Lucas Martins', 3, 'clt', 'active'],
  ['camila', 'Camila Rocha', 1, 'clt', 'enable_pending'],
  ['pedro', 'Pedro Lima', 4, 'pj', 'disabled'],
].map(([id, name, title, contract, state]) => ({
  uid: `visual-${id}`, name, email: `${id}@example.test`, role: 'viewer', contract_type: contract,
  state, active: state === 'active', job_title: jobTitles[title].name, job_title_id: jobTitles[title].id,
  job_title_active: jobTitles[title].active, pj_due_day: contract === 'pj' ? 10 : null,
  permissions: state === 'disabled' ? { accountDisabled: true } : {}, firebase_enable_pending: state === 'enable_pending',
}))];

export const articles = [
  ['Primeiros passos na Ownerinc', 'Integração', `Seu primeiro dia fica mais simples quando você sabe onde encontrar apoio. Comece conferindo nome, cargo e dados de contato no perfil. Depois, explore os atalhos do Conecta e abra a trilha Primeiros passos na Ownerinc, na Academy. O objetivo é conhecer as áreas antes de assumir novas atividades.

Combine com sua liderança uma conversa de apresentação e anote as pessoas de referência para cada assunto. Organize suas dúvidas por tema: acessos, rotina, comunicação e entregas. Assim, cada conversa ajuda a resolver uma necessidade concreta.

Ao final da primeira semana, revise suas anotações e identifique o que ainda depende de acompanhamento. Este guia é demonstrativo: o roteiro oficial de integração, horários e responsáveis devem ser confirmados com o DHO.`],
  ['Como solicitar apoio ao DHO', 'Pessoas', `Para organizar uma solicitação, descreva o assunto em uma frase e explique qual resultado você precisa. Separe dúvidas de cadastro, documentos, integração e orientações sobre a rotina. Uma mensagem com contexto suficiente reduz trocas desnecessárias e facilita o encaminhamento para a pessoa responsável.

Antes de enviar, confira se há um artigo relacionado na Base de Conhecimento. Inclua apenas informações necessárias para o atendimento. Documentos pessoais, dados bancários e informações de saúde não devem ser publicados em canais coletivos. Utilize o canal privado autorizado pela empresa.

Registre a data do contato e acompanhe a resposta pelo mesmo canal para manter o histórico. Não há prazo de atendimento ou canal oficial definido neste exemplo. Conteúdo demonstrativo: confirme o procedimento vigente com a equipe de DHO.`],
  ['Conversa de desenvolvimento e feedback', 'Pessoas', `Uma conversa de desenvolvimento funciona melhor quando parte de situações observáveis. Prepare dois exemplos recentes: uma entrega que funcionou bem e uma oportunidade de melhoria. Descreva o contexto, a ação realizada e o impacto percebido, evitando julgamentos sobre características pessoais.

Durante a conversa, escute a outra perspectiva e faça perguntas para entender obstáculos. Transforme a troca em um acordo pequeno e verificável, como revisar uma etapa do trabalho ou pedir apoio em uma atividade. Combine também quando vocês voltarão a conversar sobre o avanço.

Registre somente os acordos necessários, em local adequado e com acesso restrito. Não compartilhe avaliações individuais em canais abertos. Este material demonstrativo apresenta boas práticas gerais e não substitui processos oficiais de avaliação, políticas de pessoas ou orientação da liderança.`],
  ['Segurança de acesso e senhas', 'Tecnologia', `Proteja seus acessos com senhas únicas e evite reutilizar a mesma combinação entre serviços pessoais e profissionais. Quando disponível e autorizado, utilize autenticação em duas etapas e um gerenciador de senhas aprovado. Nunca compartilhe códigos temporários, tokens ou credenciais em conversas e documentos coletivos.

Ao receber um pedido inesperado de acesso, confira o endereço do remetente e confirme a solicitação por outro canal conhecido. Não abra arquivos suspeitos nem informe uma senha em páginas acessadas por links duvidosos. Se já tiver interagido com uma mensagem suspeita, procure a equipe responsável e descreva o ocorrido sem ocultar detalhes importantes.

Bloqueie a tela ao se afastar do computador. Este conteúdo é demonstrativo: ferramentas aprovadas, contatos de suporte e procedimentos de resposta a incidentes devem ser consultados nas orientações oficiais da empresa.`],
  ['Organize suas ferramentas de trabalho', 'Tecnologia', `Uma rotina digital organizada começa com o mínimo necessário para a atividade do dia. Liste os sistemas usados pela sua área e confirme quais acessos foram autorizados. Guarde os endereços oficiais nos favoritos e evite depender de links recebidos em mensagens antigas, especialmente para páginas de autenticação.

Separe arquivos por projeto e use nomes que indiquem assunto e versão. Antes de criar uma nova cópia, verifique se existe um documento compartilhado que deve continuar sendo a referência da equipe. Ajuste as permissões de leitura e edição de acordo com a necessidade de cada participante.

Quando algo não funcionar, anote a mensagem de erro, o horário e os passos executados. Remova informações sensíveis de qualquer captura antes de encaminhá-la ao suporte. Este roteiro é demonstrativo e não define ferramentas obrigatórias nem autoriza instalação de aplicativos.`],
  ['Passagem de atendimento entre equipes', 'Atendimento', `Uma boa passagem de atendimento permite continuar a conversa sem fazer o cliente repetir toda a história. Registre o motivo do contato, o que já foi verificado e qual é a próxima ação esperada. Diferencie fatos confirmados, hipóteses e informações que ainda precisam ser consultadas antes de responder.

Antes de encaminhar, confirme qual equipe pode atuar no caso e compartilhe somente os dados necessários pelo canal autorizado. Evite prometer prazos que ainda não foram combinados com a área responsável. Avise o cliente sobre o encaminhamento usando uma linguagem clara e respeitosa.

Ao receber um caso, leia o histórico e confirme o entendimento com a pessoa que o encaminhou quando houver dúvidas. Este exemplo demonstrativo não descreve um fluxo operacional oficial: filas, responsabilidades e prazos reais dependem do procedimento vigente de cada área.`],
  ['Checklist de uma comunicação acolhedora', 'Atendimento', `Comece a conversa identificando a necessidade da pessoa, sem antecipar uma solução antes de entender o contexto. Use perguntas abertas, explique termos pouco conhecidos e confirme os pontos principais com suas próprias palavras. Um atendimento acolhedor combina atenção, clareza e respeito pelo tempo de quem procura ajuda.

Ao orientar uma ação, apresente uma etapa de cada vez e informe o que acontecerá depois. Se uma informação depender de confirmação, diga isso explicitamente. Evite respostas genéricas, abreviações internas e promessas sem respaldo. Antes de encerrar, pergunte se a orientação resolveu a dúvida inicial.

Registre o acordo final no sistema autorizado e preserve a privacidade de quem foi atendido. Conteúdo demonstrativo para apoiar a navegação da prévia; modelos de mensagem e compromissos de atendimento oficiais precisam ser validados pela área responsável.`],
  ['Sua primeira semana: um roteiro de consulta', 'Integração', `Use a primeira semana para construir uma visão do trabalho e da equipe. No início, conheça os canais de comunicação, confira seus acessos e alinhe as primeiras prioridades com a liderança. Consulte os artigos de integração e separe um período para iniciar a formação disponível na Academy.

Nos dias seguintes, acompanhe uma atividade real com alguém da área e observe como as informações passam entre as pessoas. Anote siglas, decisões frequentes e dúvidas que surgirem. Organize uma lista curta de próximos passos em vez de tentar memorizar todos os procedimentos de uma vez.

No fechamento da semana, converse sobre o que você já consegue fazer com autonomia e onde ainda precisa de apoio. Este roteiro demonstrativo não estabelece metas, horários ou obrigações; cada área deve confirmar seu calendário e as orientações oficiais de integração.`],
].map(([title, category, content], index) => ({
  id: `article-${index + 1}`, title, category, content, created_at: '2026-11-03T12:00:00Z',
}));

export const benefits = [
  ['Bem-estar em movimento', 'Bem-estar', 'Exemplo de programa de atividades e pausas para uma rotina equilibrada.', 'Consulte o DHO sobre programas vigentes. Não há contratação ou desconto real nesta prévia.'],
  ['Apoio ao desenvolvimento', 'Educação', 'Exemplo de apoio a cursos e encontros de aprendizagem relacionados ao trabalho.', 'Alinhe o tema com a liderança antes de qualquer inscrição. Condições e valores são demonstrativos.'],
  ['Clube de leitura', 'Educação', 'Exemplo de encontros para compartilhar leituras, referências e práticas entre áreas.', 'Demonstração sem inscrições: confira com a equipe se existe um grupo ativo.'],
  ['Rede de cuidados', 'Bem-estar', 'Exemplo de orientação para encontrar recursos de cuidado e qualidade de vida.', 'Procure o canal privado autorizado. Este exemplo não representa cobertura médica ou assistência contratada.'],
].map(([company, category, description, instructions], index) => ({
  id: `benefit-${index + 1}`, company, category, description: `${description} Conteúdo demonstrativo.`, instructions, active: true,
}));

export const autocards = [
  ['comunicado', 'Encontro de integração · exemplo', { titulo: 'Vamos nos conectar', subtitulo: 'Integração · exemplo', regraPrincipal: 'Um encontro para conhecer a equipe', corpo: 'Conteúdo demonstrativo. Combine os próximos passos com sua liderança.' }, 'triangle-alert'],
  ['vaga', 'Relacionamento · vaga demonstrativa', { titulo: 'Consultor de relacionamento', subtitulo: 'Equipe de atendimento · exemplo', descricao: 'Uma oportunidade fictícia para demonstrar a edição de cards.', requisitos: 'Escuta ativa\nClareza na comunicação', beneficios: 'Conteúdo demonstrativo', prazo: '30/11', contato: 'equipe@example.test' }, 'briefcase-business'],
  ['aniversariante', 'Aniversário da Beatriz · exemplo', { titulo: 'Beatriz Nunes', data: '18/11' }, 'cake'],
  ['novo_funcionario', 'Boas-vindas ao Lucas · exemplo', { titulo: 'Lucas Martins', subtitulo: 'Assistente de operações · exemplo', data: '09/11', corpo: 'Que bom ter você por aqui! Este é um card demonstrativo de boas-vindas.' }, 'user'],
].map(([template, name, values, icon], index) => ({
  id: `autocard-${index + 1}`, template, name, values, icon, illustration: null,
  mode: 'light', variant: 'editorial', mediaSize: 'medium', mediaId: null, mediaCrop: { x: 50, y: 50, zoom: 1 },
  updatedAt: '2026-11-08T14:00:00Z',
}));

export const posCards = ['convite_owntime', 'convite_owner'].map((template, index) => ({
  id: `pos-card-${index + 1}`, template, name: index ? 'Reserva Owner · demonstração' : 'Convite de experiência · demonstração',
  values: {
    heroTitle: index ? 'Confirmação de' : 'Um convite', heroEmphasis: index ? 'reserva' : 'a viver o seu tempo', heroBrand: 'Owntime',
    salutation: 'Olá, pessoa convidada.', greeting: 'Este é um convite demonstrativo, sem reserva ou validade comercial.',
    stayInfo: 'Responsável: Equipe de demonstração\nHóspedes: 2 adultos\nUnidade: exemplo\nCheck-in: a combinar\nCheck-out: a combinar',
    experienceTitle: 'Uma experiência para conhecer', experienceBody: 'Conteúdo fictício para conferir a composição do convite.',
    consumptionTitle: 'Informações da experiência', consumptionBody: 'Nenhuma hospedagem está sendo contratada.',
    notIncludedTitle: 'Importante', notIncludedBody: 'Exemplo sem benefícios, serviços ou disponibilidade garantidos.',
    afterStay: 'Demonstração visual dos Cards Pós.', conditions: 'Sem reserva real. Não compartilhar como confirmação de hospedagem.',
    address: 'Endereço demonstrativo', includedIntro: 'Este material apresenta apenas a estrutura visual de uma confirmação.',
    includedTitle: 'Informações demonstrativas', cleaning: 'Serviço ilustrativo, sem contratação.', support: 'Apoio ilustrativo da equipe.',
    paidTitle: 'Condições a confirmar', utilities: 'Valores não informados nesta demonstração.', pet: 'Condições não contratadas.',
    servicesIntro: 'Serviços apenas ilustrativos:', gastronomy: 'Gastronomia', chef: 'Chef em casa', extraCleaning: 'Limpeza adicional',
    babysitter: 'Babysitter', trainer: 'Personal trainer', carWash: 'Car wash', hostNote: 'Não há contato ou agendamento real nesta prévia.',
    footerLabel: 'DEMONSTRAÇÃO', contact: 'Sem contato real', footerEmail: 'equipe@example.test',
  },
  mediaId: null, updatedAt: '2026-11-08T16:00:00Z',
}));
