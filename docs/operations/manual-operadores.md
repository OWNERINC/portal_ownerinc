# Guia de operação do Portal Ownerinc

Manual rápido para administradores e operadores de conteúdo.

Edição: 18/11/2026 · Release candidata: `feat/portal-welcome`.

Use o sumário para ir direto à tarefa. Os nomes em **negrito** correspondem a campos, botões ou áreas da interface. Cada procedimento informa o acesso necessário e o resultado esperado.

Este guia descreve a versão analisada do Portal, sem afirmar sua implantação. A disponibilidade depende da versão publicada e das permissões da sua conta. Recursos condicionais são identificados no próprio capítulo.

## Acesso, Dashboard e Meu Perfil

**Caminho:** tela de login → Dashboard ou Meu Perfil.

**Quem usa:** qualquer pessoa com conta liberada.

### Entrar no Portal

1. Preencha **E-mail** e **Senha**. Clique em **Entrar no portal**.
2. Se aparecer o **Código de Ética e Conduta**, leia e role o documento até o final.
3. Marque **Li e aceito o Código de Ética e Conduta apresentado.** e clique em **Aceitar e entrar no portal**.
4. Use o menu lateral para navegar. No celular, abra o menu para ver os atalhos.

### Consultar o Dashboard

As boas-vindas são fixas, com saudação pelo horário de São Paulo e primeiro nome do perfil; sem nome utilizável, a saudação é neutra. Os links explicam cada destino:

- **Conhecimento:** documentos, manuais de uniformes e orientações.
- **Notificações:** avisos e lembretes destinados a você.
- **Pages:** comunicados e conteúdos liberados para seu cargo.
- **Meu Perfil:** dados pessoais e foto.
- Em **Ferramentas e gestão**, **AutoCard** e **Cards Pós** oferecem artes e convites somente com acesso liberado; **Admin** aparece quando sua conta permite.

Logo após as boas-vindas, use **Ler Código de Ética** no destaque **Código de Ética**. Em seguida, **Próximas notificações** mostra os próximos sete dias. A Academy está fora do menu e do Dashboard temporariamente; continua por link direto e no Admin.

### Atualizar seu perfil

1. Em **Meu Perfil**, ajuste **Nome completo**, **Bio / Cargo**, **WhatsApp** e **Perfil do LinkedIn**. Use **Salvar perfil** e aguarde a confirmação.
2. Use **Alterar foto**: JPEG, PNG ou WebP de até **500 KB**.
3. Em **Ajustar enquadramento**, centralize e use **Salvar enquadramento**. **Remover foto** retira a imagem.

> **Cargo profissional:** “Bio / Cargo” não muda o cargo que libera acessos. Esse vínculo é definido em Admin → Usuários.

### Redefinir senha ou sair

- No login: **Esqueci minha senha** → e-mail → **Enviar link de redefinição**.
- No Portal: **Meu Perfil → Segurança → Enviar link de redefinição**.
- Para encerrar a sessão, clique em **Sair** no menu lateral.

## Cargos e permissões

**Caminho:** Admin → Cargos / Usuários.

**Quem opera:** gestão de usuários; alterações de perfil administrativo e permissões exigem Super Admin.

### Cadastrar um cargo e liberar ferramentas

1. Na aba **Cargos**, clique em **Adicionar cargo**.
2. Informe **Nome do cargo** e mantenha **Cargo ativo para atribuição e acesso atual** marcado.
3. Em **Páginas com acesso**, marque **AutoCard** e/ou **Cards Pós**, conforme a função.
4. Clique em **Salvar cargo**.
5. Em **Usuários**, abra **Editar**, atribua esse cargo à pessoa e clique em **Salvar**.

**Resultado:** as ferramentas marcadas ficam disponíveis para quem estiver vinculado ao cargo ativo.

> **Regra de acesso:** ser Administrador, por si só, não libera AutoCard ou Cards Pós. Essas ferramentas dependem do cargo ativo e de suas marcações. Super Admin tem acesso direto.

### Conceder uma permissão administrativa

1. Como Super Admin, abra **Admin → Usuários → Editar** na conta de outra pessoa.
2. Em **Perfil**, selecione **Administrador**.
3. Marque as permissões necessárias e clique em **Salvar**.

| Permissão na tela | O que libera |
| --- | --- |
| Gerenciar Usuários | Usuários, solicitações e cargos. |
| Gerenciar Base de Conhecimento | Criar, editar e excluir artigos. |
| Gerenciar Notificações | Cadastrar avisos e consultar entregas. |
| Gerenciar Academy | Cursos, módulos e aulas, com os limites deste guia. |
| Editar minhas Pages | Criar páginas e editar as de própria autoria. |
| Revisar, publicar e arquivar Pages | Revisar e publicar páginas; arquivar e restaurar. |

### Editar ou desativar um cargo

Na aba **Cargos**, use **Editar** para mudar o nome ou os acessos. Use **Desativar** e confirme para interromper os acessos derivados daquele cargo; **Ativar** reabilita o cargo.

**Efeito:** o vínculo das pessoas com o cargo é mantido. Desativar o cargo não desativa suas contas, mas afeta ferramentas e conteúdos restritos por cargo.

