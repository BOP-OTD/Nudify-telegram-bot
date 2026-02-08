import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://your-app.onrender.com
const nudify_URL = process.env.nudify_URL;   // e.g. https://public-api.example.com/api/v1/photos/nudify
const API_KEY_HEADER = process.env.API_KEY_HEADER;   // e.g. Authorization OR x-api-key
const API_KEY_VALUE = process.env.API_KEY_VALUE;     // e.g. Bearer <key> OR <key>
const FILE_FIELD_NAME = process.env.FILE_FIELD_NAME || 'photo'; // 
const WEBHOOK_RESULT_FIELD_URL = process.env.WEBHOOK_RESULT_FIELD_URL || 'url'; // if webhook returns {"url": "..."}
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL');
if (!nudify_URL) throw new Error('Missing nudify_URL');

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: '10mb' })); // webhook payloads can be big
app.use(express.urlencoded({ extended: true }));

// ---------- Tiny in-memory storage (simple starter) ----------
const users = new Map(); // userId -> { credits, lifetime }
const jobs = new Map();  // id_gen -> { chatId, userId }

function getUser(userId) {
  if (!users.has(userId)) users.set(userId, { credits: 0, lifetime: 0 });
  return users.get(userId);
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎨 nudify', 'DO_nudify')],
    [Markup.button.callback('💳 Buy Credits', 'BUY'), Markup.button.callback('📊 Credits', 'CREDITS')],
    [Markup.button.callback('ℹ️ Help', 'HELP')]
  ]);
}

// ---------- Telegram bot ----------
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const u = getUser(userId);
  await ctx.reply(
    `Welcome!\n\nYour Telegram ID: ${userId}\nCredits: ${u.credits}\n\nTap a button below.`,
    mainMenu()
  );
});

bot.action('HELP', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`How it works:
• 1 credit = 1 nudify
• Send a photo after tapping nudify

Rules:
• Only photos you own or have permission to edit
• No sexual content, no minors, no illegal content`,
    mainMenu()
  );
});

bot.action('CREDITS', async (ctx) => {
  await ctx.answerCbQuery();
  const u = getUser(String(ctx.from.id));
  await ctx.reply(`Credits: ${u.credits}\nLifetime uses: ${u.lifetime}`, mainMenu());
});

bot.action('BUY', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
`To buy credits:
1) Pay via your payment link(s)
2) Then message “Paid” with your Telegram ID: ${ctx.from.id}

(You can automate this later with Stripe webhooks.)`,
    mainMenu()
  );
});

bot.action('DO_nudify', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Send me a photo now. (Costs 1 credit)', mainMenu());
});

// Simple manual credit add (you can remove later)
bot.command('addcredits', async (ctx) => {
  // Usage: /addcredits <userId> <amount>
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 3) return ctx.reply('Usage: /addcredits <userId> <amount>');
  const target = String(parts[1]);
  const amount = Number(parts[2]);
  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Amount must be positive.');

  const u = getUser(target);
  u.credits += amount;
  await ctx.reply(`Added ${amount} credits to ${target}. New balance: ${u.credits}`);
});

bot.on('photo', async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  const u = getUser(userId);

  if (u.credits <= 0) {
    return ctx.reply('Out of credits. Tap “Buy Credits”.', mainMenu());
  }

  try {
    // Get largest photo size
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(best.file_id);

    // Download image bytes
    const imgRes = await fetch(fileLink.href);
    if (!imgRes.ok) throw new Error(`Failed to download photo: ${imgRes.status}`);
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());

    // Create job id
    const id_gen = `tg_${chatId}_${Date.now()}`;
    jobs.set(id_gen, { chatId, userId });

    // Webhook URL we give to the API
    const webhookUrl = `${PUBLIC_BASE_URL}/webhook/nudify`;

    // Build multipart/form-data
    const boundary = `----nudify${Date.now()}`;
    const CRLF = '\r\n';
    const parts = [];

    // id_gen field
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="id_gen"${CRLF}${CRLF}${id_gen}${CRLF}`));

    // photo field
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${FILE_FIELD_NAME}"; filename="photo.jpg"${CRLF}`));
    parts.push(Buffer.from(`Content-Type: image/jpeg${CRLF}${CRLF}`));
    parts.push(imgBuf);
    parts.push(Buffer.from(CRLF));

    // webhook field
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="webhook"${CRLF}${CRLF}${webhookUrl}${CRLF}`));

    parts.push(Buffer.from(`--${boundary}--${CRLF}`));

    const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    if (API_KEY_HEADER && API_KEY_VALUE) headers[API_KEY_HEADER] = API_KEY_VALUE;

    await ctx.reply('Queued. I’ll send the cartoon when it’s ready…');

    const apiRes = await fetch(nudify_URL, {
      method: 'POST',
      headers,
      body: Buffer.concat(parts)
    });

    if (!apiRes.ok) {
      const txt = await apiRes.text().catch(() => '');
      jobs.delete(id_gen);
      throw new Error(`API error ${apiRes.status}: ${txt.slice(0, 300)}`);
    }

    // Deduct credit now (or deduct on webhook success—your choice)
    u.credits -= 1;
    u.lifetime += 1;

  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`, mainMenu());
  }
});

// ---------- Webhook receiver (THIS is your webhook) ----------
app.post('/webhook/nudify', async (req, res) => {
  try {
    // The API should POST back something that includes id_gen and the result
    const body = req.body || {};
    const id_gen = body.id_gen || body.id || body.job_id;
    if (!id_gen) return res.status(400).send('Missing id_gen');

    const job = jobs.get(id_gen);
    if (!job) return res.status(200).send('Unknown id_gen (ignored)');

    // Determine where the result image is
    const resultUrl = body[WEBHOOK_RESULT_FIELD_URL] || body.url || body.image_url || body.result_url;

    if (resultUrl) {
      await bot.telegram.sendPhoto(job.chatId, resultUrl, { caption: '✅ nudify complete' });
    } else if (body.base64 || body.image_base64) {
      const b64 = body.base64 || body.image_base64;
      const buf = Buffer.from(b64, 'base64');
      await bot.telegram.sendPhoto(job.chatId, { source: buf }, { caption: '✅ nudify complete' });
    } else {
      await bot.telegram.sendMessage(job.chatId, 'Got webhook, but did not find a result URL/base64 in payload. Tell me what fields it sends.');
    }

    jobs.delete(id_gen);
    return res.status(200).send('ok');
  } catch (e) {
    return res.status(500).send('error');
  }
});

// Health check
app.get('/', (req, res) => res.send('ok'));

// Start both web server + telegram bot
app.listen(PORT, () => console.log(`Web server on :${PORT}`));
bot.launch();
console.log('Bot running…');
