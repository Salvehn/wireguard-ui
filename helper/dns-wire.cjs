// Minimal DNS transport: preserve upstream responses, inspect only answer records.
const dgram = require("node:dgram");
const net = require("node:net");
const crypto = require("node:crypto");
const { domainToASCII } = require("node:url");

function readName(packet, offset) {
  let cursor = offset,
    end,
    total = 0;
  const labels = [],
    visited = new Set();
  for (let steps = 0; steps < 128; steps++) {
    if (cursor >= packet.length || visited.has(cursor))
      throw Error("Invalid DNS name");
    visited.add(cursor);
    const size = packet[cursor];
    if ((size & 0xc0) === 0xc0) {
      if (cursor + 1 >= packet.length) throw Error("Invalid DNS pointer");
      end ??= cursor + 2;
      cursor = ((size & 0x3f) << 8) | packet[cursor + 1];
      continue;
    }
    if (size & 0xc0) throw Error("Invalid DNS label");
    cursor++;
    if (!size)
      return { name: labels.join(".").toLowerCase(), end: end ?? cursor };
    if (cursor + size > packet.length || (total += size + 1) > 254)
      throw Error("Invalid DNS name");
    const label = packet.subarray(cursor, cursor + size).toString("ascii");
    if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw Error("Invalid DNS label");
    labels.push(label);
    cursor += size;
  }
  throw Error("DNS pointer loop");
}
function question(packet) {
  if (
    !Buffer.isBuffer(packet) ||
    packet.length < 17 ||
    packet.length > 65535 ||
    packet.readUInt16BE(4) !== 1 ||
    packet[2] & 0x78
  )
    throw Error("Unsupported DNS question");
  const name = readName(packet, 12);
  if (name.end + 4 > packet.length || packet.readUInt16BE(name.end + 2) !== 1)
    throw Error("Unsupported DNS class");
  return {
    name: name.name,
    type: packet.readUInt16BE(name.end),
    end: name.end + 4,
  };
}
function errorResponse(packet, code = 2) {
  const q = question(packet);
  const result = Buffer.from(packet.subarray(0, q.end));
  result[2] = 0x80 | (packet[2] & 1);
  result[3] = 0x80 | code;
  result.fill(0, 6, 12);
  return result;
}
function answers(packet, query) {
  const expected = question(query),
    actual = question(packet);
  if (
    !(packet[2] & 0x80) ||
    packet.readUInt16BE(0) !== query.readUInt16BE(0) ||
    actual.name !== expected.name ||
    actual.type !== expected.type
  )
    throw Error("Mismatched DNS response");
  if (packet[3] & 15 || packet[2] & 2) return [];
  const count = packet.readUInt16BE(6);
  if (count > 256) throw Error("Too many DNS answers");
  let offset = actual.end;
  const records = [];
  for (let i = 0; i < count; i++) {
    const owner = readName(packet, offset);
    offset = owner.end;
    if (offset + 10 > packet.length) throw Error("Truncated DNS record");
    const type = packet.readUInt16BE(offset),
      cls = packet.readUInt16BE(offset + 2),
      size = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + size > packet.length) throw Error("Truncated DNS data");
    if (cls === 1) {
      if (type === 5) {
        const target = readName(packet, offset);
        if (target.end !== offset + size) throw Error("Invalid CNAME record");
        records.push({ owner: owner.name, target: target.name });
      }
      if (type === 1 && size === 4)
        records.push({
          owner: owner.name,
          address: [...packet.subarray(offset, offset + size)].join("."),
        });
      if (type === 28 && size === 16)
        records.push({
          owner: owner.name,
          address: Array.from({ length: 8 }, (_, j) =>
            packet.readUInt16BE(offset + j * 2).toString(16),
          ).join(":"),
        });
    }
    offset += size;
  }
  const names = new Set([expected.name]);
  for (let i = 0; i < records.length; i++)
    for (const record of records)
      if (names.has(record.owner) && record.target) names.add(record.target);
  return [
    ...new Set(
      records
        .filter((record) => names.has(record.owner) && record.address)
        .map((record) => record.address),
    ),
  ];
}
function makeQuery(name, type) {
  name = domainToASCII(name.replace(/\.$/, ""));
  if (
    !name ||
    name.length > 253 ||
    !name.split(".").every((label) => /^[a-z0-9_-]{1,63}$/i.test(label))
  )
    throw Error("Invalid DNS query name");
  const header = Buffer.alloc(12);
  header.writeUInt16BE(crypto.randomInt(65536));
  header[2] = 1;
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([
    header,
    ...name
      .split(".")
      .map((label) =>
        Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
      ),
    tail,
  ]);
}
function exchange(query, server, port = 53, tcp = false) {
  return new Promise((resolve, reject) => {
    let finished = false,
      buffer = Buffer.alloc(0);
    const socket = tcp
      ? net.createConnection({ host: server, port })
      : dgram.createSocket(net.isIP(server) === 6 ? "udp6" : "udp4");
    const timer = setTimeout(() => done(Error("DNS upstream timed out")), 3000);
    function done(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (tcp) socket.destroy();
      else {
        try {
          socket.close();
        } catch {}
      }
      error ? reject(error) : resolve(result);
    }
    socket.on("error", (error) => done(error));
    if (tcp) {
      socket.on("connect", () => {
        const size = Buffer.alloc(2);
        size.writeUInt16BE(query.length);
        socket.write(Buffer.concat([size, query]));
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 65537) return done(Error("DNS response too large"));
        if (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2)
          done(null, buffer.subarray(2, buffer.readUInt16BE(0) + 2));
      });
      socket.on("end", () => {
        if (!finished) done(Error("Incomplete DNS response"));
      });
    } else {
      socket.on("message", (packet) => {
        try {
          answers(packet, query);
          done(null, packet);
        } catch {}
      });
      socket.connect(port, server, () =>
        socket.send(query, (error) => {
          if (error) done(error);
        }),
      );
    }
  });
}
async function forward(query, servers) {
  for (const server of servers) {
    try {
      let response = await exchange(query, server);
      if (response[2] & 2) response = await exchange(query, server, 53, true);
      answers(response, query);
      return response;
    } catch {}
  }
  throw Error("DNS servers unavailable");
}
async function createDnsProxy(
  {
    servers,
    observe,
    matches,
    onError = () => {},
    forwardQuery = (query) => forward(query, servers),
    port = 0,
    listenHost = "127.0.0.1",
  },
  attempt = 0,
) {
  const udp = dgram.createSocket("udp4");
  const clients = new Set();
  let active = 0,
    closed = false;
  async function processQuery(packet) {
    let q;
    try {
      q = question(packet);
      if (packet[2] & 0x80) return null;
    } catch {
      return null;
    }
    if (active >= 32 || closed) return errorResponse(packet);
    active++;
    try {
      if (!matches(q.name)) return await forwardQuery(packet);
      // HTTPS/SVCB hints can bypass A/AAAA resolution. Advertise no local HTTPS/SVCB
      // data for matching rules, so clients resolve the original host normally.
      if (q.type === 64 || q.type === 65) return errorResponse(packet, 0);
      const response = await forwardQuery(packet);
      const addresses = answers(response, packet);
      if (addresses.length) await observe(q.name, addresses);
      return response;
    } catch (error) {
      onError(error);
      return errorResponse(packet);
    } finally {
      active--;
    }
  }
  udp.on("error", onError);
  udp.on("message", (packet, remote) => {
    void processQuery(packet).then((response) => {
      if (response && !closed)
        udp.send(response, remote.port, remote.address, () => {});
    });
  });
  const tcp = net.createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    let buffer = Buffer.alloc(0),
      received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65537) {
        socket.destroy();
        return;
      }
      if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2)
        return;
      received = true;
      socket.pause();
      void processQuery(buffer.subarray(2, buffer.readUInt16BE(0) + 2)).then(
        (response) => {
          if (!response) {
            socket.destroy();
            return;
          }
          const size = Buffer.alloc(2);
          size.writeUInt16BE(response.length);
          socket.end(Buffer.concat([size, response]));
        },
      );
    });
  });
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, listenHost, resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(udp.address().port, listenHost, resolve);
    });
  } catch (error) {
    await new Promise((resolve) => udp.close(resolve));
    // A free UDP port may already be occupied by an unrelated TCP service.
    if (port === 0 && error.code === "EADDRINUSE" && attempt < 8)
      return createDnsProxy(
        { servers, observe, matches, onError, forwardQuery, port, listenHost },
        attempt + 1,
      );
    throw error;
  }
  return {
    port: udp.address().port,
    async close() {
      closed = true;
      for (const socket of clients) socket.destroy();
      await Promise.all([
        new Promise((resolve) => udp.close(resolve)),
        new Promise((resolve) => tcp.close(resolve)),
      ]);
    },
  };
}
module.exports = {
  readName,
  question,
  answers,
  errorResponse,
  makeQuery,
  exchange,
  forward,
  createDnsProxy,
};