## Usuários: convidar, editar e desativar

**Caminho:** Admin → Usuários.

**Quem opera:** Gerenciar Usuários.

### Convidar uma pessoa

1. Clique em **Convidar usuário**.
2. Informe **Nome**, **E-mail**, um **Cargo** ativo e **Tipo de contrato**.
3. Para **PJ**, preencha **Dia do mês para emitir nota (1–31)**. Para **CLT**, esse campo não se aplica.
4. Complete **WhatsApp**, se necessário. O perfil comum é **Leitor**; somente Super Admin atribui privilégios administrativos.
5. Clique em **Enviar convite** e aguarde o resultado.

**Resultado:** o convite é encaminhado ao serviço de e-mail para criar a primeira senha. Confirme o recebimento e a habilitação da conta; o encaminhamento não comprova chegada à caixa de entrada. O administrador não define nem recebe essa senha.

### Encontrar e editar um usuário

1. Use **Nome ou e-mail**, **Perfil**, **Estado da conta** e/ou **Cargo**.
2. Clique em **Aplicar**. Use **Limpar** para retirar os filtros.
3. Na pessoa correta, clique em **Editar**.
4. Ajuste os campos disponíveis e clique em **Salvar**.
5. Confira a linha atualizada. Use **Anterior** e **Próxima** quando houver mais páginas.

O e-mail fica somente para leitura na edição de uma conta existente.

> **Dia NF:** esse campo cadastral não cria um lembrete automaticamente e não permite enviar ou concluir notas fiscais. Para avisos mensais, cadastre uma Notificação.

### Suspender ou devolver acesso

- **Desativar:** clique na ação da pessoa e confirme. O acesso é revogado.
- **Reativar:** localize a conta desativada e clique em **Reativar**.
- **Habilitação pendente:** a liberação ainda não terminou; verifique a mensagem e encaminhe ao suporte se o estado persistir.

**Resultado:** a coluna **Status** informa a situação atual da conta.

### Se uma ação estiver bloqueada

Leia a explicação exibida na linha. O Portal protege a própria conta, contas superiores e o último Super Admin ativo. Peça a atuação de outro administrador habilitado quando necessário.

## Solicitações e importação em lote

**Caminho:** Admin → Solicitações / Usuários.

**Quem opera:** Gerenciar Usuários.

### Aprovar um cadastro solicitado pelo colaborador

1. Abra **Solicitações** e clique em **Analisar** na pessoa correta.
2. Confira a identidade e o e-mail informado.
3. Escolha **Tipo de contrato** e **Cargo para aprovação**. O cargo deve estar ativo.
4. Para PJ, informe o dia de nota entre 1 e 31.
5. Clique em **Aprovar cadastro** e aguarde o resultado.

**Resultado:** a pessoa é admitida como **Leitor** e pode entrar com o e-mail e a senha escolhidos no cadastro, após a habilitação concluir.

Para recusar, use **Rejeitar**, informe o motivo se necessário e confirme em **Rejeitar cadastro**.

### Importar convites por CSV

1. Em **Usuários**, clique em **Importar CSV** e depois em **Baixar modelo CSV**.
2. Substitua ou remova as duas linhas de exemplo.
3. Preencha até **500 pessoas**, mantendo CSV UTF-8 e os cabeçalhos na mesma ordem.
4. Selecione o arquivo em **Arquivo CSV de convites** e clique em **Pré-visualizar**.
5. Confira as linhas prontas e as ignoradas. Corrija o arquivo e pré-visualize novamente, se necessário.
6. Clique em **Confirmar importação** e confirme o envio dos convites.
7. Acompanhe os totais de convidados, falhas e itens em andamento. Use **Tentar falhas novamente** quando disponível.

| Coluna do CSV | Como preencher |
| --- | --- |
| `name` | Nome obrigatório, até 120 caracteres. |
| `email` | E-mail válido, sem repetição no arquivo ou no Portal. |
| `job_title` | Nome exato de um cargo ativo. |
| `contract_type` | `clt` ou `pj`, em minúsculas. |
| `pj_due_day` | Vazio para CLT; de 1 a 31 para PJ. |
| `phone` | Opcional, até 40 caracteres. |

**Resultado:** os convidados entram como leitores. O total de convidados indica processamento, não recebimento na caixa de entrada. Acompanhe o lote antes de importar o mesmo grupo outra vez; recarregar a página não cancela o lote.

## Base de Conhecimento

**Caminho:** Conhecimento → Base de Conhecimento.

**Quem opera:** Gerenciar Base de Conhecimento.

### Criar um artigo

1. Clique em **Novo artigo**.
2. Preencha **Título**, **Categoria** e **Conteúdo**.
3. Escreva o conteúdo em texto simples. Use parágrafos curtos para facilitar a leitura.
4. Clique em **Salvar** e aguarde a confirmação.
5. Localize e abra o artigo na listagem para conferir o texto.

**Resultado:** o artigo fica disponível na Base de Conhecimento. Não há uma segunda etapa de publicação nesse formulário.

### Localizar e alterar um artigo

