# Limite de 100 MB para anexos PDF

## Objetivo

Permitir anexos PDF de até 100 MB no Portal sem ampliar o limite atual dos
demais assets do CMS.

## Limites

- PDFs: até 100 MB;
- imagens e vídeos: permanecem limitados a 50 MB;
- Nginx: aceita requisições multipart de até `101m` nas duas rotas de upload
  de assets do CMS.

O megabyte usado pelo frontend e pela API corresponde a `1024 * 1024` bytes.
A margem adicional do Nginx cobre os metadados do multipart sem alterar o
limite de arquivo aplicado pela API.

## API

O Multer continuará usando armazenamento em memória e aceitará no transporte
o maior limite permitido, 100 MB. Depois da detecção do MIME pelos bytes do
arquivo, a API aplicará o limite específico:

- `application/pdf`: 100 MB;
- qualquer outro MIME permitido: 50 MB.

Arquivos maiores que o limite correspondente retornarão HTTP `413` e não serão
gravados. Assinaturas inválidas ou divergentes do MIME declarado continuarão
seguindo a validação existente.

Não será introduzido streaming nesta mudança. Essa revisão será necessária se
o limite aumentar novamente ou se a concorrência de uploads administrativos
passar a pressionar a memória da API.

## Frontend e documentação

As duas validações de PDF em `public/js/knowledge.js` passarão de 50 MB para
100 MB, incluindo a mensagem apresentada ao usuário. O inventário funcional
será atualizado para registrar o novo limite.

O editor CMS continuará dependendo da validação autoritativa da API quando não
houver validação antecipada específica no navegador.

## Validação

Os testes automatizados verificarão:

- teto de transporte de 100 MB no Multer;
- limite de 100 MB para PDF e manutenção de 50 MB para outros assets;
- resposta `413` para arquivo acima do limite detectado;
- mensagens de 100 MB nas duas entradas de PDF do frontend;
- `client_max_body_size 101m` nas duas rotas de upload CMS do Nginx;
- inventário funcional atualizado.

Será executado `npm run verify` antes da entrega.
