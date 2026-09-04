const ALLOWED_BOSS_NETWORK_PATHS = new Set([
  "/wapi/zpchat/config/get",
  "/wapi/zpgeek/friend/add.json"
]);
const DEFAULT_RESOURCE_TYPES = new Set(["XHR", "Fetch"]);

class CdpNetworkLog {
  constructor({ wsUrl, timeoutMs, options = {}, onFatal = null }) {
    this.wsUrl = wsUrl;
    this.timeoutMs = positiveInteger(timeoutMs, 15_000, 1, 120_000);
    this.maxEntries = positiveInteger(options.maxEntries, 12, 1, 100);
    this.maxBodies = positiveInteger(options.maxBodies, 4, 0, 10);
    this.maxBodyBytes = positiveInteger(options.maxBodyBytes, 8192, 1, 65_536);
    this.captureBodies = options.captureBodies === true;
    this.resourceTypes = allowedResourceTypes(options.resourceTypes);
    this.urlPaths = allowedPaths(options.urlIncludes);
    this.bodyPaths = allowedPaths(options.bodyUrlIncludes);
    this.onFatal = typeof onFatal === "function" ? onFatal : null;
    this.entries = [];
    this.byRequestId = new Map();
    this.bodyTasks = new Set();
    this.pendingCommands = new Map();
    this.commandId = 0;
    this.sequence = 0;
    this.bodyCount = 0;
    this.socket = null;
    this.opened = false;
    this.enabled = false;
    this.stopping = false;
    this.stopped = false;
    this.fatalError = null;
    this.messageQueue = Promise.resolve();
  }

  async start() {
    if (!this.urlPaths.size) {
      throw networkLogError("BROWSER_COMMAND_FAILED", "CDP network observer has no permitted endpoints.");
    }
    await this.openSocket();
    try {
      await this.command("Network.enable", {});
      this.enabled = true;
      return { started: true };
    } catch (error) {
      await this.closeAfterFailure(error);
      throw error;
    }
  }

  getMark() {
    this.assertActive();
    return { mark: { lastSequence: this.sequence } };
  }

  async read({ sinceSequence = 0, maxEntries = this.maxEntries, includeBodies = false, resourceTypes, urlIncludes, consume = false } = {}) {
    this.assertActive();
    await this.drainBodyTasks();
    this.assertActive();
    const minimumSequence = Math.max(0, Number(sinceSequence) || 0);
    const limit = positiveInteger(maxEntries, this.maxEntries, 1, this.maxEntries);
    const requestedTypes = resourceTypes === undefined ? this.resourceTypes : allowedResourceTypes(resourceTypes);
    const requestedPaths = urlIncludes === undefined ? this.urlPaths : allowedPaths(urlIncludes);
    const matching = this.entries.filter((entry) => entry.sequence > minimumSequence
      && requestedTypes.has(entry.resourceType)
      && requestedPaths.has(new URL(entry.url).pathname));
    const selected = matching.filter((entry) => entry.completedAt).slice(0, limit);
    const entries = selected.map((entry) => publicEntry(entry, includeBodies === true));
    if (consume === true) {
      const consumed = new Set(selected);
      this.entries = this.entries.filter((entry) => !consumed.has(entry));
      for (const [requestId, entry] of this.byRequestId) {
        if (consumed.has(entry)) this.byRequestId.delete(requestId);
      }
    }
    return { entries, meta: { pendingRequests: matching.filter((entry) => !entry.completedAt).length } };
  }

  async stop() {
    if (this.stopped || this.stopping) return { stopped: true };
    this.stopping = true;
    let disableError = null;
    try {
      await this.drainBodyTasks();
      if (this.enabled && this.opened && !this.fatalError) {
        try {
          await this.command("Network.disable", {});
        } catch (error) {
          disableError = error;
        }
      }
    } finally {
      this.enabled = false;
      this.opened = false;
      this.stopped = true;
      this.stopping = false;
      this.rejectPending(networkLogError("BROWSER_DISCONNECTED", "CDP network observer stopped."));
      tryClose(this.socket);
      this.socket = null;
      this.entries = [];
      this.byRequestId.clear();
    }
    if (disableError) throw disableError;
    return { stopped: true };
  }

