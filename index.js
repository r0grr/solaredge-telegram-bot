require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const mqtt = require('mqtt');

// Variables d'entorn
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const SOLAREDGE_SITE_ID = process.env.SOLAREDGE_SITE_ID;
const SOLAREDGE_API_KEY = process.env.SOLAREDGE_API_KEY;

const MQTT_HOST = process.env.MQTT_BROKER_HOST || 'mosquitto';
const MQTT_PORT = process.env.MQTT_PORT || 1883;

// Horari de silenci general nocturn (per defecte: de 22:00 a 06:00)
const QUIET_START_HOUR = process.env.QUIET_START_HOUR !== undefined ? parseInt(process.env.QUIET_START_HOUR, 10) : 22;
const QUIET_END_HOUR = process.env.QUIET_END_HOUR !== undefined ? parseInt(process.env.QUIET_END_HOUR, 10) : 6;

function isQuietHours(date = new Date()) {
  const h = date.getHours();
  if (QUIET_START_HOUR > QUIET_END_HOUR) {
    return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
  }
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

// Regla de consum vespre/nit: Si a partir de les 20:30 la producció baixa de 500W,
// silenciar avisos de consum fins a les 06:00 del matí
function isEveningNightConsumptionSilenced(pvKw, date = new Date()) {
  const hour = date.getHours();
  const minute = date.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  const inWindow = timeInMinutes >= (20 * 60 + 30) || timeInMinutes < (6 * 60);
  return inWindow && pvKw < 0.5;
}

// Inicialització del Bot de Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.log('⚠️ Error de connexió amb Telegram:', error.code || error.message);
});

// ------------------------------------------------------------------------------
// Client MQTT: Publicació de telemetria solar i recepció de dades Davis (Cumulus MX)
// ------------------------------------------------------------------------------
console.log(`[MQTT] Conectant a mqtt://${MQTT_HOST}:${MQTT_PORT}...`);
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  reconnectPeriod: 5000,
});

const weatherState = {
  temperatura: 'N/D',
  humedad: 'N/D',
  viento_velocidad: 'N/D',
  viento_direccion: 'N/D',
  lluvia_hoy: 'N/D',
  presion: 'N/D',
  last_update: null
};

mqttClient.on('connect', () => {
  console.log('✅ [MQTT] Conectat correctament al broker Mosquitto.');
  mqttClient.subscribe(['clima/#'], (err) => {
    if (err) console.error('❌ [MQTT] Error en subscripció a clima/#:', err);
    else console.log('📡 [MQTT] Subscrit a canal meteorològic clima/#');
  });
});

mqttClient.on('message', (topic, message) => {
  const payload = message.toString();
  const subtopic = topic.split('/')[1];
  if (topic.startsWith('clima/') && subtopic) {
    weatherState[subtopic] = payload;
    weatherState.last_update = new Date();
  }
});

function publishSolarToMqtt(pvWatts, loadWatts, gridWatts) {
  if (!mqttClient.connected) return;
  try {
    mqttClient.publish('solar/power', pvWatts.toFixed(0), { retain: true });
    mqttClient.publish('solar/load', loadWatts.toFixed(0), { retain: true });
    mqttClient.publish('solar/grid', gridWatts.toFixed(0), { retain: true });
    mqttClient.publish('solar/status', JSON.stringify({
      power_w: Math.round(pvWatts),
      load_w: Math.round(loadWatts),
      grid_w: Math.round(gridWatts),
      timestamp: new Date().toISOString()
    }), { retain: true });
    console.log(`📡 [MQTT] Publicat: Solar ${pvWatts.toFixed(0)}W | Casa ${loadWatts.toFixed(0)}W | Xarxa ${gridWatts.toFixed(0)}W`);
  } catch (err) {
    console.error('❌ [MQTT] Error publicant dades solars:', err.message);
  }
}

// ------------------------------------------------------------------------------
// Gestió de Memòria (Estat diari persistent)
// ------------------------------------------------------------------------------
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
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Error writing memory", e);
  }
}

loadMemory();

// Límit i llindars
const POLL_INTERVAL_MS = (parseInt(process.env.SOLAR_POLL_INTERVAL_SEC, 10) || 600) * 1000;
const EXCESS_THRESHOLD_KW = -1.0; 
const CONSUMPTION_THRESHOLD_KW = 0.2; 
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; 

