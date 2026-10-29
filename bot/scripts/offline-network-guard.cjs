// Preloaded in every test worker. Test doubles may replace fetch/request, but
// real traffic still cannot open a socket. A caught attempt fails the runner.
'use strict';
const fs = require('node:fs');

function blocked() {
  if (process.env.ELI_OFFLINE_VIOLATIONS_PATH) {
    fs.appendFileSync(process.env.ELI_OFFLINE_VIOLATIONS_PATH, 'blocked\n');
  }
  throw new Error('Offline tests prohibit network access');
}

globalThis.fetch = async () => blocked();
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = blocked;
  transport.get = blocked;
}
const net = require('node:net');
net.connect = net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
require('node:tls').connect = blocked;
require('node:dgram').createSocket = blocked;
