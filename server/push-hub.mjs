// The self-host push hub: the OwnerPush Durable Object's local
// stand-in. It holds each owner's open board sockets and passes
// a new version number to them when a change lands — the number
// and nothing else, exactly as on Cloudflare. The client
// messages mean nothing here, as they mean nothing to the
// Durable Object: a ping is answered with a pong, a close is
// answered with a close, and anything else is ignored.
//
// The WebSocket wire work is the small server half of RFC 6455,
// written on node:crypto: the handshake's accept key, unmasked
// text frames out, and masked frames in (clients always mask).
// It uses no dependency, because this much of the protocol is
// short and finished.
//
// Two limits keep a socket from costing the machine its memory:
// a frame may declare at most MAX_FRAME_PAYLOAD bytes (the
// pushes are version numbers, a few bytes; a client frame has
// nothing bigger to say), and one socket's unprocessed buffer
// may hold at most MAX_SOCKET_BUFFER. A frame that breaks
// either limit — or arrives unmasked, which RFC 6455 forbids a
// client — closes the socket: the hub never waits for the rest
// of a giant frame to arrive.
import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_PAYLOAD = 64 * 1024;
const MAX_SOCKET_BUFFER = 256 * 1024;

function acceptKey(key) {
  return createHash("sha1").update(String(key) + WS_GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

export function createPushHub() {
  const byOwner = new Map(); // ownerId -> Set of sockets

  function attach(socket, ownerId) {
    let set = byOwner.get(ownerId);
    if (!set) {
      set = new Set();
      byOwner.set(ownerId, set);
    }
    set.add(socket);

    let buffer = Buffer.alloc(0);
    let closed = false;
    const drop = () => {
      if (closed) return;
      closed = true;
      set.delete(socket);
      if (set.size === 0) byOwner.delete(ownerId);
    };
    // Fail the connection, RFC 6455's own remedy: a close frame
    // naming why, then the socket goes away once it has flushed.
    const fail = (code) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      try {
        socket.write(encodeFrame(0x8, payload), () => socket.destroy());
        setTimeout(() => socket.destroy(), 1000).unref();
      } catch (e) { /* already gone */ }
      drop();
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_SOCKET_BUFFER) { fail(1009); return; }
      // Walk every whole frame the buffer now holds.
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        // The header alone settles both refusals, before a
        // single payload byte is waited for: an unmasked client
        // frame is a protocol error (1002), and a declared
        // payload past the cap is too big (1009).
        if (!masked) { fail(1002); return; }
        if (length > MAX_FRAME_PAYLOAD) { fail(1009); return; }
        let mask = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          mask = buffer.slice(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) return;
        let payload = buffer.slice(offset, offset + length);
        if (mask) {
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buffer = buffer.slice(offset + length);
        if (opcode === 0x8) {
          // Close: answer with a close and let go.
          try { socket.end(encodeFrame(0x8, payload)); } catch (e) { /* already gone */ }
          drop();
          return;
        }
        if (opcode === 0x9) {
          try { socket.write(encodeFrame(0xA, payload)); } catch (e) { drop(); return; }
        }
        // Pongs and any data frames are ignored, as the Durable
        // Object ignores what a board sends it.
      }
    });
    socket.on("close", drop);
    socket.on("error", drop);
  }

  // Answers the HTTP upgrade on an already-authenticated socket:
  // the handshake itself. Who the socket belongs to was settled
  // before this runs, by the core, through the same caller checks
  // as every other route.
  function handshake(socket, head, ownerId) {
    const key = head["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return false;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
    );
    attach(socket, ownerId);
    return true;
  }

  function broadcast(ownerId, text) {
    const set = byOwner.get(String(ownerId));
    if (!set) return;
    const frame = encodeFrame(0x1, String(text));
    for (const socket of [...set]) {
      try {
        socket.write(frame);
      } catch (e) {
        set.delete(socket);
      }
    }
  }

  // Lets go of every socket one owner holds, with a close
  // frame: the sockets' boards are gone (the owner deleted
  // their account), so there is nothing left to update them
  // about. Each socket's own close handling removes it from
  // the set as it goes away.
  function dropOwner(ownerId) {
    const set = byOwner.get(String(ownerId));
    if (!set) return;
    for (const socket of [...set]) {
      try {
        socket.write(encodeFrame(0x8, Buffer.alloc(0)), () => socket.destroy());
        setTimeout(() => socket.destroy(), 1000).unref();
      } catch (e) { /* already gone */ }
    }
    byOwner.delete(String(ownerId));
  }

  return { handshake, broadcast, dropOwner };
}
