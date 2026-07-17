require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SOLAREDGE_SITE_ID = process.env.SOLAREDGE_SITE_ID;
const SOLAREDGE_API_KEY = process.env.SOLAREDGE_API_KEY;

// Initialize the bot (only works for sending messages if we pass {polling: false})
// If you want the bot to also receive commands (e.g. /estat), change to {polling: true}
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let lastExcessAlertTime = 0;
let lastConsumptionAlertTime = 0;
let todayMilestones = {
  date: new Date().getDate(),
  reached: []
};

// Limits and thresholds
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const EXCESS_THRESHOLD_KW = -1.0; // Exporting 1000W or more (negative = exporting)
const CONSUMPTION_THRESHOLD_KW = 0.2; // Buying 200W or more from the grid
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between repetitive alerts

// Respond to the /estat or /estado command
bot.onText(/\/(estado|estat)/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const data = await fetchSolarEdgeData();
    const pv = (data.PV?.currentPower || 0) * 1000;
    const load = (data.LOAD?.currentPower || 0) * 1000;
    const grid = (data.gridKwSigned !== undefined ? data.gridKwSigned : (data.GRID?.currentPower || 0)) * 1000;
    
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
      GRID: { currentPower: -2.3 }, // Exportando 2300W
      gridKwSigned: -2.3
    };
  }
  const url = `https://monitoringapi.solaredge.com/site/${SOLAREDGE_SITE_ID}/currentPowerFlow?api_key=${SOLAREDGE_API_KEY}`;
  const response = await axios.get(url);
  const flow = response.data.siteCurrentPowerFlow;
  
  const isExporting = flow.connections?.some(c => c.to.toLowerCase() === 'grid');
  flow.gridKwSigned = isExporting ? -(flow.GRID?.currentPower || 0) : (flow.GRID?.currentPower || 0);
  
  return flow;
}

async function checkAlerts() {
  try {
    const data = await fetchSolarEdgeData();
    if (!data) return;

    const pvKw = data.PV?.currentPower || 0;
    const loadKw = data.LOAD?.currentPower || 0;
    const gridKw = data.gridKwSigned !== undefined ? data.gridKwSigned : (data.GRID?.currentPower || 0);

    const now = Date.now();
    const currentDay = new Date().getDate();

    // Reset daily milestones every morning
    if (todayMilestones.date !== currentDay) {
      todayMilestones.date = currentDay;
      todayMilestones.reached = [];
    }

    // 1. Excessive consumption (Buying more than 200W from the grid)
    if (gridKw >= CONSUMPTION_THRESHOLD_KW) {
      if (now - lastConsumptionAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `🚨 *Avís de Consum:* S'estan comprant ${(gridKw * 1000).toFixed(0)}W de la xarxa elèctrica. Reviseu si hi ha alguna cosa encesa que es pugui apagar!`, { parse_mode: 'Markdown' });
        lastConsumptionAlertTime = now;
      }
    }

    // 2. Low consumption / High generation (Selling more than 1000W to the grid)
    if (gridKw <= EXCESS_THRESHOLD_KW) {
      if (now - lastExcessAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `💡 *Energia Sobrant!* Esteu regalant a la xarxa ${Math.abs(gridKw * 1000).toFixed(0)}W ara mateix.\n\n✅ És un bon moment per posar rentadores, encendre aires condicionats o el termo d'aigua calenta.`, { parse_mode: 'Markdown' });
        lastExcessAlertTime = now;
      }
    }

    // 3. Generation milestones (2000W, 3000W, 4000W, 5000W)
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

// Start the monitoring loop
if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.log('⚠️ Falten dades vitals (Token o Chat ID) a l\'arxiu .env.');
} else {
  if (SOLAREDGE_API_KEY === 'pega_aqui_tu_api_key') {
    console.log('🧪 Iniciant Bot en MODE PROVA (Dades Simulades) perquè no hi ha API Key...');
    bot.sendMessage(CHAT_ID, '🔧 *Mode de Prova Activat:* El bot s\'ha iniciat amb dades simulades per provar les alertes.', { parse_mode: 'Markdown' });
  } else {
    console.log('🤖 Bot de SolarEdge iniciat en mode REAL. Comprovant cada 10 minuts...');
  }
  
  // Check immediately upon startup
  checkAlerts();
  // Configure polling interval
  setInterval(checkAlerts, POLL_INTERVAL_MS);
}
