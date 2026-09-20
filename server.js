/**
 * Conectado — Gateway
 *
 * Segura a sessão do WhatsApp (QR Code), responde quem manda mensagem
 * usando o agente de IA treinado no admin, e cria cobranças no Mercado Pago.
 *
 * Roda em Railway, Render, Fly.io ou qualquer VPS. NÃO funciona em
 * Netlify/Vercel Functions — a sessão do WhatsApp precisa de processo
 * vivo com socket aberto, e função serverless morre a cada requisição.
 *
 * AVISO: conectar por QR usa o protocolo do WhatsApp Web por fora da API
 * oficial da Meta, o que contraria os Termos de Uso do WhatsApp. Responder
 * quem te procura é de baixo risco. Iniciar conversa nova em volume derruba
 * o número. O disparo frio fica no admin, clique a clique, de propósito.
 */

import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const PORTA        = process.env.PORT || 3000;
const TOKEN        = process.env.CONECTADO_TOKEN || '';
const ANTHROPIC    = process.env.ANTHROPIC_API_KEY || '';
const MP_TOKEN     = process.env.MP_ACCESS_TOKEN || '';
const ORIGEM       = process.env.ORIGEM_PERMITIDA || '*';
const PAUSA_HUMANA = Number(process.env.PAUSA_HUMANA_MIN || 30); // min sem IA depois que você responde

const app = express();
app.use(cors({ origin: ORIGEM }));
app.use(express.json({ limit: '1mb' }));

/* ---------- estado ---------- */
let sock = null;
let qrAtual = null;
let conectado = false;
let numeroConectado = '';
const conversas = new Map();   // jid -> { historico: [], pausadoAte: 0, lead: {} }
const optOut = new Set();

let TREINO = {
  agente: { nome: 'Nina', tom: 'direto e simpático', instrucoes: '', faq: [], escalar: [] },
  precos: { servicos: [], pacotes: [], regras: {} }
};
try {
  if (fs.existsSync('./treino.json')) TREINO = JSON.parse(fs.readFileSync('./treino.json', 'utf8'));
} catch {}

function salvarTreino() {
  try { fs.writeFileSync('./treino.json', JSON.stringify(TREINO, null, 2)); } catch {}
}

/* ---------- auth simples ---------- */
function protege(req, res, next) {
  if (!TOKEN) return next();
  if (req.headers['x-conectado-token'] !== TOKEN) return res.status(401).json({ erro: 'Token inválido' });
  next();
}

/* ==========================================================================
   WHATSAPP
   ========================================================================== */
async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./sessao');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Conectado', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false   // não marca você como online o tempo todo
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      qrAtual = await qrcode.toDataURL(qr, { margin: 1, width: 400 });
      conectado = false;
    }
    if (connection === 'open') {
      conectado = true;
      qrAtual = null;
      numeroConectado = (sock.user?.id || '').split(':')[0];
      console.log('WhatsApp conectado:', numeroConectado);
    }
    if (connection === 'close') {
      conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      if (motivo !== DisconnectReason.loggedOut) {
        console.log('Conexão caiu, reconectando...');
        setTimeout(iniciarWhatsApp, 4000);
      } else {
        console.log('Sessão encerrada. Escaneie o QR de novo.');
        try { fs.rmSync('./sessao', { recursive: true, force: true }); } catch {}
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try { await tratarMensagem(m); } catch (e) { console.error('Erro ao tratar mensagem:', e.message); }
    }
  });
}

function textoDe(m) {
  const msg = m.message || {};
  return msg.conversation
      || msg.extendedTextMessage?.text
      || msg.imageMessage?.caption
      || msg.videoMessage?.caption
      || '';
}

