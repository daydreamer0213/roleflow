class FixtureElement {
  constructor({ classes = [], innerText = "", textContent, attributes = {}, children = {} } = {}) {
    this.classes = new Set(classes);
    this.innerText = innerText;
    this.textContent = textContent ?? innerText;
    this.attributes = attributes;
    this.children = children;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const className = part.trim().replace(/^\./, "");
      return this.classes.has(className);
    });
  }

  querySelector(selector) {
    return this.children[selector] || null;
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }
}

function createBossMessageDomFixture() {
  const rows = [
    new FixtureElement({
      classes: ["friend-content-warp"],
      innerText: "Alex Example\nPlease share availability",
      children: { ".notice-badge": new FixtureElement() },
      attributes: { "data-conversation-id": "conv-alex", "data-recruiter-id": "recruiter-alex" }
    }),
    new FixtureElement({
      classes: ["friend-content-warp", "selected"],
      innerText: "Blair Example\nThanks for the update",
      attributes: { "data-conversation-id": "conv-blair", "data-recruiter-id": "recruiter-blair" }
    }),
    new FixtureElement({
      classes: ["friend-content-warp"],
      innerText: "Casey Example\nInterview details attached",
      children: { ".notice-badge": new FixtureElement() },
      attributes: { "data-conversation-id": "conv-casey", "data-recruiter-id": "recruiter-casey" }
    })
  ];
  const messages = [
    new FixtureElement({ classes: ["message-item", "item-friend"], textContent: "Fake incoming text", attributes: { "data-mid": "123456789012345" } }),
    new FixtureElement({ classes: ["message-item", "item-myself", "item-voice"], textContent: "Fake outgoing voice", attributes: { "data-mid": "123456789012346" } }),
    new FixtureElement({ classes: ["message-item"], textContent: "Fake system text", attributes: { "data-mid": "123456789012347" } })
  ];
  const single = {
    ".top-info-content": new FixtureElement({ innerText: "Alex Example\nOnline" }),
    ".chat-position-content .position-name": new FixtureElement({ textContent: "Fake Role" }),
    ".company-name": new FixtureElement({ textContent: "Fixture Company" }),
    ".salary": new FixtureElement({ textContent: "15K-20K" }),
    ".city": new FixtureElement({ textContent: "Example City" }),
    ".chat-input": new FixtureElement(),
    ".btn-send": new FixtureElement()
  };
  return {
    title: "",
    body: { innerText: "" },
    querySelectorAll(selector) {
      if (selector === ".friend-content-warp") return rows;
      if (selector === ".message-item") return messages;
      if (selector === ".sign-form, .login-register, [class*='login-form']") return [];
      return [];
    },
    querySelector(selector) {
      return single[selector] || null;
    }
  };
}

module.exports = { createBossMessageDomFixture };
