// Academy curriculum fixtures. No playable media or progress writes.
import { jobTitles } from './conecta-content.mjs';

const definitions = [
  {
    id: 'culture', title: 'Primeiros passos na Ownerinc', category: 'Cultura', learning_group: 'initial', icon_key: 'icon-02',
    description: 'Conheça a equipe, organize sua chegada e descubra como usar o Conecta no dia a dia. Trilha demonstrativa de integração com seis aulas em dois módulos; não substitui o onboarding oficial da empresa.',
    instructor_name: 'Equipe de DHO · demonstração', completed: 3,
    modules: [
      ['Conhecer e pertencer', [
        ['Boas-vindas', 'Comece conhecendo os objetivos da integração e as pessoas que podem apoiar sua chegada. Anote suas primeiras dúvidas e combine uma conversa com a liderança para alinhar expectativas e próximos passos.'],
        ['Nossa história', 'Explore como a trajetória de uma empresa ajuda a entender suas escolhas atuais. Nesta atividade, prepare perguntas sobre os principais marcos da equipe e procure as fontes oficiais para conhecer a história da Ownerinc.'],
        ['Nossos valores', 'Reflita sobre atitudes que fortalecem o trabalho em equipe: clareza, responsabilidade e cuidado nas relações. Escolha uma situação do cotidiano e converse com a liderança sobre os valores oficiais que orientam a decisão.'],
      ]],
      ['Conectar e colocar em prática', [
        ['Nosso jeito de trabalhar', 'Organize sua rotina com prioridades claras e acordos de comunicação. Identifique onde registrar uma demanda, quando pedir ajuda e como avisar sobre um impedimento. Ao final, monte um pequeno checklist para sua primeira semana.'],
        ['Seu guia do Conecta', 'Navegue pelo perfil, pela Base de Conhecimento e pelos lembretes. Descubra como encontrar um artigo, retomar uma aula e consultar uma orientação. Confirme as informações reais com a área responsável antes de executar um procedimento.'],
        ['Próximos passos', 'Revise o que aprendeu e escolha uma atividade para realizar com acompanhamento. Registre as dúvidas que ainda precisam de resposta e combine uma nova conversa para avaliar sua adaptação e os próximos objetivos de desenvolvimento.'],
      ]],
    ],
  },
  {
    id: 'service', title: 'Atendimento e relacionamento com o cliente', category: 'Atendimento', learning_group: 'role', icon_key: 'icon-06',
    description: 'Pratique escuta, comunicação clara e continuidade do atendimento. Trilha demonstrativa por cargo, com situações fictícias para apoiar a leitura e a navegação; procedimentos e prazos reais devem ser validados pela área.',
    instructor_name: 'Equipe de relacionamento · demonstração', completed: 0,
    modules: [
      ['Entender para acolher', [
        ['Escuta ativa na prática', 'Antes de responder, entenda o que a pessoa precisa resolver. Prepare perguntas abertas, confirme seu entendimento e evite interromper o relato. Nesta atividade fictícia, transforme uma solicitação genérica em uma necessidade bem definida.'],
        ['Comunicação clara e empática', 'Explique uma orientação em frases curtas e sem siglas internas. Diferencie o que já está confirmado do que depende de outra equipe e revise a mensagem para retirar promessas sem respaldo. Use um tom respeitoso, direto e acolhedor.'],
        ['Conhecer a jornada do cliente', 'Observe os momentos de contato entre cliente e equipe: chegada, esclarecimento, encaminhamento e acompanhamento. Desenhe uma jornada fictícia e identifique onde informações claras ajudam a reduzir dúvidas e retrabalho.'],
      ]],
      ['Cuidar da continuidade', [
        ['Registro e passagem de atendimento', 'Organize um registro com contexto, verificações realizadas e próxima ação esperada. Compartilhe somente os dados necessários pelo canal autorizado. Revise um caso fictício e confirme se outra pessoa conseguiria continuar o atendimento sem repetir perguntas.'],
        ['Situações delicadas e encaminhamento', 'Reconheça quando uma demanda exige apoio de outra área. Acolha a pessoa, explique o próximo passo e confirme quem pode decidir sobre o caso. Evite prometer prazos ou exceções antes de receber uma orientação responsável.'],
        ['Fechamento e acompanhamento', 'Antes de encerrar, confirme se a dúvida inicial foi resolvida e resuma o acordo combinado. Registre o encaminhamento e, quando aplicável, alinhe o próximo contato conforme o procedimento real. Use o aprendizado para identificar melhorias na comunicação da equipe.'],
      ]],
    ],
  },
];

export function academyFixtures() {
  return definitions.map(definition => {
    let position = 0;
    const modules = definition.modules.map(([title, lessons], moduleIndex) => ({
      id: `${definition.id}-module-${moduleIndex + 1}`, course_id: definition.id, title, active: true, order: moduleIndex + 1,
      lessons: lessons.map(([lessonTitle, copy]) => {
        position += 1;
        return {
          id: `${definition.id}-${position}`, module_id: `${definition.id}-module-${moduleIndex + 1}`,
          title: lessonTitle, active: true, order: position, media_version: 1, completed: position <= definition.completed,
          description: `${copy}\n\nAula demonstrativa: vídeo indisponível nesta prévia local. O conteúdo e o progresso são fictícios; não há reprodução externa ou gravação de conclusão.`,
        };
      }),
    }));
    const total = modules.flatMap(module => module.lessons).length;
    return {
      course: {
        id: definition.id, title: definition.title, category: definition.category, learning_group: definition.learning_group,
        icon_key: definition.icon_key, description: definition.description, instructor_name: definition.instructor_name,
        active: true, delivery_mode: 'internal', url: null, order: definition.id === 'culture' ? 1 : 2,
        // Both visual groups remain available to the fictitious DHO user.
        audience: 'all', allowed_job_title_ids: [], available_job_titles: jobTitles.filter(title => title.active),
        total_modules: modules.length, total_lessons: total, completed_lessons: definition.completed,
        progress_percent: Math.floor(definition.completed / total * 100),
        resume_lesson_id: definition.completed ? `${definition.id}-${definition.completed + 1}` : null,
      },
      modules,
    };
  });
}

export function lessonFixture(id, views) {
  for (const view of views) {
    const lessons = view.modules.flatMap(module => module.lessons);
    const index = lessons.findIndex(lesson => lesson.id === id);
    if (index < 0) continue;
    const lesson = lessons[index];
    return {
      course_id: view.course.id, lesson, media: null, description: lesson.description,
      progress: { lesson_id: id, media_version: 1, completed: lesson.completed, position_seconds: 0, version: lesson.completed ? 1 : 0 },
      previous_lesson_id: lessons[index - 1]?.id ?? null, next_lesson_id: lessons[index + 1]?.id ?? null,
    };
  }
  return undefined;
}
