require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SOLAREDGE_SITE_ID = process.env.SOLAREDGE_SITE_ID;
const SOLAREDGE_API_KEY = process.env.SOLAREDGE_API_KEY;

// Inicializa el bot (solo funciona para enviar mensajes si pasamos {polling: false})
// Si quieres que el bot también reciba comandos (ej. /estado), cambia a {polling: true}
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let lastExcessAlertTime = 0;
let lastConsumptionAlertTime = 0;
let todayMilestones = {
  date: new Date().getDate(),
  reached: []
};

// Limites y configuraciones
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
const EXCESS_THRESHOLD_KW = -1.0; // Exportando 1000W o más (negativo = exportando)
const CONSUMPTION_THRESHOLD_KW = 0.2; // Comprando 200W o más a la red
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hora entre avisos repetitivos

// Responder al comando /estat o /estado
bot.onText(/\/(estado|estat)/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const data = await fetchSolarEdgeData();
    const pv = (data.PV?.currentPower || 0) * 1000;
    const load = (data.LOAD?.currentPower || 0) * 1000;
    const grid = (data.GRID?.currentPower || 0) * 1000;
    
    let text = `☀️ *Estat actual de les plaques:*\n`;
    text += `⚡ Generació: ${pv.toFixed(0)} W\n`;
    text += `🏠 Consum casa: ${load.toFixed(0)} W\n`;
    text += `🔌 Xarxa elèctrica: ${Math.abs(grid).toFixed(0)} W ${grid >= 0 ? '(Comprant 💸)' : '(Venent excedent 📉)'}\n`;
    
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Error en consultar l'API: ${err.message}`);
  }
});

async function fetchSolarEdgeData() {
  if (SOLAREDGE_API_KEY === 'pega_aqui_tu_api_key' || SOLAREDGE_API_KEY === 'DEMO') {
    return {
      PV: { currentPower: 3.5 }, // 3500W
      LOAD: { currentPower: 1.2 }, // 1200W
      GRID: { currentPower: -2.3 } // Exportando 2300W
    };
  }
  const url = `https://monitoringapi.solaredge.com/site/${SOLAREDGE_SITE_ID}/currentPowerFlow?api_key=${SOLAREDGE_API_KEY}`;
  const response = await axios.get(url);
  return response.data.siteCurrentPowerFlow;
}

async function checkAlerts() {
  try {
    const data = await fetchSolarEdgeData();
    if (!data) return;

    const pvKw = data.PV?.currentPower || 0;
    const loadKw = data.LOAD?.currentPower || 0;
    const gridKw = data.GRID?.currentPower || 0;

    const now = Date.now();
    const currentDay = new Date().getDate();

    // Resetear hitos diarios cada mañana
    if (todayMilestones.date !== currentDay) {
      todayMilestones.date = currentDay;
      todayMilestones.reached = [];
    }

    // 1. Consum excessiu (Comprant a la xarxa més de 200W)
    if (gridKw >= CONSUMPTION_THRESHOLD_KW) {
      if (now - lastConsumptionAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `🚨 *Avís de Consum:* S'estan comprant ${(gridKw * 1000).toFixed(0)}W de la xarxa elèctrica. Reviseu si hi ha alguna cosa encesa que es pugui apagar!`, { parse_mode: 'Markdown' });
        lastConsumptionAlertTime = now;
      }
    }

    // 2. Poc consum / Molta generació (Venent a la xarxa més de 1000W)
    if (gridKw <= EXCESS_THRESHOLD_KW) {
      if (now - lastExcessAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `💡 *Energia Sobrant!* Esteu regalant a la xarxa ${Math.abs(gridKw * 1000).toFixed(0)}W ara mateix.\n\n✅ És un bon moment per posar rentadores, encendre aires condicionats o el termo d'aigua calenta.`, { parse_mode: 'Markdown' });
        lastExcessAlertTime = now;
      }
    }

    // 3. Fites de generació (2000W, 3000W, 4000W, 5000W)
    const milestones = [2, 3, 4, 5]; // kW
    for (const milestone of milestones) {
      if (pvKw >= milestone && !todayMilestones.reached.includes(milestone)) {
        bot.sendMessage(CHAT_ID, `🔥 *Rècord diari!* Les plaques solars acaben d'assolir els *${milestone * 1000}W* de generació en aquest moment.`, { parse_mode: 'Markdown' });
        todayMilestones.reached.push(milestone);
      }
    }

  } catch (error) {
    console.error('Error al comprobar alertas:', error.message);
  }
}

// Iniciar bucle de monitorització
if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.log('⚠️ Falten dades vitals (Token o Chat ID) a l\'arxiu .env.');
} else {
  if (SOLAREDGE_API_KEY === 'pega_aqui_tu_api_key') {
    console.log('🧪 Iniciant Bot en MODE PROVA (Dades Simulades) perquè no hi ha API Key...');
    bot.sendMessage(CHAT_ID, '🔧 *Mode de Prova Activat:* El bot s\'ha iniciat amb dades simulades per provar les alertes.', { parse_mode: 'Markdown' });
  } else {
    console.log('🤖 Bot de SolarEdge iniciat en mode REAL. Comprovant cada 10 minuts...');
  }
  
  // Comprobar inmediatamente al arrancar
  checkAlerts();
  // Configurar intervalo
  setInterval(checkAlerts, POLL_INTERVAL_MS);
}
