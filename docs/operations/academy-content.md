# Manual editorial da Academy

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

O backend aplica audiência, conta ativa, curso/módulo/aula ativos e publicação
CMS antes de listar categorias, total, curso, aula, materiais ou asset. Não
confie em ocultar cards: a API é a fronteira de autorização.

## 2. Ciclo editorial

- **Salvar** mantém os metadados ou rascunho no CMS; não torna o conteúdo público.
- **Disponibilizar** ativa curso, módulo ou aula na árvore, desde que os pré-
  requisitos editoriais sejam satisfeitos.
- **Publicar** promove a revisão CMS e torna descrição/materiais elegíveis para
  leitura pública. Um documento existente sem revisão publicada válida não cai
  de volta para a descrição legada.
- Despublicar, desativar ou retirar um ancestral remove o item do catálogo e
  bloqueia novo GET de aula/material/asset para alunos. Gestores continuam com
  prévia explícita quando autorizado.

Ative um curso interno somente depois de ter módulo e aula ativos, mídia
reproduzível e publicação válida quando houver documento CMS. Concorrência é
serializada pelo lock CMS e as falhas de auditoria/validação revertem a
transação.

## 3. Estrutura, capa e materiais

Um curso contém módulos e aulas; reordene usando a lista completa de IDs. O
progresso acompanha o ID da aula, não sua posição. Cada aula tem título,
descrição simples e uma mídia primária: YouTube ou arquivo HTTPS MP4/WebM.

No CMS, use o tipo `academy_lesson` para descrição e materiais da aula. Para a
apresentação do curso, a primeira imagem publicada é a capa (`cover_asset_id`);
sem imagem publicada, a interface usa o vetor original da Academy. Referências
de assets permanecem nas revisões para a retenção reconhecer arquivos ainda
necessários.

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

Cursos externos/legados permanecem acessíveis até conversão editorial explícita.
Converter preserva o ID e o documento CMS, limpa a URL externa e exige currículo
interno elegível antes da ativação. Não converter automaticamente nem inferir
cargos reais a partir de exemplos comerciais.

## 7. Segurança e privacidade editorial

`manageAcademy` é obrigatório para criar, editar, ordenar, publicar e pré-visualizar
conteúdo fora da audiência. Assets não ficam públicos por terem sido enviados:
uma referência válida e autorizada basta; asset conhecido sem referência legível
retorna 403 e asset inexistente retorna 404.

Progresso é individual e visível ao próprio colaborador nesta versão. Não há
relatório gerencial, certificado ou avaliação automática. Ao apagar usuário,
aula, módulo ou curso, o progresso relacionado é excluído em cascata; trocar
cargo não apaga o histórico, mas muda a elegibilidade corrente.

## 8. Checklist de publicação

- [ ] audiência, formação visual e cargos ativos conferidos;
- [ ] curso, módulo e aula com estado editorial correto;
- [ ] URL de mídia validada e título acessível;
- [ ] descrição/material salvo no `academy_lesson` correto;
- [ ] assets publicados e autorizados, com capa escolhida pela primeira imagem;
- [ ] publicação explícita confirmada, sem depender de fallback legado;
- [ ] curso interno testado por uma conta elegível e uma conta inelegível em
      ambiente autorizado;
- [ ] retirada/despublicação registrada quando conteúdo deixa de ser público.
