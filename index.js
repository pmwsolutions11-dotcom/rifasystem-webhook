require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ══════════════════════════════════
// CONFIGURACIÓN DE SORTEOS
// ══════════════════════════════════
const SORTEOS = [
  {
    id: 1,
    nombre: 'Gran Rifa Agosto',
    precio: 50000,
    disponibles: 394,
    total: 1250,
    cierre: '31/08/2025',
    premio: 'TV Samsung 65 pulgadas 4K'
  },
  {
    id: 2,
    nombre: 'Moto del Mes',
    precio: 100000,
    disponibles: 698,
    total: 1000,
    cierre: '25/08/2025',
    premio: 'Moto Honda CB190'
  },
  {
    id: 3,
    nombre: 'Celular Samsung',
    precio: 30000,
    disponibles: 410,
    total: 500,
    cierre: '15/09/2025',
    premio: 'Samsung Galaxy S24'
  }
];

const DATOS_PAGO = `
- Tigo Money: 0991-546245 (a nombre de Rifas Premium)
- Banco: cuenta 123-456789, sucursal Central
`;

// ══════════════════════════════════
// SISTEMA PROMPT DEL BOT
// ══════════════════════════════════
const SYSTEM_PROMPT = `Sos el asistente virtual de "Rifas Premium Paraguay", atendiendo clientes por WhatsApp.
Sos amable, profesional y respondés en español latinoamericano.

SORTEOS DISPONIBLES AHORA:
${SORTEOS.map(s => `- ${s.nombre}: ₲ ${s.precio.toLocaleString()}/boleta, ${s.disponibles} disponibles de ${s.total}, cierra ${s.cierre}, premio: ${s.premio}`).join('\n')}

DATOS DE PAGO:${DATOS_PAGO}

FLUJO DE ATENCIÓN:
1. Saludá calurosamente y mostrá los sorteos disponibles si te preguntan
2. Cuando el cliente elija un sorteo y cantidad, calculá el total exacto: cantidad × precio del sorteo
3. Enviá los datos de pago con el monto exacto
4. Cuando el cliente diga que pagó o envió el comprobante, generá los números de boleta
5. Para generar boletas usá el formato exacto: [BOLETA:XXXX] donde XXXX son 4 dígitos. Si pide 2 boletas, generá 2 diferentes: [BOLETA:1234] [BOLETA:5678]
6. Confirmá que las boletas están registradas en el sistema con sus datos

REGLAS IMPORTANTES:
- Máximo 5 líneas por mensaje para no abrumar
- Si el cliente da su nombre, usalo en los siguientes mensajes
- Siempre calculá el total correcto antes de dar datos de pago
- Si el cliente pregunta por sorteos anteriores o ganadores, decí que los sorteos se transmiten en vivo por Facebook/TikTok
- Si el cliente tiene dudas sobre la legitimidad, explicá que el sorteo es en vivo con número de RUC verificable
- No des información de contacto adicional más allá de los datos de pago`;

// ══════════════════════════════════
// MEMORIA DE CONVERSACIONES
// ══════════════════════════════════
const conversaciones = new Map();
const boletasGeneradas = new Set();

function getConversacion(telefono) {
  if (!conversaciones.has(telefono)) {
    conversaciones.set(telefono, {
      historial: [],
      nombre: null,
      sorteo: null,
      boletas: [],
      timestamp: Date.now()
    });
  }
  return conversaciones.get(telefono);
}

// ══════════════════════════════════
// GENERAR NÚMERO ÚNICO DE BOLETA
// ══════════════════════════════════
function generarNumeroBoleta() {
  let num;
  do {
    num = Math.floor(Math.random() * 9000 + 1000).toString();
  } while (boletasGeneradas.has(num));
  boletasGeneradas.add(num);
  return num;
}

// ══════════════════════════════════
// ENVIAR MENSAJE POR WHATSAPP
// ══════════════════════════════════
async function enviarMensaje(telefono, mensaje) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'text',
        text: { body: mensaje }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Mensaje enviado a ${telefono}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${telefono}:`, error.response?.data || error.message);
    throw error;
  }
}

// ══════════════════════════════════
// PROCESAR MENSAJE CON IA
// ══════════════════════════════════
async function procesarConIA(telefono, mensajeCliente) {
  const conv = getConversacion(telefono);

  // Agregar mensaje del cliente al historial
  conv.historial.push({
    role: 'user',
    content: mensajeCliente
  });

  // Mantener historial en máximo 20 mensajes para no exceder tokens
  if (conv.historial.length > 20) {
    conv.historial = conv.historial.slice(-20);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conv.historial
    });

    const respuestaIA = response.content[0].text;

    // Agregar respuesta de la IA al historial
    conv.historial.push({
      role: 'assistant',
      content: respuestaIA
    });

    // Extraer y reemplazar tokens de boleta con números reales
    let respuestaFinal = respuestaIA;
    const boletasEnRespuesta = respuestaIA.match(/\[BOLETA:\d{4}\]/g);

    if (boletasEnRespuesta) {
      boletasEnRespuesta.forEach(token => {
        const numReal = generarNumeroBoleta();
        respuestaFinal = respuestaFinal.replace(token, `*#${numReal}*`);
        conv.boletas.push(numReal);
        console.log(`🎟 Boleta generada: #${numReal} para ${telefono}`);
      });
    }

    // Extraer nombre si el cliente lo dio
    const nombreMatch = mensajeCliente.match(/me llamo ([A-Za-záéíóúñÁÉÍÓÚÑ]+)/i) ||
                        mensajeCliente.match(/soy ([A-Za-záéíóúñÁÉÍÓÚÑ]+)/i) ||
                        mensajeCliente.match(/mi nombre es ([A-Za-záéíóúñÁÉÍÓÚÑ]+)/i);
    if (nombreMatch) conv.nombre = nombreMatch[1];

    conv.timestamp = Date.now();
    return respuestaFinal;

  } catch (error) {
    console.error('❌ Error con API de Claude:', error.message);
    return 'Disculpá, tuve un problema técnico. Por favor intentá de nuevo en un momento 🙏';
  }
}

