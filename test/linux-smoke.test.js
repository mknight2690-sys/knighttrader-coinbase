const assert = require('assert');
const { parseCliArgs } = require('../lib/cli');
const { setPaperOnly } = require('../lib/paper-mode');
const { proprRequest } = require('../lib/propr-api');

const cli = parseCliArgs(['node', 'electron', '--headless', '--paper-only', '--task', 'hi']);
assert.strictEqual(cli.headless, true);
assert.strictEqual(cli.paperOnly, true);
assert.strictEqual(cli.task, 'hi');

setPaperOnly(true);
proprRequest('fake', '/accounts/x/orders', { method: 'POST', body: {} }).then((r) => {
  assert.strictEqual(r.paperOnlyBlocked, true);
  assert.strictEqual(r.status, 403);
  console.log('linux-smoke: ok');
});
