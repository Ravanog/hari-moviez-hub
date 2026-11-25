require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const SITE_NAME = 'Hari moviez hub';
const PORT = Number(process.env.PORT || 8080);
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const ALLOWED_CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID ? Number(process.env.LOG_CHANNEL_ID) : null;

// --- PLANS CONFIG ---
const PLANS = {
  basic: {
    id: 'basic',
    name: 'Basic',
    price: Number(process.env.PRICE_BASIC || 89),
    days: 30,
    vipAccess: false,
    hideAds: false,
    skipShortlink: true
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    price: Number(process.env.PRICE_STANDARD || 139),
    days: 30, // 1 month
    vipAccess: true,
    hideAds: true,
    skipShortlink: true
  },
  diamond: {
    id: 'diamond',
    name: 'Diamond',
    price: Number(process.env.PRICE_DIAMOND || 189),
    days: 60, // 2 months
    vipAccess: true,
    hideAds: true,
    skipShortlink: true
  }
};

// --- DATABASE CONNECTION & SCHEMAS ---
if (!process.env.MONGO_URI) {
  console.warn(`[${SITE_NAME}] Warning: MONGO_URI is not set in .env`);
} else {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log(`[${SITE_NAME}] MongoDB Connected`))
    .catch(err => console.error(`[${SITE_NAME}] MongoDB Error:`, err.message));
}

const MediaSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  year: { type: String, required: true, trim: true },
  posterUrl: { type: String, required: true, trim: true },
  downloadLink: { type: String, required: true, trim: true },
  credentials: { type: String, default: '', trim: true },
  category: { type: String, enum: ['movie', 'series', 'vip'], required: true },
  createdAt: { type: Date, default: Date.now }
});

const AdminSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true }
});

const VipKeySchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  plan: { type: String, enum: ['basic', 'standard', 'diamond'], required: true },
  userId: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

const PendingRequestSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true },
  selectedPlan: { type: String, enum: ['basic', 'standard', 'diamond'], default: 'standard' },
  updatedAt: { type: Date, default: Date.now }
});

const Media = mongoose.model('Media', MediaSchema);
const Admin = mongoose.model('Admin', AdminSchema);
const VipKey = mongoose.model('VipKey', VipKeySchema);
const PendingRequest = mongoose.model('PendingRequest', PendingRequestSchema);

// --- TELEGRAM BOT SETUP ---
const bot = process.env.BOT_TOKEN
  ? new TelegramBot(process.env.BOT_TOKEN, {
      polling: {
        params: {
          allowed_updates: ['message', 'channel_post', 'callback_query']
        }
      }
    })
  : null;

if (bot) {
  bot.on('polling_error', (err) => {
    console.error(`[${SITE_NAME}] Polling error:`, err.message);
  });
}

