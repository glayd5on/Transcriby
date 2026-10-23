# Como ficam os textos (exemplos ilustrativos)

Estes exemplos mostram o **formato** que o Transcriby entrega. O conteúdo é inventado para ilustrar;
não são o resultado de uma transcrição real. Quem transcreve é o Whisper, então a qualidade vem dele.

Trecho falado (áudio de uma aula sobre saúde):

## TXT (texto corrido, em parágrafos)

```
Olá, pessoal, tudo bem? Hoje eu quero falar sobre a importância de dormir bem. Muita gente acha que cinco horas de sono são suficientes, mas a ciência mostra que não é bem assim.

Vamos começar pelo básico: o que acontece com o corpo quando a gente dorme? Primeiro, o cérebro organiza as memórias do dia. Depois, o corpo se recupera fisicamente.
```

Os parágrafos mudam quando há uma pausa longa na fala (modo sem IA) ou quando muda o assunto (com revisão por IA).

## SRT (legenda, com tempos)

```
1
00:00:00,000 --> 00:00:03,120
Olá, pessoal, tudo bem?

2
00:00:03,120 --> 00:00:09,800
Hoje eu quero falar sobre a importância
de dormir bem.

3
00:00:09,800 --> 00:00:17,400
Muita gente acha que cinco horas de sono são
suficientes, mas a ciência mostra que não é bem assim.
```

Cada bloco tem no máximo 2 linhas de 42 caracteres. Abre direto em editores de vídeo, YouTube e players.

## O que esperar de qualidade

- **Áudio limpo, uma pessoa falando, português:** muito bom. Acentos, vírgulas, pontos e maiúsculas já vêm certos
  na grande maioria das frases. Costuma sobrar poucos erros por página.
- **Ruído, música de fundo, várias pessoas falando juntas, sotaque forte:** erros aumentam. Palavras parecidas
  podem ser trocadas.
- **Nomes próprios, siglas e termos técnicos:** são o ponto mais fraco. "Transcriby" pode sair "Transcribi".
- **Revisão por IA** corrige pontuação e ortografia, mas não adivinha o que não foi entendido no áudio.
  "Ortografia perfeita" é o objetivo, mas uma leitura rápida no final continua sendo recomendada.

## Limites

- Não separa quem está falando (não escreve "Pessoa 1 / Pessoa 2").
- O tempo de cada legenda segue as frases que o Whisper detecta; pode ficar uns décimos de segundo fora do ponto.
- No modo local, a velocidade depende do seu computador.
