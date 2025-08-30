const mineflayer = require('mineflayer');
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// Express serverini ishga tushirish
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// WebSocket serverini Express serveriga bog'lash
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let config = { bots: [] };
const bots = new Map();
const configPath = path.join(__dirname, 'config.json');

try {
  if (fs.existsSync(configPath)) {
    const data = fs.readFileSync(configPath, 'utf8');
    if (data.trim()) {
      config = JSON.parse(data);
      console.log('Config loaded successfully:', config);
    } else {
      console.log('config.json is empty, initializing with default config.');
      saveConfig();
    }
  } else {
    console.log('config.json does not exist, creating new one.');
    saveConfig();
  }
} catch (err) {
  console.error('Error reading config.json, initializing with default config:', err);
  saveConfig();
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Config saved successfully:', config);
  } catch (err) {
    console.error('Error writing to config.json:', err);
  }
}

function createBot(botConfig) {
  const options = {
    host: botConfig.server.host,
    port: botConfig.server.port,
    username: botConfig.username,
    password: botConfig.password || undefined,
    version: '1.20.1'
  };

  const bot = mineflayer.createBot(options);
  bots.set(botConfig.username, bot);

  let reloginTimer;
  let antiAfkInterval;

  bot.on('login', () => {
    broadcast({ type: 'status', username: bot.username, status: 'logged in' });
    
    if (botConfig.reloginInterval && botConfig.reloginInterval > 0) {
      reloginTimer = setTimeout(() => {
        broadcast({ type: 'status', username: bot.username, status: 'Scheduled relogin' });
        bot.quit();
      }, botConfig.reloginInterval * 60 * 1000);
    }
  });

  bot.on('spawn', () => {
    broadcast({ type: 'status', username: bot.username, status: 'spawned' });
    
    antiAfkInterval = setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
        
        const directions = ['forward', 'back', 'left', 'right'];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        bot.setControlState(randomDir, true);
        setTimeout(() => bot.setControlState(randomDir, false), 500);
        
        bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI / 2);
      }
    }, 30000);
  });

  bot.on('kicked', (reason) => {
    broadcast({ type: 'status', username: bot.username, status: `kicked: ${reason}` });
    bots.delete(bot.username);
  });

  bot.on('error', (err) => {
    broadcast({ type: 'status', username: bot.username, status: `error: ${err}` });
  });

  bot.on('end', () => {
    if (reloginTimer) clearTimeout(reloginTimer);
    if (antiAfkInterval) clearInterval(antiAfkInterval);
    
    broadcast({ type: 'status', username: bot.username, status: 'disconnected' });
    bots.delete(bot.username);
    
    // Config'da bot hali mavjud bo'lsa va relogin yoqilgan bo'lsa, qayta ulanish
    const botConfig = config.bots.find(b => b.username === bot.username);
    if (botConfig && botConfig.reloginInterval && botConfig.reloginInterval > 0) {
      setTimeout(() => {
        console.log(`Attempting to reconnect bot: ${bot.username}`);
        createBot(botConfig);
      }, 5000);
    }
  });

  bot.on('packetError', (err, packet) => {
    console.error(`Packet error for ${bot.username}:`, err, packet);
    broadcast({ type: 'status', username: bot.username, status: `packet error: ${err.message}` });
  });

  return bot;
}

function stopBot(username) {
  const bot = bots.get(username);
  if (bot) {
    const botConfig = config.bots.find(b => b.username === username);
    if (botConfig) {
      botConfig.reloginInterval = 0; // Reloginni o'chirish
      saveConfig();
    }
    bot.quit();
    bots.delete(username);
    broadcast({ type: 'status', username, status: 'stopped' });
    broadcast({ type: 'bots', bots: config.bots });
  }
}

function removeBot(username) {
  const bot = bots.get(username);
  if (bot) {
    bot.quit();
    config.bots = config.bots.filter(b => b.username !== username);
    saveConfig();
    bots.delete(username);
    broadcast({ type: 'bots', bots: config.bots });
  }
}

function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

wss.on('connection', ws => {
  console.log('New WebSocket connection established');
  ws.send(JSON.stringify({ type: 'bots', bots: config.bots }));

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'addBot') {
        if (config.bots.length >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Maximum 10 bots allowed' }));
          return;
        }
        const botConfig = { 
          username: data.username, 
          password: data.password, 
          server: { host: data.server.host, port: data.server.port },
          commands: [], 
          reloginInterval: data.reloginInterval || 0
        };
        // Botni config'ga qo'shish va saqlash
        config.bots.push(botConfig);
        saveConfig();
        createBot(botConfig);
        broadcast({ type: 'bots', bots: config.bots });
      } else if (data.type === 'removeBot') {
        removeBot(data.username);
      } else if (data.type === 'sendCommand') {
        const bot = bots.get(data.username);
        if (bot) {
          bot.chat(data.command);
          broadcast({ type: 'status', username: data.username, status: `sent command: ${data.command}` });
        }
      } else if (data.type === 'stopBot') {
        stopBot(data.username);
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    // Botlar faol qoladi, chunki ular WebSocket ulanishiga bog'liq emas
  });
});

// Server ishga tushganda config.json'dagi barcha botlarni qayta ulash
config.bots.forEach(botConfig => {
  console.log(`Starting bot: ${botConfig.username}`);
  createBot(botConfig);
});

// Serverni faol tutish uchun oddiy endpoint qo'shish
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});
