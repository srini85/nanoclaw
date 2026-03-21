import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media');

/** Download a URL to a local file. Returns the local path on success, null on failure. */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          resolve(false);
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        logger.warn({ err: err.message }, 'Telegram media download error');
        resolve(false);
      });
  });
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    await sendTelegramMessage(chatId, text);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

// Fallback send via the registered channel instance (used by sendPoolMessage fallback)
let _sendFallback: ((jid: string, text: string) => Promise<void>) | null = null;
function sendTelegramMessage(jid: string, text: string): Promise<void> {
  if (_sendFallback) return _sendFallback(jid, text);
  logger.warn(
    { jid },
    'sendTelegramMessage called but no channel instance registered',
  );
  return Promise.resolve();
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    _sendFallback = (jid, text) => this.sendMessage(jid, text);
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Build common message context from a ctx object
    const msgContext = (ctx: any) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      return { chatJid, group, timestamp, senderName, isGroup };
    };

    // Emit metadata + message. attachment is the local file path (if downloaded).
    const storeMessage = (
      ctx: any,
      content: string,
      attachment?: string,
    ) => {
      const { chatJid, group, timestamp, senderName, isGroup } = msgContext(ctx);
      if (!group) return;
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        ...(attachment ? { attachment } : {}),
      });
    };

    // Download a Telegram file by file_id and return the local path, or null on failure.
    const downloadTgFile = async (
      fileId: string,
      ext: string,
      msgId: string,
    ): Promise<string | null> => {
      try {
        const token = readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
        if (!token) return null;
        const fileInfo = await this.bot!.api.getFile(fileId);
        if (!fileInfo.file_path) return null;
        const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
        const destPath = path.join(MEDIA_DIR, `${msgId}${ext}`);
        const ok = await downloadFile(url, destPath);
        return ok ? destPath : null;
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to download Telegram file');
        return null;
      }
    };

    // Photos — download the highest-resolution version
    this.bot.on('message:photo', async (ctx) => {
      const { group } = msgContext(ctx);
      if (!group) return;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      // photos array is sorted smallest→largest; take the last (largest)
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const msgId = ctx.message.message_id.toString();
      const localPath = await downloadTgFile(best.file_id, '.jpg', `tg_photo_${msgId}`);
      storeMessage(ctx, `[Photo]${caption}`, localPath ?? undefined);
      if (localPath) {
        logger.info({ path: localPath }, 'Telegram photo downloaded');
      } else {
        logger.warn({ msgId }, 'Telegram photo download failed — stored as placeholder');
      }
    });

    // Documents (PDFs, images sent as files, etc.)
    this.bot.on('message:document', async (ctx) => {
      const { group } = msgContext(ctx);
      if (!group) return;
      const doc = ctx.message.document!;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const name = doc.file_name || 'file';
      const ext = path.extname(name) || '';
      const msgId = ctx.message.message_id.toString();
      // Only attempt download for reasonably sized files (Telegram bot API cap: 20 MB)
      const localPath = doc.file_size && doc.file_size > 20 * 1024 * 1024
        ? null
        : await downloadTgFile(doc.file_id, ext, `tg_doc_${msgId}`);
      storeMessage(ctx, `[Document: ${name}]${caption}`, localPath ?? undefined);
    });

    // Non-downloadable / non-actionable media — store as placeholder text only
    const storeNonText = (ctx: any, placeholder: string) => {
      const { group } = msgContext(ctx);
      if (!group) return;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      storeMessage(ctx, `${placeholder}${caption}`);
    };

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