1. Digite palavras em **Buscar artigos**; a busca considera título e conteúdo.
2. Se necessário, use **Filtrar por categoria** e a paginação.
3. Abra o artigo e clique em **Editar**.
4. Ajuste os campos, clique em **Salvar** e confira o resultado.
5. Use **Voltar** para retornar à listagem.

### Excluir um artigo

Abra o artigo, clique em **Excluir** e confirme. Confira se ele deixou de aparecer na listagem.

### Compartilhar o acesso

Abra o artigo e copie o endereço exibido no navegador. A pessoa que receber o link precisa entrar no Portal.

> **Formato atual:** esse editor oferece título, categoria e texto simples. Para uma página com imagens, botões, colunas ou público por cargo, use Pages.

### Editar um artigo com documento

Editar título, categoria ou conteúdo não substitui o documento vinculado, suas páginas WebP ou o Código oficial. Para trocar o arquivo ou seu pacote de páginas, encaminhe ao responsável técnico. Um link do Drive em linha própria no conteúdo pode gerar **Abrir documento no Drive ↗**, sujeito às permissões do Drive.

### Quando a busca não retornar o esperado

Limpe o texto da busca e a categoria selecionada. Se aparecer uma falha de carregamento, use **Tentar novamente**. Uma lista vazia com filtros ativos não significa que o artigo foi excluído.

## Leitura de documentos e Código de Ética

**Caminho:** Conhecimento → artigo; ou Dashboard → Ler Código de Ética.

**Quem usa:** qualquer pessoa com acesso ao Portal e ao conteúdo.

### Localizar o Código

O **Código de Ética e Conduta** tem capa institucional e prioridade na primeira página da Base, antes dos manuais de uniformes, quando corresponde à consulta.

Busca e categoria continuam valendo: o Código não é forçado em resultados incompatíveis nem repetido nas outras páginas. Limpe a busca e selecione **Todos** para consultar o catálogo completo.

No Dashboard, o destaque vem após as boas-vindas e antes das notificações. Clique em **Ler Código de Ética**. Se houver falha, use a nova tentativa oferecida; se estiver indisponível, aguarde a regularização. Os demais acessos continuam disponíveis.

### Consultar não é aceitar

Na Base, o Código abre o texto oficial para consulta recorrente. Essa leitura não registra um novo aceite nem substitui a tela obrigatória de entrada. O aceite, quando solicitado no login, exige leitura, marcação da declaração e confirmação próprias.

A capa de destaque identifica o material; não representa uma nova versão ou aprovação do Código.

### Ler manuais em páginas WebP

1. Abra o artigo do manual. Role pelas páginas numeradas; as imagens WebP carregam conforme a leitura.
2. Aguarde a imagem e clique em **Ampliar** para ver os detalhes.
3. Use **Tamanho real** ou **Ajustar à tela**. Na imagem ampliada, role para consultar outras regiões; use **Fechar** para voltar.
4. Abra **Ler texto da página** com o número correspondente para consultar o texto extraído. Páginas sem texto extraível exibem um aviso.
5. Quando disponível, **PDF original ↗** abre o documento no Drive em nova aba. O acesso ao original segue as permissões do Drive.

**Resultado:** a consulta acontece dentro do Portal, com imagem e texto de apoio. O Código usa seu leitor de texto oficial; os controles WebP pertencem aos manuais convertidos.

### Se uma página não carregar

Use **Tentar novamente** junto à página ou à mensagem de falha. **Ampliar** fica disponível depois que a imagem carrega. O texto extraído é apoio à leitura; confira a imagem ou o original para detalhes de composição.

## Notificações e lembretes mensais

**Caminho:** Notificações.

**Quem opera:** Gerenciar Notificações.

### Criar um lembrete

1. Clique em **Nova notificação**.
2. Preencha **Título**, **Descrição** e **Dia do mês (1–31)**.
3. Em **Destinatários**, escolha **Todos**, **Apenas PJ**, **Apenas CLT** ou **Usuários específicos**.
4. Para usuários específicos, preencha **UIDs dos usuários**, um identificador por linha. Use os UIDs fornecidos pelo responsável técnico; nomes e e-mails não substituem esses valores.
5. Mantenha **Canal → E-mail** e **Ativo** marcado.
6. Clique em **Salvar** e confira o dia e o público na listagem.

**Resultado:** o aviso fica visível ao público escolhido e entra no agendamento mensal. Salvar não dispara um e-mail imediatamente.

### Editar ou interromper o lembrete

- **Editar:** abra **Editar**, ajuste os campos e clique em **Salvar**.
- **Interromper:** em **Editar**, desmarque **Ativo** e salve.
- **Excluir:** use **Excluir** e confirme. O histórico das entregas é preservado.

### Consultar os envios

Na seção **Entregas recentes**, filtre por status, canal, ID da notificação, UID ou período. Clique em **Filtrar**. Veja destinatário, motivo e tentativas; use **Limpar** para retirar os filtros. Essa seção acompanha notificações, não convites de usuários.

| Status | Como interpretar |
| --- | --- |
| `sent` | O servidor de e-mail aceitou a mensagem; não comprova leitura. |
| `failed` | A entrega falhou ou ficou com resultado incerto. Consulte o motivo. |
| `skipped` | A ocorrência foi ignorada; consulte o motivo. |
| `pending` / `sending` | A ocorrência está pendente ou em processamento. |

