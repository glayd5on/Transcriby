// Endereço do mini servidor (Cloudflare Worker) que faz a transcrição e o resumo.
export const GEMINI_URL = "https://transcriby-gemini.glaydsonironside.workers.dev";

// Importador de conversas do WhatsApp: limite de áudio somado (áudios + áudio dos vídeos) por envio de .zip.
export const MAX_AUDIO_HOURS = 10;
