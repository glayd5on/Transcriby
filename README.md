# Transcriby

> **Site grátis (pasta `web/` e `docs/`):** devolve só o texto completo, para copiar e usar numa IA. Transcreve com o Gemini via um Cloudflare Worker grátis (`cloudflare/LEIA-ME.md`) ou com o Whisper no navegador.

> **Quer 100% grátis na web?** Use a pasta `web/` (roda no navegador, sem servidor e sem API). Veja `web/LEIA-ME.md`.
> O restante deste README é da versão com servidor (pasta `app/`).

Site para transcrever áudio e vídeo com ortografia revisada. Você envia o arquivo, escolhe o idioma
e baixa o resultado em **TXT** (texto organizado em parágrafos) ou **SRT** (legenda com tempos).

## Estilos de saída

- **Estilo CapCut (padrão):** SRT em blocos curtos (até 24 caracteres), sem pontuação, ideal para colar numa IA.
  Não usa a revisão por IA, então é mais rápido e mais barato. O TXT sai como texto contínuo, também sem pontuação.
- **Completo:** legendas de 2 linhas, com pontuação, revisão ortográfica por IA e TXT em parágrafos.

## Dois modos

| | **Local (padrão, grátis)** | **OpenAI (API paga)** |
|---|---|---|
| Transcrição | Whisper rodando no seu PC (faster-whisper) | Whisper na nuvem da OpenAI |
| Custo | Zero | ~US$ 0,36 por hora de áudio |
| Velocidade | Depende do PC. Com placa NVIDIA é rápido; só com processador, 1 h de áudio pode levar 30 min a 1 h | Rápido em qualquer máquina |
| Revisão ortográfica | Opcional, com o Ollama (IA local e grátis) | Automática |
| Internet | Só para baixar o modelo na 1ª vez (~1,6 GB) | Sempre |

Sem chave nenhuma, o site já roda no modo local. O próprio Whisper já entrega o texto com acentos,
pontuação e letras maiúsculas; a revisão por IA é um polimento extra. Sem ela, o TXT é dividido em
parágrafos pelas pausas da fala.

## Como funciona

1. **ffmpeg** extrai o áudio de qualquer formato (MP3, WAV, M4A, MP4, MOV, MKV…).
2. **Whisper** transcreve com marcação de tempo de cada frase.
3. Se houver uma IA configurada, ela revisa ortografia, acentuação e pontuação de cada trecho
   (sem resumir nem mudar o sentido) e organiza o texto em parágrafos.
4. O SRT é montado com até 2 linhas de 42 caracteres por legenda.

## Rodar no seu computador (modo local, sem API)

Precisa de Python 3.10+ e ffmpeg instalados (no Windows: `winget install ffmpeg`; no Mac: `brew install ffmpeg`).

```bash
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Abra http://localhost:8000. Na primeira transcrição o modelo é baixado (demora uns minutos).

PC mais fraco? Use um modelo menor, por exemplo `TRANSCRIBY_WHISPER_MODEL=small`
(mais rápido, um pouco menos preciso). Opções: `tiny`, `base`, `small`, `medium`, `large-v3-turbo` (padrão), `large-v3`.

### Revisão ortográfica grátis com Ollama (opcional)

1. Instale o Ollama: https://ollama.com
2. Baixe um modelo bom em português: `ollama pull qwen2.5:7b`
3. Rode o site assim:

```bash
export TRANSCRIBY_LLM_BASE_URL=http://localhost:11434/v1   # Windows: set TRANSCRIBY_LLM_BASE_URL=...
uvicorn app.main:app --port 8000
```

## Rodar com a API da OpenAI (mais rápido)

Crie uma chave em https://platform.openai.com/api-keys (é preciso adicionar crédito) e:

```bash
export OPENAI_API_KEY=sk-...
uvicorn app.main:app --port 8000
```

Com a chave definida, o site usa a OpenAI para transcrever e revisar.

Para testar a tela sem transcrever nada: `TRANSCRIBY_MOCK=1 uvicorn app.main:app`.

## Com Docker

```bash
docker build -t transcriby .
docker run -p 8000:8000 -e OPENAI_API_KEY=sk-... transcriby
```

## Colocar na internet

Qualquer serviço que rode Docker funciona. Sugestão: **Render** (render.com) ou **Railway**.
Crie um "Web Service" a partir deste repositório, escolha Docker e adicione a variável
`OPENAI_API_KEY`. (O modo local na nuvem exige um servidor com bastante memória ou GPU, o que
costuma sair mais caro que a API; para uso grátis, rode no seu próprio computador.) Atenção: o site não tem login, então quem tiver o link pode usar sua chave.
Antes de divulgar, vale adicionar uma senha ou login.

## Configurações opcionais (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `TRANSCRIBY_ENGINE` | `local` sem chave, `openai` com chave | Força um dos modos |
| `TRANSCRIBY_WHISPER_MODEL` | `large-v3-turbo` | Modelo do modo local |
| `TRANSCRIBY_LLM_BASE_URL` | (vazio) | Endereço do Ollama para revisão local |
| `TRANSCRIBY_STT_MODEL` | `whisper-1` | Modelo de transcrição da OpenAI |
| `TRANSCRIBY_LLM_MODEL` | `gpt-4.1-mini` (OpenAI) ou `qwen2.5:7b` (Ollama) | Modelo que revisa a ortografia |
| `TRANSCRIBY_MOCK` | `0` | `1` = modo demonstração |

## Estrutura

```
app/main.py         servidor web e API (upload, progresso, download)
app/transcriber.py  extração de áudio, transcrição e revisão
app/formats.py      geração de SRT e TXT
static/index.html   página do site
```
