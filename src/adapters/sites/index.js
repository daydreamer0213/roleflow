const { BossSiteAdapter } = require('./boss');
const { ZhaopinSiteAdapter } = require('./zhaopin');
const { ZhaopinCommunicationAdapter } = require('./zhaopin_communication');

function createSiteAdapter(site = 'boss', context) {
  site = String(site || 'boss').trim().toLowerCase() || 'boss';
  if (site === 'boss') return new BossSiteAdapter(context);
  if (site === 'zhaopin' && context?.operation === 'communication') return new ZhaopinCommunicationAdapter(context);
  if (site === 'zhaopin') return new ZhaopinSiteAdapter(context);
  throw Object.assign(new Error(`不支持的平台：${site}`), { code: 'UNKNOWN_SITE' });
}

module.exports = { createSiteAdapter };
