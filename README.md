# SolarEdge Telegram Bot 🤖

An autonomous Telegram bot that monitors your SolarEdge solar panel system and sends instant notifications about high consumption, excess energy to use, and generation milestones.

## 🌟 Features
- **Excess Energy Alerts:** Notifies you when you are exporting a significant amount of electricity to the grid (e.g. >1000W), reminding you to turn on appliances (washing machine, AC, etc.) to make the most of your free solar power.
- **High Consumption Warnings:** Alerts you if your home is buying an excessive amount of electricity from the grid.
- **Advanced Step Tracking:** Monitors generation in 500W intervals. Intelligently tracks the daily maximum and notifies you with "Daily Records", or lets you know if generation is recovering ("Going up") or dropping ("Going down") without spam.
- **Persistent Memory:** Uses a `memoria.json` file to safely remember today's milestones across reboots.
- **Smart Grid Polarity:** Accurately calculates true Import/Export direction using the SolarEdge connection matrix.
- **2-Hour Periodic Summaries:** Sends a quiet summary of your generation every 2 hours, strictly between 06:00 and 22:00 to prevent night-time disturbances.
- **Instant Status (`/estat`):** Reply to the bot with `/estat` or `/estado` to instantly receive a real-time summary of your current generation, load, and grid exchange.
- **Demo Mode:** If you don't have an API key yet, the bot runs in a simulated test mode so you can verify the Telegram connection.

## 🚀 Getting Started

### Prerequisites
- Node.js (v16 or higher recommended)
- A Telegram Bot Token (You can get one by messaging `@BotFather` on Telegram)
- Your Telegram Group/Chat ID
- SolarEdge Site ID and API Key

### Installation & Configuration
1. Clone this repository.
2. Install the required dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root of the project to store your secure credentials. DO NOT commit this file to GitHub:
   ```env
   TELEGRAM_TOKEN=your_telegram_bot_token_here
   CHAT_ID=your_telegram_chat_id_here
   SOLAREDGE_SITE_ID=your_solaredge_site_id
   SOLAREDGE_API_KEY=your_solaredge_api_key
   ```
   *(Note: Leave the API Key as `pega_aqui_tu_api_key` to force the bot into Demo Mode).*

4. Start the bot:
   ```bash
   node index.js
   ```

## ⚙️ Customization
You can easily adjust the threshold limits in `index.js`:
- `EXCESS_THRESHOLD_KW`: Set how much power you must be exporting before getting an alert (Default: `-1.0` kW).
- `CONSUMPTION_THRESHOLD_KW`: Set how much power you must be buying before getting a warning (Default: `0.2` kW).
- `POLL_INTERVAL_MS`: How often the bot checks the SolarEdge API (Default: 10 minutes).

## 🔒 Security
Always keep your `.env` file secure. It has been added to the `.gitignore` list by default so your API keys are never leaked to public repositories.