async function sendToLogChannel(text) {
  if (!bot || !LOG_CHANNEL_ID) return;
  try {
    await bot.sendMessage(LOG_CHANNEL_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[${SITE_NAME}] Log channel error:`, err.message);
  }
}

async function sendPhotoToLogChannel(photoId, caption) {
  if (!bot || !LOG_CHANNEL_ID) return;
  try {
    await bot.sendPhoto(LOG_CHANNEL_ID, photoId, {
      caption,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error(`[${SITE_NAME}] Log channel photo error:`, err.message);
  }
}

async function isAuthorized(userId) {
  if (!userId) return false;
  if (OWNER_ID && Number(userId) === OWNER_ID) return true;
  const admin = await Admin.findOne({ telegramId: Number(userId) });
  return Boolean(admin);
}

async function findMediaByIdentifier(identifier) {
  const clean = (identifier || '').trim();
  if (!clean) return null;

  if (mongoose.Types.ObjectId.isValid(clean)) {
    const byId = await Media.findById(clean).catch(() => null);
    if (byId) return byId;
  }

  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Media.findOne({ title: new RegExp(`^${escaped}$`, 'i') }).sort({ createdAt: -1 })
    || Media.findOne({ title: new RegExp(escaped, 'i') }).sort({ createdAt: -1 });
}

function parseEditFields(lines) {
  const fieldMap = {
    title: 'title',
    year: 'year',
    poster: 'posterUrl',
    posterurl: 'posterUrl',
    link: 'downloadLink',
    download: 'downloadLink',
    downloadlink: 'downloadLink',
    credit: 'credentials',
    credits: 'credentials',
    credentials: 'credentials',
    category: 'category',
    type: 'category'
  };

  const updates = {};
  for (const rawLine of lines) {
    const eqIdx = rawLine.indexOf('=');
    if (eqIdx === -1) continue;
    const key = rawLine.slice(0, eqIdx).trim().toLowerCase();
    const val = rawLine.slice(eqIdx + 1).trim();
    const targetField = fieldMap[key];
    if (!targetField || !val) continue;

    if (targetField === 'category') {
      const normalizedCat = val.toLowerCase();
      if (['movie', 'series', 'vip'].includes(normalizedCat)) {
        updates.category = normalizedCat;
      }
    } else {
      updates[targetField] = val;
    }
  }
  return updates;
}

// Expected format (1 field per line):
// line 0: addmovie / addseries / addvip
// line 1: Title
// line 2: Year
// line 3: PosterURL
// line 4: DownloadLink
// line 5+: Credentials / Credit
function parseCommandLines(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length < 5) return null;
  return {
    title: lines[1],
    year: lines[2],
    posterUrl: lines[3],
    downloadLink: lines[4],
    credentials: lines.slice(5).join(' ') || ''
  };
}

function formatPlanInstructions(planKey) {
  const plan = PLANS[planKey] || PLANS.standard;
  const benefits = plan.id === 'basic'
    ? '30 Days • No Shortlinks • Website Ads Shown'
    : plan.id === 'standard'
      ? '1 Month (30 Days) • VIP Movies Unlocked • All Ads Blocked • No Shortlinks'
      : '2 Months (60 Days) • VIP Movies Unlocked • All Ads Blocked • No Shortlinks';

  const upiText = process.env.UPI_ID ? `\`${process.env.UPI_ID}\`` : '_Contact admin for UPI ID_';

  return (
    `🎬 *${SITE_NAME} — ${plan.name} Plan*\n` +
    `💰 *Price:* ₹${plan.price} INR\n` +
    `✨ *Benefits:* ${benefits}\n` +
    `🏦 *UPI ID:* ${upiText}\n\n` +
    `📸 *How to get your Access Key:*\n` +
    `1. Pay *₹${plan.price}* to the UPI ID above.\n` +
    `2. Send your *payment screenshot* directly to this bot.\n` +
    `3. Once approved, your Access Key will be delivered here.`
  );
}

async function sendPlanPrompt(chatId, telegramId, planKey) {
  if (!bot) return;
  const normalized = PLANS[planKey] ? planKey : 'standard';
  await PendingRequest.findOneAndUpdate(
    { telegramId },
    { selectedPlan: normalized, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  await bot.sendMessage(chatId, formatPlanInstructions(normalized), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: `Basic ₹${PLANS.basic.price}`, callback_data: 'selectplan_basic' },
          { text: `Standard ₹${PLANS.standard.price}`, callback_data: 'selectplan_standard' },
          { text: `Diamond ₹${PLANS.diamond.price}`, callback_data: 'selectplan_diamond' }
        ]
      ]
    }
  });
}

