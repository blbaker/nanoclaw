import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * NO_REPLY sentinel detection.
 *
 * Cron tasks and persona prompts use the literal text "NO_REPLY" to mean
 * "I checked, nothing to report — say nothing". This must be intercepted
 * BEFORE the message reaches Discord, in EVERY path that calls
 * channel.sendMessage:
 *
 *   1. Streaming result path  (src/index.ts processGroupMessages → onOutput)
 *   2. IPC message path       (src/ipc.ts when agent calls send_message MCP tool)
 *   3. Any future path that does outbound delivery
 *
 * If you add a new outbound path, call this helper before sending.
 *
 * Matches case-insensitively, with optional surrounding whitespace,
 * underscores/hyphens/spaces inside, optional parentheses, optional
 * trailing period. All of these suppress:
 *   - "NO_REPLY"
 *   - "no_reply"
 *   - "NO REPLY"
 *   - "no-reply"
 *   - "NOREPLY"
 *   - "(NO_REPLY)"
 *   - "NO_REPLY."
 *   - "  NO_REPLY  "
 *
 * Does NOT match if the sentinel is embedded in a longer message
 * (e.g. "Result: NO_REPLY") — those are treated as legitimate replies
 * because the agent went out of its way to wrap them.
 */
export function isNoReplySentinel(text: string): boolean {
  if (!text) return false;
  return /^\s*\(?\s*NO[\s_-]*REPLY\s*\)?\.?\s*$/i.test(text);
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