### Regras que o operador precisa conhecer

- Envio mensal, processado às **8h de São Paulo**. Dias 29–31 usam o último dia de meses curtos.
- A retomada pode recuperar até sete dias de ocorrências; não envia ocorrências anteriores à criação.
- Falhas temporárias conhecidas podem ter até três tentativas no total.
- Não há WhatsApp, “lido”, “concluído” ou adiamento individual. O aviso continua mensalmente enquanto estiver ativo e a pessoa pertencer ao público.

## Academy: cadastrar e organizar cursos

**Caminho:** Admin → Academy; acesso direto em `/academy.html`.

**Quem opera:** Gerenciar Academy.

A Academy está temporariamente oculta no menu e no Dashboard. Links diretos, gestão no Admin, permissões, cursos e progresso permanecem disponíveis.

### Criar um curso

1. Na aba **Academy** do Admin, clique em **Novo curso**.
2. Preencha **Título**, **Categoria** e **Descrição**.
3. Em **Entrega**, escolha **Curso interno** para módulos e aulas ou **Curso externo** para outro site.
4. Defina **Público**: **Todos** ou **Cargos selecionados**; neste caso, marque os **Cargos elegíveis**.
5. Confira **Grupo visual**, **Ícone**, **Instrutor** e **Ordem**.
6. Para curso externo, preencha **URL externa**.
7. Mantenha **Disponível → Rascunho / indisponível** durante o preparo.
8. Clique em **Criar curso**. Para curso interno, veja os limites de aulas no próximo capítulo.

**Público** controla o acesso; cargos inativos não o concedem. **Grupo visual** organiza **Formação inicial** ou **Formação por cargo**, sem criar pré-requisitos.

### Editar e disponibilizar

1. Em **Admin → Academy**, localize o curso; a aba tem paginação de 50 itens.
2. Abra **Gerenciar curso** ou **Editar curso externo**.
3. Confira e selecione novamente **Entrega**, **Público**, **Grupo visual**, **Ícone** e **Disponível** antes de **Salvar curso**.
4. Para liberar, escolha **Disponibilizar** e salve; no curso interno, módulos e aulas também precisam estar ativos. Para retirar, escolha **Rascunho / indisponível**.

> **Limitação atual:** os seletores não restauram os valores salvos. Iniciam em Curso externo, Todos, Formação inicial, Ícone 1 e Rascunho / indisponível. Confira também os cargos elegíveis antes de salvar.

Salve cada alteração de módulo/aula antes de trocar a Entrega. Não há garantia de bloqueio dessa troca com currículo pendente.

### Voltar e conferir como aluno

Em curso existente, **Cancelar** recarrega a página; em novo curso, não retorna à lista. A gestão dedicada lista até 100 cursos, sem paginação. Use a aba Admin para a listagem paginada. **Voltar aos cursos** abre o catálogo; a prévia administrativa não simula outro colaborador nem grava progresso.

## Academy: módulos, aulas e manutenção

**Caminho:** Admin → Academy → Gerenciar curso.

**Quem opera:** Gerenciar Academy; o curso deve ser interno.

### Adicionar um módulo

Em **Módulos e aulas**, use **Adicionar módulo**, informe o nome e confirme. O módulo começa inativo. Após preparar as aulas, marque o módulo como ativo e use **Salvar módulo**.

### Criação de novas aulas: limitação atual

**Adicionar aula** abre somente a pergunta **Nome da aula**. A interface envia o vídeo vazio e a API rejeita a criação. Não há formulário com título, URL e **Criar aula** nesta versão.

Encaminhe a criação de novas aulas ao responsável técnico. Cadastrar um curso ou módulo não resolve essa limitação da interface.

### Editar aulas existentes

1. Ajuste o título e o estado ativo da aula, conforme necessário.
2. Preencha novamente **Vídeo da aula**, identificado pelo título, com a URL válida do vídeo atual: HTTPS do YouTube ou arquivo MP4/WebM.
3. Clique em **Salvar aula** e aguarde a confirmação antes de outra alteração.

O campo de vídeo aparece vazio porque o resumo carregado não inclui a mídia. Mesmo para alterar somente o título ou a ativação, é necessário informar a URL válida novamente. Se não souber a URL atual, solicite-a ao responsável pelo conteúdo.

### Alterar módulos e ordem

- Nome ou ativação do módulo: ajuste os campos e use **Salvar módulo**.
- Ordem das aulas: **Subir** e **Descer**; dos módulos: **Subir módulo** e **Descer módulo**. Essas ações gravam a ordem.
- Para retirar uma aula, desmarque o estado ativo, informe novamente a URL e use **Salvar aula**.

> **Trocar o vídeo reinicia a posição e a conclusão para a nova mídia.** Manter a mesma mídia e alterar apenas título ou ordem preserva o progresso.

### Salvar sem perder alterações

Faça uma alteração e seu salvamento por vez. Salvar ou reordenar reconstrói o currículo e pode descartar campos pendentes; **Salvar curso** recarrega a página. Os botões de curso, módulo e aula são separados. Não conte com preservação de rascunhos na tela.

