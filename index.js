require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SOLAREDGE_SITE_ID = process.env.SOLAREDGE_SITE_ID;
const SOLAREDGE_API_KEY = process.env.SOLAREDGE_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.log('⚠️ Error de connexió amb Telegram:', error.code || error.message);
});

// Memory Management
const MEMORY_FILE = './memoria.json';
let state = {
  date: new Date().getDate(),
  dailyMax: 0,
  lastNotifiedPv: 0,
  lastStatusTime: 0,
  lastExcessAlertTime: 0,
  lastConsumptionAlertTime: 0,
  isConsumingFromGrid: false
};

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      if (data.date === new Date().getDate()) {
        state = { ...state, ...data };
      }
    } catch (e) {
      console.error("Error reading memory", e);
    }
  }
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2));
}

loadMemory();

// Limits and thresholds
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const EXCESS_THRESHOLD_KW = -1.0; 
const CONSUMPTION_THRESHOLD_KW = 0.2; 
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; 

// Respond to /estat
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
    
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(err => console.error(err));
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Error en consultar l'API: ${err.message}`).catch(err => console.error(err));
  }
});

async function fetchSolarEdgeData() {
  if (SOLAREDGE_API_KEY === 'pega_aqui_tu_api_key' || SOLAREDGE_API_KEY === 'DEMO') {
    return {
      PV: { currentPower: 3.5 },
      LOAD: { currentPower: 1.2 },
      GRID: { currentPower: -2.3 },
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
    const currentHour = new Date().getHours();

    // Reset daily milestones every morning
    if (state.date !== currentDay) {
      state.date = currentDay;
      state.dailyMax = 0;
      state.lastNotifiedPv = 0;
    }

    // 1. Excessive consumption
    if (gridKw >= CONSUMPTION_THRESHOLD_KW) {
      state.isConsumingFromGrid = true;
      if (now - state.lastConsumptionAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `🚨 *Avís de Consum:* S'estan comprant ${(gridKw * 1000).toFixed(0)}W de la xarxa elèctrica. Reviseu si hi ha alguna cosa encesa que es pugui apagar!`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.lastConsumptionAlertTime = now;
        saveMemory();
      }
    } else if (gridKw <= 0 && state.isConsumingFromGrid) {
      // Recovery!
      bot.sendMessage(CHAT_ID, `✅ *Recuperació:* La casa torna a ser autosuficient i tornem a vendre excedent a la xarxa! (${Math.abs(gridKw * 1000).toFixed(0)}W)`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
      state.isConsumingFromGrid = false;
      saveMemory();
    }

    // 2. Excess Generation
    if (gridKw <= EXCESS_THRESHOLD_KW) {
      if (now - state.lastExcessAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `💡 *Energia Sobrant!* Esteu regalant a la xarxa ${Math.abs(gridKw * 1000).toFixed(0)}W ara mateix.\n\n✅ És un bon moment per posar rentadores, encendre aires condicionats o el termo d'aigua calenta.`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.lastExcessAlertTime = now;
        saveMemory();
      }
    }

    // 3. Absolute Step Tracking (every 500W movement, min 1000W)
    if (state.lastNotifiedPv === 0 && pvKw >= 1.0) {
      // First boot or first time reaching 1kW today
      state.lastNotifiedPv = pvKw;
      state.dailyMax = pvKw;
      saveMemory();
    } else if (state.lastNotifiedPv > 0 && (pvKw >= state.lastNotifiedPv + 0.5 || pvKw <= state.lastNotifiedPv - 0.5)) {
      // It has moved at least 500W up or down
      if (pvKw > state.dailyMax) {
        bot.sendMessage(CHAT_ID, `🔥 *Rècord diari!* La producció acaba d'assolir els *${(pvKw * 1000).toFixed(0)}W*.`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.dailyMax = pvKw;
      } else if (pvKw > state.lastNotifiedPv) {
        bot.sendMessage(CHAT_ID, `☀️ *Pujant:* La producció solar s'ha recuperat fins als *${(pvKw * 1000).toFixed(0)}W*.`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
      } else if (pvKw < state.lastNotifiedPv) {
        bot.sendMessage(CHAT_ID, `📉 *Baixant:* La producció solar ha caigut a *${(pvKw * 1000).toFixed(0)}W*.`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
      }
      state.lastNotifiedPv = pvKw;
      saveMemory();
    }

    // 4. Periodic 1.5-hour status during the day (6 AM to 10 PM)
    if (currentHour >= 6 && currentHour < 22) {
      if (state.lastStatusTime === 0 || now - state.lastStatusTime >= 1.5 * 60 * 60 * 1000) {
        const text = `🕒 *Resum periòdic (1.5h)*\n⚡ Generació: ${(pvKw*1000).toFixed(0)} W\n🏠 Consum: ${(loadKw*1000).toFixed(0)} W\n🔌 Xarxa: ${Math.abs(gridKw*1000).toFixed(0)} W ${gridKw >= 0 ? '(Comprant 💸)' : '(Venent excedent 📉)'}`;
        bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.lastStatusTime = now;
        saveMemory();
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
    bot.sendMessage(CHAT_ID, '🔧 *Mode de Prova Activat:* El bot s\'ha iniciat amb dades simulades per provar les alertes.').catch(err => console.error(err));
  } else {
    console.log('🤖 Bot de SolarEdge iniciat en mode REAL. Comprovant cada 10 minuts...');
  }
  
  checkAlerts();
  setInterval(checkAlerts, POLL_INTERVAL_MS);
}
