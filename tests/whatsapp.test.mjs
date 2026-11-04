// Testes do leitor de conversas do WhatsApp. Rodar: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseChat, formatLine, applyFilters, toMarkdown, toTranscript, kindFromName, fmtDuration, hasFilters } from "../docs/whatsapp.js";

const IOS = [
  "‎[15/10/2026 09:00:01] Maria: ‎Mensagens e ligações são protegidas.",
  "[15/10/2026 09:12:30] Maria: ‎<anexo: 00000012-PHOTO-2026-10-15-09-12-30.jpg>",
  "[15/10/2026 14:32:05] João: ‎<anexo: 00000013-AUDIO-2026-10-15-14-32-05.opus>",
  "[15/10/2026 14:33:00] Maria: Primeira linha",
  "segunda linha da mesma mensagem",
  "[15/10/2026 14:35:10] João: ‎<anexo: 00000014-VIDEO-2026-10-15-14-35-10.mp4>",
  "[15/10/2026 14:36:10] João: ‎<anexo: 00000015-STICKER-2026-10-15-14-36-10.webp>",
  "[15/10/2026 14:37:10] Maria: ‎<anexo: contrato.pdf>",
  "[16/10/2026 08:00:00] Maria criou o grupo \"Casa: reforma\"",
].join("\n");
const IOS_FILES = ["_chat.txt", "00000012-PHOTO-2026-10-15-09-12-30.jpg", "00000013-AUDIO-2026-10-15-14-32-05.opus", "00000014-VIDEO-2026-10-15-14-35-10.mp4", "00000015-STICKER-2026-10-15-14-36-10.webp", "contrato.pdf"];

test("iPhone: colchetes, segundos, anexos, várias linhas", () => {
  const { messages: m, senders, counts } = parseChat(IOS, IOS_FILES);
  assert.equal(m.length, 8);
  assert.deepEqual(senders, ["Maria", "João"]);
  assert.equal(m[1].kind, "imagem"); assert.equal(m[1].file, "00000012-PHOTO-2026-10-15-09-12-30.jpg"); assert.equal(m[1].status, "pending");
  assert.equal(m[2].kind, "audio"); assert.equal(m[2].date, "2026-10-15"); assert.equal(m[2].time, "14:32");
  assert.equal(m[3].text, "Primeira linha\nsegunda linha da mesma mensagem");
  assert.equal(m[4].kind, "video");
  assert.equal(m[5].kind, "figurinha"); assert.equal(m[5].status, "done");
  assert.equal(m[6].kind, "documento");
  assert.equal(m[7].kind, "sistema"); assert.equal(m[7].sender, "WhatsApp");
  assert.equal(counts.audio, 1);
  assert.equal(formatLine(m[3]), "[15/10/2026 14:33] Maria (texto): Primeira linha segunda linha da mesma mensagem");
});

const ANDROID = [
  "15/10/2026 09:00 - As mensagens são protegidas com a criptografia de ponta a ponta.",
  "15/10/2026 09:12 - Maria: IMG-20261015-WA0001.jpg (arquivo anexado)",
  "contrato assinado",
  "15/10/2026 14:32 - João: AUD-20261015-WA0002.opus (arquivo anexado)",
  "15/10/2026 14:40 - João: <Mídia oculta>",
  "15/10/26, 2:41 PM - Pedro: oi",
].join("\n");

test("Android: traço, sem segundos, legenda, mídia oculta, 12 h", () => {
  const { messages: m } = parseChat(ANDROID, ["Conversa do WhatsApp com Maria.txt", "IMG-20261015-WA0001.jpg", "AUD-20261015-WA0002.opus"]);
  assert.equal(m.length, 5);
  assert.equal(m[0].kind, "sistema");
  assert.equal(m[1].kind, "imagem"); assert.equal(m[1].caption, "contrato assinado");
  assert.equal(m[2].kind, "audio"); assert.ok(m[2].file);
  assert.equal(m[3].kind, "outro");
  assert.equal(m[4].time, "14:41"); assert.equal(m[4].sender, "Pedro");
});