if (bot) {
  // 1. OWNER COMMANDS
  bot.onText(/^\/?addadmin\s+(\d+)/i, async (msg, match) => {
    if (!OWNER_ID || msg.from?.id !== OWNER_ID) {
      return bot.sendMessage(msg.chat.id, '❌ Owner only command.');
    }
    const newAdminId = Number(match[1]);
    try {
      await Admin.create({ telegramId: newAdminId });
      bot.sendMessage(msg.chat.id, `✅ User \`${newAdminId}\` added as Admin for *${SITE_NAME}*.`, { parse_mode: 'Markdown' });
    } catch {
      bot.sendMessage(msg.chat.id, '⚠️ User is already an admin.');
    }
  });

  bot.onText(/^\/?removeadmin\s+(\d+)/i, async (msg, match) => {
    if (!OWNER_ID || msg.from?.id !== OWNER_ID) {
      return bot.sendMessage(msg.chat.id, '❌ Owner only command.');
    }
    const adminId = Number(match[1]);
    await Admin.deleteOne({ telegramId: adminId });
    bot.sendMessage(msg.chat.id, `🗑️ User \`${adminId}\` removed from Admins.`, { parse_mode: 'Markdown' });
  });

  bot.onText(/^\/?stats$/i, async (msg) => {
    if (!(await isAuthorized(msg.from?.id))) return;
    const [totalMedia, vipCount, activeKeys] = await Promise.all([
      Media.countDocuments(),
      Media.countDocuments({ category: 'vip' }),
      VipKey.countDocuments({ isActive: true, expiresAt: { $gt: new Date() } })
    ]);
    bot.sendMessage(
      msg.chat.id,
      `📊 *${SITE_NAME} Stats*\n• Total Titles: *${totalMedia}*\n• VIP Titles: *${vipCount}*\n• Active VIP Keys: *${activeKeys}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // ADMIN DELETE COMMAND: /deletemovie <title or id>
  bot.onText(/^\/deletemovie(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    if (!(await isAuthorized(msg.from?.id))) {
      return bot.sendMessage(msg.chat.id, '❌ Admin only command.');
    }
    const identifier = (match[1] || '').trim();
    if (!identifier) {
      return bot.sendMessage(msg.chat.id, '❌ Usage: `/deletemovie Movie Title or ID`', { parse_mode: 'Markdown' });
    }

    const item = await findMediaByIdentifier(identifier);
    if (!item) {
      return bot.sendMessage(msg.chat.id, `⚠️ No title found matching *${identifier}*.`, { parse_mode: 'Markdown' });
    }

    await Media.deleteOne({ _id: item._id });
    return bot.sendMessage(
      msg.chat.id,
      `🗑️ Deleted *${item.title}* (${item.year}) [${item.category.toUpperCase()}] from *${SITE_NAME}*.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ADMIN EDIT COMMAND: /editmovie <title or id> + field = value lines
  bot.onText(/^\/editmovie(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    if (!(await isAuthorized(msg.from?.id))) {
      return bot.sendMessage(msg.chat.id, '❌ Admin only command.');
    }
    const rawBody = (match[1] || '').trim();
    if (!rawBody) {
      return bot.sendMessage(
        msg.chat.id,
        '❌ Usage:\n`/editmovie Movie Title or ID`\n`title = New Title`\n`year = 2026`\n`credentials = Hari_moviez`',
        { parse_mode: 'Markdown' }
      );
    }

    const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
    const identifier = lines[0];
    const updates = parseEditFields(lines.slice(1));

    if (!Object.keys(updates).length) {
      return bot.sendMessage(
        msg.chat.id,
        '⚠️ Provide at least one valid update line like `title = ...`, `year = ...`, `posterUrl = ...`, `downloadLink = ...`, `credentials = ...`, or `category = movie|series|vip`.',
        { parse_mode: 'Markdown' }
      );
    }

    const item = await findMediaByIdentifier(identifier);
    if (!item) {
      return bot.sendMessage(msg.chat.id, `⚠️ No title found matching *${identifier}*.`, { parse_mode: 'Markdown' });
    }

    Object.assign(item, updates);
    await item.save();

    return bot.sendMessage(
      msg.chat.id,
      `✏️ Updated *${item.title}* (${item.year}) [${item.category.toUpperCase()}]` +
      (item.credentials ? `\n🏷️ *Credit:* ${item.credentials}` : ''),
      { parse_mode: 'Markdown' }
    );
  });

  // USER REQUEST COMMAND IN BOT: /request <movie name>
  bot.onText(/^\/?request\s+(.+)/i, async (msg, match) => {
    if (msg.chat.type === 'channel') return;
    const movieName = match[1].trim();
    const userId = msg.from?.id || 'Unknown';
    const username = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');

    await sendToLogChannel(
      `📩 *${SITE_NAME} — New Movie Request*\n` +
      `🎬 *Title:* ${movieName}\n` +
      `👤 *User:* ${username} (\`${userId}\`)\n` +
      `📍 *Source:* Telegram Bot`
    );

    return bot.sendMessage(
      msg.chat.id,
      `✅ Your request for *${movieName}* has been sent to *${SITE_NAME}*!`,
      { parse_mode: 'Markdown' }
    );
  });

  // 2. CHANNEL & ADMIN CONTENT COMMANDS
  async function handleMediaPost(msg) {
    const text = msg.text || msg.caption;
    if (!text) return;

    const senderId = msg.from ? msg.from.id : null;
    const isChannel = msg.chat.type === 'channel';

    if (isChannel && ALLOWED_CHANNEL_ID && msg.chat.id !== ALLOWED_CHANNEL_ID) {
      return;
    }

    if (!isChannel && !(await isAuthorized(senderId))) return;

    const firstLine = text.split('\n')[0].trim().toLowerCase().replace(/^\//, '');
    let category = null;

    if (firstLine === 'addmovie') category = 'movie';
    else if (firstLine === 'addseries') category = 'series';
    else if (firstLine === 'addvip') category = 'vip';
    else return;

    const data = parseCommandLines(text);
    if (!data) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Invalid format! Use:\n${firstLine}\nTitle\nYear\nPosterURL\nDownloadLink\nCredentials`
      );
    }

    try {
      await Media.create({ ...data, category });
      const creditLine = data.credentials ? `\n🏷️ *Credit:* ${data.credentials}` : '';
      await bot.sendMessage(
        msg.chat.id,
        `✅ Added *${data.title} (${data.year})* to *${SITE_NAME}* [${category.toUpperCase()}]!${creditLine}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error(`[${SITE_NAME}] Failed saving media:`, err.message);
      await bot.sendMessage(msg.chat.id, '❌ Failed to save item to database.');
    }
  }

  bot.on('message', handleMediaPost);
  bot.on('channel_post', handleMediaPost);

  bot.onText(/^\/?bycredit\s+(.+)/i, async (msg, match) => {
    if (!(await isAuthorized(msg.from?.id))) return;
    const creditQuery = match[1].trim();
    const items = await Media.find({ credentials: new RegExp(creditQuery, 'i') })
      .sort({ createdAt: -1 })
      .limit(15);
    if (!items.length) return bot.sendMessage(msg.chat.id, `No items found for credit: ${creditQuery}`);
    const list = items.map(i => `• *${i.title}* (${i.year}) [${i.category.toUpperCase()}] — ${i.credentials}`).join('\n');
    bot.sendMessage(msg.chat.id, list, { parse_mode: 'Markdown' });
  });

  // 3. DEEP LINK & PLAN COMMANDS
  bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
    if (msg.chat.type !== 'private') return;
    const payload = (match[1] || '').trim().toLowerCase();

    if (payload === 'plan_basic') return sendPlanPrompt(msg.chat.id, msg.from.id, 'basic');
    if (payload === 'plan_standard') return sendPlanPrompt(msg.chat.id, msg.from.id, 'standard');
    if (payload === 'plan_diamond') return sendPlanPrompt(msg.chat.id, msg.from.id, 'diamond');

    await sendPlanPrompt(msg.chat.id, msg.from.id, 'standard');
  });

  bot.onText(/^\/vip$/i, async (msg) => {
    if (msg.chat.type !== 'private') return;
    await sendPlanPrompt(msg.chat.id, msg.from.id, 'standard');
  });

  // Handle User Payment Screenshot
  bot.on('photo', async (msg) => {
    if (msg.chat.type !== 'private') return;
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User');
    const photoId = msg.photo[msg.photo.length - 1].file_id;

    const pending = await PendingRequest.findOne({ telegramId: userId });
    const selectedPlan = pending?.selectedPlan || 'standard';
    const planObj = PLANS[selectedPlan];

    await bot.sendMessage(
      userId,
      `⏳ Screenshot received for *${planObj.name} (₹${planObj.price})* on *${SITE_NAME}*! Please wait while an admin verifies your payment.`,
      { parse_mode: 'Markdown' }
    );

    await sendPhotoToLogChannel(
      photoId,
      `🧾 *${SITE_NAME} — Payment Screenshot Log*\n` +
      `User: ${username}\n` +
      `User ID: \`${userId}\`\n` +
      `Selected Plan: *${planObj.name} (₹${planObj.price})*`
    );

    if (OWNER_ID) {
      try {
        await bot.sendPhoto(OWNER_ID, photoId, {
          caption:
            `💳 *${SITE_NAME} — VIP Payment Request*\n` +
            `User: ${username}\n` +
            `User ID: \`${userId}\`\n` +
            `Selected Plan: *${planObj.name} (₹${planObj.price})*\n` +
            `Validity: *${planObj.days} days*`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve Selected', callback_data: `approve_${userId}_${selectedPlan}` },
                { text: '❌ Reject', callback_data: `reject_${userId}` }
              ],
              [
                { text: 'Basic ₹89', callback_data: `approve_${userId}_basic` },
                { text: 'Std ₹139', callback_data: `approve_${userId}_standard` },
                { text: 'Dia ₹189', callback_data: `approve_${userId}_diamond` }
              ]
            ]
          }
        });
      } catch (err) {
        console.error(`[${SITE_NAME}] Failed forwarding screenshot to owner:`, err.message);
      }
    }
  });

  // Handle Callback Queries
  bot.on('callback_query', async (query) => {
    const data = query.data || '';

    if (data.startsWith('selectplan_')) {
      const planKey = data.replace('selectplan_', '');
      if (!PLANS[planKey]) return bot.answerCallbackQuery(query.id);
      await PendingRequest.findOneAndUpdate(
        { telegramId: query.from.id },
        { selectedPlan: planKey, updatedAt: new Date() },
        { upsert: true }
      );
      await bot.editMessageText(formatPlanInstructions(planKey), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: query.message.reply_markup
      });
      return bot.answerCallbackQuery(query.id, { text: `Selected ${PLANS[planKey].name}` });
    }

    if (data.startsWith('approve_')) {
      const authorized = await isAuthorized(query.from.id);
      if (!authorized) {
        return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
      }

      const [, targetUserIdRaw, planKeyRaw] = data.split('_');
      const targetUserId = Number(targetUserIdRaw);
      const planObj = PLANS[planKeyRaw] || PLANS.standard;

      const generatedKey = `${planObj.id.slice(0, 3).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const expiresAt = new Date(Date.now() + planObj.days * 24 * 60 * 60 * 1000);

      await VipKey.create({
        key: generatedKey,
        plan: planObj.id,
        userId: targetUserId,
        expiresAt
      });

      await bot.sendMessage(
        targetUserId,
        `🎉 *${SITE_NAME} — Payment Approved!*\n\n` +
        `Plan: *${planObj.name}*\n` +
        `Valid Until: *${expiresAt.toDateString()}*\n` +
        `Access Key:\n\`${generatedKey}\`\n\n` +
        `Enter this key on *${SITE_NAME}* to activate your benefits!`,
        { parse_mode: 'Markdown' }
      );

      await bot.editMessageCaption(
        `✅ Approved *${planObj.name}*! Key \`${generatedKey}\` sent to \`${targetUserId}\` (Expires: ${expiresAt.toDateString()}).`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    } else if (data.startsWith('reject_')) {
      const authorized = await isAuthorized(query.from.id);
      if (!authorized) {
        return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
      }

      const targetUserId = Number(data.split('_')[1]);
      await bot.sendMessage(
        targetUserId,
        `❌ Your payment screenshot for *${SITE_NAME}* was rejected. Please send a valid screenshot.`,
        { parse_mode: 'Markdown' }
      );
      await bot.editMessageCaption(`❌ Rejected payment for user \`${targetUserId}\`.`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    }

    bot.answerCallbackQuery(query.id);
  });
}

