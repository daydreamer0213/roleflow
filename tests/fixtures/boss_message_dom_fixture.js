class FixtureElement {
  constructor({ classes = [], innerText = "", textContent, attributes = {}, children = {}, tagName = "div", source = null } = {}) {
    this.tagName = tagName;
    this.classes = new Set(classes);
    this.innerText = innerText;
    this.textContent = textContent ?? innerText;
    this.attributes = attributes;
    this.children = children;
    if (source) this.__vue__ = { source };
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

  querySelectorAll(selector) {
    const value = this.children[selector];
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
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
      children: {
        ".notice-badge": new FixtureElement(),
        ".title-box": new FixtureElement({ textContent: "Alex Example" }),
        ".last-msg-text": new FixtureElement({ textContent: "Please share availability" })
      },
      attributes: { "data-conversation-id": "conv-alex", "data-recruiter-id": "recruiter-alex" },
      source: {
        uniqueId: "conversation-a",
        encryptJobId: "encrypt-job-a",
        lastMsgId: "378917037748737",
        lastIsSelf: false,
        lastMsgStatus: 0
      }
    }),
    new FixtureElement({
      classes: ["friend-content-warp", "selected"],
      innerText: "Blair Example\nThanks for the update",
      children: {
        ".title-box": new FixtureElement({ textContent: "Blair Example" }),
        ".last-msg-text": new FixtureElement({ textContent: "Thanks for the update" }),
        ".status-delivery": new FixtureElement({ classes: ["status-delivery"] })
      },
      attributes: { "data-conversation-id": "conv-blair", "data-recruiter-id": "recruiter-blair" },
      source: {
        uniqueId: "conversation-b",
        encryptJobId: "encrypt-job-b",
        lastMsgId: "378917037748738",
        lastIsSelf: true,
        lastMsgStatus: 1
      }
    }),
    new FixtureElement({
      classes: ["friend-content-warp"],
      innerText: "Casey Example\nInterview details attached",
      children: {
        ".title-box": new FixtureElement({ textContent: "Casey Example" }),
        ".last-msg-text": new FixtureElement({ textContent: "Interview details attached" }),
        ".status-read": new FixtureElement({ classes: ["status-read"] })
      },
      attributes: { "data-conversation-id": "conv-casey", "data-recruiter-id": "recruiter-casey" },
      source: {
        uniqueId: "conversation-c",
        encryptJobId: "encrypt-job-c",
        lastMsgId: "378917037748739",
        lastIsSelf: true,
        lastMsgStatus: 2
      }
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
    ".base-info": new FixtureElement({
      tagName: "div",
      children: [
        new FixtureElement({ tagName: "span", textContent: "Fixture Company" }),
        new FixtureElement({ tagName: "span", classes: ["base-title"], textContent: "\u62db\u8058\u8005" })
      ]
    }),
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

function createStructuredBossMessageDomFixture({ resumeIcon = true, plainText = "请问你的英语和粤语水平如何？" } = {}) {
  const documentLike = createBossMessageDomFixture();
  const platformButton = new FixtureElement({
    classes: ["card-btn", "one-btn"],
    textContent: "查看详细分析"
  });
  const platformCard = new FixtureElement({
    classes: ["message-card-wrap", "blue"],
    textContent: "你与该职位竞争者PK情况 查看详细分析",
    children: {
      ".message-card-top-title": new FixtureElement({ textContent: "你与该职位竞争者PK情况" }),
      ".card-btn": [platformButton],
      ".card-btn.one-btn": platformButton
    }
  });
  const resumeButtons = new FixtureElement({
    classes: ["message-card-buttons"],
    children: {
      ".card-btn": [
        new FixtureElement({ classes: ["card-btn"], textContent: "拒绝" }),
        new FixtureElement({ classes: ["card-btn"], textContent: "同意" })
      ]
    }
  });
  const resumeChildren = {
    ".message-card-top-title.message-card-top-text": new FixtureElement({
      classes: ["message-card-top-title", "message-card-top-text"],
      textContent: "我想要一份您的附件简历，您是否同意"
    }),
    ".message-card-buttons": resumeButtons
  };
  if (resumeIcon) {
    resumeChildren[".dialog-icon.resume"] = new FixtureElement({ classes: ["dialog-icon", "resume"] });
  }
  const resumeCard = new FixtureElement({
    classes: ["message-dialog-both", "message-card-wrap", "boss-green"],
    textContent: "我想要一份您的附件简历，您是否同意 拒绝 同意",
    children: resumeChildren
  });
  const messages = [
    new FixtureElement({
      classes: ["message-item", "item-friend"],
      textContent: "你与该职位竞争者PK情况 查看详细分析",
      attributes: { "data-mid": "123456789012350" },
      children: { ".message-card-wrap": platformCard }
    }),
    new FixtureElement({
      classes: ["message-item", "item-friend"],
      textContent: plainText,
      attributes: { "data-mid": "123456789012351" }
    }),
    new FixtureElement({
      classes: ["message-item", "item-friend"],
      textContent: "我想要一份您的附件简历，您是否同意 拒绝 同意",
      attributes: { "data-mid": "123456789012352" },
      children: { ".message-card-wrap": resumeCard }
    })
  ];
  const originalQuerySelectorAll = documentLike.querySelectorAll.bind(documentLike);
  documentLike.querySelectorAll = (selector) => selector === ".message-item"
    ? messages
    : originalQuerySelectorAll(selector);
  return documentLike;
}

module.exports = { createBossMessageDomFixture, createStructuredBossMessageDomFixture, FixtureElement };