test("data em ordem mês/dia é reconhecida pelos dados", () => {
  const { messages: m } = parseChat("[10/25/2026, 9:05:00 AM] A: oi\n[10/26/2026, 9:06:00 PM] B: tchau", []);
  assert.equal(m[0].date, "2026-10-25"); assert.equal(m[1].time, "21:06");
});

test("anexo que não veio no zip fica marcado", () => {
  const { messages: m } = parseChat("[15/10/2026 09:12:30] Maria: <anexo: sumiu.jpg>", []);
  assert.equal(m[0].missing, true); assert.equal(m[0].status, "done");
  assert.match(formatLine(m[0]), /Maria \(imagem\): arquivo sumiu\.jpg não veio no zip/);
});

test("ordem cronológica estável", () => {
  const { messages: m } = parseChat("[15/10/2026 10:00:00] A: segundo\n[15/10/2026 09:00:00] B: primeiro\n[15/10/2026 10:00:00] C: terceiro", []);
  assert.deepEqual(m.map((x) => x.text), ["primeiro", "segundo", "terceiro"]);
});

test("filtros por pessoa, período e busca (sem acento); exportar .md", () => {
  const { messages: m, senders } = parseChat(IOS, IOS_FILES);
  m[2].status = "done"; m[2].result = "Transcrição do áudio com ação urgente";
  assert.equal(applyFilters(m, { sender: "João" }).length, 3);
  assert.equal(applyFilters(m, { from: "2026-10-16" }).length, 1);
  assert.equal(applyFilters(m, { to: "2026-10-14" }).length, 0);
  assert.equal(applyFilters(m, { q: "ACAO urgente" }).length, 1);
  const md = toMarkdown(applyFilters(m, { sender: "João" }), { fileName: "x.zip", total: m.length, filters: { sender: "João" }, senders });
  assert.match(md, /^# Conversa do WhatsApp/);
  assert.match(md, /Filtros aplicados: pessoa: João/);
  assert.match(md, /\[15\/10\/2026 14:32\] João \(áudio\): Transcrição do áudio/);
  assert.equal(toTranscript(m).split("\n").length, 8);
});

test("vídeo sem fala e imagem", () => {
  const { messages: m } = parseChat(IOS, IOS_FILES);
  m[4].status = "done"; m[4].result = "";
  assert.match(formatLine(m[4]), /\(vídeo\): vídeo sem fala$/);
  m[1].status = "done"; m[1].result = "Contrato assinado sobre uma mesa.";
  assert.equal(formatLine(m[1]), "[15/10/2026 09:12] Maria (imagem): Contrato assinado sobre uma mesa.");
});

test("tipos por nome e duração", () => {
  assert.equal(kindFromName("STK-20261015-WA0003.webp"), "figurinha");
  assert.equal(kindFromName("a.vcf"), "contato");
  assert.equal(fmtDuration(3 * 3600 + 12 * 60), "3 h 12 min");
});

test("várias conversas: transcrição com cabeçalho por conversa, filtro por conversa e .md com a lista", () => {
  const a = parseChat("[15/10/2026 09:00:01] Maria: Oi\n[15/10/2026 09:01:00] João: Bom dia").messages.map((m) => ({ ...m, conv: "Casa" }));
  const b = parseChat("[20/10/2026 14:00:00] Ana: Reunião amanhã").messages.map((m) => ({ ...m, conv: "Trabalho" }));
  const all = [...a, ...b];
  const t = toTranscript(all);
  assert.match(t, /^=== Conversa: Casa ===\n\[15\/10\/2026 09:00\] Maria \(texto\): Oi/);
  assert.match(t, /\n\n=== Conversa: Trabalho ===\n\[20\/10\/2026 14:00\] Ana/);
  assert.equal(toTranscript(a).includes("==="), false);   // uma conversa só: sem cabeçalho (igual a antes)
  assert.equal(hasFilters({ conv: "Casa" }), true);
  assert.deepEqual(applyFilters(all, { conv: "Trabalho" }).map((m) => m.sender), ["Ana"]);
  const md = toMarkdown(all, { fileName: "2 conversas" });
  assert.match(md, /- Conversas: Casa, Trabalho/);
  assert.match(md, /- Período: 15\/10\/2026 a 20\/10\/2026/);
  assert.match(md, /=== Conversa: Trabalho ===/);
});
