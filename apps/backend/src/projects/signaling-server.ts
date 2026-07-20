import * as WebSocket from 'ws';
import { Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';

export class SignalingServer {
  private wss: WebSocket.Server;
  private streamer: WebSocket | null = null;
  private players: Set<WebSocket> = new Set();
  private logger = new Logger('SignalingServer');

  constructor(private port: number) {
    this.wss = new WebSocket.Server({ port });
    this.logger.log(`Signaling WebSocket server listening on port ${port}`);

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = req.url || '';
      this.logger.log(`New WebSocket connection on port ${port} path: ${url}`);

      // Assign a temporary player ID to distinguish players
      const playerId = String(Math.floor(Math.random() * 1000) + 100);
      (ws as any).playerId = playerId;
      let isRegistered = false;
      let timeoutId: NodeJS.Timeout | null = null;

      const registerAsPlayer = () => {
        if (isRegistered) return;
        isRegistered = true;
        if (timeoutId) clearTimeout(timeoutId);

        this.players.add(ws);
        // Send initial config to player (ICE servers)
        const configMsg = {
          type: 'config',
          peerConnectionOptions: {
            iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
          },
        };
        ws.send(JSON.stringify(configMsg));
        this.logger.log(`Sent WebRTC config to player ${playerId}`);

        // Notify streamer with a small delay to ensure UE plugin is ready
        if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
          setTimeout(() => {
            if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
              const playerMsg = JSON.stringify({
                type: 'playerConnected',
                playerId: playerId,
                dataChannel: true,
              });
              this.streamer.send(playerMsg);
              this.logger.log(`Notified streamer that player ${playerId} connected (delayed)`);
            }
          }, 1000);
        } else {
          this.logger.log(`Player ${playerId} connected but no streamer present yet`);
        }
      };

      const registerAsStreamer = () => {
        if (isRegistered) return;
        isRegistered = true;
        if (timeoutId) clearTimeout(timeoutId);

        this.streamer = ws;
        this.logger.log(`Streamer registered on port ${port}`);

        // Notify streamer of existing players after a brief delay
        // so the UE plugin has time to initialize its message handlers
        if (this.players.size > 0) {
          const playerList = Array.from(this.players);
          setTimeout(() => {
            playerList.forEach((player) => {
              const pId = (player as any).playerId;
              if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
                const playerMsg = JSON.stringify({
                  type: 'playerConnected',
                  playerId: pId,
                  dataChannel: true,
                });
                this.streamer.send(playerMsg);
                this.logger.log(`Notified streamer of existing player ${pId} (delayed)`);
              }
            });
          }, 2000);
        }
      };

      // Check URL path to identify role immediately
      // The browser client connects to /player. The Unreal Streamer connects to / or //
      if (url.includes('player')) {
        registerAsPlayer();
      } else {
        registerAsStreamer();
      }

      ws.on('message', (message: WebSocket.Data) => {
        let messageStr = '';
        if (typeof message === 'string') {
          messageStr = message;
        } else if (Buffer.isBuffer(message)) {
          messageStr = message.toString();
        } else if (message instanceof ArrayBuffer) {
          messageStr = Buffer.from(message).toString();
        } else if (Array.isArray(message)) {
          messageStr = Buffer.concat(message).toString();
        }

        let parsed: any;
        try {
          parsed = JSON.parse(messageStr);
        } catch (e) {
          // If not JSON, register as player if not registered, then forward raw message
          if (!isRegistered) registerAsPlayer();
          this.forwardRawMessage(ws, message);
          return;
        }

        // Process identify message
        if (
          parsed.type === 'identify' &&
          (parsed.id === 'Streamer' || parsed.role === 'streamer')
        ) {
          registerAsStreamer();
          return;
        }

        // Register as player if not registered yet
        if (!isRegistered) {
          registerAsPlayer();
        }

        this.handleMessage(ws, parsed, messageStr);
      });

      ws.on('close', () => {
        if (timeoutId) clearTimeout(timeoutId);

        if (ws === this.streamer) {
          this.logger.log(`Streamer disconnected from port ${port}`);
          this.streamer = null;
          // Notify players
          this.broadcastToPlayers(JSON.stringify({ type: 'streamerDisconnected' }));
        } else {
          this.logger.log(`Player ${playerId} disconnected from port ${port}`);
          this.players.delete(ws);
          if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
            // Notify streamer that player disconnected
            this.streamer.send(JSON.stringify({ type: 'playerDisconnected', playerId }));
          }
        }
      });

      ws.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.logger.error(`Socket error on port ${port}: ${err.message}`);
      });
    });
  }

  private handleMessage(sender: WebSocket, parsed: any, raw: string) {
    const senderId = (sender as any).playerId;

    // Handle ping/pong keepalive
    if (parsed.type === 'ping') {
      this.logger.debug(
        `Responding to ping from ${sender === this.streamer ? 'streamer' : `player ${senderId}`}`,
      );
      sender.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (sender === this.streamer) {
      this.logger.log(`Streamer → type=${parsed.type} playerId=${parsed.playerId || '*'}`);
      // Message from Streamer to Player(s)
      if (parsed.playerId) {
        // Direct message to a specific player
        const target = Array.from(this.players).find(
          (p) => (p as any).playerId === parsed.playerId,
        );
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(raw);
          this.logger.log(`Forwarded ${parsed.type} → player ${parsed.playerId}`);
        } else {
          this.logger.warn(`Target player ${parsed.playerId} not found for streamer message`);
        }
      } else if (parsed.type === 'offer') {
        // Offer without playerId → send to first available player
        if (this.players.size > 0) {
          const firstPlayer = Array.from(this.players)[0];
          const pId = (firstPlayer as any).playerId;
          parsed.playerId = pId;
          firstPlayer.send(JSON.stringify(parsed));
          this.logger.log(`Forwarded offer → first player ${pId}`);
        }
      } else if (parsed.type !== 'pong') {
        // Broadcast to all players
        this.broadcastToPlayers(raw);
        this.logger.log(`Broadcasted ${parsed.type} → ${this.players.size} players`);
      }
    } else {
      this.logger.log(`Player ${senderId} → type=${parsed.type}`);
      // Message from Player to Streamer
      if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
        // Attach player ID so streamer knows where it came from
        parsed.playerId = senderId;
        const msgStr = JSON.stringify(parsed);
        this.streamer.send(msgStr);
        this.logger.log(`Forwarded ${parsed.type} → streamer`);
      } else {
        this.logger.warn(`No streamer connected on port ${this.port} to receive player message`);
      }
    }
  }

  private forwardRawMessage(sender: WebSocket, message: WebSocket.Data) {
    if (sender === this.streamer) {
      const byteLen =
        typeof message === 'string'
          ? message.length
          : (message as any).byteLength || (message as any).length || 0;
      this.logger.debug(
        `Forwarding binary message (${byteLen}B) from streamer to ${this.players.size} players`,
      );
      this.players.forEach((player) => {
        if (player.readyState === WebSocket.OPEN) {
          player.send(message);
        }
      });
    } else if (this.streamer && this.streamer.readyState === WebSocket.OPEN) {
      const byteLen =
        typeof message === 'string'
          ? message.length
          : (message as any).byteLength || (message as any).length || 0;
      this.logger.debug(`Forwarding binary message (${byteLen}B) from player to streamer`);
      this.streamer.send(message);
    }
  }

  private broadcastToPlayers(message: string) {
    this.players.forEach((player) => {
      if (player.readyState === WebSocket.OPEN) {
        player.send(message);
      }
    });
  }

  public getPlayerCount(): number {
    return this.players.size;
  }

  public hasStreamer(): boolean {
    return this.streamer !== null && this.streamer.readyState === WebSocket.OPEN;
  }

  public close() {
    // Disconnect everyone
    if (this.streamer) {
      this.streamer.close();
    }
    this.players.forEach((p) => p.close());
    this.wss.close(() => {
      this.logger.log(`Signaling WebSocket server closed on port ${this.port}`);
    });
  }
}
