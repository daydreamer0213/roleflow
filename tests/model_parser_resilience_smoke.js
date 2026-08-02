const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { OpenAICompatibleAdapter } = require("../src/adapters/models/openai_compatible");
const { extractPdfTextInReadingOrder } = require("../src/core/pdf_text");

const root = path.resolve(__dirname, "..");

async function main() {
  await testModelTimeouts();
  await testModelRetryPolicy();
  await testResumeParserTimeouts();
  await testPdfExtractionLifecycle();
  await testPdfGetPageDeadline();
  await testPdfCumulativeDeadline();
  console.log("model_parser_resilience_smoke ok");
}

async function testModelTimeouts() {
  let calls = 0;
  await withFetch((url, { signal }) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }, async () => {
    const adapter = makeAdapter({ timeoutMs: 5, maxRetries: 0 });
    await assert.rejects(
      () => adapter.chatJson("return json", { test: true }),
      (error) => error.code === "MODEL_TIMEOUT" && error.retryable === true
    );
  });
  assert.strictEqual(calls, 1);

  await withFetch(async () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    throw error;
  }, async () => {
    await assert.rejects(
      () => makeAdapter({ maxRetries: 0 }).chatJson("return json", { test: true }),
      (error) => error.code === "MODEL_TIMEOUT"
    );
  });

  await withFetch(async () => new Response("request timeout", { status: 408 }), async () => {
    await assert.rejects(
      () => makeAdapter({ maxRetries: 0 }).chatJson("return json", { test: true }),
      (error) => error.code === "MODEL_TIMEOUT" && error.status === 408
    );
  });
}

async function testModelRetryPolicy() {
  const requestTimeoutMs = 60000;
  let calls = 0;
  const retryAfterDelays = await withImmediateRetryTimers(requestTimeoutMs, async () => {
    await withFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
      return modelResponse({ retried: true });
    }, async () => {
      const result = await makeAdapter({ timeoutMs: requestTimeoutMs, maxRetries: 1 }).chatJson("return json", { test: true });
      assert.deepStrictEqual(result, { retried: true });
    });
  });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(retryAfterDelays, [2000]);

  calls = 0;
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const backoffDelays = await withImmediateRetryTimers(requestTimeoutMs, async () => {
      await withFetch(async () => {
        calls += 1;
        return calls < 3 ? new Response("unavailable", { status: 503 }) : modelResponse({ recovered: true });
      }, async () => {
        const result = await makeAdapter({ timeoutMs: requestTimeoutMs, maxRetries: 2 }).chatJson("return json", { test: true });
        assert.deepStrictEqual(result, { recovered: true });
      });
    });
    assert.deepStrictEqual(backoffDelays, [375, 750]);
  } finally {
    Math.random = originalRandom;
  }
  assert.strictEqual(calls, 3);
  assert.strictEqual(makeAdapter({ maxRetries: 99 }).maxRetries, 3);

  calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }, async () => {
    await assert.rejects(
      () => makeAdapter({ maxRetries: 3 }).chatJson("return json", { test: true }),
      (error) => error.status === 400 && error.retryable === false
    );
  });
  assert.strictEqual(calls, 1);
}

