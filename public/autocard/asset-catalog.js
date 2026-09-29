// Presentation/search metadata only. IDs and ordering mirror the existing API
// allowlists; persisted cards and Lucide rendering continue to use those IDs.
const metadata = {
  'triangle-alert': ['Alerta', 'aviso atenção cuidado regra'],
  info: ['Informação', 'ajuda orientação comunicado'],
  megaphone: ['Megafone', 'anúncio divulgação comunicado'],
  bell: ['Sino', 'notificação lembrete aviso'],
  'shield-check': ['Escudo de proteção', 'segurança verificação aprovado'],
  'file-text': ['Documento de texto', 'arquivo formulário regra'],
  mail: ['Envelope', 'email correio mensagem'],
  phone: ['Telefone', 'ligação contato'],
  user: ['Pessoa', 'usuário colaborador perfil'],
  users: ['Equipe', 'pessoas usuários colaboradores grupo'],
  heart: ['Coração', 'amor saúde cuidado'],
  star: ['Estrela', 'destaque favorito'],
  gift: ['Presente', 'benefício aniversário'],
  wallet: ['Carteira', 'dinheiro pagamento benefício'],
  coffee: ['Café', 'pausa bebida'],
  utensils: ['Talheres', 'alimentação refeição restaurante almoço'],
  'car-front': ['Carro', 'transporte veículo estacionamento'],
  'circle-check': ['Confirmação', 'aprovado concluído verificação'],
  search: ['Lupa', 'buscar pesquisa procura'],
  'briefcase-business': ['Maleta de trabalho', 'vaga emprego negócios carreira'],
  'bar-chart-3': ['Gráfico de barras', 'resultados estatísticas indicadores'],
  settings: ['Engrenagem', 'configurações ajustes'],
  package: ['Pacote', 'caixa entrega encomenda'],
  'party-popper': ['Festa', 'celebração comemoração aniversário'],
  trophy: ['Troféu', 'prêmio conquista reconhecimento'],
  cake: ['Bolo de aniversário', 'aniversariante comemoração festa'],
  'calendar-days': ['Calendário', 'data evento agenda treinamento'],
  clock: ['Relógio', 'hora tempo prazo'],
  'map-pin': ['Localização', 'endereço mapa lugar'],
  house: ['Casa', 'moradia hospedagem lar'],
  wrench: ['Chave de manutenção', 'ferramenta reparo conserto'],
  'bed-double': ['Cama de casal', 'quarto descanso hospedagem'],
  trees: ['Árvores', 'natureza meio ambiente sustentabilidade'],
  sparkles: ['Brilhos', 'novidade celebração destaque'],
  send: ['Envio', 'enviar mensagem avião de papel'],
  'message-circle': ['Conversa', 'mensagem diálogo comentário'],
  'share-2': ['Compartilhar', 'compartilhamento rede conexão'],
  target: ['Alvo', 'meta objetivo foco'],
  'hard-hat': ['Capacete', 'obra construção segurança epi'],
  'user-plus': ['Nova pessoa', 'contratação novo funcionário boas-vindas'],
  rabbit: ['Coelho', 'páscoa animal'],
  syringe: ['Seringa', 'vacina vacinação saúde'],
  'piggy-bank': ['Cofrinho', 'poupança economia dinheiro'],
  ghost: ['Fantasma', 'halloween dia das bruxas'],
  drama: ['Máscaras de teatro', 'cultura arte espetáculo'],
};
const catalog = ids => Object.freeze(ids.map(id => Object.freeze({ id, title: metadata[id][0], aliases: metadata[id][1] })));
export const ICON_ASSETS = catalog(['triangle-alert','info','megaphone','bell','shield-check','file-text','mail','phone','user','users','heart','star','gift','wallet','coffee','utensils','car-front','circle-check','search','briefcase-business','bar-chart-3','settings','package','party-popper','trophy','cake','calendar-days','clock','map-pin','house','wrench','bed-double','trees','sparkles','send','message-circle','share-2','target']);
export const ILLUSTRATION_ASSETS = catalog(['hard-hat','shield-check','user-plus','users','cake','trophy','rabbit','utensils','car-front','house','syringe','piggy-bank','trees','ghost','party-popper','drama']);
export function normalizeAssetSearch(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
export function searchAssets(mode, query) {
  const list = mode === 'icon' ? ICON_ASSETS : ILLUSTRATION_ASSETS;
  const search = normalizeAssetSearch(query);
  return list.filter(asset => normalizeAssetSearch(`${asset.id} ${asset.title} ${asset.aliases}`).includes(search));
}
