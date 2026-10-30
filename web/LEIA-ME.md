# Transcriby (site estático)

Página estática (`index.html` + módulos JS). O áudio é lido no navegador, cortado em partes de ~5 minutos e enviado a um
Cloudflare Worker (ver `../cloudflare/LEIA-ME.md`), que transcreve com o modelo Reo (Beta) e também gera resumos.
O vídeo nunca sai do aparelho: só o áudio é enviado.

## Publicar

O GitHub Pages publica a pasta `docs`. Esta pasta `web` é a cópia-fonte; mantenha as duas iguais (exceto este arquivo).
O endereço do Worker fica em `config.js`.

Para testar no computador: `cd web && python3 -m http.server 8000` e abra http://localhost:8000.
(O Worker só aceita o site publicado em `ALLOWED_ORIGIN`; em `localhost` a transcrição fica bloqueada.)

## Arquivos

- `index.html`: tela (idioma, modelo Reo, "Conversa em ZIP" em breve, resultado, downloads e resumo)
- `gemini.js`: corta o áudio em partes, envia ao Worker, ajusta o tempo dos trechos e pede o resumo
- `srt.js`: monta o texto em parágrafos e o SRT com tempo
- `audio.js`: lê o áudio do arquivo (aos poucos, sem carregar o vídeo inteiro) e converte para mono 16 kHz
- `config.js`: endereço do Worker
