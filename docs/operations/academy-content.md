# Manual operacional da Academy

Manual operacional da entrega de 1º de outubro de 2026. Ele descreve o contrato
implementado; a [matriz de aceite](../reviews/2026-09-30-academy-acceptance.md)
registra o que foi verificado e o que ainda depende de ambiente autorizado.

## 1. Audiência e cadastro por cargo

1. Crie o curso como **Formação inicial** (`all`) quando ele deve aparecer para
   todo colaborador ativo, ou como **Formação por cargo** (`job_titles`) quando
   depende do cargo profissional atual.
2. Para uma formação por cargo, selecione cargos pelo catálogo real. Cargo
   inativo não concede acesso; ausência de cargo concede somente cursos gerais.
3. A formação inicial e a formação por cargo são grupos visuais, não pré-
   requisitos. Ambas ficam disponíveis desde o primeiro acesso quando o usuário
   é elegível.
4. O gestor usa prévia explícita (`all=true`) somente com `manageAcademy`. Isso
   não simula outro colaborador e não salva progresso.

O backend aplica audiência, conta ativa e curso/módulo/aula ativos antes de listar
categorias, total, curso ou aula. Não confie em ocultar cards: a API é a fronteira
de autorização.

## 2. Ciclo de gestão

- **Salvar** mantém os metadados e a descrição/mídia próprias da árvore Academy.
- **Ativar** curso, módulo ou aula torna o item elegível, desde que a audiência,
  os ancestrais e a mídia válida permitam a leitura.
- **Desativar** um item ou retirar um ancestral remove o item do catálogo e
  bloqueia novo GET de aula para alunos. Gestores continuam com prévia explícita
  quando autorizado.

Ative um curso interno somente depois de ter módulo e aula ativos e mídia
reproduzível. Concorrência é serializada pelos locks da árvore própria e as
falhas de auditoria/validação revertem a transação.

## 3. Estrutura e mídia própria

Um curso contém módulos e aulas; reordene usando a lista completa de IDs. O
progresso acompanha o ID da aula, não sua posição. Cada aula tem título,
descrição simples e uma mídia primária: YouTube ou arquivo HTTPS MP4/WebM.

A aula usa a descrição simples persistida em `academy_lessons` e uma mídia
primária YouTube ou arquivo HTTPS MP4/WebM. Para a apresentação do curso, a
interface usa `icon_key` e o vetor original da Academy; não há capa ou material
CMS na Academy ativa.

## 4. URLs de mídia

- YouTube: HTTPS, sem credenciais/porta não padrão, somente hosts permitidos
  (`youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be` e
  `www.youtube-nocookie.com`) e URL `watch?v=`, `embed/`, `shorts/` ou curta com
  ID de 11 caracteres. Playlist isolada e hosts parecidos são rejeitados.
- Arquivo: HTTPS, sem credenciais, caminho terminando em `.mp4` ou `.webm`;
  query string é permitida. O servidor não faz probe nem baixa a mídia para
  validá-la.
- O player oficial não inicia sozinho. Erros de incorporação mostram estado
  explicativo e retry; erro nunca marca a aula como concluída. A validação real
  contra YouTube/MP4 e Nginx ainda precisa ser feita em ambiente autorizado.

## 5. Edição, versão e conclusão

Alterar a origem normalizada do vídeo incrementa `media_version`; a nova mídia
começa sem posição/conclusão. Alterar título ou ordem preserva o progresso por
ID. A posição confirmada é retomada em outra sessão da mesma conta; uma troca de
conta não compartilha player, progresso ou materiais.

O colaborador pode usar **Concluir aula**. Somente o ACK da escrita própria no
servidor altera o estado; chegar ao fim do vídeo não conclui automaticamente.
Conflito 409 pede recarga. Fechar abruptamente pode perder o último intervalo
não confirmado, mas não inventa conclusão.

## 6. Curso legado e retirada

Cursos externos/legados permanecem acessíveis até conversão explícita. Converter
preserva o ID, limpa a URL externa e exige currículo interno elegível antes da
ativação. Não converter automaticamente nem inferir cargos reais a partir de
exemplos comerciais.

## 7. Segurança e privacidade editorial

`manageAcademy` é obrigatório para criar, editar, ordenar, ativar/desativar e
pré-visualizar conteúdo fora da audiência. A Academy ativa usa somente a mídia
própria da aula; não há upload, referência ou material CMS nesse fluxo.

Progresso é individual e visível ao próprio colaborador nesta versão. Não há
relatório gerencial, certificado ou avaliação automática. Ao apagar usuário,
aula, módulo ou curso, o progresso relacionado é excluído em cascata; trocar
cargo não apaga o histórico, mas muda a elegibilidade corrente.

## 8. Checklist de ativação

- [ ] audiência, formação visual e cargos ativos conferidos;
- [ ] curso, módulo e aula com estado ativo/inativo correto;
- [ ] URL de mídia validada e título acessível;
- [ ] descrição e mídia salvas na aula Academy correta;
- [ ] ícone/fallback visual próprio conferido;
- [ ] não há dependência de processo editorial, documento ou material CMS;
- [ ] curso interno testado por uma conta elegível e uma conta inelegível em
      ambiente autorizado;
- [ ] desativação registrada quando o conteúdo deixa de ser elegível.
