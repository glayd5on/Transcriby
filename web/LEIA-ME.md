# Transcriby (versão grátis, roda no navegador)

Página estática: o Whisper roda dentro do navegador de quem usa (Transformers.js). Não tem servidor,
não tem API e não custa nada. O arquivo de áudio/vídeo nunca sai do computador da pessoa.

## Publicar de graça (qualquer uma serve)

- **Netlify Drop:** abra https://app.netlify.com/drop e arraste a pasta `web`. Em segundos você ganha um link.
- **Cloudflare Pages** ou **GitHub Pages:** envie o conteúdo da pasta `web` e ative a publicação.

Para testar no seu computador: `cd web && python3 -m http.server 8000` e abra http://localhost:8000.
(Não abra o index.html com duplo clique; o navegador bloqueia por segurança. Precisa de um endereço http.)

## O que esperar

- Na primeira vez, o navegador baixa o modelo (cerca de 80 MB no "Rápida", 250 MB no "Melhor"). Depois fica guardado.
- Velocidade depende do aparelho de quem usa. Chrome ou Edge no computador com placa de vídeo é bem mais rápido (WebGPU);
  sem isso roda no processador e pode levar de 1x a 3x a duração do áudio no modelo "Melhor".
- Arquivos muito grandes (vídeos de várias centenas de MB ou mais de 1 hora) podem faltar memória. O ideal é até ~1 hora de áudio.
- Não funciona bem no celular com arquivos longos.

## Arquivos

- `index.html`: tela
- `worker.js`: transcrição (carrega o Transformers.js pela internet)
- `srt.js`: gera o SRT estilo CapCut (curto, sem pontuação) ou completo
- `audio.js`: lê o áudio do arquivo (aos poucos, sem carregar o vídeo inteiro) e converte para mono 16 kHz
