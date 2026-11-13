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

Pronto: o site passa a transcrever com o modelo Reo 1.0. O mesmo Worker também gera o resumo (`?mode=summary`).

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
- Modelos (constantes no topo de `worker.js`): `MODEL_LITE` = `gemini-3.1-flash-lite` (transcrição de áudio e descrição de imagem) e
  `MODEL_FLASH` = `gemini-3.8-flash` (chat do Reo e resumos, só quando a pessoa pede no site). Para trocar sem mexer no código,
  crie as variáveis de texto `MODEL_LITE` e/ou `MODEL_FLASH`. Se o modelo não existir no seu projeto/região, o Worker tenta o
  `MODEL_FALLBACK` (padrão `gemini-2.5-flash`). Modelos novos às vezes só existem na região `global`: use `VERTEX_LOCATION` = `global`.
  A variável antiga `GEMINI_MODEL` não é mais usada.
- O áudio vai para o Google durante a transcrição. O site não tem mais o modo "No navegador" (Whisper).
- O Worker devolve os trechos com o tempo de início (`{segments: [{start: "MM:SS", text, paragraph}]}`); o site monta o texto em parágrafos e o SRT.

## Importador do WhatsApp e chat do Reo

O mesmo Worker atende:

- `POST ?mode=image` (corpo = imagem): descrição curta da imagem (Flash-Lite).
- `POST` com áudio (WAV, ou `audio/ogg`, `audio/mpeg`, `audio/mp4` etc.): transcrição (Flash-Lite).
- `POST ?mode=chat` (JSON `{message, history, transcript}`): resposta do Reo (Flash). A instrução de sistema é fixa e fica em
  `cloudflare/reo.js`; o site não consegue trocá-la. A transcrição entra só dentro de `<conversa></conversa>` (qualquer `<conversa>`
  que apareça no texto é removida). O chat só aceita texto e só chama o modelo de texto.

## Alerta de tentativas de descobrir o Reo (Telegram + KV)

O código está em `cloudflare/guard.js` (números no objeto `CFG` do topo). Sem o KV e sem o Telegram o Worker funciona normalmente,
só sem o alerta e com um freio mais fraco (na memória do Worker). Para ligar tudo:

1. **Telegram:** fale com `@BotFather`, envie `/newbot` e guarde o token. Mande uma mensagem qualquer ao seu bot e abra
   `https://api.telegram.org/botSEU_TOKEN/getUpdates` para ver o número do chat (campo `chat` > `id`).
2. **KV:** no painel da Cloudflare, **Storage & Databases** > **KV** > **Create** com o nome `ABUSE_KV`. Copie o **ID** do namespace
   e coloque em `wrangler.toml` (as 3 linhas comentadas no fim do arquivo; o ID não é segredo).
3. **Segredos** (Worker > **Settings** > **Variables and Secrets**, tipo Secret): `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
4. O site já manda o `X-Session-Id` (um código por aba, guardado em `sessionStorage`).

Regras: 5 tentativas suspeitas em 10 minutos (por IP ou por sessão) => alerta no Telegram e bloqueio do IP por 1 hora.
Limite geral de 40 mensagens por IP em 10 minutos. O contador do KV não é atômico: em rajadas muito rápidas pode contar um pouco a menos.

## Limite diário e código de liberação

O código está em `cloudflare/limits.js`. Cada pessoa (por IP) e o site inteiro têm um limite por dia, em **minutos de uso**:
o áudio conta pela duração, cada foto vale 0,2 min e cada resumo ou pergunta ao Reo vale 2 min. Zera à meia-noite de Brasília.
Padrões: 60 min por pessoa e 3.000 min para o site todo. Para trocar, crie as variáveis de texto `DAILY_LIMIT_IP_MIN` e
`DAILY_LIMIT_SITE_MIN` no Cloudflare (Settings, Variables and Secrets).

- **Contador:** um Durable Object chamado `USAGE`, declarado no `wrangler.toml` (não precisa criar nada no painel).
  Sem ele o Worker usa a memória (freio fraco) e o `?status` mostra `contador_ligado: false`.
- **Código de liberação (sem limite):** crie o segredo `UNLIMITED_CODES` com um ou mais códigos separados por vírgula
  (cada um com pelo menos 8 caracteres; use letras e números sem sentido). Quem digita o código no rodapé do site, ou abre o
  link `https://SEU-SITE/?liberar=CODIGO`, fica sem limite naquele aparelho. Para cancelar um código, tire ele do segredo.
- Errar o código mais de 10 vezes por hora bloqueia o IP por 1 hora.
- O Worker também só aceita pedidos vindos do site (cabeçalho `Origin` em `ALLOWED_ORIGIN` ou nos endereços do site).