// --- ENTITLEMENT & SHORTLINK HELPERS ---
async function getUserEntitlement(key) {
  if (!key) {
    return {
      active: false,
      plan: 'none',
      planName: 'Free',
      vipAccess: false,
      hideAds: false,
      skipShortlink: false,
      expiresAt: null
    };
  }

  const keyDoc = await VipKey.findOne({ key: String(key).trim(), isActive: true });
  if (!keyDoc || new Date(keyDoc.expiresAt) <= new Date()) {
    return {
      active: false,
      plan: 'none',
      planName: 'Free',
      vipAccess: false,
      hideAds: false,
      skipShortlink: false,
      expiresAt: null,
      expired: Boolean(keyDoc)
    };
  }

  const planCfg = PLANS[keyDoc.plan] || PLANS.basic;
  return {
    active: true,
    plan: planCfg.id,
    planName: planCfg.name,
    vipAccess: planCfg.vipAccess,
    hideAds: planCfg.hideAds,
    skipShortlink: planCfg.skipShortlink,
    expiresAt: keyDoc.expiresAt
  };
}

async function generateShortlink(targetUrl) {
  if (process.env.SHORTLINK_API_URL && process.env.SHORTLINK_API_KEY) {
    try {
      const endpoint = `${process.env.SHORTLINK_API_URL}?api=${encodeURIComponent(process.env.SHORTLINK_API_KEY)}&url=${encodeURIComponent(targetUrl)}`;
      const response = await fetch(endpoint);
      const data = await response.json();
      const shortUrl = data.shortenedUrl || data.short_url || data.url;
      if (shortUrl && typeof shortUrl === 'string') return shortUrl;
    } catch (err) {
      console.error(`[${SITE_NAME}] Shortlink API error, using fallback:`, err.message);
    }
  }
  return targetUrl;
}