// ------------------------------------------------------------------------------
// Comandes de Telegram (sempre disponibles sota petició de l'usuari)
// ------------------------------------------------------------------------------

// Comanda /estat o /estado o /solar
bot.onText(/\/(estado|estat|solar)/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const data = await fetchSolarEdgeData();
    const pv = (data.PV?.currentPower || 0) * 1000;
    const load = (data.LOAD?.currentPower || 0) * 1000;
    const grid = (data.gridKwSigned !== undefined ? data.gridKwSigned : (data.GRID?.currentPower || 0)) * 1000;
    
    // Publicar també a MQTT en cada petició
    publishSolarToMqtt(pv, load, grid);

    let text = `☀️ *Estat actual de les plaques:*\n`;
    text += `⚡ Generació: ${pv.toFixed(0)} W\n`;
    text += `🏠 Consum casa: ${load.toFixed(0)} W\n`;
    text += `🔌 Xarxa elèctrica: ${Math.abs(grid).toFixed(0)} W ${grid >= 0 ? '(Comprant 💸)' : '(Venent excedent 📉)'}\n`;
    
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(err => console.error(err));
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Error en consultar l'API de SolarEdge: ${err.message}`).catch(err => console.error(err));
  }
});

// Comanda /clima o /temps (Telemetria Davis Vantage Pro2 des de Cumulus MX)
bot.onText(/\/(clima|temps|estacio)/, (msg) => {
  const chatId = msg.chat.id;
  const c = weatherState;
  const hora = c.last_update ? c.last_update.toLocaleTimeString('ca-ES') : 'Sense dades encara';

  let text = `🌤 *Estació Meteorològica Davis Vantage Pro2*\n`;
  text += `────────────────────────────\n`;
  text += `🌡 Temperatura: *${c.temperatura} °C*\n`;
  text += `💧 Humitat: *${c.humedad} %*\n`;
  text += `💨 Vent: *${c.viento_velocidad} km/h* (${c.viento_direccion}°)\n`;
  text += `🌧️ Pluja avui: *${c.lluvia_hoy} mm*\n`;
  text += `🧭 Pressió: *${c.presion} hPa*\n`;
  text += `🕒 _Última actualització: ${hora}_`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(err => console.error(err));
});

// Comanda /start o /ajuda
bot.onText(/\/(start|ajuda|help)/, (msg) => {
  const chatId = msg.chat.id;
  const text = `👋 *Bot Homelab IoT (Solar & Meteorologia)*\n\n` +
               `Comandes disponibles:\n` +
               `☀️ /estat - Producció de plaques solars i consum de casa\n` +
               `🌤 /clima - Telemetria de l'estació Davis Vantage Pro2\n` +
               `ℹ️ /ajuda - Mostrar aquesta llista de comandes`;
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(err => console.error(err));
});

// ------------------------------------------------------------------------------
// Consulta API SolarEdge
// ------------------------------------------------------------------------------
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
  const response = await axios.get(url, { timeout: 8000 });
  const flow = response.data.siteCurrentPowerFlow;
  
  const isExporting = flow.connections?.some(c => c.to.toLowerCase() === 'grid');
  flow.gridKwSigned = isExporting ? -(flow.GRID?.currentPower || 0) : (flow.GRID?.currentPower || 0);
  
  return flow;
}