### Orientar o colaborador

Pelo link direto da Academy, o aluno elegível abre ou retoma a aula e usa **Concluir aula**. O fim do vídeo não conclui automaticamente. O progresso é individual; não há certificados, provas ou relatório gerencial de aprendizagem.

## Pages: criar uma página

**Caminho:** Pages → Gerenciar Pages.

**Quem opera:** Editar minhas Pages. Publicar exige uma permissão adicional.

### Criar o rascunho

1. Clique em **Gerenciar Pages**.
2. Em **Modelo**, selecione uma opção disponível.
3. Clique em **Criar comunicado** e confirme em **Criar rascunho**. O botão usa esse nome também quando outro modelo estiver selecionado.
4. No editor, abra **Propriedades → Página** e preencha **Título**, **Resumo** e **Tags (separadas por vírgula)**.
5. Em **Público e destinos → Público por cargo**, marque os cargos ativos que poderão ler.
6. Substitua os textos ilustrativos do modelo pelo conteúdo que deseja publicar.
7. Clique em **Salvar rascunho** e aguarde a confirmação.

**Resultado:** a página está salva para edição e revisão. Ela ainda não está publicada para os colaboradores.

### Encontrar uma página existente

Em **Gerenciar Pages**, use **Buscar por título** e/ou **Tag**, clique em **Buscar** e abra o título. Use **Anterior** e **Próxima** para navegar.

### Entender quem pode editar

- **Editar minhas Pages:** permite criar e editar páginas de própria autoria.
- **Revisar, publicar e arquivar Pages:** permite revisar e publicar páginas, inclusive de outros autores.
- A permissão de publicação não libera a edição do conteúdo de outro autor. Essa regra também se aplica a Super Admin.

> **Público obrigatório:** nenhuma seleção de cargo é feita automaticamente. Uma página publicada só pode ser lida por colaboradores elegíveis aos cargos definidos.

### Escolher um modelo durante a edição

O seletor **Modelo** oferece opções “Novo: …”. Escolher uma delas e confirmar **Criar novo rascunho** cria outra página; não troca o modelo da página atual.

### Recursos que dependem da instalação

**Guia interno**, galeria, FAQ, categoria e alguns controles avançados dependem da habilitação da versão correspondente. Use as opções disponíveis; uma opção desabilitada informa o motivo.

## Pages: editar blocos e inserir mídia

**Caminho:** editor da Page → Inserir bloco / Propriedades.

**Quem opera:** autor com Editar minhas Pages.

### Montar o conteúdo

1. Selecione um bloco na página e clique em **Inserir bloco**. No celular, essa ação fica em **Mais ações do editor** (•••).
2. Escolha **Texto**, **Imagem ou GIF**, **Vídeo**, **Áudio** ou **Duas colunas**.
3. Em **Destaque ou botão**, escolha uma chamada ou um botão com destino.
4. Edite o texto diretamente na página. Use a barra de formatação para títulos, listas e destaques.
5. Abra **Propriedades**: **Conteúdo** altera campos; **Estilo**, a aparência; **Posição**, a composição e a ordem.
6. Para organizar seções, use **Organizar estrutura**, a alça de arraste ou **Subir/Descer**.
7. Confira **Prévia desktop** e **Prévia mobile · 390 px** no menu **Prévia**. Depois, use **Salvar rascunho**.

### Preparar arquivos para publicação

| Arquivo | Limite de envio | Complemento necessário |
| --- | --- | --- |
| JPEG, PNG ou WebP | 5 MB | Texto alternativo descrevendo a imagem. |
| GIF | 8 MB / 30 s | Texto alternativo. |
| MP3 | 10 MB / 10 min | Transcrição do conteúdo. |
| MP4 | 25 MB / 2 min | Transcrição e legendas sincronizadas. |

Selecione o bloco para preencher os campos. Aguarde o arquivo carregar. Para substituí-lo, use **Substituir arquivo**. Se houver falha, use **Tentar upload novamente**.

O campo de legendas do MP4 recebe uma lista JSON de trechos. Exemplo de formato: `[{"start_ms":0,"end_ms":1000,"text":"Olá!"}]`. Os tempos são em milissegundos, sem sobreposição e dentro da duração do vídeo. Solicite esse material ao responsável pelo conteúdo.

### Galeria e FAQ, quando disponíveis

- **Galeria:** use **Adicionar imagens à galeria**, preencha o texto alternativo de cada item e ajuste a ordem com **Subir item/Descer item**.
- **FAQ:** em **Outros blocos → FAQ**, use **Adicionar pergunta** e preencha a pergunta e a resposta.

> **Concluir edição fecha o painel de propriedades; não salva a página.** Use sempre **Salvar rascunho** para persistir. O upload de um arquivo também não substitui esse salvamento.

## Pages: publicar, atualizar e arquivar

**Caminho:** Pages → Gerenciar Pages → título da página.

**Quem opera:** Revisar, publicar e arquivar Pages.

### Publicar uma revisão