// --- EXPRESS API ROUTES ---
app.get('/api/config', (req, res) => {
  res.json({
    siteName: SITE_NAME,
    botUsername: process.env.BOT_USERNAME || 'YourBotUsername',
    plans: PLANS
  });
});

app.post('/api/request-content', async (req, res) => {
  const { title, year, notes, contact } = req.body || {};
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    return res.status(400).json({ error: 'Movie or series title is required.' });
  }

  const cleanYear = String(year || '').trim();
  const cleanNotes = String(notes || '').trim();
  const cleanContact = String(contact || '').trim();

  await sendToLogChannel(
    `📩 *${SITE_NAME} — New Content Request*\n` +
    `🎬 *Title:* ${cleanTitle}${cleanYear ? ` (${cleanYear})` : ''}\n` +
    (cleanNotes ? `📝 *Details:* ${cleanNotes}\n` : '') +
    (cleanContact ? `👤 *User / Telegram:* ${cleanContact}\n` : '') +
    `📍 *Source:* Website`
  );

  return res.json({ ok: true, message: `Request submitted for "${cleanTitle}".` });
});

app.get('/api/media', async (req, res) => {
  const entitlement = await getUserEntitlement(req.headers['x-vip-key']);
  const allMedia = await Media.find().sort({ createdAt: -1 });

  const sanitized = allMedia.map(item => {
    const isVipLocked = item.category === 'vip' && !entitlement.vipAccess;
    if (isVipLocked) {
      return {
        _id: item._id,
        title: item.title,
        year: item.year,
        posterUrl: item.posterUrl,
        category: item.category,
        credentials: item.credentials || '',
        locked: true
      };
    }
    return { ...item.toObject(), locked: false };
  });

  res.json({ entitlement, media: sanitized });
});

