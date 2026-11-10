const assert = require('assert');
const { getKeepAliveAgent } = require('../lib/network');

function testAgentOptions() {
  const agent = getKeepAliveAgent();
  assert.strictEqual(agent.keepAlive, true, 'KeepAlive phải được kích hoạt');
  assert.strictEqual(agent.maxSockets, 32, 'maxSockets tối đa phải là 32');
  console.log('✅ testAgentOptions passed');
}

testAgentOptions();

