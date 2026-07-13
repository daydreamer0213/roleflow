const { EdgeControlAdapter } = require("./edge_control");

class BrowserAdapter {
  async open() {
    throw new Error("BrowserAdapter.open not implemented");
  }

  async readPage() {
    throw new Error("BrowserAdapter.readPage not implemented");
  }
}

class PlaywrightAdapter extends BrowserAdapter {}

module.exports = { BrowserAdapter, EdgeControlAdapter, PlaywrightAdapter };