app.post('/api/verify-vip', async (req, res) => {
  const { key } = req.body || {};
  const entitlement = await getUserEntitlement(key);
  if (entitlement.active) {
    return res.json({
      valid: true,
      entitlement,
      message: `${entitlement.planName} plan active until ${new Date(entitlement.expiresAt).toDateString()}!`
    });
  }
  res.status(401).json({
    valid: false,
    message: entitlement.expired ? 'This key has expired.' : 'Invalid access key.'
  });
});

app.get('/api/download/:id', async (req, res) => {
  const entitlement = await getUserEntitlement(req.headers['x-vip-key']);
  const item = await Media.findById(req.params.id).catch(() => null);
  if (!item) return res.status(404).json({ error: 'Not found' });

  if (item.category === 'vip' && !entitlement.vipAccess) {
    return res.status(403).json({
      error: 'Standard (1 Month) or Diamond (2 Months) plan required for VIP movies.'
    });
  }

  const useShortlink = !entitlement.skipShortlink;
  const finalUrl = useShortlink
    ? await generateShortlink(item.downloadLink)
    : item.downloadLink;

  res.json({
    siteName: SITE_NAME,
    title: item.title,
    year: item.year,
    downloadLink: finalUrl,
    credentials: item.credentials || '',
    useShortlink,
    showAds: !entitlement.hideAds,
    plan: entitlement.plan
  });
});

app.listen(PORT, () => {
  console.log(`${SITE_NAME} running on http://localhost:${PORT}`);
});