// ══════════════════════════════════
// WEBHOOK — VERIFICACIÓN (GET)
// ══════════════════════════════════
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`🔍 Verificación webhook: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Token de verificación incorrecto');
    res.sendStatus(403);
  }
});

// ══════════════════════════════════
// WEBHOOK — RECIBIR MENSAJES (POST)
// ══════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Ignorar notificaciones de estado (delivered, read, etc)
    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const telefono = message.from;
    const tipo = message.type;

    console.log(`📨 Mensaje recibido de ${telefono} (tipo: ${tipo})`);

    // Solo procesar mensajes de texto por ahora
    if (tipo === 'text') {
      const textoCliente = message.text.body;
      console.log(`💬 Texto: ${textoCliente}`);

      // Procesar con IA
      const respuesta = await procesarConIA(telefono, textoCliente);

      // Enviar respuesta
      await enviarMensaje(telefono, respuesta);

    } else if (tipo === 'image') {
      // Cuando el cliente manda una imagen (comprobante)
      console.log(`🖼 Imagen recibida de ${telefono} — posible comprobante`);
      await enviarMensaje(telefono,
        '📋 Recibí tu comprobante, estoy verificando el pago...\n\n⏳ Dame un momento, confirmo en seguida.'
      );

      // Procesar como si hubiera enviado comprobante
      const respuesta = await procesarConIA(telefono, '[El cliente envió una foto del comprobante de pago]');
      await enviarMensaje(telefono, respuesta);

    } else {
      // Otros tipos de mensaje
      await enviarMensaje(telefono,
        'Hola! 👋 Por favor enviame un mensaje de texto para atenderte mejor.'
      );
    }

  } catch (error) {
    console.error('❌ Error procesando webhook:', error.message);
  }
});

// ══════════════════════════════════
// ENDPOINTS DE ADMINISTRACIÓN
// ══════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    sistema: 'RifaSystem Bot',
    version: '1.0.0',
    conversaciones_activas: conversaciones.size,
    boletas_generadas: boletasGeneradas.size,
    timestamp: new Date().toISOString()
  });
});

// Ver conversaciones activas
app.get('/admin/conversaciones', (req, res) => {
  const data = [];
  conversaciones.forEach((conv, telefono) => {
    data.push({
      telefono,
      nombre: conv.nombre || 'Sin nombre',
      mensajes: conv.historial.length,
      boletas: conv.boletas,
      ultima_actividad: new Date(conv.timestamp).toLocaleString('es-PY')
    });
  });
  res.json({ total: data.length, conversaciones: data });
});

// Ver boletas generadas
app.get('/admin/boletas', (req, res) => {
  res.json({
    total: boletasGeneradas.size,
    numeros: Array.from(boletasGeneradas)
  });
});

// Enviar mensaje manual (para el supervisor)
app.post('/admin/enviar', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) {
    return res.status(400).json({ error: 'Falta telefono o mensaje' });
  }
  try {
    await enviarMensaje(telefono, mensaje);
    res.json({ success: true, mensaje: 'Enviado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════
// LIMPIAR CONVERSACIONES VIEJAS
// (más de 2 horas sin actividad)
// ══════════════════════════════════
setInterval(() => {
  const ahora = Date.now();
  const dosHoras = 2 * 60 * 60 * 1000;
  let limpiadas = 0;
  conversaciones.forEach((conv, telefono) => {
    if (ahora - conv.timestamp > dosHoras) {
      conversaciones.delete(telefono);
      limpiadas++;
    }
  });
  if (limpiadas > 0) console.log(`🧹 ${limpiadas} conversaciones limpiadas por inactividad`);
}, 30 * 60 * 1000);

// ══════════════════════════════════
// INICIAR SERVIDOR
// ══════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     🎟 RifaSystem Bot — Online       ║
╠══════════════════════════════════════╣
║  Puerto: ${PORT}                        ║
║  Webhook: /webhook                   ║
║  Admin:   /admin/conversaciones      ║
╚══════════════════════════════════════╝
  `);
});
