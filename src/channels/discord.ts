import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
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
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    files?: string[],
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed.
      // Attachments only go on the LAST chunk so the file appears next to
      // the closing text.
      const MAX_LENGTH = 2000;
      const attachments = (files || []).filter(
        (f) => typeof f === 'string' && f.length > 0,
      );

      if (text.length <= MAX_LENGTH) {
        await textChannel.send({
          content: text || undefined,
          files: attachments.length > 0 ? attachments : undefined,
        });
      } else {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await textChannel.send({
            content: chunks[i],
            files: isLast && attachments.length > 0 ? attachments : undefined,
          });
        }
      }
      logger.info(
        { jid, length: text.length, files: attachments.length },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /**
   * Ask the user a multiple-choice question via Discord reactions.
   * Posts the question, pre-reacts each option emoji, then waits for
   * the user (matching senderUserId) to react with one of them, or for
   * the timeout to elapse.
   *
   * Returns the selected option's `value` field, or 'timeout', or 'error'.
   */
  async askUser(
    jid: string,
    question: string,
    options: Array<{ emoji: string; label: string; value: string }>,
    senderUserId: string,
    timeoutMs: number,
  ): Promise<string> {
    if (!this.client) {
      logger.warn('Discord client not initialized for askUser');
      return 'error';
    }
    if (options.length === 0 || options.length > 10) {
      logger.warn({ count: options.length }, 'askUser: invalid options count');
      return 'error';
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        return 'error';
      }
      const textChannel = channel as TextChannel;

      const legend = options
        .map((o) => `${o.emoji} ${o.label}`)
        .join('\n');
      const sent = await textChannel.send(
        `${question}\n\n${legend}\n\n_Reply within ${Math.round(timeoutMs / 1000)}s, or I'll proceed with the default._`,
      );

      // Pre-react with each option emoji so user just taps
      for (const o of options) {
        try {
          await sent.react(o.emoji);
        } catch (err) {
          logger.warn({ emoji: o.emoji, err }, 'askUser: failed to pre-react');
        }
      }

      // Wait for the user's reaction
      return await new Promise<string>((resolve) => {
        const finished = { done: false };
        const finish = (result: string) => {
          if (finished.done) return;
          finished.done = true;
          this.client?.off(Events.MessageReactionAdd, listener);
          clearTimeout(timer);
          resolve(result);
        };

        const listener = async (
          reaction: { message: { id: string }; emoji: { name: string | null } },
          user: { id: string; bot: boolean },
        ) => {
          if (user.bot) return;
          if (user.id !== senderUserId) return;
          if (reaction.message.id !== sent.id) return;
          const emojiName = reaction.emoji.name;
          if (!emojiName) return;
          const match = options.find((o) => o.emoji === emojiName);
          if (match) {
            finish(match.value);
          }
        };

        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        this.client?.on(
          Events.MessageReactionAdd,
          listener as Parameters<Client['on']>[1],
        );
      });
    } catch (err) {
      logger.error({ jid, err }, 'askUser failed');
      return 'error';
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