1. Abra a página e confira o conteúdo salvo nas prévias.
2. Se for o autor e houver alterações, clique em **Salvar rascunho**.
3. Clique em **Publicar** para abrir **Pronto para compartilhar?**.
4. Confira **Título**, **Categoria**, quando disponível, e **Visibilidade → Somente colaboradores**. Veja os cargos ativos selecionados.
5. Resolva as **Pendências de publicação**. **Corrigir** leva o autor ao campo correspondente.
6. Se alterar conteúdo, título ou público, salve novamente o rascunho e confira a nova revisão.
7. Clique em **Publicar página**. Aguarde **Publicação confirmada.**

**Resultado:** a revisão salva fica disponível aos colaboradores dos cargos definidos.

### Compartilhar o link

Use o endereço apresentado na revisão ou abra o conteúdo em **Ver publicadas** e copie a URL do navegador. O link continua exigindo login e acesso ao público da página.

O nome **Somente colaboradores** não significa “todos os colaboradores”: a seleção de cargos continua sendo aplicada.

### Atualizar uma página já publicada

O autor altera e salva um novo rascunho. Um publicador revisa e usa **Publicar página** novamente. Até essa publicação, os leitores continuam vendo a revisão anteriormente publicada.

### Arquivar ou restaurar

- No editor, abra **Propriedades → Página**, use **Arquivar** e confirme. A leitura publicada e suas mídias deixam de ficar disponíveis.
- Para recuperar, abra a página arquivada, vá a **Propriedades → Página**, use **Restaurar** e confirme **Restaurar como rascunho**.
- Depois de restaurar, revise e publique novamente quando desejar liberá-la.

> **Conferência pessoal:** as caixas “Prévia de celular conferida”, “Imagens com descrição alternativa” e “Conferi o conteúdo” são opcionais e não registram aprovação de outra pessoa.

### Se houver conflito ou confirmação pendente

Leia a mensagem antes de continuar. Em confirmação pendente, use a tentativa indicada para a mesma operação. **Recarregar versão salva** descarta alterações locais após confirmação; preserve os textos que deseja manter antes de escolher essa ação.

## AutoCard: produzir e exportar uma arte

**Caminho:** AutoCard → Criar card.

**Quem opera:** pessoa com cargo ativo que libere AutoCard, ou Super Admin.

### Criar o card

1. Escolha um dos modelos da galeria: **Comunicado / Regra Interna**, **Vaga / Recrutamento**, **Aniversariante** ou **Novo funcionário**.
2. Preencha os campos do modelo. A prévia acompanha as alterações.
3. Em **Variação visual**, escolha **Editorial claro**, **Noir** ou **Paper beige**.
4. Use **Escolher ícone** para consultar a biblioteca.
5. Nos modelos com mídia, use **Adicionar imagem** ou **Escolher ilustração**. Aguarde a imagem carregar.
6. Para ajustar uma foto, clique em **Ajustar enquadramento**, mova a imagem, ajuste o zoom e use **Aplicar enquadramento**.
7. Confira todos os textos na **Prévia do card**.

### Salvar e baixar o arquivo

1. Clique em **Salvar**, informe **Nome do card** e confirme.
2. Aguarde **Card salvo no histórico compartilhado.**
3. Clique em **Exportar PNG** e aguarde o download.
4. Abra o PNG baixado e confira o conteúdo antes de distribuí-lo.

**Resultado:** o histórico guarda um card editável; a exportação gera um PNG com largura de 1080 px e a proporção da arte.

> **Salvar e exportar são ações diferentes.** Baixar o PNG não salva automaticamente a versão no histórico.

### Reutilizar uma arte

1. Abra **Histórico** e busque pelo nome ou pelo filtro de modelo.
2. Use **Editar** para alterar o mesmo card.
3. Use **Duplicar** para criar uma cópia e manter o original.
4. Edite a cópia, salve com um nome identificável e exporte novamente.

**Excluir** remove o card selecionado após confirmação. O histórico é compartilhado entre pessoas autorizadas, não uma pasta pessoal.

### Se a exportação estiver bloqueada

Aguarde a imagem terminar de carregar e leia o aviso de excesso de conteúdo. Reduza o texto que estiver cortado. O Portal bloqueia a exportação quando a arte ultrapassa seus limites.

## AutoCard: divulgar uma vaga

**Caminho:** AutoCard → Criar card → Vaga / Recrutamento.

**Quem opera:** acesso ao AutoCard.

### Preencher a divulgação

1. Em **Cargo**, informe o nome da vaga.
2. Em **Unidade / área**, informe o local ou a equipe.
3. Em **Descritivo da vaga**, resuma a missão e o dia a dia da posição.
4. Em **Requisitos (um por linha)**, escreva até **quatro itens**.
5. Em **Benefícios (um por linha)**, escreva até **quatro itens**.
6. Preencha **Prazo para candidatura** e **Canal de candidatura**.
7. Escolha a variação visual e confira a prévia inteira.
8. Clique em **Salvar**, dê um nome ao card e depois use **Exportar PNG**.

**Resultado:** uma arte de recrutamento pronta para distribuição.

### Limites dos campos

