import { createHmac } from "node:crypto";

export type PusherAuthInput = {
  /** The app key (public). */
  key: string;
  /** The app secret. Server side only; never send it to a browser. */
  secret: string;
  socketId: string;
  channel: string;
  /** Presence channels only: the exact JSON string that is signed and returned. */
  channelData?: string;
};

export type PusherAuth = { auth: string; channel_data?: string };

const SOCKET_ID = /^\d+\.\d+$/;
const CHANNEL = /^[A-Za-z0-9_=@,.;-]{1,164}$/;

/**
 * Sign a private or presence channel subscription the way the Pusher protocol
 * (and so Reverb and Laravel Echo) expects: HMAC-SHA256 of
 * `socket_id:channel[:channel_data]`, hex, prefixed with the key. A malformed
 * socket id or channel throws rather than being signed, because a colon in
 * either would let a caller choose what the signature covers.
 */
export function signPusherAuth(input: PusherAuthInput): PusherAuth {
  if (!SOCKET_ID.test(input.socketId)) throw new TypeError("Invalid socket id.");
  if (!CHANNEL.test(input.channel)) throw new TypeError("Invalid channel name.");
  if (!input.key || !input.secret) throw new TypeError("A key and a secret are required.");
  const subject = input.channelData === undefined ? `${input.socketId}:${input.channel}` : `${input.socketId}:${input.channel}:${input.channelData}`;
  const signature = createHmac("sha256", input.secret).update(subject).digest("hex");
  return input.channelData === undefined
    ? { auth: `${input.key}:${signature}` }
    : { auth: `${input.key}:${signature}`, channel_data: input.channelData };
}
