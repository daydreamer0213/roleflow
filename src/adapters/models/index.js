const { MockModelAdapter } = require("./mock");
const { OpenAICompatibleAdapter } = require("./openai_compatible");

function createModelAdapter(modelConfig = {}) {
  const provider = modelConfig.provider || "mock";
  const providerConfig = modelConfig.providers?.[provider] || {};
  if (provider === "mock") return new MockModelAdapter(providerConfig);
  if (provider === "openai_compatible") return new OpenAICompatibleAdapter(providerConfig);
  throw new Error(`未知模型 provider：${provider}`);
}

module.exports = { createModelAdapter, MockModelAdapter, OpenAICompatibleAdapter };