| Campo | Limite |
| --- | --- |
| Cargo | 40 caracteres. |
| Unidade / área | 40 caracteres. |
| Descritivo da vaga | 220 caracteres. |
| Requisitos | 160 caracteres no total e até quatro linhas com conteúdo. |
| Benefícios | 140 caracteres no total e até quatro linhas com conteúdo. |
| Prazo para candidatura | 5 caracteres, por exemplo `30/11`. |
| Canal de candidatura | 50 caracteres. |

Se aparecer “além do limite visual”, remova ou una itens. Se houver texto cortado, encurte o campo indicado até **Exportar PNG** ficar disponível.

> **Candidaturas:** são recebidas pelo canal informado na arte. Este módulo produz a divulgação; não acompanha candidatos.

## Cards Pós: convite para Convidado

**Caminho:** Cards Pós → Convidado → Criar convite.

**Quem opera:** pessoa com cargo ativo que libere Cards Pós, ou Super Admin.

### Montar o convite

1. Selecione **Convidado**.
2. Clique em **Adicionar imagem principal** e escolha JPG, PNG ou WebP de até **3 MB**, com pelo menos **500 × 500 px**.
3. Preencha **Chamada**, **Frase em destaque**, **Saudação** e **Apresentação**.
4. Em **Hospedagem, datas e unidade**, confira os dados da estadia.
5. Ajuste **Título da primeira seção**, **Descrição da experiência** e **O que não está incluso**.
6. Confira **Título dos consumos**, **Descrição dos consumos** e **Telefone**.
7. Revise a composição em **Arte inteira**; use **Ampliar** para ler os detalhes.

### Editar diretamente na prévia

Clique em um campo de texto editável da arte. Ajuste o conteúdo e use **Concluir**. **Cancelar** desfaz a edição local daquele campo; **Anterior** e **Próximo** navegam entre campos.

### Salvar e exportar

1. Clique em **Salvar**.
2. Preencha **Nome do card** e confirme em **Salvar**.
3. Aguarde **Convite salvo no histórico.**
4. Clique em **Exportar PDF**.
5. Abra o PDF baixado e confira nome, datas, serviços, consumos e contato.

**Resultado:** convite editável no histórico e PDF de uma página, no formato do modelo Convidado.

> **Salvar e exportar são independentes.** **Concluir** confirma o campo na edição local; não salva o convite no histórico.

### Se a nova imagem falhar

Leia o aviso abaixo do controle de imagem. A imagem anterior é mantida quando a troca falha. Confira o arquivo e tente novamente; uma exportação bem-sucedida não significa que a imagem nova foi aplicada.

## Cards Pós: Owner e histórico

**Caminho:** Cards Pós → Owner / Histórico.

**Quem opera:** acesso a Cards Pós.

### Preparar o card do Owner

1. Selecione **Owner** e confira a imagem principal.
2. Preencha **Chamada**, **Frase em destaque** e **Assinatura da experiência**.
3. Confira **Saudação**, **Apresentação**, **Responsável, hóspedes, unidade e datas** e **Como chegar**.
4. Revise os serviços inclusos: introdução, título, limpeza e equipe de apoio.
5. Revise os consumos pagos: **Gás, água e energia** e **Hospedagem pet**.
6. Confira as opções de serviços adicionais, os contatos dos anfitriões e os dados da central.
7. Clique em **Salvar**, nomeie o card e aguarde a confirmação.
8. Use **Exportar PDF** e confira o arquivo de uma página.

**Resultado:** o card do Owner fica salvo e disponível para exportação no formato próprio desse modelo.

### Localizar e atualizar convites

1. Abra **Histórico**.
2. Use **Buscar convites** para localizar o nome.
3. Confira se o item está identificado como **Owner** ou **Convidado**.
4. Clique em **Editar**, ajuste os dados e use **Salvar**.
5. Exporte novamente o PDF para obter a versão atualizada.

### Criar uma cópia

No histórico, clique em **Duplicar**. Localize a cópia, use **Editar**, troque os dados da reserva e salve com um nome que identifique a nova utilização.

### Excluir um convite

Clique em **Excluir** no item correto e confirme. A lista é compartilhada entre as pessoas autorizadas.

> **Conteúdo salvo:** convites antigos preservam os textos gravados na época. Ao reutilizar, revise valores, serviços, datas e contatos; mudar um texto padrão não atualiza automaticamente os itens antigos.

Os rascunhos dos modelos Owner e Convidado são separados. Salve o modelo que deseja manter antes de encerrar o trabalho.

## Auditoria e dados de usuários

**Caminho:** Admin → Usuários.

**Quem opera:** Super Admin.

### Consultar a atividade administrativa

1. Na aba **Usuários**, localize **Atividade administrativa recente**.
2. Em **Código exato da ação**, informe um código conhecido, como `user.update`, ou deixe vazio para consultar todas as ações.
3. Preencha **De** e **Até**, conforme o período desejado.
4. Clique em **Aplicar**.
5. Confira **Data (São Paulo)**, **Ator atual**, **Ação**, **Alvo** e **Request ID**.
6. Use a paginação para continuar ou **Limpar** para retirar os filtros.

**Resultado:** a lista apresenta os eventos que correspondem à consulta. As datas inicial e final são incluídas.

### Entender o registro