// ------------------------------------------------------------------------------
// Comprovació d'Alertes i Monitorització Cíclica
// ------------------------------------------------------------------------------
async function checkAlerts() {
  try {
    const data = await fetchSolarEdgeData();
    if (!data) return;

    const pvKw = data.PV?.currentPower || 0;
    const loadKw = data.LOAD?.currentPower || 0;
    const gridKw = data.gridKwSigned !== undefined ? data.gridKwSigned : (data.GRID?.currentPower || 0);

    // Publicació automàtica a MQTT en cada cicle (telemetria ininterrompuda 24/7)
    publishSolarToMqtt(pvKw * 1000, loadKw * 1000, gridKw * 1000);

    const now = Date.now();
    const currentDay = new Date().getDate();

    // Reset de fites diàries al matí
    if (state.date !== currentDay) {
      state.date = currentDay;
      state.dailyMax = 0;
      state.lastNotifiedPv = 0;
    }

    // 1. Consum excessiu de la xarxa
    if (gridKw >= CONSUMPTION_THRESHOLD_KW) {
      state.isConsumingFromGrid = true;
      // Regla: si a partir de les 20:30 la producció baixa de 500W, silenci fins a les 06:00
      if (isEveningNightConsumptionSilenced(pvKw)) {
        console.log(`🌙 [Silenci Consum Vespre/Nit] Producció < 500W (${(pvKw*1000).toFixed(0)}W) entre 20:30 i 06:00. Avís de consum cancel·lat.`);
      } else if (now - state.lastConsumptionAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `🚨 *Avís de Consum:* S'estan comprant ${(gridKw * 1000).toFixed(0)}W de la xarxa elèctrica. Reviseu si hi ha alguna cosa encesa que es pugui apagar!`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.lastConsumptionAlertTime = now;
        saveMemory();
      }
    } else if (gridKw <= 0 && state.isConsumingFromGrid) {
      // Recuperació
      bot.sendMessage(CHAT_ID, `✅ *Recuperació:* La casa torna a ser autosuficient i tornem a vendre excedent a la xarxa! (${Math.abs(gridKw * 1000).toFixed(0)}W)`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
      state.isConsumingFromGrid = false;
      saveMemory();
    }

    // Horari de silenci absolut nocturn (22:00 a 06:00) per a la resta d'alertes proactives
    if (isQuietHours()) {
      console.log(`🌙 [Silenci Nocturn (${QUIET_START_HOUR}:00 - ${QUIET_END_HOUR}:00)] Alertes automàtiques silenciades.`);
      return;
    }

    // 2. Excedent de Generació (venda a la xarxa)
    if (gridKw <= EXCESS_THRESHOLD_KW) {
      if (now - state.lastExcessAlertTime > ALERT_COOLDOWN_MS) {
        bot.sendMessage(CHAT_ID, `💡 *Energia Sobrant!* Esteu regalant a la xarxa ${Math.abs(gridKw * 1000).toFixed(0)}W ara mateix.\n\n✅ És un bon moment per posar rentadores, encendre aires condicionats o el termo d'aigua calenta.`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
        state.lastExcessAlertTime = now;
        saveMemory();
      }
    }

    // 3. Seguiment de passos de potència (cada 500W, min 1000W)
    if (state.lastNotifiedPv === 0 && pvKw >= 1.0) {
      state.lastNotifiedPv = pvKw;
      state.dailyMax = pvKw;
      saveMemory();
    } else if (state.lastNotifiedPv > 0 && (pvKw >= state.lastNotifiedPv + 0.5 || pvKw <= state.lastNotifiedPv - 0.5)) {
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

    // 4. Resum periòdic cada 1.5 hores durant el dia
    if (state.lastStatusTime === 0 || now - state.lastStatusTime >= 1.5 * 60 * 60 * 1000) {
      const text = `🕒 *Resum periòdic (1.5h)*\n⚡ Generació: ${(pvKw*1000).toFixed(0)} W\n🏠 Consum: ${(loadKw*1000).toFixed(0)} W\n🔌 Xarxa: ${Math.abs(gridKw*1000).toFixed(0)} W ${gridKw >= 0 ? '(Comprant 💸)' : '(Venent excedent 📉)'}`;
      bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviant Telegram:", err));
      state.lastStatusTime = now;
      saveMemory();
    }

  } catch (error) {
    console.error('Error al comprobar alertas:', error.message);
  }
}

// ------------------------------------------------------------------------------
// Cicle d'inici
// ------------------------------------------------------------------------------
if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.log('⚠️ Falten dades vitals (Token o Chat ID) a l\'arxiu .env.');
} else {
  if (SOLAREDGE_API_KEY === 'pega_aqui_tu_api_key' || !SOLAREDGE_API_KEY) {
    console.log('🧪 Iniciant Bot en MODE PROVA perquè no hi ha API Key...');
  } else {
    console.log(`🤖 Bot de SolarEdge iniciat en mode REAL. Monitoritzant cada ${POLL_INTERVAL_MS / 60000} minuts...`);
  }
  
  checkAlerts();
  setInterval(checkAlerts, POLL_INTERVAL_MS);
}