  async openSocket() {
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      try {
        this.socket = new WebSocket(this.wsUrl);
        timer = setTimeout(() => finish(networkLogError(
          "BROWSER_TIMEOUT",
          `Network.enable timed out after ${this.timeoutMs}ms.`
        )), this.timeoutMs);
        this.socket.addEventListener("open", () => {
          this.opened = true;
          finish();
        });
        this.socket.addEventListener("message", (event) => {
          this.messageQueue = this.messageQueue
            .then(() => readMessageData(event.data))
            .then((text) => this.handleMessage(text))
            .catch((error) => this.fail(error));
        });
        this.socket.addEventListener("error", (event) => {
          const error = networkLogError("BROWSER_DISCONNECTED", "CDP network observer websocket error.", event?.error);
          if (!this.opened) finish(error);
          this.fail(error);
        });
        this.socket.addEventListener("close", (event) => {
          if (this.stopping || this.stopped) return;
          const detail = event?.code ? ` (code ${event.code})` : "";
          const error = networkLogError("BROWSER_DISCONNECTED", `CDP network observer websocket closed${detail}.`);
          if (!this.opened) finish(error);
          this.fail(error);
        });
      } catch (error) {
        finish(networkLogError("BROWSER_DISCONNECTED", "CDP network observer websocket could not connect.", error));
      }
    });
  }

  command(method, params) {
    this.assertCommandAvailable();
    return new Promise((resolve, reject) => {
      const id = ++this.commandId;
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(networkLogError("BROWSER_TIMEOUT", `${method} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pendingCommands.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pendingCommands.delete(id);
        clearTimeout(timer);
        reject(networkLogError("BROWSER_DISCONNECTED", `${method} could not be sent because the browser disconnected.`, error));
      }
    });
  }

  handleMessage(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw networkLogError("BROWSER_COMMAND_FAILED", "CDP network observer returned invalid JSON.", error);
    }
    if (data.id !== undefined) {
      const pending = this.pendingCommands.get(data.id);
      if (!pending) return;
      this.pendingCommands.delete(data.id);
      if (data.error) pending.reject(networkLogError(
        "BROWSER_COMMAND_FAILED",
        `${pending.method} failed.`
      ));
      else pending.resolve(data.result ?? data);
      return;
    }
    if (this.fatalError || this.stopping || this.stopped) return;
    if (data.method === "Network.requestWillBeSent") this.onRequest(data.params || {});
    if (data.method === "Network.responseReceived") this.onResponse(data.params || {});
    if (data.method === "Network.loadingFinished") this.onFinished(data.params || {});
    if (data.method === "Network.loadingFailed") this.onFailed(data.params || {});
  }

  onRequest(params) {
    if (this.entries.length >= this.maxEntries || this.byRequestId.has(params.requestId)) return;
    const resourceType = String(params.type || "");
    const url = allowedEndpointUrl(params.request?.url, this.urlPaths);
    if (!this.resourceTypes.has(resourceType) || !url) return;
    const entry = {
      sequence: ++this.sequence,
      url,
      resourceType,
      startedAt: new Date().toISOString(),
      completedAt: "",
      status: null,
      failed: false,
      content: "",
      bodyRead: false
    };
    this.entries.push(entry);
    this.byRequestId.set(String(params.requestId), entry);
  }

  onResponse(params) {
    const entry = this.byRequestId.get(String(params.requestId));
    if (!entry || entry.completedAt) return;
    const status = Number(params.response?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
  }

  onFinished(params) {
    const requestId = String(params.requestId);
    const entry = this.byRequestId.get(requestId);
    if (!entry || entry.completedAt) return;
    entry.completedAt = new Date().toISOString();
    if (!this.shouldReadBody(entry)) return;
    entry.bodyRead = true;
    this.bodyCount += 1;
    const task = this.command("Network.getResponseBody", { requestId })
      .then((result) => {
        entry.content = boundedResponseBody(result, this.maxBodyBytes);
      })
      .catch((error) => this.fail(error))
      .finally(() => this.bodyTasks.delete(task));
    this.bodyTasks.add(task);
  }

  onFailed(params) {
    const entry = this.byRequestId.get(String(params.requestId));
    if (!entry || entry.completedAt) return;
    entry.failed = true;
    entry.completedAt = new Date().toISOString();
  }

  shouldReadBody(entry) {
    if (!this.captureBodies || entry.failed || entry.bodyRead || this.bodyCount >= this.maxBodies) return false;
    return this.bodyPaths.has(new URL(entry.url).pathname);
  }

  async drainBodyTasks() {
    if (!this.bodyTasks.size) return;
    await Promise.all([...this.bodyTasks]);
  }

  assertActive() {
    if (this.fatalError) throw this.fatalError;
    if (!this.opened || !this.enabled || this.stopped || this.stopping) {
      throw networkLogError("BROWSER_COMMAND_FAILED", "CDP network observer is not active.");
    }
  }

  assertCommandAvailable() {
    if (this.fatalError) throw this.fatalError;
    if (!this.opened || !this.socket || this.stopped) {
      throw networkLogError("BROWSER_DISCONNECTED", "CDP network observer is disconnected.");
    }
  }

  fail(error) {
    if (this.fatalError || this.stopping || this.stopped) return;
    this.fatalError = error?.code ? error : networkLogError("BROWSER_COMMAND_FAILED", "CDP network observer failed.", error);
    this.opened = false;
    this.enabled = false;
    this.rejectPending(this.fatalError);
    tryClose(this.socket);
    this.entries = [];
    this.byRequestId.clear();
    this.onFatal?.(this.fatalError);
  }

  rejectPending(error) {
    for (const pending of this.pendingCommands.values()) pending.reject(error);
    this.pendingCommands.clear();
  }

  async closeAfterFailure(error) {
    this.fatalError = error;
    this.opened = false;
    this.enabled = false;
    this.stopped = true;
    this.rejectPending(error);
    tryClose(this.socket);
    this.socket = null;
  }
}

function allowedResourceTypes(values) {
  const source = Array.isArray(values) ? values : [...DEFAULT_RESOURCE_TYPES];
  return new Set(source.map(String).filter((value) => DEFAULT_RESOURCE_TYPES.has(value)));
}

function allowedPaths(values) {
  const paths = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const path = pathFromAllowlistValue(value);
    if (ALLOWED_BOSS_NETWORK_PATHS.has(path)) paths.add(path);
  }
  return paths;
}

function pathFromAllowlistValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text, "https://www.zhipin.com").pathname;
  } catch {
    return "";
  }
}

function allowedEndpointUrl(value, allowed) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:"
      || parsed.hostname !== "www.zhipin.com"
      || parsed.username
      || parsed.password
      || !allowed.has(parsed.pathname)) return "";
    return `https://www.zhipin.com${parsed.pathname}`;
  } catch {
    return "";
  }
}

function publicEntry(entry, includeBody) {
  return {
    sequence: entry.sequence,
    url: entry.url,
    resourceType: entry.resourceType,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    ...(Number.isInteger(entry.status) ? { status: entry.status } : {}),
    ...(entry.failed ? { failed: true } : {}),
    ...(includeBody && entry.bodyRead ? { content: entry.content } : {})
  };
}

function boundedResponseBody(result, maxBodyBytes) {
  const raw = result?.base64Encoded
    ? Buffer.from(String(result.body || ""), "base64")
    : Buffer.from(String(result?.body || ""), "utf8");
  if (raw.length <= maxBodyBytes) return raw.toString("utf8");
  let value = raw.subarray(0, maxBodyBytes).toString("utf8");
  while (Buffer.byteLength(value, "utf8") > maxBodyBytes) value = value.slice(0, -1);
  return value;
}

async function readMessageData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (data?.arrayBuffer) return Buffer.from(await data.arrayBuffer()).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function positiveInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function tryClose(socket) {
  try {
    socket?.close();
  } catch {
    // Ignore close races.
  }
}

function networkLogError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = { CdpNetworkLog };
