require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'rifasystem2025';
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;

const SORTEOS = [
  { nombre: 'Gran Rifa Agosto', precio: 50000, disponibles: 394, cierre: '31/08/2025', premio: 'TV Samsung 65"' },
  { nombre: 'Moto del Mes', precio: 100000, disponibles: 698, cierre: '25/08/2025', premio: 'Moto Honda CB190' },
  { nombre: 'Celular Samsung', precio: 30000, disponibles: 410, cierre: '15/09/2025', premio: 'Samsung Galaxy S24' }
];

const SYSTEM = `Sos el asistente virtual de "Rifas Premium Paraguay" atendiendo por WhatsApp.

SORTEOS DISPONIBLES:
- Gran Rifa Agosto: 50000 guaranies/boleta, 394 disponibles, cierra 31/08/2025, premio: TV Samsung 65"
- Moto del Mes: 100000 guaranies/boleta, 698 disponibles, cierra 25/08/2025, premio: Moto Honda CB190
- Celular Samsung: 30000 guaranies/boleta, 410 disponibles, cierra 15/09/2025, premio: Samsung Galaxy S24

DATOS DE PAGO:
- Tigo Money: 0991-546245 (Rifas Premium)
- Banco: cuenta 123-456789

FLUJO:
1. Saluda y muestra sorteos si preguntan
2. Cuando elijan sorteo y cantidad, calcula total exacto (cantidad x precio)
3. Envia datos de pago
4. Cuando paguen o manden comprobante, genera boletas con formato [BOLETA:XXXX] — 4 digitos unicos
5. Confirma que estan registradas

REGLAS: Espanol latinoamericano, amigable, maximo 5 lineas por mensaje, calcula siempre el total exacto.`;

const conversaciones = new Map();
const boletasUsadas = new Set();

function getConv(tel) {
  if (!conversaciones.has(tel)) conversaciones.set(tel, { historial: [], timestamp: Date.now() });
  return conversaciones.get(tel);
}

function numeroBoleta() {
  let n;
  do { n = Math.floor(Math.random() * 9000 + 1000).toString(); } while (boletasUsadas.has(n));
  boletasUsadas.add(n);
  return n;
}

async function enviar(tel, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: tel, type: 'text', text: { body: texto } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`Mensaje enviado a ${tel}`);
  } catch (err) {
    console.error('Error enviando:', err.response?.data || err.message);
  }
}

async function responderIA(tel, msg) {
  const conv = getConv(tel);
  conv.historial.push({ role: 'user', content: msg });
  if (conv.historial.length > 20) conv.historial = conv.historial.slice(-20);
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: SYSTEM,
    messages: conv.historial
  });
  let reply = res.content[0].text;
  conv.historial.push({ role: 'assistant', content: reply });
  conv.timestamp = Date.now();
  reply = reply.replace(/\[BOLETA:\d{4}\]/g, () => `*#${numeroBoleta()}*`);
  return reply;
}

app.get('/', (req, res) => {
  res.json({ status: 'online', sistema: 'RifaSystem Bot', version: '2.0.0', conversaciones: conversaciones.size });
});

app.get('/webhook', (req, res) => {
  console.log('Verificacion recibida:', JSON.stringify(req.query));
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`mode=${mode} token=${token} esperado=${VERIFY_TOKEN}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado OK');
    return res.status(200).send(challenge);
  }
  console.log('Token incorrecto');
  return res.status(403).send('Forbidden');
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    const msg = messages[0];
    const tel = msg.from;
    console.log(`Mensaje de ${tel} tipo=${msg.type}`);
    if (msg.type === 'text') {
      const reply = await responderIA(tel, msg.text.body);
      await enviar(tel, reply);
    } else if (msg.type === 'image') {
      const reply = await responderIA(tel, '[Cliente envio foto del comprobante de pago]');
      await enviar(tel, reply);
    } else {
      await enviar(tel, 'Hola! Por favor enviame un mensaje de texto para atenderte.');
    }
  } catch (err) {
    console.error('Error webhook:', err.message);
  }
});

setInterval(() => {
  const limite = Date.now() - 7200000;
  conversaciones.forEach((c, t) => { if (c.timestamp < limite) conversaciones.delete(t); });
}, 1800000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`RifaSystem Bot online - Puerto ${PORT}`));