async function tratarMensagem(m) {
  const jid = m.key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;  // ignora grupo e status

  const texto = textoDe(m).trim();
  if (!texto) return;

  const conv = conversas.get(jid) || { historico: [], pausadoAte: 0, lead: {} };

  // Você respondeu manualmente pelo celular: a IA cala a boca por um tempo
  if (m.key.fromMe) {
    conv.pausadoAte = Date.now() + PAUSA_HUMANA * 60000;
    conv.historico.push({ role: 'assistant', content: texto });
    conversas.set(jid, conv);
    return;
  }

  const numero = jid.split('@')[0];

  // opt-out: pedido de parar é definitivo
  if (/\b(n[aã]o quero|me tira|para de|pare de|descadastr|sai da lista|n[aã]o me mand)/i.test(texto)) {
    optOut.add(numero);
    await sock.sendMessage(jid, { text: 'Entendido, não te chamo mais. Desculpa o incômodo e sucesso com o negócio!' });
    avisarCRM({ numero, evento: 'opt_out', texto });
    return;
  }
  if (optOut.has(numero)) return;

  if (Date.now() < conv.pausadoAte) {           // você está no controle agora
    conv.historico.push({ role: 'user', content: texto });
    conversas.set(jid, conv);
    return;
  }

  // gatilhos de escalonamento: a IA para e te avisa
  const gatilhos = TREINO.agente.escalar || [];
  if (gatilhos.some(g => texto.toLowerCase().includes(g.toLowerCase()))) {
    await sock.sendMessage(jid, { text: 'Claro, vou chamar o ' + (process.env.MEU_NOME || 'Leo') + ' aqui pra falar contigo. Um instante.' });
    conv.pausadoAte = Date.now() + PAUSA_HUMANA * 60000;
    conversas.set(jid, conv);
    avisarCRM({ numero, evento: 'escalar', texto });
    return;
  }

  conv.historico.push({ role: 'user', content: texto });
  if (conv.historico.length > 24) conv.historico = conv.historico.slice(-24);

  await sock.sendPresenceUpdate('composing', jid);
  const resposta = await chamarIA(conv.historico);
  // pausa proporcional ao tamanho, pra não parecer robô instantâneo
  await new Promise(r => setTimeout(r, Math.min(6000, 900 + resposta.length * 22)));

  await sock.sendMessage(jid, { text: resposta });
  conv.historico.push({ role: 'assistant', content: resposta });
  conversas.set(jid, conv);

  avisarCRM({ numero, evento: 'conversa', texto, resposta });
}

/* ==========================================================================
   AGENTE DE IA
   ========================================================================== */
function montarSystemPrompt() {
  const a = TREINO.agente, p = TREINO.precos;

  const tabela = (p.servicos || []).filter(s => s.ativo !== false).map(s =>
    `- ${s.nome}: instalação R$ ${Number(s.setup).toFixed(2)}, mensalidade R$ ${Number(s.mensal).toFixed(2)}` +
    (s.desc ? ` — ${s.desc}` : '')
  ).join('\n');

  const pacotes = (p.pacotes || []).map(pk => {
    const nomes = pk.servicos.map(id => (p.servicos.find(s => s.id === id) || {}).nome).filter(Boolean);
    return `- ${pk.nome} (${pk.desconto}% de desconto): ${nomes.join(' + ')}`;
  }).join('\n');

  const faq = (a.faq || []).filter(f => f.p && f.r)
    .map(f => `P: ${f.p}\nR: ${f.r}`).join('\n\n');

  const r = p.regras || {};

  return [
    a.instrucoes,
    '',
    '--- TABELA DE PREÇOS (use exatamente estes valores) ---',
    tabela,
    '',
    'PACOTES:',
    pacotes,
    '',
    `Desconto máximo que você pode oferecer: ${r.descontoMaxAgente || 0}%. Acima disso, diga que vai confirmar com o Leo.`,
    `Instalação pode ser parcelada em até ${r.parcelasSetup || 1}x.`,
    r.diasTeste ? `Existem ${r.diasTeste} dias de teste grátis.` : '',
    '',
    '--- RESPOSTAS DE REFERÊNCIA ---',
    faq,
    '',
    `Tom de voz: ${a.tom}. Seu nome é ${a.nome}.`,
    'Responda SEMPRE em português do Brasil, em no máximo 4 linhas, e termine com uma pergunta ou um próximo passo claro.'
  ].filter(Boolean).join('\n');
}

async function chamarIA(historico) {
  if (!ANTHROPIC) return 'Oi! Em um instante o Leo te responde aqui.';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',   // barato, suficiente pra atendimento
        max_tokens: 400,
        system: montarSystemPrompt(),
        messages: historico
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
      || 'Pode repetir? Não peguei bem.';
  } catch (e) {
    console.error('IA falhou:', e.message);
    return 'Opa, tive um probleminha aqui. Já já te respondo.';
  }
}

/* webhook opcional pro CRM registrar a conversa */
async function avisarCRM(dados) {
  const url = process.env.WEBHOOK_CRM;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-conectado-token': TOKEN },
      body: JSON.stringify({ ...dados, em: new Date().toISOString() })
    });
  } catch {}
}

/* ==========================================================================
   MERCADO PAGO
   ========================================================================== */