- **Ator atual** exibe o nome atual da conta; não é uma cópia do nome na data do evento.
- **Alvo** identifica o recurso afetado.
- **Request ID** ajuda o suporte a localizar a operação nos registros técnicos.
- Quando o autor não estiver mais disponível, pode aparecer **Sistema ou conta removida**.

### Desativar ou anonimizar

Para suspender o acesso e manter a conta, use **Desativar**.

Para executar a remoção permanente dos dados pessoais, quando essa for a tarefa autorizada:

1. Localize a pessoa correta e desative a conta.
2. Como Super Admin, clique em **Anonimizar**.
3. Leia a confirmação exibida e confirme somente a operação pretendida.
4. Aguarde o resultado e confira a listagem.

**Efeito:** remove nome, contato, foto e identidade de autenticação. Históricos operacionais permanecem conforme as regras de retenção. Essa ação é diferente de desativar e não tem uma ação de desfazer na interface.

### Pedir apoio com uma ocorrência

Informe a área, o horário, a ação executada, o texto da mensagem e o **Request ID**, quando disponível. Inclua uma captura apenas do trecho necessário para explicar o problema.

## Recursos condicionais: Benefícios e Sólides

**Caminho:** Admin → Benefícios / Sólides, quando a aba estiver disponível.

**Quem opera:** permissão específica da área.

### Cadastrar um benefício

1. Abra **Benefícios** e clique em **Novo benefício**.
2. Preencha **Empresa parceira**, **Categoria**, **Descrição do benefício** e **Como usar**.
3. Informe **Ordem (para exibição)** e marque **Ativo** quando o item puder ficar disponível.
4. Clique em **Salvar**.
5. Para alterar, use **Editar**. Para retirar temporariamente, desmarque **Ativo** e salve. **Excluir** remove o item após confirmação.

**Resultado:** o item fica no catálogo de benefícios conforme o estado salvo.

> **Disponibilidade:** a gestão de Benefícios existe, mas o catálogo permanece fora da navegação inicial dos colaboradores. Cadastrar um item não acrescenta um novo menu nem cria cupons ou resgates.

### Manter um vínculo Sólides

Esta integração fica desligada por padrão. Os passos abaixo só se aplicam quando a aba **Sólides** estiver liberada para sua conta e a integração estiver configurada.

1. Abra **Sólides** e confira o estado apresentado.
2. Em **Vincular colaborador**, selecione **Usuário do Portal**.
3. Informe **Employee ID** e, se necessário, **External ID (opcional)**, usando os identificadores fornecidos pela equipe responsável.
4. Escolha **Estado** conforme a situação efetivamente conferida.
5. Clique em **Salvar vínculo**.
6. Na listagem, use **Editar** para corrigir ou **Remover** para retirar o vínculo.

**Resultado:** o Portal registra a associação entre as duas contas. Salvar o vínculo, por si só, não habilita a integração.

### Quando essas abas não aparecerem

Consulte o Super Admin sobre a permissão e a disponibilidade da área. A ausência de uma aba condicionada não significa perda dos dados cadastrados.

## Consulta rápida e solução de dúvidas

### Qual ação encerra cada tarefa?

| Área | Ação que grava ou conclui |
| --- | --- |
| Usuários e artigos | **Salvar**; convites usam **Enviar convite**. |
| Notificações | **Salvar** grava o aviso e o agendamento. |
| Academy | **Salvar curso**, **Salvar módulo** e **Salvar aula**, separadamente. |
| Pages | **Salvar rascunho** grava; **Publicar página** libera aos leitores. |
| AutoCard | **Salvar** guarda o editável; **Exportar PNG** baixa a arte. |
| Cards Pós | **Salvar** guarda o convite; **Exportar PDF** baixa o documento. |
| Meu Perfil | **Salvar perfil**; foto e enquadramento têm controles próprios. |

### O botão ou a área não aparece

Confirme permissões e cargo ativo com o Super Admin. Em Pages, confira autoria ou revisão. A Academy está fora do menu e do Dashboard; use `/academy.html` ou Admin.

### Salvei, mas o colaborador não encontra

- **Academy:** confira público/cargo, ativação de curso, módulo e aula e acesso direto.
- **Pages:** confira a publicação da revisão e os cargos ativos selecionados.
- **Notificações:** confira **Ativo**, o público e o dia do mês.
- **Artigos:** retire os filtros. A prioridade do Código também respeita a busca.

### O salvamento falhou

Corrija os campos indicados e aguarde a confirmação. Em Pages, recarregar pode descartar alterações locais. Na Academy, confira seletores e vídeo e salve uma alteração por vez.

### O e-mail não chegou

Confira endereço e spam. **Entregas recentes** mostra notificações: `sent` não comprova leitura. Para convites, confirme recebimento e habilitação; esse histórico não os inclui. Encaminhe falhas persistentes ao suporte.

### A exportação está bloqueada

Espere a imagem carregar, reduza textos cortados e confira os limites. Abra o arquivo baixado para conferir e salve também a versão editável no histórico.

**Release candidata:** 18/11/2026, `feat/portal-welcome`, sobre `31de914`. Não atesta deploy, entrega externa de e-mail nem substitui o Código de Ética.