async function testResumeParserTimeouts() {
  let docxOptions;
  const resumeParser = loadResumeParser({
    spawnSync: (command, args, options) => {
      docxOptions = options;
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
      };
    }
  });

  const runtimeParent = path.join(root, ".runtime");
  fs.mkdirSync(runtimeParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(runtimeParent, "model-parser-resilience-"));
  try {
    await assert.rejects(
      () => resumeParser.parseResumeUpload({ fileName: "resume.docx", buffer: Buffer.from("docx"), root: tempRoot }),
      (error) => error.code === "RESUME_DOCX_TIMEOUT"
        && error.statusCode === 408
        && error.message.includes("\u7c98\u8d34")
        && error.details?.diagnostics?.extractionMethod === "docx_powershell"
    );
    assert.strictEqual(docxOptions.timeout, 30000);

    const pasted = resumeParser.parseResumeText({
      text: "Candidate profile with education, experience, projects, and technical skills. ".repeat(2)
    });
    assert.strictEqual(pasted.diagnostics.extractionMethod, "pasted_text");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testPdfExtractionLifecycle() {
  let destroyed = 0;
  const loadDocument = async () => ({
    promise: new Promise(() => {}),
    destroy: async () => { destroyed += 1; }
  });

  await assert.rejects(
    () => extractPdfTextInReadingOrder(Buffer.from("pdf"), { loadDocument, timeoutMs: 5 }),
    (error) => error.code === "RESUME_PDF_TIMEOUT"
  );
  assert.strictEqual(destroyed, 1);

  const pageCalls = [];
  const cleanupCalls = [];
  destroyed = 0;
  const pages = [
    [{ str: "Page One", transform: [1, 0, 0, 12, 72, 700], height: 12, width: 50 }],
    [{ str: "Page Two", transform: [1, 0, 0, 12, 72, 700], height: 12, width: 50 }]
  ];
  const fakeDocument = {
    numPages: 2,
    async getPage(pageNumber) {
      pageCalls.push(pageNumber);
      return {
        getTextContent: async () => ({ items: pages[pageNumber - 1] }),
        cleanup() { cleanupCalls.push(pageNumber); }
      };
    }
  };
  const fakeLoadingTask = {
    promise: Promise.resolve(fakeDocument),
    async destroy() { destroyed += 1; }
  };

  const text = await extractPdfTextInReadingOrder(Buffer.from("pdf"), {
    loadDocument: async () => fakeLoadingTask
  });
  assert.strictEqual(text, "Page One\n\nPage Two");
  assert.deepStrictEqual(pageCalls, [1, 2]);
  assert.deepStrictEqual(cleanupCalls, [1, 2]);
  assert.strictEqual(destroyed, 1);
}

async function testPdfCumulativeDeadline() {
  let destroyed = 0;
  const cleanupCalls = [];
  const fakeDocument = {
    numPages: 2,
    async getPage(pageNumber) {
      return {
        async getTextContent() {
          await delay(100);
          return {
            items: [{ str: `Page ${pageNumber}`, transform: [1, 0, 0, 12, 72, 700], height: 12, width: 50 }]
          };
        },
        cleanup() { cleanupCalls.push(pageNumber); }
      };
    }
  };
  const fakeLoadingTask = {
    promise: Promise.resolve(fakeDocument),
    async destroy() { destroyed += 1; }
  };

  await assert.rejects(
    () => extractPdfTextInReadingOrder(Buffer.from("pdf"), {
      loadDocument: async () => fakeLoadingTask,
      timeoutMs: 150
    }),
    (error) => error.code === "RESUME_PDF_TIMEOUT"
  );
  assert.deepStrictEqual(cleanupCalls, [1, 2]);
  assert.strictEqual(destroyed, 1);
}

async function testPdfGetPageDeadline() {
  let destroyed = 0;
  const fakeLoadingTask = {
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => new Promise(() => {})
    }),
    async destroy() { destroyed += 1; }
  };

  await assert.rejects(
    () => withTestDeadline(
      extractPdfTextInReadingOrder(Buffer.from("pdf"), {
        loadDocument: async () => fakeLoadingTask,
        timeoutMs: 5
      }),
      75
    ),
    (error) => error.code === "RESUME_PDF_TIMEOUT"
  );
  assert.strictEqual(destroyed, 1);
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function withTestDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("getPage did not honor the PDF deadline")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeAdapter(overrides = {}) {
  return new OpenAICompatibleAdapter({
    baseUrl: "https://model.test/v1",
    apiKey: "test-key",
    model: "test-model",
    jsonMode: false,
    timeoutMs: 30000,
    maxRetries: 1,
    ...overrides
  });
}

function modelResponse(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function withFetch(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    global.fetch = originalFetch;
  }
}

async function withImmediateRetryTimers(requestTimeoutMs, run) {
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (callback, timeout, ...args) => {
    if (timeout === requestTimeoutMs) return originalSetTimeout(callback, timeout, ...args);
    delays.push(timeout);
    return originalSetTimeout(callback, 0, ...args);
  };
  try {
    await run();
    return delays;
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

function loadResumeParser({ spawnSync }) {
  const modulePath = require.resolve("../src/core/resume_parser");
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function load(request, parent, isMain) {
    if (request === "node:child_process") {
      return { ...originalLoad.call(this, request, parent, isMain), spawnSync };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
