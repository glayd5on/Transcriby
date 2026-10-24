# Ligar o Gemini (mini servidor grátis)

O site manda o áudio em partes de 5 minutos para um **Cloudflare Worker**, que guarda a sua chave do Google e
pede ao Gemini a transcrição. A chave nunca fica na página, então ninguém consegue copiá-la. O plano grátis
da Cloudflare (100 mil pedidos por dia) sobra.

## Passo a passo (tudo pelo navegador, dá para fazer no computador)

1. Pegue uma chave grátis em https://aistudio.google.com/apikey (botão "Create API key").
2. Crie uma conta grátis em https://dash.cloudflare.com e abra **Workers & Pages** > **Create** > **Create Worker**.
   Dê o nome `transcriby-gemini` e clique em **Deploy**.
3. Clique em **Edit code**, apague tudo, cole o conteúdo do arquivo `cloudflare/worker.js` e clique em **Deploy**.
4. Em **Settings** > **Variables and Secrets**, adicione:
   - `GEMINI_API_KEY` (tipo Secret): a chave do passo 1
   - `ACCESS_KEY` (tipo Secret): uma senha que você inventar; o site pede essa senha uma vez por aparelho
   - `ALLOWED_ORIGIN` (tipo Text): `https://glayd5on.github.io`
5. Copie o endereço do Worker (algo como `https://transcriby-gemini.SEUNOME.workers.dev`).
6. No GitHub, abra `docs/config.js`, toque no lápis, troque `GEMINI_URL = ""` pelo endereço entre aspas e salve.
   (Faça o mesmo em `web/config.js` para manter as duas pastas iguais.)

Pronto: o site passa a mostrar "Como transcrever: Gemini (mais preciso)".

## Usando a chave da Vertex (arquivo .json da conta de serviço)

No passo 1 não precisa da chave do AI Studio. No passo 4, em vez de `GEMINI_API_KEY`, crie:

- `GOOGLE_SERVICE_ACCOUNT` (tipo **Secret**): abra o arquivo `.json` da Vertex no seu computador (ele abre no Bloco de Notas
  ou no TextEdit), selecione **tudo**, copie e cole no campo do valor. Não cole o conteúdo em nenhum chat.
- `VERTEX_LOCATION` (tipo Text, opcional): a região, por exemplo `us-central1` (padrão) ou `southamerica-east1`.
  O modelo precisa estar disponível nessa região; se der erro de modelo, tente `global`.

Os outros itens (`ACCESS_KEY` e `ALLOWED_ORIGIN`) são os mesmos. Requisitos no Google Cloud: a API **Vertex AI** ativada no
projeto e a conta de serviço com o papel **Vertex AI User**. A transcrição passa a ser cobrada na conta do projeto
(ou nos créditos dela).

## Observações

- A chave do AI Studio tem cota grátis com limite por minuto e por dia. Para vídeos de 10 minutos de uso pessoal costuma bastar.
- Modelo padrão: `gemini-2.5-flash`. Para outro, crie a variável `GEMINI_MODEL`.
- O áudio vai para o Google quando você usa o Gemini. Para não enviar nada, escolha "No navegador".
