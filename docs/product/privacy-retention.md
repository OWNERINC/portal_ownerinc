# Privacidade e Retenção

Política técnica inicial para validação com o responsável por LGPD. Ela não
substitui orientação jurídica nem o registro formal das bases legais.

## Perfis de Colaboradores

- Finalidade: autenticação, comunicação interna e personalização operacional.
- Retenção ativa: enquanto houver vínculo ou necessidade autorizada de acesso.
- Saída: a conta é primeiro desativada e tokens são revogados.
- Exclusão: super-admin pode apagar o registro pessoal, a identidade Firebase e
  a foto pelo painel após desativar a conta.
- Referências em conteúdo, notificações e auditoria passam a nulas; o histórico
  operacional permanece sem UID estável do titular.
- O próprio usuário pode exportar perfil, notificações e eventos de auditoria
  associados em Meu Perfil.

## Fotos

- Uploads são decodificados e normalizados para WebP, sem nome baseado em UID.
- A foto anterior é removida na substituição e existe remoção explícita.
- Fotos são arquivos públicos não indexados por nome aleatório para permitir uso
  em `<img>` sem token. Não devem conter documentos ou informação sensível.
- Anonimização remove a referência e tenta excluir o arquivo correspondente.

## Notificações

- Retenção: 730 dias, aplicada diariamente pelo worker.
- Registros preservam ocorrência, canal, resultado, tentativas e timestamps.
- Exclusão de lembrete não apaga seu histórico; o vínculo passa a nulo.
- Exclusão de dados pessoais remove o UID dos registros históricos por FK.

## AutoCard

- Finalidade: permitir que cargos autorizados de RH criem e mantenham cards
  internos com identidade visual Ownerinc.
- Acesso: somente os cargos exatos Analista de RH Sênior e Gerente de RH; a
  autorização é repetida na API e não depende de role de administrador.
- Histórico: cards e mídias são compartilhados entre usuários autorizados de RH
  e alterações são registradas na auditoria administrativa.
- Mídias: imagens são normalizadas para WebP, possuem limite de tamanho e ficam
  vinculadas ao card; arquivos sem referência são removidos quando aplicável.
- Retenção: o histórico segue a política de dados internos e deve ser mantido
  ou excluído conforme decisão do responsável por DHO e validação jurídica.

## CMS Editorial

- Revisões são imutáveis e permanecem vinculadas ao documento para auditoria.
- Assets privados sem referência em qualquer revisão são removidos diariamente
  após 30 dias por padrão; o prazo pode ser ajustado por
  `CMS_ASSET_ORPHAN_RETENTION_DAYS` entre 1 e 3650 dias.
- Uma falha ao remover o arquivo mantém o registro para nova tentativa e é
  registrada no log operacional.

## Cards Pós

- Finalidade: criar e manter convites internos de Pós-Vendas no template
  Owntime, com histórico compartilhado entre os usuários autorizados.
- Acesso: temporariamente restrito a administradores pela política própria do
  módulo; ocultar a navegação é apenas UX e toda rota repete a autorização.
- Registros: `pos_cards` preserva o histórico operacional e a autoria enquanto
  houver necessidade interna autorizada. O prazo definitivo depende da
  validação do responsável por Pós-Vendas e LGPD.
- Mídias: arquivos privados são normalizados para WebP e não são publicados
  pelo diretório genérico de uploads. Mídias sem referência são removidas pelo
  worker após a janela técnica configurada para mídias órfãs.

## Auditoria

- Retenção: 5 anos para ações privilegiadas, aplicada diariamente pelo worker.
- O log contém ator, ação, alvo, request ID, detalhes mínimos e horário.
- Somente super-admin consulta a trilha pela interface.

## Integração Sólides

- Finalidade inicial: exibir ao titular seu resumo de ponto, escala e saldo.
- O vínculo mínimo contém UID do Portal, `employeeId`, `externalId` opcional,
  escopo, estado de verificação e timestamps operacionais.
- O vínculo é removido em cascata quando o usuário do Portal é apagado.
- Consultas descartam CPF, PIS, CTPS, PIN, fotos, biometria e geolocalização.
- O Portal não persiste atualmente marcações, saldos ou payloads brutos da
  Sólides; qualquer cache futuro exige prazo de retenção aprovado.
- O token permanece em variável de ambiente do servidor e não pode aparecer em
  logs, auditoria, resposta HTTP ou exportação do titular.
- Leituras e alterações administrativas de vínculos são auditadas com detalhes
  mínimos, sem dados trabalhistas.

## Logs Técnicos e Backups

- Logs de aplicação devem ser retidos por até 90 dias, com acesso operacional
  restrito e sem payloads, tokens ou chaves.
- Backups locais têm retenção padrão de 14 dias e devem ser copiados cifrados
  para outro host conforme a política de infraestrutura.
- Uma exclusão pode persistir temporariamente em backups até o fim da retenção;
  restaurações devem reaplicar exclusões registradas após o ponto restaurado.
- Backups externos S3-compatible devem usar credenciais protegidas, checksum do
  artefato local e retenção definida pela infraestrutura; uma falha de upload
  não invalida o backup local verificado.

## Direitos do Titular

1. Exportação: disponível no perfil.
2. Correção: perfil editável pelo próprio usuário; campos administrativos por
   gestor autorizado.
3. Bloqueio: desativação revoga acesso sem destruir evidência operacional.
4. Exclusão: anonimização administrativa após bloqueio e validação da obrigação
   de retenção.
5. Registro: toda operação privilegiada relevante gera auditoria.
