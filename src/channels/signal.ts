import http from 'http';
import axios from 'axios';

import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    groupInfo?: {
      groupId: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      timestamp?: number;
      message?: string;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      groupInfo?: {
        groupId: string;
      };
    };
  };
}

export class SignalChannel implements Channel {
  name = 'signal';
  prefixAssistantName = true;

  private phoneNumber: string;
  private rpcUrl: string;
  private eventsUrl: string;
  private opts: SignalChannelOpts;
  private connected = false;
  private sseRequest: http.ClientRequest | null = null;
  private lastMessageTimestamp = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(phoneNumber: string, rpcUrl: string, opts: SignalChannelOpts) {
    this.phoneNumber = phoneNumber;
    this.rpcUrl = rpcUrl;
    // Derive events URL from RPC URL: http://host:port/api/v1/rpc -> http://host:port/api/v1/events
    this.eventsUrl = rpcUrl.replace(/\/rpc$/, '/events');
    this.opts = opts;
  }

  async connect(): Promise<void> {
    logger.info({ phone: this.phoneNumber }, 'Connecting to Signal');

    // Test connection to signal-cli daemon
    try {
      await this.rpcCall('version', {});
      logger.info('Signal daemon connection verified');
    } catch (err) {
      throw new Error(
        `Failed to connect to signal-cli daemon at ${this.rpcUrl}: ${err}`,
      );
    }

    // Start SSE listener for incoming messages
    this.connectSSE();

    console.log(`\n  Signal account: ${this.phoneNumber}`);
    console.log('  Ready to receive messages\n');
  }

  private async rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await axios.post(
      this.rpcUrl,
      {
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now(),
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      },
    );

    if (response.data.error) {
      throw new Error(
        `Signal RPC error: ${JSON.stringify(response.data.error)}`,
      );
    }

    return response.data.result;
  }

  private connectSSE(): void {
    const url = new URL(this.eventsUrl);

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          logger.error(
            { statusCode: res.statusCode },
            'Signal SSE connection failed',
          );
          this.scheduleReconnect();
          return;
        }

        this.connected = true;
        logger.info('Signal SSE stream connected');

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // SSE messages are delimited by double newlines
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            this.handleSSEEvent(part);
          }
        });

        res.on('end', () => {
          logger.info('Signal SSE stream ended');
          this.connected = false;
          this.scheduleReconnect();
        });

        res.on('error', (err) => {
          logger.error({ err }, 'Signal SSE stream error');
          this.connected = false;
          this.scheduleReconnect();
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'Signal SSE connection error');
      this.connected = false;
      this.scheduleReconnect();
    });

    this.sseRequest = req;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting Signal SSE...');
      this.connectSSE();
    }, 5000);
  }

  private handleSSEEvent(raw: string): void {
    // Parse SSE format: lines starting with "data:" contain the JSON payload
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;

    const jsonStr = dataLines.join('\n');
    if (!jsonStr) return;

    try {
      const event = JSON.parse(jsonStr);
      // The SSE event contains an envelope directly
      if (event.envelope) {
        this.handleMessage(event.envelope, event.account).catch((err) =>
          logger.error({ err }, 'Error handling Signal message'),
        );
      }
    } catch (err) {
      logger.debug(
        { err, raw: jsonStr.slice(0, 200) },
        'Failed to parse Signal SSE event',
      );
    }
  }

  private async handleMessage(
    envelope: SignalEnvelope,
    _account?: string,
  ): Promise<void> {
    // Skip if we've already processed this timestamp
    if (envelope.timestamp <= this.lastMessageTimestamp) {
      return;
    }
    this.lastMessageTimestamp = envelope.timestamp;

    let content = '';
    let sender = '';
    let senderName = '';
    let chatJid = '';
    let isFromMe = false;

    // Handle regular incoming message
    if (envelope.dataMessage) {
      content = envelope.dataMessage.message || '';
      sender = envelope.sourceNumber || envelope.source || '';
      senderName = envelope.sourceName || sender;

      if (envelope.dataMessage.groupInfo) {
        chatJid = `signal:group:${envelope.dataMessage.groupInfo.groupId}`;
      } else {
        chatJid = `signal:${sender}`;
      }
    }
    // Handle sync message (sent from this account on another device)
    else if (envelope.syncMessage?.sentMessage) {
      const sentMsg = envelope.syncMessage.sentMessage;
      content = sentMsg.message || '';
      sender = this.phoneNumber;
      senderName = 'Me';
      isFromMe = true;

      if (sentMsg.groupInfo) {
        chatJid = `signal:group:${sentMsg.groupInfo.groupId}`;
      } else {
        const destination =
          sentMsg.destinationNumber || sentMsg.destination || '';
        chatJid = `signal:${destination}`;
      }
    }

    if (!content || !chatJid) {
      return;
    }

    const timestamp = new Date(envelope.timestamp).toISOString();

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatJid);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Signal chat');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: `${envelope.timestamp}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
    });

    logger.info({ chatJid, sender: senderName }, 'Signal message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      let recipient: string;
      let isGroup = false;

      if (jid.startsWith('signal:group:')) {
        recipient = jid.replace('signal:group:', '');
        isGroup = true;
      } else {
        recipient = jid.replace('signal:', '');
      }

      const MAX_LENGTH = 2000;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );

      for (const chunk of chunks) {
        if (isGroup) {
          await this.rpcCall('sendGroupMessage', {
            message: chunk,
            groupId: recipient,
          });
        } else {
          await this.rpcCall('send', {
            message: chunk,
            recipient: [recipient],
          });
        }
        if (chunks.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }
    this.connected = false;
    logger.info('Signal channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // signal-cli doesn't support typing indicators via JSON-RPC
  }
}