async function criarCobranca(lead, contrato) {
  if (!MP_TOKEN) throw new Error('MP_ACCESS_TOKEN não configurado');

  const itens = [];
  if (Number(contrato.setup) > 0) {
    itens.push({
      title: `Instalação — ${contrato.pacote}`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Number(Number(contrato.setup).toFixed(2))
    });
  }
  if (Number(contrato.mensal) > 0) {
    itens.push({
      title: `1º mês — ${contrato.pacote}`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Number(Number(contrato.mensal).toFixed(2))
    });
  }

  const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + MP_TOKEN },
    body: JSON.stringify({
      items: itens,
      payer: { name: lead.nome },
      external_reference: lead.id,
      statement_descriptor: 'CONECTADO',
      payment_methods: {
        installments: Number(TREINO.precos?.regras?.parcelasSetup || 3)
      },
      back_urls: {
        success: (process.env.URL_SITE || 'https://conectado.alphagalerie.com') + '/obrigado',
        failure: (process.env.URL_SITE || 'https://conectado.alphagalerie.com') + '/erro'
      },
      notification_url: process.env.URL_GATEWAY ? process.env.URL_GATEWAY + '/pagamento/webhook' : undefined
    })
  });
  const d = await r.json();
  if (d.error || !d.init_point) throw new Error(d.message || 'Mercado Pago recusou a cobrança');
  return d.init_point;
}

/* ==========================================================================
   ROTAS
   ========================================================================== */
app.get('/', (_, res) => res.json({ ok: true, servico: 'conectado-gateway' }));

app.get('/status', protege, (_, res) => {
  res.json({
    conectado,
    numero: numeroConectado,
    conversasAtivas: conversas.size,
    optOut: optOut.size,
    ia: !!ANTHROPIC,
    pagamentos: !!MP_TOKEN
  });
});

app.post('/whatsapp/qr', protege, async (_, res) => {
  if (conectado) return res.json({ conectado: true, numero: numeroConectado });
  if (!sock) await iniciarWhatsApp();
  // espera o QR aparecer (até 15s)
  for (let i = 0; i < 30 && !qrAtual && !conectado; i++) await new Promise(r => setTimeout(r, 500));
  if (conectado) return res.json({ conectado: true, numero: numeroConectado });
  if (!qrAtual) return res.status(503).json({ erro: 'QR ainda não gerado, tente de novo' });
  res.json({ conectado: false, qr: qrAtual });
});

app.post('/whatsapp/sair', protege, async (_, res) => {
  try { await sock?.logout(); } catch {}
  try { fs.rmSync('./sessao', { recursive: true, force: true }); } catch {}
  conectado = false; qrAtual = null; sock = null;
  res.json({ ok: true });
});

app.post('/whatsapp/enviar', protege, async (req, res) => {
  const { numero, texto } = req.body || {};
  if (!conectado) return res.status(409).json({ erro: 'WhatsApp não conectado' });
  if (optOut.has(String(numero))) return res.status(403).json({ erro: 'Número pediu para não ser contatado' });
  try {
    await sock.sendMessage(String(numero).replace(/\D/g, '') + '@s.whatsapp.net', { text: texto });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/agente/treinar', protege, (req, res) => {
  if (req.body?.agente) TREINO.agente = req.body.agente;
  if (req.body?.precos) TREINO.precos = req.body.precos;
  salvarTreino();
  res.json({ ok: true });
});

app.post('/agente/testar', protege, async (req, res) => {
  if (req.body?.agente) TREINO.agente = req.body.agente;
  if (req.body?.precos) TREINO.precos = req.body.precos;
  const resposta = await chamarIA(req.body?.historico || []);
  res.json({ resposta });
});

app.post('/pagamento/criar', protege, async (req, res) => {
  try {
    const link = await criarCobranca(req.body.lead || {}, req.body.contrato || {});
    res.json({ link });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mercado Pago avisa aqui quando o pagamento muda de status
app.post('/pagamento/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const id = req.body?.data?.id;
    if (!id || !MP_TOKEN) return;
    const r = await fetch('https://api.mercadopago.com/v1/payments/' + id, {
      headers: { Authorization: 'Bearer ' + MP_TOKEN }
    });
    const p = await r.json();
    console.log('Pagamento', p.status, 'ref', p.external_reference);
    avisarCRM({ evento: 'pagamento', leadId: p.external_reference, status: p.status, valor: p.transaction_amount });
  } catch (e) { console.error(e.message); }
});

app.listen(PORTA, () => {
  console.log('Gateway do Conectado na porta ' + PORTA);
  iniciarWhatsApp().catch(e => console.error('WhatsApp não subiu:', e.message));
});
