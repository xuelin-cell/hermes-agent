// apps/desktop/electron/login/cloud-drive-worker.ts
import { once } from "node:events";
import path2 from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// apps/desktop/electron/uniwork-welcome/catalog.ts
function text(value, limit = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}
function order(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
function normalizeWelcomeCatalog(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.modules)) {
    throw new Error("\u529E\u516C\u6A21\u677F\u76EE\u5F55\u683C\u5F0F\u65E0\u6548\u3002");
  }
  return value.modules.slice(0, 100).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const item = raw;
    if (!text(item.name)) {
      return [];
    }
    return [
      {
        id: `configured-module-${index}`,
        name: item.name,
        workspace: item.workspace === "codex" ? "codex" : "work",
        ...text(item.icon, 128) ? { icon: item.icon.trim() } : {},
        sort: order(item.sort),
        tags: normalizeWelcomeCategories(item.tags)
      }
    ];
  }).sort((a, b) => a.sort - b.sort);
}
function normalizeWelcomeCategories(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const categories = [];
  for (const row of value.slice(0, 100)) {
    if (!row || !text(row.id) || !text(row.name) || seen.has(row.id) || !Array.isArray(row.templates)) {
      continue;
    }
    const ids2 = /* @__PURE__ */ new Set();
    const templates = [];
    for (const item of row.templates.slice(0, 100)) {
      if (!item || !text(item.id) || !text(item.name) || !text(item.prompt, 32768) || ids2.has(item.id)) {
        continue;
      }
      ids2.add(item.id);
      templates.push({
        id: item.id,
        name: item.name,
        prompt: item.prompt,
        sort: order(item.sort),
        ...text(item.icon, 128) ? { icon: item.icon.trim() } : {}
      });
    }
    if (!templates.length) {
      continue;
    }
    seen.add(row.id);
    categories.push({
      id: row.id,
      name: row.name,
      sort: order(row.sort),
      ...text(row.icon, 128) ? { icon: row.icon.trim() } : {},
      templates: templates.sort((a, b) => a.sort - b.sort)
    });
  }
  return categories.sort((a, b) => a.sort - b.sort);
}

// apps/desktop/electron/uniwork-welcome/client.ts
var WelcomeCatalogClient = class {
  /** 网络可注入以验证真实 HTTP 路径，业务调用始终使用 Electron 的网络会话。 */
  constructor(request, identity) {
    this.request = request;
    this.identity = identity;
  }
  request;
  identity;
  /** 解析失败保留页面已缓存的完整目录。 */
  async load(locale) {
    if (!["zh-CN", "en"].includes(locale)) {
      throw new Error("\u529E\u516C\u6A21\u677F\u8BED\u8A00\u65E0\u6548\u3002");
    }
    const key = `welcome_config_v3_${locale}`;
    const identity = this.identity?.();
    const token = identity && identity.expiresAt > Date.now() ? identity.token : null;
    try {
      if (!token) {
        throw new Error("\u6807\u7B7E\u914D\u7F6E\u9700\u8981\u5F53\u524D\u767B\u5F55\u8EAB\u4EFD");
      }
      const response = await this.request(`https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config?key=${key}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8e3),
        redirect: "error",
        credentials: "omit",
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error();
      }
      const envelope = await response.json();
      if (typeof envelope?.configValue !== "string" || envelope.configValue.length > 2e6) {
        throw new Error();
      }
      const payload = JSON.parse(envelope.configValue);
      const current = this.identity?.();
      if (!normalizeWelcomeCatalog(payload).length || current?.token !== token || current.expiresAt <= Date.now()) {
        throw new Error();
      }
      return {
        modules: payload.modules,
        ...typeof envelope.version === "string" && envelope.version.trim() ? { version: envelope.version.trim() } : {}
      };
    } catch {
      throw new Error("\u529E\u516C\u6A21\u677F\u66F4\u65B0\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u672C\u5730\u6A21\u677F\u3002");
    }
  }
};

// apps/desktop/electron/login/uniagentgate.ts
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseUniAgentGate(value) {
  if (!record(value)) {
    return { status: "missing" };
  }
  const legacy = Object.hasOwn(value, "uniagentgate");
  const fields = ["ipUrl", "agentIdPersonal", "agentKeyPersonal"];
  if (!legacy && !fields.some((name2) => Object.hasOwn(value, name2))) {
    return { status: "missing" };
  }
  const raw = legacy ? value.uniagentgate : {
    gateway_url: value.ipUrl,
    agent_id: value.agentIdPersonal,
    agent_sk: value.agentKeyPersonal
  };
  if (raw === null) {
    return { status: "clear" };
  }
  if (!record(raw) || ["gateway_url", "agent_id", "agent_sk"].some(
    (name2) => typeof raw[name2] !== "string" || !raw[name2].trim() || /[^\x20-\x7e]/.test(raw[name2])
  )) {
    return { status: "invalid" };
  }
  try {
    const url = new URL(raw.gateway_url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || raw.agent_sk.includes("${")) {
      return { status: "invalid" };
    }
    return {
      status: "available",
      binding: {
        gatewayUrl: url.href.replace(/\/+$/, ""),
        agentId: raw.agent_id.trim(),
        agentSk: raw.agent_sk.trim()
      }
    };
  } catch {
    return { status: "invalid" };
  }
}

// apps/desktop/electron/uniwork-usage/contract.ts
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function amount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function normalizePlanUsage(body, fetchedAt) {
  const envelope = record2(body);
  if (!Object.keys(envelope).length || envelope.code !== void 0 && envelope.code !== 0 && envelope.code !== "0")
    throw new Error("Invalid plan response");
  const data = record2(envelope.data === void 0 ? body : envelope.data);
  if (!Object.keys(data).length) throw new Error("Missing plan response");
  const kind = data.planType === "coding_plan" || data.planType === "token_plan" ? data.planType : "unknown";
  const coding = record2(data.codingPlanUsage), token = record2(data.tokenPlanUsage);
  const windows = [];
  const names = [
    ["five-hour", "second", "secondTtl"],
    ["week", "week", "weekTtl"],
    ["month", "month", "monthTtl"]
  ];
  if (kind === "coding_plan")
    for (const [name2, key, ttlKey] of names) {
      const used2 = amount(coding[key]), ttl = typeof coding[ttlKey] === "number" && Number.isFinite(coding[ttlKey]) ? Math.max(0, coding[ttlKey]) : null;
      if (used2 !== null)
        windows.push({
          name: name2,
          usedPercent: Math.min(100, used2),
          resetAt: ttl !== null && ttl > 0 ? Math.min(864e13, fetchedAt + ttl * 1e3) : null,
          notStarted: ttl === 0
        });
    }
  const total = amount(token.totalQuota), used = amount(token.usedQuota), limit = amount(token.concurrencyLimit);
  return {
    kind,
    productName: typeof data.productName === "string" ? data.productName.slice(0, 120) : "",
    endTime: typeof data.endTime === "string" ? data.endTime.slice(0, 64) : null,
    expired: data.status === "invalid",
    fetchedAt,
    windows,
    quota: kind === "token_plan" && total !== null && total > 0 && used !== null ? {
      total,
      used,
      remaining: Math.max(0, total - used),
      usedPercent: Math.min(100, used / total * 100),
      unit: typeof token.quotaUnit === "string" ? token.quotaUnit : null
    } : null,
    concurrency: kind === "token_plan" && limit !== null && limit > 0 ? { current: amount(token.currentConcurrency), limit } : null
  };
}

// apps/desktop/electron/uniwork-usage/client.ts
var PlanUsageClient = class {
  /** 注入身份与网络，生产走 Electron 会话，测试可验证实际 HTTP。 */
  constructor(identity, request, applyBinding) {
    this.identity = identity;
    this.request = request;
    this.applyBinding = applyBinding;
  }
  identity;
  request;
  applyBinding;
  key = "";
  pending = null;
  cached = null;
  cachedUntil = 0;
  /** 账号变化或过期立即清除缓存，成功结果只在内存复用三十秒；手动刷新可绕过缓存。 */
  async load(force = false) {
    const identity = this.identity();
    const key = identity && identity.expiresAt > Date.now() ? `${identity.uid}\0${identity.token}` : "";
    if (key !== this.key) {
      this.key = key;
      this.pending = null;
      this.cached = null;
      this.cachedUntil = 0;
    }
    if (!identity || !key) {
      return { status: "failed", reason: "auth" };
    }
    if (!force && this.cached && Date.now() < this.cachedUntil) {
      return this.cached;
    }
    if (this.pending) {
      return this.pending;
    }
    const pending = this.fetch(identity).then((result) => {
      if (this.key === key && this.identity()?.token === identity.token && identity.expiresAt > Date.now() && result.status === "available") {
        this.cached = result;
        this.cachedUntil = Date.now() + 3e4;
      }
      return result;
    }).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
      }
    });
    this.pending = pending;
    return pending;
  }
  /** 固定上游并拒绝重定向，迟到响应不能跨账号，错误不透出服务端原文。 */
  async fetch(identity) {
    try {
      const response = await this.request("https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan", {
        headers: { Accept: "application/json", Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15e3),
        redirect: "error",
        credentials: "omit",
        cache: "no-store"
      });
      if (response.status === 401 || response.status === 403) {
        return { status: "failed", reason: "auth" };
      }
      if (!response.ok) {
        return { status: "failed" };
      }
      const body = await response.json();
      const data = normalizePlanUsage(body, Date.now());
      const current = this.identity();
      if (!current || current.uid !== identity.uid || current.token !== identity.token || current.expiresAt <= Date.now()) {
        return { status: "failed", reason: "auth" };
      }
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const envelope = body;
        const update = parseUniAgentGate(envelope.data === void 0 ? body : envelope.data);
        if (update.status === "available" || update.status === "clear") {
          try {
            await this.applyBinding?.(update);
          } catch {
            console.warn("[desktop-mt] 5G \u7ED1\u5B9A\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8D26\u53F7\u914D\u7F6E\uFF1B\u5957\u9910\u7528\u91CF\u4ECD\u53EF\u67E5\u770B\u3002");
          }
        }
      }
      if (this.identity()?.token !== identity.token || identity.expiresAt <= Date.now()) {
        return { status: "failed", reason: "auth" };
      }
      return {
        status: "available",
        data,
        account: { maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt }
      };
    } catch {
      return { status: "failed" };
    }
  }
};

// apps/desktop/electron/uniwork-usage/subscription.ts
var MARKET_TICKET_URL = "https://maas.ai-yuanjing.com/app/gateway/uniwork/market-ticket";
var SUBSCRIPTION_MARKET_URL = "https://market.ai-yuanjing.com/#/active";
var PAYMENT_CALLBACK_URL = "https://maas.ai-yuanjing.com/app/gateway/op/payment/callback";
function buildSubscriptionMarketUrl(phone, ticket) {
  return SUBSCRIPTION_MARKET_URL + `?u=${Buffer.from(phone, "utf8").toString("base64")}&callback_url=${Buffer.from(PAYMENT_CALLBACK_URL, "utf8").toString("base64")}&single=1&ticket=${encodeURIComponent(ticket.ticket)}&customerid=${encodeURIComponent(ticket.customerId)}&timestamp=${encodeURIComponent(ticket.timestamp)}&number=${encodeURIComponent(ticket.number)}`;
}
function parseMarketTicket(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const data = body;
  const value = (key) => {
    const field = data[key];
    return typeof field === "string" && field.trim() && field.length <= 4096 ? field : null;
  };
  const ticket = value("ticket");
  const customerId = value("customerId");
  const timestamp = value("timestamp");
  const number = value("number");
  return ticket && customerId && timestamp && number ? { ticket, customerId, timestamp, number } : null;
}
var PlanSubscriptionClient = class {
  constructor(identity, openExternal, request) {
    this.identity = identity;
    this.openExternal = openExternal;
    this.request = request;
  }
  identity;
  openExternal;
  request;
  async open() {
    const identity = this.identity();
    if (!identity || identity.expiresAt <= Date.now()) {
      return { status: "failed", reason: "auth" };
    }
    const phone = identity.phone?.trim() ?? "";
    if (!/^1\d{10}$/.test(phone)) {
      return { status: "failed", reason: "missing-phone" };
    }
    try {
      const response = await this.request(MARKET_TICKET_URL, {
        headers: { Accept: "application/json", Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15e3),
        redirect: "error",
        credentials: "omit",
        cache: "no-store"
      });
      if (response.status === 401 || response.status === 403) {
        return { status: "failed", reason: "auth" };
      }
      if (!response.ok) {
        return { status: "failed", reason: "upstream" };
      }
      const ticket = parseMarketTicket(await response.json());
      if (!ticket) {
        return { status: "failed", reason: "upstream" };
      }
      const current = this.identity();
      if (!current || current.uid !== identity.uid || current.token !== identity.token || current.expiresAt <= Date.now()) {
        return { status: "failed", reason: "auth" };
      }
      await this.openExternal(buildSubscriptionMarketUrl(phone, ticket));
      return { status: "opened" };
    } catch {
      return { status: "failed", reason: "upstream" };
    }
  }
};

// apps/desktop/electron/login/cloud-drive-credentials.ts
import { createHash } from "node:crypto";
var CloudDriveCredentials = class {
  /** 网络和密文存储由主进程注入，测试使用临时目录和可控时间。 */
  constructor(identity, acquire, options = {}) {
    this.identity = identity;
    this.acquire = acquire;
    this.options = options;
    this.now = options.now ?? Date.now;
  }
  identity;
  acquire;
  options;
  context = null;
  now;
  /** 登录变更即换归属，旧请求无法向新账号发布令牌或写入缓存。 */
  current() {
    const identity = this.identity();
    if (!identity || identity.expiresAt <= this.now()) {
      throw new Error("\u767B\u5F55\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const owner2 = createHash("sha256").update(JSON.stringify([identity.uid, identity.token, identity.phone])).digest("hex");
    if (this.context?.owner !== owner2) {
      this.context = { owner: owner2, identity, record: this.options.store?.load(owner2) ?? null, pending: null };
    }
    return this.context;
  }
  /** 等待网络后再次校验上下文，不因切回同一账号而认领旧请求。 */
  check(context) {
    if (this.current() !== context) {
      throw new Error("\u767B\u5F55\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u8D44\u6599\u5E93");
    }
  }
  /** 同一归属合并续期，七天有效期与原数字员工一致，成功后先安全保存再发布。 */
  async renew(context) {
    this.check(context);
    if (context.pending) {
      return context.pending;
    }
    const requestedAt = this.now();
    const pending = (async () => {
      const token = await this.acquire(context.identity);
      this.check(context);
      const record4 = { token, expiresAt: requestedAt + 7 * 24 * 60 * 60 * 1e3 };
      this.options.store?.save(context.owner, record4);
      context.record = record4;
      return token;
    })();
    context.pending = pending;
    try {
      return await pending;
    } finally {
      if (context.pending === pending) {
        context.pending = null;
      }
    }
  }
  /** 每次使用前检查到期；有效密文可跨重启复用，过期只合并一次获取。 */
  async get() {
    const context = this.current();
    if (context.pending) {
      return context.pending;
    }
    if (!context.record && context.lastRecoveryAt !== void 0 && this.now() - context.lastRecoveryAt < 6e4) {
      throw new Error("\u4E2A\u4EBA\u4E91\u76D8\u4EE4\u724C\u6682\u65F6\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    return context.record && context.record.expiresAt > this.now() ? context.record.token : this.renew(context);
  }
  /** 明确过期才恢复；迟到的旧拒绝复用新令牌，失败后的强制续期一分钟内不再发起。 */
  async recover(rejectedToken) {
    const context = this.current();
    if (context.pending) {
      return context.pending;
    }
    if (context.record && context.record.token !== rejectedToken && context.record.expiresAt > this.now()) {
      return context.record.token;
    }
    if (context.lastRecoveryAt !== void 0 && this.now() - context.lastRecoveryAt < 6e4) {
      throw new Error("\u4E2A\u4EBA\u4E91\u76D8\u4EE4\u724C\u6682\u65F6\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    context.lastRecoveryAt = this.now();
    context.record = null;
    return this.renew(context);
  }
  /** 定时与唤醒只检查已经启用的云盘，不为从未打开过云盘的账号获取令牌。 */
  async renewActive() {
    const identity = this.identity();
    if (this.context && identity && identity.uid === this.context.identity.uid && identity.token === this.context.identity.token && identity.phone === this.context.identity.phone) {
      await this.get();
    }
  }
  /** 退出成功后失效所有在途获取，再移除本账号的云盘密文。 */
  clear() {
    this.context = null;
    this.options.store?.clear();
  }
};

// apps/desktop/electron/login/cloud-drive-verification.ts
import { setTimeout as delay } from "node:timers/promises";
async function* readDriveFolderPages(read, parent2, signal) {
  const found = /* @__PURE__ */ new Set();
  for (let page2 = 1; page2 <= 100; page2++) {
    signal.throwIfAborted();
    const params = new URLSearchParams({
      space_id: "personal",
      parent_asset_id: parent2,
      page_no: String(page2),
      page_size: "100",
      sort: "name_asc"
    });
    const value = await read({ route: `/assets?${params}` }, signal);
    signal.throwIfAborted();
    if (!Array.isArray(value?.items)) {
      throw new Error("Incomplete directory");
    }
    if (!value.items.length) {
      if (value.page?.has_more === true) {
        throw new Error("Inconsistent directory page");
      }
      return;
    }
    const previous = found.size;
    for (const item of value.items) {
      if (!item || typeof item.asset_id !== "string" || !item.asset_id || typeof item.name !== "string" || !["file", "directory"].includes(item.kind) || item.parent_asset_id !== parent2) {
        throw new Error("Invalid directory item");
      }
      found.add(item.asset_id);
    }
    if (previous === found.size) {
      throw new Error("Repeated directory page");
    }
    yield value.items;
  }
  throw new Error("Incomplete directory");
}
async function readDriveFolder(read, parent2, signal) {
  const found = /* @__PURE__ */ new Map();
  for await (const rows of readDriveFolderPages(read, parent2, signal)) {
    rows.forEach((row) => found.set(row.asset_id, row));
  }
  return [...found.values()];
}
async function readRecycle(read, signal) {
  const found = /* @__PURE__ */ new Map();
  for (let page2 = 1; page2 <= 100; page2++) {
    signal.throwIfAborted();
    const rows = await read(
      { route: "/unicom/QueryRecycleData", method: "POST", body: { pageNo: page2, pageSize: 50, sortRule: "0" } },
      signal
    );
    signal.throwIfAborted();
    if (!Array.isArray(rows)) {
      throw new Error("Invalid recycle response");
    }
    const previous = found.size;
    for (const row of rows) {
      if (!row || typeof row.deleteNo !== "string" || !row.deleteNo) {
        throw new Error("Invalid recycle item");
      }
      found.set(row.deleteNo, row);
    }
    if (!rows.length) {
      return [...found.values()];
    }
    if (previous === found.size) {
      throw new Error("Repeated recycle page");
    }
  }
  throw new Error("Incomplete recycle bin");
}
function fileFid(value) {
  return typeof value === "string" && value.trim() && value !== "0" ? value : void 0;
}
async function assetFid(read, asset, signal) {
  const known = fileFid(asset.fid);
  if (known) {
    return known;
  }
  const details = await read(
    { route: "/unicom/FileDetails", method: "POST", body: { fileId: asset.asset_id } },
    signal
  );
  const fid = fileFid(details?.fid);
  if (!fid) {
    throw new Error("Missing file fid");
  }
  return fid;
}
async function* walkAssets(read, signal) {
  const pending = ["0"];
  const visited = /* @__PURE__ */ new Set();
  while (pending.length) {
    const parent2 = pending.shift();
    if (visited.has(parent2)) {
      continue;
    }
    if (visited.size >= 1e3) {
      throw new Error("Incomplete directory tree");
    }
    visited.add(parent2);
    for await (const rows of readDriveFolderPages(read, parent2, signal)) {
      yield rows;
      pending.push(...rows.filter((row) => row.kind === "directory").map((row) => row.asset_id));
    }
  }
}
async function findAssets(read, ids2, signal) {
  const matches = /* @__PURE__ */ new Map();
  for await (const rows of walkAssets(read, signal)) {
    rows.filter((row) => ids2.has(row.asset_id)).forEach((row) => matches.set(row.asset_id, row));
    if (matches.size === ids2.size) {
      return [...matches.values()];
    }
  }
  return [...matches.values()];
}
async function confirmDriveState(query, signal, check) {
  let absent = 0;
  for (const wait of [0, 5e3, 1e4]) {
    await delay(wait, void 0, { signal });
    check();
    try {
      const verdict = await query();
      check();
      if (verdict === "confirmed") {
        return verdict;
      }
      absent += Number(verdict === "absent");
    } catch {
      check();
      signal.throwIfAborted();
    }
  }
  return absent === 3 ? "absent" : "inconclusive";
}
async function snapshotUpload(read, parent2, name2, size, signal) {
  const rows = await readDriveFolder(read, parent2, signal);
  return { parent: parent2, name: name2, size, ids: new Set(rows.map((row) => row.asset_id)) };
}
async function verifyUpload(read, before, signal) {
  const rows = await readDriveFolder(read, before.parent, signal);
  const candidates = rows.filter(
    (row) => row.kind === "file" && row.name === before.name && !before.ids.has(row.asset_id)
  );
  if (candidates.some((row) => !Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) < 0)) {
    return "inconclusive";
  }
  const matches = candidates.filter((row) => row.size_bytes === before.size);
  return matches.length === 1 ? "confirmed" : matches.length === 0 ? "absent" : "inconclusive";
}
function hasAsset(rows, id2, kind) {
  return rows.some((row) => row.asset_id === id2 && row.kind === kind);
}
function mutationVerdict(confirmed) {
  return confirmed ? "confirmed" : "inconclusive";
}
async function prepareFolder({ read, input, signal }) {
  const body = input.body ?? {};
  const parent2 = String(body.parent_asset_id ?? "0");
  const before = new Set((await readDriveFolder(read, parent2, signal)).map((row) => row.asset_id));
  const query = async (scope) => {
    const matches = (await readDriveFolder(read, parent2, scope)).filter(
      (row) => row.kind === "directory" && row.name === body.name && !before.has(row.asset_id)
    );
    if (matches.length === 1) {
      query.result = { asset_id: matches[0].asset_id };
    }
    return mutationVerdict(matches.length === 1);
  };
  return query;
}
async function prepareRename({ read, input, signal }) {
  const body = input.body ?? {};
  const id2 = decodeURIComponent(input.route.split("?")[0].slice("/assets/".length));
  const before = await findAssets(read, /* @__PURE__ */ new Set([id2]), signal);
  const source = before.find((row) => row.asset_id === id2 && row.kind === body.kind);
  if (!source || source.name === body.new_name) {
    throw new Error("Missing rename baseline");
  }
  return async (scope) => {
    for await (const rows of readDriveFolderPages(read, source.parent_asset_id, scope)) {
      if (rows.some((row) => row.asset_id === id2 && row.kind === source.kind && row.name === body.new_name)) {
        return "confirmed";
      }
    }
    return "inconclusive";
  };
}
async function mutationTargets({ read, input, signal }) {
  const body = input.body ?? {};
  const targets = [
    ...Array.isArray(body.file_ids) ? body.file_ids.map((id2) => ({ id: String(id2), kind: "file" })) : [],
    ...Array.isArray(body.directory_ids) ? body.directory_ids.map((id2) => ({ id: String(id2), kind: "directory" })) : []
  ];
  const before = await findAssets(read, new Set(targets.map((item) => item.id)), signal);
  if (!targets.length || !targets.every((item) => hasAsset(before, item.id, item.kind))) {
    throw new Error("Missing mutation baseline");
  }
  return { targets, before };
}
async function prepareMove(context) {
  const { read, input } = context;
  const { targets, before } = await mutationTargets(context);
  const destination = String(input.body?.target_parent_asset_id);
  if (before.some((row) => row.parent_asset_id === destination)) {
    throw new Error("Already in destination");
  }
  return async (scope) => {
    const matched = /* @__PURE__ */ new Set();
    for await (const rows of readDriveFolderPages(read, destination, scope)) {
      targets.filter((item) => hasAsset(rows, item.id, item.kind)).forEach((item) => matched.add(item.id));
      if (targets.every((item) => matched.has(item.id))) {
        return "confirmed";
      }
    }
    return "inconclusive";
  };
}
async function prepareTrash(context) {
  const { read, input, signal } = context;
  if (Array.isArray(input.body?.directory_ids) && input.body.directory_ids.length) {
    throw new Error("Directory recycle identity unavailable");
  }
  const { before } = await mutationTargets(context);
  const files = await Promise.all(
    before.map(async (source) => ({ id: source.asset_id, fid: await assetFid(read, source, signal) }))
  );
  if (new Set(files.map((file) => file.fid)).size !== files.length) {
    throw new Error("Ambiguous file identity");
  }
  const previous = new Set((await readRecycle(read, signal)).map((row) => String(row.deleteNo)));
  return async (scope) => {
    const recycled = (await readRecycle(read, scope)).filter(
      (row) => !previous.has(String(row.deleteNo)) && String(row.type) === "1"
    );
    if (!files.every((file) => recycled.filter((row) => fileFid(row.fid) === file.fid).length === 1)) {
      return "inconclusive";
    }
    const remaining = await findAssets(read, new Set(files.map((file) => file.id)), scope);
    return mutationVerdict(remaining.length === 0);
  };
}
async function prepareFileRestore(read, originals, signal) {
  const fids = originals.map((row) => String(row.type) === "1" ? fileFid(row.fid) : void 0);
  if (fids.some((fid) => !fid) || new Set(fids).size !== fids.length) {
    throw new Error("Missing or ambiguous file identity");
  }
  const wanted = new Set(fids);
  const previous = /* @__PURE__ */ new Set();
  for await (const rows of walkAssets(read, signal)) {
    for (const row of rows) {
      previous.add(row.asset_id);
    }
  }
  const deleteNos = new Set(originals.map((row) => String(row.deleteNo)));
  return async (scope) => {
    if ((await readRecycle(read, scope)).some((row) => deleteNos.has(String(row.deleteNo)))) {
      return "inconclusive";
    }
    const matches = [];
    for await (const rows of walkAssets(read, scope)) {
      for (const row of rows) {
        if (row.kind !== "file" || previous.has(row.asset_id)) {
          continue;
        }
        const fid = await assetFid(read, row, scope);
        if (wanted.has(fid)) {
          matches.push(fid);
        }
      }
    }
    return mutationVerdict(fids.every((fid) => matches.filter((value) => value === fid).length === 1));
  };
}
async function prepareRecycle({ read, input, signal }) {
  const route = input.route.split("?")[0];
  const body = input.body ?? {};
  const targets = new Set(Array.isArray(body.deleteNos) ? body.deleteNos.map(String) : []);
  const before = await readRecycle(read, signal);
  if (route === "/unicom/EmptyRecycleData") {
    return async (scope) => mutationVerdict((await readRecycle(read, scope)).length === 0);
  }
  const originals = before.filter((row) => targets.has(String(row.deleteNo)));
  if (!targets.size || originals.length !== targets.size) {
    throw new Error("Missing recycle baseline");
  }
  if (route === "/unicom/DeleteRecycleData") {
    return async (scope) => mutationVerdict(!(await readRecycle(read, scope)).some((row) => targets.has(String(row.deleteNo))));
  }
  return prepareFileRestore(read, originals, signal);
}
var MUTATION_VERIFIERS = {
  "POST:/folders": prepareFolder,
  "PATCH:/assets/:id": prepareRename,
  "POST:/assets/move": prepareMove,
  "POST:/assets/trash": prepareTrash,
  "POST:/unicom/ReductionRecycleData": prepareRecycle,
  "POST:/unicom/DeleteRecycleData": prepareRecycle,
  "POST:/unicom/EmptyRecycleData": prepareRecycle
};
async function prepareMutationVerification(read, input, signal) {
  const route = input.method === "PATCH" ? "/assets/:id" : input.route.split("?")[0];
  const prepare = MUTATION_VERIFIERS[`${input.method}:${route}`];
  if (!prepare) {
    throw new Error("Unsupported mutation");
  }
  return prepare({ read, input, signal });
}

// apps/desktop/electron/login/contract.ts
function isCloudDriveReadOperation(input) {
  return (input.method ?? "GET") === "GET" || input.method === "POST" && ["/assets/download", "/assets/search", "/unicom/FileDetails", "/unicom/QueryRecycleData"].includes(
    input.route.split("?")[0]
  ) || input.method === "DELETE" && /^\/assets\/search\/[a-f0-9]{32}$/.test(input.route);
}

// apps/desktop/electron/login/cloud-drive.ts
var BASE = "https://maas.ai-yuanjing.com/app/uniwork/general_uniclaw/clouddrive/v1";
var AUTH = "https://www.yjworker.10010.com/app/gateway/uniwork-yunpan/access-token";
var CloudDriveOperationError = class extends Error {
  result;
  /** 将部分成功或未知结果保留为可由页面区分的安全数据。 */
  constructor(status, code) {
    super("\u4E91\u76D8\u64CD\u4F5C\u672A\u5B8C\u6210");
    this.result = { protocol: "uniwork.drive-result.v1", ok: false, status, code };
  }
};
var CloudDriveClient = class {
  /** 身份由登录模块提供，测试可替换网络但不能让页面选择上游。 */
  constructor(identity, request = fetch, options = {}) {
    this.identity = identity;
    this.request = request;
    this.credentials = new CloudDriveCredentials(identity, (value) => this.acquireToken(value), options);
  }
  identity;
  request;
  credentials;
  uploadQueues = /* @__PURE__ */ new Map();
  /** GUI 和 MCP 使用同一客户端的上传锁，每个同签名文件开始前重新取快照。 */
  async withUploadLock(key, signal, action) {
    const previous = this.uploadQueues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.uploadQueues.set(key, current);
    try {
      await previous;
      signal.throwIfAborted();
      return await action();
    } finally {
      release();
      if (this.uploadQueues.get(key) === current) {
        this.uploadQueues.delete(key);
      }
    }
  }
  /** 定期和唤醒检查共享同一份主进程令牌，MCP 调用无需单独同步凭据。 */
  renewCredentials() {
    return this.credentials.renewActive();
  }
  /** 仅在退出账号成功后调用，失效在途认证并删除本账号云盘密文。 */
  clearCredentials() {
    this.credentials.clear();
  }
  /** 传输绑定发起时的账号和登录，切换或到期后立即停止落盘和发送。 */
  guardIdentity() {
    const original = this.identity();
    return () => {
      const current = this.identity();
      if (!original || !current || current.uid !== original.uid || current.token !== original.token || current.expiresAt <= Date.now()) {
        throw new CloudDriveOperationError("failed", "AUTH_CHANGED");
      }
    };
  }
  /** 只向固定账号服务提交手机号和应用版本，不转发 MaaS 或云盘认证头。 */
  async acquireToken(identity) {
    const response = await this.request(AUTH, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(3e4),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: identity.phone, appVersion: "0.17.0" })
    });
    const payload = await response.json();
    const token = payload?.result?.accessToken;
    if (!response.ok || !payload?.meta || !["", "0", "200"].includes(String(payload.meta.code ?? "")) || typeof token !== "string" || !token.trim()) {
      throw new Error("\u4E2A\u4EBA\u4E91\u76D8\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
      throw new Error("\u767B\u5F55\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u8D44\u6599\u5E93");
    }
    return token;
  }
  /** 写入只发一次；响应不确定时，GUI 和 MCP 共用按目标身份的只读核验。 */
  async execute(input, signal, verifying) {
    this.validateRequest(input);
    if (isCloudDriveReadOperation(input)) {
      return this.executeRequest(input, signal);
    }
    const check = this.guardIdentity();
    const read = async (request, scope) => {
      check();
      scope.throwIfAborted();
      const result = await this.executeRequest(request, scope);
      check();
      return result;
    };
    let query;
    try {
      query = await prepareMutationVerification(
        read,
        input,
        AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(8e3)])
      );
    } catch {
    }
    check();
    signal?.throwIfAborted();
    try {
      return await this.executeRequest(input, signal);
    } catch (error) {
      if (!(error instanceof CloudDriveOperationError) || error.result.status === "failed" && ![
        "NETWORK_ERROR",
        "REQUEST_TIMEOUT",
        "TRANSPORT_ERROR",
        "OUTCOME_UNKNOWN",
        "INVALID_UPSTREAM_RESPONSE"
      ].includes(error.result.code)) {
        throw error;
      }
      const incomplete = () => new CloudDriveOperationError(
        error.result.status === "partial_success" ? "partial_success" : "outcome_unknown",
        "OPERATION_CONFIRMATION_UNAVAILABLE"
      );
      if (!query) {
        throw incomplete();
      }
      try {
        check();
        signal?.throwIfAborted();
        const scope = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(45e3)]);
        verifying?.();
        const verdict = await confirmDriveState(() => query(scope), scope, check);
        if (verdict === "confirmed") {
          return {
            ...query.result,
            ...input.method === "PATCH" ? { asset_id: decodeURIComponent(input.route.split("?")[0].slice("/assets/".length)) } : {},
            verified: true,
            confirmed_by: "desktop_state_read"
          };
        }
      } catch {
      }
      throw incomplete();
    }
  }
  /** 只转发云盘业务操作，并在服务明确报告云盘令牌过期时刷新一次。 */
  async executeRequest(input, signal) {
    const { identity, method, route } = this.validateRequest(input);
    const readOnly = isCloudDriveReadOperation(input);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.credentials.get();
      if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
        throw new Error("\u767B\u5F55\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u8D44\u6599\u5E93");
      }
      let response;
      let payload;
      try {
        response = await this.request(BASE + input.route, {
          method,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6e4)]) : AbortSignal.timeout(6e4),
          headers: {
            Authorization: `Bearer ${identity.token}`,
            "X-Drive-Access-Token": token,
            "Content-Type": "application/json"
          },
          ...input.body ? { body: JSON.stringify(input.body) } : {}
        });
        payload = await response.json();
      } catch {
        throw new CloudDriveOperationError(readOnly ? "failed" : "outcome_unknown", "TRANSPORT_ERROR");
      }
      if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
        throw new CloudDriveOperationError(readOnly ? "failed" : "outcome_unknown", "AUTH_CHANGED");
      }
      const expired = payload?.error?.code === "DRIVE_AUTH_EXPIRED" || String(payload?.error?.provider_code ?? "") === "9999";
      if (expired) {
        if (attempt === 0) {
          try {
            await this.credentials.recover(token);
          } catch {
            throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
          }
          if (readOnly) {
            continue;
          }
        }
        throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
      }
      if (!response.ok || payload?.ok !== true || !Object.hasOwn(payload, "data") || payload.status !== void 0 && payload.status !== "succeeded" && !(payload.status === "accepted" && route.startsWith("/assets/search") && readOnly)) {
        const uncertainItems = route === "/assets/trash" && Array.isArray(payload?.data?.item_results) && payload.data.item_results.some(
          (item) => ["OUTCOME_UNKNOWN", "NETWORK_ERROR", "REQUEST_TIMEOUT"].includes(item.error?.code ?? "")
        );
        const status = payload?.status === "partial_success" || payload?.status === "outcome_unknown" ? payload.status : uncertainItems ? "outcome_unknown" : payload?.status === "failed" || payload?.ok === false || readOnly ? "failed" : "outcome_unknown";
        const itemErrors = route === "/assets/trash" && Array.isArray(payload?.data?.item_results) ? payload.data.item_results.map(
          (item) => item.ok === false ? item.error?.code : void 0
        ) : [];
        const candidate = itemErrors.length && itemErrors.every((code2) => code2 === itemErrors[0]) ? itemErrors[0] : payload?.error?.code;
        const code = uncertainItems ? "OUTCOME_UNKNOWN" : typeof candidate === "string" && /^[A-Z_]{1,64}$/.test(candidate) ? candidate : response.status === 401 ? "AUTH_REQUIRED" : "SERVICE_ERROR";
        throw new CloudDriveOperationError(status, code);
      }
      return payload.data;
    }
    throw new Error("\u4E2A\u4EBA\u4E91\u76D8\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");
  }
  /** 在任何查询或发送之前限制原生操作范围。 */
  validateRequest(input) {
    const identity = this.identity();
    if (!identity || identity.expiresAt <= Date.now()) {
      throw new Error("\u8BF7\u91CD\u65B0\u767B\u5F55 UniWork");
    }
    if (!identity.phone || !/^1\d{10}$/.test(identity.phone)) {
      throw new Error("\u8BF7\u9000\u51FA\u8D26\u53F7\u5E76\u91CD\u65B0\u767B\u5F55\u4E00\u6B21\uFF0C\u4EE5\u542F\u7528\u4E2A\u4EBA\u4E91\u76D8");
    }
    if (!input || typeof input.route !== "string") {
      throw new Error("\u4E91\u76D8\u8BF7\u6C42\u65E0\u6548");
    }
    const method = input.method ?? "GET";
    const route = input.route.split("?")[0];
    const allowed = {
      GET: [
        /^\/asset-spaces$/,
        /^\/asset-spaces\/[^/]+\/usage$/,
        /^\/assets$/,
        /^\/drive\/capabilities$/,
        /^\/assets\/search\/[a-f0-9]{32}$/
      ],
      POST: [
        /^\/folders$/,
        /^\/assets\/(move|trash|download|search)$/,
        /^\/unicom\/FileDetails$/,
        /^\/unicom\/(QueryRecycleData|ReductionRecycleData|DeleteRecycleData|EmptyRecycleData)$/
      ],
      PATCH: [/^\/assets\/[^/]+$/],
      DELETE: [/^\/assets\/search\/[a-f0-9]{32}$/]
    };
    if (!allowed[method]?.some((pattern) => pattern.test(route)) || /[\\\r\n#]/.test(input.route) || /%(?:2e|2f|5c)/i.test(route) || route.includes("..")) {
      throw new Error("\u4E91\u76D8\u64CD\u4F5C\u4E0D\u53D7\u652F\u6301");
    }
    if (/^\/unicom\/(QueryRecycleData|ReductionRecycleData|DeleteRecycleData|EmptyRecycleData)$/.test(route) && (Object.hasOwn(input.body ?? {}, "spaceType") || Object.hasOwn(input.body ?? {}, "space_id") || input.route !== route)) {
      throw new Error("\u4E91\u76D8\u64CD\u4F5C\u4E0D\u53D7\u652F\u6301");
    }
    if (route === "/unicom/EmptyRecycleData" && (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || Object.keys(input.body).length > 0)) {
      throw new Error("\u4E91\u76D8\u64CD\u4F5C\u4E0D\u53D7\u652F\u6301");
    }
    if (route === "/unicom/DeleteRecycleData" && (!Array.isArray(input.body?.deleteNos) || input.body.deleteNos.length !== 1 || typeof input.body.deleteNos[0] !== "string" || !input.body.deleteNos[0] || Object.keys(input.body).some((key) => key !== "deleteNos"))) {
      throw new Error("\u4E91\u76D8\u64CD\u4F5C\u4E0D\u53D7\u652F\u6301");
    }
    return { identity, method, route };
  }
  /** 分片只发送一次；凭据与固定上传地址始终留在主进程。 */
  async uploadPart(metadata, bytes, signal) {
    const check = this.guardIdentity();
    const identity = this.identity();
    check();
    const token = await this.credentials.get();
    check();
    signal.throwIfAborted();
    let response;
    let payload;
    try {
      response = await this.request(BASE + "/drive/upload-part", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15e4)]),
        headers: {
          Authorization: `Bearer ${identity.token}`,
          "X-Drive-Access-Token": token,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "X-Drive-Upload-Metadata": Buffer.from(JSON.stringify({ ...metadata, partSize: bytes.length })).toString(
            "base64"
          )
        },
        body: bytes
      });
      payload = await response.json();
      check();
    } catch {
      throw new CloudDriveOperationError("outcome_unknown", "UPLOAD_INTERRUPTED");
    }
    if (payload?.error?.code === "DRIVE_AUTH_EXPIRED" || String(payload?.error?.provider_code ?? "") === "9999") {
      try {
        await this.credentials.recover(token);
      } catch {
      }
      throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
    }
    const final = metadata.partIndex === metadata.totalPart;
    const ambiguous = [
      "OUTCOME_UNKNOWN",
      "NETWORK_ERROR",
      "REQUEST_TIMEOUT",
      "INVALID_UPSTREAM_RESPONSE",
      "UPLOAD_UNCONFIRMED",
      "UPLOAD_INTERRUPTED"
    ].includes(payload?.error?.code);
    if (!response.ok || payload?.ok !== true || !["succeeded", ...final ? [] : ["accepted"]].includes(payload.status)) {
      throw new CloudDriveOperationError(
        ambiguous ? "outcome_unknown" : payload?.status === "partial_success" || payload?.status === "outcome_unknown" ? payload.status : payload?.status === "failed" || payload?.ok === false ? "failed" : "outcome_unknown",
        typeof payload?.error?.code === "string" && /^[A-Z_]{1,64}$/.test(payload.error.code) ? payload.error.code : payload?.status === "failed" || payload?.ok === false ? "UPLOAD_FAILED" : "UPLOAD_UNCONFIRMED"
      );
    }
  }
  /** 只下载服务授权的同源中转路径，不接收页面 URL，也不把认证头送到 CDN。 */
  async downloadContent(assetId, signal) {
    const check = this.guardIdentity();
    const details = await this.execute(
      { route: "/unicom/FileDetails", method: "POST", body: { fileId: assetId } },
      signal
    );
    if (typeof details?.fid !== "string" || !details.fid) {
      throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
    }
    const plan = await this.execute(
      { route: "/assets/download", method: "POST", body: { fid: details.fid } },
      signal
    );
    const relative = plan?.download_path;
    if (typeof relative !== "string" || !relative.startsWith("/drive/content?")) {
      throw new CloudDriveOperationError("failed", "SERVER_UPGRADE_REQUIRED");
    }
    const url = new URL(BASE + relative);
    if (url.origin !== new URL(BASE).origin || url.pathname !== new URL(BASE).pathname + "/drive/content" || url.hash || [...url.searchParams.keys()].some((key) => key !== "fid") || url.searchParams.getAll("fid").length !== 1 || url.searchParams.get("fid") !== details.fid) {
      throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
    }
    check();
    const identity = this.identity();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.credentials.get();
      check();
      signal.throwIfAborted();
      const response = await this.request(url.href, {
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${identity.token}`,
          "X-Drive-Access-Token": token,
          "Accept-Encoding": "identity"
        }
      });
      try {
        check();
        signal.throwIfAborted();
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
        let payload;
        try {
          payload = await response.clone().json().catch(() => null);
          check();
          signal.throwIfAborted();
        } catch (error) {
          await response.body?.cancel();
          throw error;
        }
        if (payload?.error?.code === "DRIVE_AUTH_EXPIRED" || String(payload?.error?.provider_code ?? "") === "9999") {
          await response.body?.cancel();
          if (attempt === 0) {
            try {
              await this.credentials.recover(token);
            } catch {
              check();
              signal.throwIfAborted();
              throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
            }
            check();
            signal.throwIfAborted();
            continue;
          }
          throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
        }
      }
      return response;
    }
    throw new CloudDriveOperationError("failed", "DRIVE_AUTH_EXPIRED");
  }
};

// apps/desktop/electron/login/cloud-drive-mcp-actions.ts
import { setTimeout as delay2 } from "node:timers/promises";
function record3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function singlePage(input, count) {
  const pageNo = Number(input.page_no ?? 1);
  if (count > 0 && pageNo >= 1e6) {
    throw new CloudDriveOperationError("failed", "INCOMPLETE_LISTING");
  }
  return {
    page_no: pageNo,
    page_size: Number(input.page_size ?? 50),
    has_more: count > 0,
    next_page_no: count > 0 ? pageNo + 1 : null,
    end_reached: count === 0
  };
}
async function listFiles(drive, input, signal) {
  const result = record3(
    await drive.execute(
      { route: `/assets?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}` },
      signal
    )
  );
  if (!Array.isArray(result.items)) {
    throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
  }
  if (!result.items.length && record3(result.page).has_more === true) {
    throw new CloudDriveOperationError("failed", "INCOMPLETE_LISTING");
  }
  return { ...result, page: { ...record3(result.page), ...singlePage(input, result.items.length) } };
}
function driveFileName(value) {
  const container = record3(value);
  const row = record3(
    Array.isArray(value) ? value[0] : Array.isArray(container.items) ? container.items[0] : Array.isArray(container.files) ? container.files[0] : value
  );
  return [row.fileName, row.file_name, row.name].find((name2) => typeof name2 === "string" && !!name2.trim()) ?? null;
}
async function recycle(drive, input, signal) {
  const raw = await drive.execute(
    {
      route: "/unicom/QueryRecycleData",
      method: "POST",
      body: {
        pageNo: input.page_no,
        pageSize: input.page_size,
        sortRule: "0"
      }
    },
    signal
  );
  const rows = Array.isArray(raw) ? raw : record3(raw).items ?? record3(raw).list;
  if (!Array.isArray(rows)) {
    throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
  }
  const items = rows.map((value) => {
    const row = record3(value);
    if (typeof row.deleteNo !== "string" || !row.deleteNo) {
      throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
    }
    const directory = String(row.type) === "0";
    return {
      delete_no: row.deleteNo,
      name: typeof row.name === "string" ? row.name : "",
      kind: directory ? "directory" : "file",
      size_bytes: !directory && Number.isSafeInteger(row.fileSize) && Number(row.fileSize) >= 0 ? row.fileSize : null,
      deleted_at: typeof row.deleteTime === "string" ? row.deleteTime : null,
      keep_days: Number.isSafeInteger(row.keepDays) ? row.keepDays : null
    };
  });
  return {
    items,
    page: singlePage(input, items.length)
  };
}
async function search(drive, input, caller) {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(66e4)]);
  const check = drive.guardIdentity();
  const page2 = new URLSearchParams({ page_no: String(input.page_no), page_size: String(input.page_size) });
  let searchId;
  let completed = false;
  try {
    let result = await drive.execute({ route: "/assets/search", method: "POST", body: input }, signal);
    while (record3(result).state === "running") {
      const id2 = record3(result).search_id;
      if (typeof id2 !== "string" || !/^[a-f0-9]{32}$/.test(id2) || searchId && id2 !== searchId) {
        throw new CloudDriveOperationError("failed", "INVALID_SEARCH_JOB");
      }
      searchId = id2;
      await delay2(1e3, void 0, { signal });
      check();
      result = await drive.execute({ route: `/assets/search/${searchId}?${page2}` }, signal);
    }
    if (!Array.isArray(record3(result).items) || !record3(result).page || typeof record3(result).page !== "object") {
      throw new CloudDriveOperationError("failed", "INVALID_RESPONSE");
    }
    completed = true;
    return result;
  } finally {
    if (searchId && !completed) {
      try {
        check();
        await drive.execute({ route: `/assets/search/${searchId}`, method: "DELETE" }, AbortSignal.timeout(3e3));
      } catch {
      }
    }
  }
}
async function remove(drive, input, signal) {
  if (input.mode !== "purge") {
    return drive.execute(
      {
        route: "/assets/trash",
        method: "POST",
        body: { file_ids: input.file_ids ?? [], directory_ids: input.directory_ids ?? [] }
      },
      signal
    );
  }
  const check = drive.guardIdentity();
  const entries = input.delete_nos;
  const results = [];
  for (const deleteNo of entries) {
    try {
      check();
      signal.throwIfAborted();
      await drive.execute(
        { route: "/unicom/DeleteRecycleData", method: "POST", body: { deleteNos: [deleteNo] } },
        signal
      );
      results.push({ delete_no: deleteNo, status: "succeeded" });
    } catch (error) {
      const failure = error instanceof CloudDriveOperationError ? error.result : { status: "failed", code: "CANCELLED" };
      results.push({ delete_no: deleteNo, status: failure.status, code: failure.code });
      const succeeded = results.filter((item) => item.status === "succeeded").length;
      for (const remaining of entries.slice(results.length)) {
        results.push({ delete_no: remaining, status: "not_started" });
      }
      return {
        ok: false,
        status: failure.status === "outcome_unknown" ? "outcome_unknown" : succeeded ? "partial_success" : failure.status,
        code: failure.code,
        item_results: results,
        summary: { succeeded, total: entries.length }
      };
    }
  }
  return { item_results: results, summary: { succeeded: results.length, total: entries.length } };
}
async function executeDriveMcpAction(drive, name2, input, signal) {
  const request = (route, method = "GET", body) => drive.execute({ route, method, body }, signal);
  const handlers = {
    list_files: () => listFiles(drive, input, signal),
    filesearch: () => search(drive, input, signal),
    make_dir: () => request("/folders", "POST", input),
    rename_file: () => request(`/assets/${encodeURIComponent(String(input.asset_id))}`, "PATCH", {
      new_name: input.new_name,
      kind: input.kind
    }),
    move_files: () => request("/assets/move", "POST", {
      file_ids: input.file_ids ?? [],
      directory_ids: input.directory_ids ?? [],
      target_parent_asset_id: input.target_parent_asset_id
    }),
    delete_files: () => remove(drive, input, signal),
    get_file_info: () => request("/unicom/FileDetails", "POST", { fileId: input.asset_id }),
    list_recycle_bin: () => recycle(drive, input, signal),
    restore_files: () => request("/unicom/ReductionRecycleData", "POST", { deleteNos: input.delete_nos }),
    get_capacity: () => request("/asset-spaces/personal/usage")
  };
  const handler = handlers[name2];
  if (!handler) {
    throw new CloudDriveOperationError("failed", "TOOL_UNAVAILABLE");
  }
  return handler();
}

// apps/desktop/electron/login/cloud-drive-mcp-tools.ts
var id = { type: "string", minLength: 1, maxLength: 512 };
var name = { type: "string", minLength: 1, maxLength: 255 };
var ids = { type: "array", items: id, minItems: 1, maxItems: 100 };
var selection = { ...ids, minItems: 0 };
var parent = { ...id, default: "0" };
var page = {
  page_no: { type: "integer", minimum: 1, maximum: 1e6, default: 1 },
  page_size: { type: "integer", minimum: 1, maximum: 200, default: 50 }
};
function tool(name2, description, properties, required, readOnlyHint = true, destructiveHint = false) {
  return {
    name: name2,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: true }
  };
}
var DRIVE_MCP_TOOLS = [
  tool(
    "list_files",
    "\u4EC5\u8FD4\u56DE\u4E2A\u4EBA\u4E91\u76D8\u6307\u5B9A\u76EE\u5F55\u7684\u4E00\u9875\u76F4\u5C5E\u6587\u4EF6\u548C\u6587\u4EF6\u5939\uFF0C\u4E0D\u542B\u5B50\u76EE\u5F55\u5185\u5BB9\uFF0C\u6839\u76EE\u5F55 ID \u4E3A 0\u3002\u975E\u7A7A\u9875\u6309 next_page_no \u7EE7\u7EED\u7FFB\u9875\uFF0C\u76F4\u5230\u7A7A\u9875 end_reached=true\uFF1Bhas_more \u662F\u4FDD\u5B88\u7FFB\u9875\u63D0\u793A\u3002\u4FDD\u6301\u76F8\u540C page_size \u548C sort\uFF1B\u91CD\u590D\u9875\u6216\u67E5\u8BE2\u5931\u8D25\u65F6\u5E94\u8BF4\u660E\u5217\u8868\u4E0D\u5B8C\u6574\uFF0C\u4E0D\u80FD\u636E\u6B64\u5224\u65AD\u6587\u4EF6\u4E0D\u5B58\u5728\u3002\u67E5\u770B\u5168\u90E8\u6587\u4EF6\u8FD8\u9700\u8FDB\u5165\u5B50\u76EE\u5F55\u3002",
    {
      space_id: { type: "string", enum: ["personal"], default: "personal" },
      parent_asset_id: parent,
      ...page,
      sort: { type: "string", enum: ["name_asc", "modified_desc"], default: "name_asc" }
    },
    []
  ),
  tool(
    "filesearch",
    "\u6309\u540D\u79F0\u641C\u7D22\u4E2A\u4EBA\u4E91\u76D8\u6587\u4EF6\uFF0C\u7B49\u5F85\u540E\u53F0\u5168\u76D8\u641C\u7D22\u5B8C\u6210\u540E\u8FD4\u56DE\u5206\u9875\u7ED3\u679C\uFF0C\u6700\u591A\u7EA6 11 \u5206\u949F\u3002",
    { query: { ...id, maxLength: 1e3 }, ...page },
    ["query"]
  ),
  tool("make_dir", "\u5728\u4E2A\u4EBA\u4E91\u76D8\u4E2D\u521B\u5EFA\u6587\u4EF6\u5939\u3002", { parent_asset_id: parent, name }, ["name"], false),
  tool(
    "rename_file",
    "\u91CD\u547D\u540D\u4E91\u76D8\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u3002",
    { asset_id: id, new_name: name, kind: { type: "string", enum: ["file", "directory"] } },
    ["asset_id", "new_name", "kind"],
    false
  ),
  tool(
    "move_files",
    "\u5C06\u4E91\u76D8\u6587\u4EF6\u548C\u6587\u4EF6\u5939\u79FB\u52A8\u5230\u76EE\u6807\u76EE\u5F55\uFF1B\u81F3\u5C11\u63D0\u4F9B\u4E00\u7EC4\u975E\u7A7A ID\u3002",
    { file_ids: selection, directory_ids: selection, target_parent_asset_id: id },
    ["target_parent_asset_id"],
    false
  ),
  tool(
    "delete_files",
    "\u5220\u9664\u4E2A\u4EBA\u4E91\u76D8\u8D44\u6599\u3002trash\uFF08\u9ED8\u8BA4\uFF09\u6309 file_ids/directory_ids \u79FB\u5165\u56DE\u6536\u7AD9\uFF1Bpurge \u6309 list_recycle_bin \u8FD4\u56DE\u7684 delete_nos \u5F7B\u5E95\u5220\u9664\uFF0C\u4E0D\u53EF\u6062\u590D\u3002\u7ED3\u679C\u672A\u77E5\u65F6\u5148\u67E5\u8BE2\u786E\u8BA4\uFF0C\u4E0D\u8981\u76F4\u63A5\u91CD\u8BD5\u3002",
    {
      mode: { type: "string", enum: ["trash", "purge"], default: "trash" },
      file_ids: selection,
      directory_ids: selection,
      delete_nos: ids
    },
    [],
    false,
    true
  ),
  tool("get_file_info", "\u83B7\u53D6\u4E91\u76D8\u6587\u4EF6\u540D\u79F0\u3001\u5927\u5C0F\u3001\u7236\u76EE\u5F55\u548C\u65F6\u95F4\u7B49\u8BE6\u60C5\u3002", { asset_id: id }, ["asset_id"]),
  tool(
    "list_recycle_bin",
    "\u8FD4\u56DE\u4E2A\u4EBA\u56DE\u6536\u7AD9\u7684\u4E00\u9875\u8BB0\u5F55\uFF0Cdelete_no \u7528\u4E8E\u6062\u590D\u6216\u5F7B\u5E95\u5220\u9664\u3002\u975E\u7A7A\u9875\u6309 next_page_no \u7EE7\u7EED\u7FFB\u9875\u76F4\u5230\u7A7A\u9875 end_reached=true\uFF0C\u4E0D\u80FD\u56E0\u77ED\u9875\u505C\u6B62\uFF1B\u91CD\u590D\u9875\u6216\u67E5\u8BE2\u5931\u8D25\u65F6\u4E0D\u80FD\u58F0\u79F0\u5DF2\u5217\u5B8C\u3002",
    page,
    []
  ),
  tool("restore_files", "\u6309\u56DE\u6536\u7AD9 delete_no \u6062\u590D\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u5230\u539F\u4F4D\u7F6E\u3002", { delete_nos: ids }, ["delete_nos"], false),
  tool("get_capacity", "\u67E5\u8BE2\u4E2A\u4EBA\u4E91\u76D8\u603B\u5BB9\u91CF\u548C\u5DF2\u7528\u5BB9\u91CF\u3002", {}, []),
  tool(
    "download",
    "\u4E0B\u8F7D\u5F53\u524D\u684C\u9762\u8D26\u53F7\u7684\u4E91\u76D8\u6587\u4EF6\u5230\u8D26\u53F7\u5DE5\u4F5C\u533A\uFF0C\u5B8C\u6210\u540E\u8FD4\u56DE\u672C\u673A path\u3002\u8BFB\u53D6\u4E91\u76D8\u5F15\u7528\u524D\u5148\u8C03\u7528\u6B64\u5DE5\u5177\uFF0C\u518D\u8BFB\u53D6 path\uFF1B\u4EC5\u9002\u7528\u4E8E\u4E0E\u684C\u9762\u540C\u673A\u7684 Hermes\u3002",
    { asset_id: id, name: { ...name, description: "\u53EF\u9009\uFF1B\u7701\u7565\u65F6\u4ECE\u6587\u4EF6\u8BE6\u60C5\u83B7\u53D6\u3002" } },
    ["asset_id"],
    false
  ),
  tool(
    "upload",
    "\u5C06\u5F53\u524D\u673A\u5668\u4E0A\u7684\u4EFB\u52A1\u6587\u4EF6\u6216\u9644\u4EF6\u4E0A\u4F20\u5230\u4E2A\u4EBA\u4E91\u76D8\uFF1B\u76F8\u5BF9\u8DEF\u5F84\u57FA\u4E8E\u8D26\u53F7\u5DE5\u4F5C\u533A\u3002\u7981\u6B62\u4E0A\u4F20\u51ED\u636E\u7B49\u654F\u611F\u6587\u4EF6\u3002\u7ED3\u679C\u672A\u77E5\u65F6\u5148\u67E5\u8BE2\u786E\u8BA4\uFF0C\u4E0D\u8981\u76F4\u63A5\u91CD\u8BD5\u3002",
    { source_path: { ...id, maxLength: 4096 }, parent_asset_id: parent },
    ["source_path"],
    false
  )
];
function validField(field, value) {
  if (field.type === "string") {
    return typeof value === "string" && !!value.trim() && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && value.length >= (field.minLength ?? 1) && value.length <= (field.maxLength ?? 512) && (!field.enum || field.enum.includes(value));
  }
  if (field.type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= field.minimum && value <= field.maximum;
  }
  return Array.isArray(value) && value.length >= field.minItems && value.length <= field.maxItems && value.every((item) => validField(field.items, item)) && new Set(value).size === value.length;
}
function parseDriveMcpInput(name2, args) {
  const entry = DRIVE_MCP_TOOLS.find((tool2) => tool2.name === name2);
  if (!entry || !args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const fields = entry.inputSchema.properties;
  const input = args;
  if (entry.inputSchema.required.some((key) => !Object.hasOwn(input, key)) || Object.entries(input).some(([key, value]) => !Object.hasOwn(fields, key) || !validField(fields[key], value))) {
    return null;
  }
  const result = {};
  for (const [key, field] of Object.entries(fields)) {
    if (Object.hasOwn(input, key)) {
      result[key] = input[key];
    } else if (field.default !== void 0) {
      result[key] = field.default;
    }
  }
  const selected = (result.file_ids ?? []).length + (result.directory_ids ?? []).length;
  if (name2 === "move_files" && !selected) {
    return null;
  }
  if (name2 === "delete_files") {
    if (result.mode === "purge" ? !result.delete_nos || !!selected : !!result.delete_nos || !selected) {
      return null;
    }
  }
  return result;
}

// apps/desktop/electron/login/cloud-drive-transfers.ts
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// apps/shared/src/office-preview.ts
var OFFICE_EXTENSIONS = {
  word: ["docx", "doc", "odt"],
  slides: ["pptx", "ppt", "odp"],
  sheet: ["xlsx", "xls", "ods"]
};
var OFFICE_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
var OFFICE_PDF_MAX_BYTES = 50 * 1024 * 1024;
var KIND_BY_EXTENSION = new Map(
  Object.entries(OFFICE_EXTENSIONS).flatMap(
    ([kind, extensions]) => extensions.map((extension) => [extension, kind])
  )
);

// apps/desktop/electron/login/cloud-drive-preview.ts
var CLOUD_DRIVE_PREVIEW_BYTES = 20 * 1024 * 1024;

// apps/desktop/electron/login/cloud-drive-transfers.ts
var PART_BYTES = 8 * 1024 * 1024;
var IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};
var TEXT_EXT = /* @__PURE__ */ new Set([".txt", ".csv", ".md", ".mdx", ".markdown", ".json", ".xml", ".html", ".htm"]);
var PREVIEW_KINDS = new Map([
  ...Object.keys(IMAGE_MIME).map((extension) => [extension, "image"]),
  [".pdf", "pdf"],
  ...Array.from(TEXT_EXT, (extension) => [extension, "text"]),
  ...Object.values(OFFICE_EXTENSIONS).flatMap(
    (extensions) => extensions.map((extension) => ["." + extension, "office"])
  )
]);
function validName(name2) {
  return typeof name2 === "string" && !!name2.trim() && name2 !== "." && name2 !== ".." && !/[\\/:]/.test(name2) && !Array.from(name2).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function validDownload(value) {
  const file = value;
  return !!file && typeof file.assetId === "string" && !!file.assetId && validName(file.name) && (file.size == null || Number.isSafeInteger(file.size) && file.size >= 0);
}
function transferFailure(error, controller, upload) {
  if (error instanceof CloudDriveOperationError && (error.result.status !== "failed" || error.result.code === "UPLOAD_CONFIRMATION_FAILED")) {
    return error.result;
  }
  if (controller.signal.aborted) {
    return controller.signal.reason instanceof CloudDriveOperationError ? controller.signal.reason.result : { status: "cancelled" };
  }
  if (error instanceof CloudDriveOperationError) {
    return error.result;
  }
  const code = error?.code;
  return new CloudDriveOperationError(
    "failed",
    upload && code === "ENOENT" ? "LOCAL_FILE_MISSING" : upload && ["EACCES", "EPERM"].includes(code || "") ? "LOCAL_FILE_READ_FAILED" : "TRANSFER_FAILED"
  ).result;
}
var CloudDriveTransfers = class {
  /** 缓存根目录来自当前账号运行时，不接受 Renderer 指定。 */
  constructor(drive, cacheRoot) {
    this.drive = drive;
    this.cacheRoot = cacheRoot;
  }
  drive;
  cacheRoot;
  active = /* @__PURE__ */ new Map();
  previews = /* @__PURE__ */ new Map();
  previewRootReady;
  previewCleanups = /* @__PURE__ */ new Set();
  /** 取消仅作用于发起窗口自己的传输。 */
  cancel(owner2, id2) {
    const transfer = this.active.get(owner2);
    if (transfer && (id2 === void 0 || transfer.id === id2)) {
      transfer.controller.abort();
      if (id2 === void 0) {
        transfer.lifetime.abort();
      }
    }
  }
  /** 退出账号时终止全部请求，临时文件由各自 finally 清理。 */
  cancelAll() {
    for (const transfer of this.active.values()) {
      transfer.controller.abort();
      transfer.lifetime.abort();
    }
    void this.clearPreviews();
  }
  /** 关闭账号窗口后释放它准备的原文件，不触碰用户下载位置或 Office 转换缓存。 */
  async clearPreviews(owner2) {
    const directories = owner2 === void 0 ? [...this.previews.values()].flatMap((value) => [...value]) : [...this.previews.get(owner2) || []];
    if (owner2 === void 0) {
      this.previews.clear();
    } else {
      this.previews.delete(owner2);
    }
    const previous = [...this.previewCleanups];
    const pending = Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {
      }))
    );
    this.previewCleanups.add(pending);
    try {
      await Promise.all([...previous, pending]);
    } finally {
      this.previewCleanups.delete(pending);
    }
  }
  /** 异常只返回固定状态码；仅成功预览返回已验证的原文件路径，不返回账号或认证头。 */
  async run(owner2, input, host) {
    if (!input || typeof input.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) || this.active.has(owner2) || !["upload", "download", "preview", "download-many"].includes(input.operation) || (input.operation === "upload" ? typeof input.parentAssetId !== "string" || !input.parentAssetId : input.operation === "download-many" ? !Array.isArray(input.assets) || !input.assets.length || input.assets.length > 1e3 || !input.assets.every(validDownload) : !validDownload(input))) {
      return new CloudDriveOperationError("failed", "INVALID_ARGUMENT").result;
    }
    const controller = new AbortController();
    const lifetime = new AbortController();
    const identityGuard = this.drive.guardIdentity();
    const checkIdentity = () => {
      lifetime.signal.throwIfAborted();
      identityGuard();
    };
    const check = () => {
      controller.signal.throwIfAborted();
      checkIdentity();
    };
    const timer = setInterval(() => {
      try {
        checkIdentity();
      } catch {
        controller.abort(new CloudDriveOperationError("failed", "AUTH_CHANGED"));
        lifetime.abort();
      }
    }, 250);
    this.active.set(owner2, { id: input.id, controller, lifetime });
    try {
      check();
      if (input.operation === "download-many") {
        return await this.downloadBatch(input, host, controller, check);
      }
      return input.operation === "upload" ? await this.upload(input, host, controller.signal, check, checkIdentity, lifetime.signal) : await this.download(input, host, controller, check, owner2);
    } catch (error) {
      return transferFailure(error, controller, input.operation === "upload");
    } finally {
      clearInterval(timer);
      this.active.delete(owner2);
    }
  }
  /** 批量下载逐项记录真实保存或取消结果，停止后剩余项不会伪装成已保存。 */
  async downloadBatch(input, host, controller, check) {
    const files = [];
    for (const [index, asset] of input.assets.entries()) {
      let last = { id: input.id, completed: 0, total: asset.size ?? null };
      const metadata = { name: asset.name, fileIndex: index + 1, fileCount: input.assets.length };
      try {
        check();
        controller.signal.throwIfAborted();
        const result = await this.download(
          { ...asset, operation: "download", id: input.id },
          {
            ...host,
            progress: (progress) => {
              last = progress;
              host.progress({ ...progress, ...metadata });
            }
          },
          controller,
          check
        );
        files.push({
          index,
          name: asset.name,
          status: result.status,
          ..."code" in result ? { code: result.code } : {}
        });
        if (result.status === "succeeded" || result.status === "cancelled") {
          host.progress({ ...last, ...metadata, fileStatus: result.status });
        }
      } catch (error) {
        const failure = transferFailure(error, controller, false);
        files.push({
          index,
          name: asset.name,
          status: failure.status,
          ..."code" in failure ? { code: failure.code } : {}
        });
        files.push(
          ...input.assets.slice(index + 1).map((asset2, offset) => ({ index: index + offset + 1, name: asset2.name, status: "not_started" }))
        );
        return {
          ...files.some((file) => file.status === "succeeded") && failure.status !== "cancelled" ? new CloudDriveOperationError("partial_success", "DOWNLOAD_BATCH_PARTIAL").result : failure,
          files
        };
      }
    }
    const saved = files.find((file) => file.status === "succeeded");
    return saved ? { status: "succeeded", name: saved.name, files } : { status: "cancelled", files };
  }
  /** 用户选中文件后读固定快照，分片失败不自动重发；末片不明确时提示先核对。 */
  async upload(input, host, signal, check, checkIdentity, lifetime) {
    const selected = await host.selectUpload(signal);
    check();
    if (!selected) {
      return { status: "cancelled" };
    }
    const selectedPath = typeof selected === "string" ? selected : selected.path;
    const name2 = typeof selected === "string" ? path.basename(selectedPath) : selected.name;
    if (!validName(name2)) {
      throw new CloudDriveOperationError("failed", "INVALID_NAME");
    }
    host.progress({ id: input.id, name: name2, completed: 0, total: null });
    const flags = typeof selected !== "string" ? constants.O_RDONLY | (constants.O_NOFOLLOW || 0) : "r";
    const file = await open(selectedPath, flags);
    try {
      const snapshot = await file.stat();
      if (typeof selected !== "string" && Object.entries(selected.snapshot).some(
        ([key, value]) => snapshot[key] !== value
      )) {
        throw new CloudDriveOperationError("failed", "FILE_CHANGED");
      }
      const capabilities = await this.drive.execute({ route: "/drive/capabilities" }, signal);
      check();
      if (!snapshot.isFile() || !Number.isSafeInteger(snapshot.size)) {
        throw new CloudDriveOperationError("failed", "LOCAL_FILE_READ_FAILED");
      }
      if (!capabilities?.upload) {
        throw new CloudDriveOperationError("failed", "UPLOAD_NOT_ALLOWED");
      }
      if (capabilities.max_upload_bytes != null && snapshot.size > capabilities.max_upload_bytes) {
        throw new CloudDriveOperationError("failed", "FILE_TOO_LARGE");
      }
      return await this.drive.withUploadLock(
        JSON.stringify([input.parentAssetId, name2, snapshot.size]),
        signal,
        async () => {
          check();
          const read = async (request, scope) => {
            checkIdentity();
            const value = await this.drive.execute(request, AbortSignal.any([scope, lifetime]));
            checkIdentity();
            return value;
          };
          let baseline;
          try {
            baseline = await snapshotUpload(
              read,
              input.parentAssetId,
              name2,
              snapshot.size,
              AbortSignal.any([signal, AbortSignal.timeout(8e3)])
            );
          } catch {
          }
          check();
          const totalPart = Math.max(1, Math.ceil(snapshot.size / PART_BYTES));
          const uniqueId = randomUUID().replaceAll("-", "");
          host.progress({ id: input.id, name: name2, completed: 0, total: snapshot.size });
          for (let index = 0; index < totalPart; index++) {
            check();
            const current = await file.stat();
            if (current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ctimeMs !== snapshot.ctimeMs) {
              throw new CloudDriveOperationError("failed", "FILE_CHANGED");
            }
            const position = index * PART_BYTES;
            const bytes = Buffer.alloc(Math.min(PART_BYTES, snapshot.size - position));
            const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
            const afterRead = await file.stat();
            if (bytesRead !== bytes.length || afterRead.size !== snapshot.size || afterRead.mtimeMs !== snapshot.mtimeMs || afterRead.ctimeMs !== snapshot.ctimeMs) {
              throw new CloudDriveOperationError("failed", "FILE_CHANGED");
            }
            check();
            try {
              await this.drive.uploadPart(
                {
                  uniqueId,
                  fileName: name2,
                  fileSize: snapshot.size,
                  totalPart,
                  partIndex: index + 1,
                  directoryId: input.parentAssetId
                },
                bytes,
                signal
              );
            } catch (error) {
              if (index + 1 < totalPart && error instanceof CloudDriveOperationError && error.result.status !== "failed") {
                throw new CloudDriveOperationError("failed", "UPLOAD_INCOMPLETE");
              }
              if (index + 1 === totalPart && error instanceof CloudDriveOperationError && error.result.status !== "failed") {
                if (!baseline) {
                  throw new CloudDriveOperationError("outcome_unknown", "UPLOAD_CONFIRMATION_UNAVAILABLE");
                }
                const confirmation = AbortSignal.any([lifetime, AbortSignal.timeout(45e3)]);
                try {
                  checkIdentity();
                  host.progress({ id: input.id, name: name2, completed: position, total: snapshot.size, phase: "verifying" });
                  const verdict = await confirmDriveState(
                    () => verifyUpload(read, baseline, confirmation),
                    confirmation,
                    checkIdentity
                  );
                  if (verdict === "confirmed") {
                    return { status: "succeeded", name: name2 };
                  }
                  if (verdict === "absent") {
                    throw new CloudDriveOperationError("failed", "UPLOAD_CONFIRMATION_FAILED");
                  }
                } catch (confirmationError) {
                  if (confirmationError instanceof CloudDriveOperationError && confirmationError.result.code === "UPLOAD_CONFIRMATION_FAILED") {
                    throw confirmationError;
                  }
                }
                throw new CloudDriveOperationError("outcome_unknown", "UPLOAD_CONFIRMATION_UNAVAILABLE");
              }
              throw error;
            }
            host.progress({ id: input.id, name: name2, completed: position + bytes.length, total: snapshot.size });
          }
          return { status: "succeeded", name: name2 };
        }
      );
    } finally {
      await file.close().catch(() => {
      });
    }
  }
  /** 下载和预览共用完整性校验；临时文件绝不作为成功文件发布。 */
  async download(input, host, controller, check, owner2) {
    const preview = input.operation === "preview";
    const extension = path.extname(input.name).toLowerCase();
    const kind = PREVIEW_KINDS.get(extension);
    if (preview && (!kind || input.size != null && input.size > CLOUD_DRIVE_PREVIEW_BYTES)) {
      throw new CloudDriveOperationError("failed", kind ? "PREVIEW_TOO_LARGE" : "PREVIEW_UNSUPPORTED");
    }
    let directory;
    let temporary;
    let idle;
    try {
      let destination;
      if (preview) {
        this.previewRootReady ??= rm(this.cacheRoot, { recursive: true, force: true });
        await this.previewRootReady;
        check();
        await mkdir(this.cacheRoot, { recursive: true, mode: 448 });
        const root = await lstat(this.cacheRoot);
        if (!root.isDirectory() || root.isSymbolicLink()) {
          throw new Error("Invalid cache");
        }
        directory = await mkdtemp(path.join(this.cacheRoot, "preview-"));
        destination = path.join(directory, input.name);
      } else {
        const selected = await host.selectDownload(input.name);
        check();
        if (!selected) {
          return { status: "cancelled" };
        }
        destination = selected;
      }
      check();
      temporary = path.join(path.dirname(destination), ".drive-" + randomUUID() + ".part");
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new CloudDriveOperationError("failed", "REQUEST_TIMEOUT")), 12e4);
      };
      resetIdle();
      const response = await this.drive.downloadContent(input.assetId, controller.signal);
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new CloudDriveOperationError("failed", "DOWNLOAD_FAILED");
      }
      const declared = response.headers.get("content-length");
      const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
      const maximum = preview ? CLOUD_DRIVE_PREVIEW_BYTES : Infinity;
      if (length !== null && (!Number.isSafeInteger(length) || length > maximum || input.size != null && length !== input.size)) {
        await response.body.cancel();
        throw new CloudDriveOperationError(
          "failed",
          preview && length > maximum ? "PREVIEW_TOO_LARGE" : "SIZE_MISMATCH"
        );
      }
      let completed = 0;
      const stream = Readable.fromWeb(response.body);
      async function* count(source) {
        for await (const chunk of source) {
          check();
          resetIdle();
          completed += chunk.length;
          if (completed > maximum || input.size != null && completed > input.size) {
            throw new CloudDriveOperationError(
              "failed",
              preview && completed > maximum ? "PREVIEW_TOO_LARGE" : "SIZE_MISMATCH"
            );
          }
          host.progress({ id: input.id, completed, total: input.size ?? length });
          yield chunk;
        }
        if (length !== null && completed !== length || input.size != null && completed !== input.size) {
          throw new CloudDriveOperationError("failed", "SIZE_MISMATCH");
        }
      }
      await pipeline(stream, count, createWriteStream(temporary, { flags: "wx", mode: 384 }), {
        signal: controller.signal
      });
      check();
      await rename(temporary, destination);
      if (!preview) {
        return { status: "succeeded", name: input.name };
      }
      check();
      const retained = this.previews.get(owner2) || /* @__PURE__ */ new Set();
      retained.add(directory);
      this.previews.set(owner2, retained);
      directory = void 0;
      return { status: "succeeded", name: input.name, preview: { kind: "file", path: destination } };
    } finally {
      clearTimeout(idle);
      if (temporary) {
        await rm(temporary, { force: true });
      }
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
};

// apps/desktop/electron/login/cloud-drive-worker.ts
var upstreamRequest = fetch;
var limitedRequest = async (url, options) => {
  const response = await upstreamRequest(url, options);
  if (!String(url).includes("/drive/content?") || !response.ok || !response.body) {
    return response;
  }
  const maximum = 512 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    throw new CloudDriveOperationError("failed", "FILE_TOO_LARGE");
  }
  let bytes = 0;
  return new Response(
    response.body.pipeThrough(
      new TransformStream({
        transform(chunk, target) {
          bytes += chunk.byteLength;
          if (bytes > maximum) {
            throw new CloudDriveOperationError("failed", "FILE_TOO_LARGE");
          }
          target.enqueue(chunk);
        }
      })
    ),
    { status: response.status, headers: response.headers }
  );
};
var contexts = /* @__PURE__ */ new Map();
var running = /* @__PURE__ */ new Map();
var owner = 0;
async function send(value) {
  if (!process.stdout.write(JSON.stringify(value) + "\n")) {
    await once(process.stdout, "drain");
  }
}
async function handle(input) {
  const { id: id2, action } = input;
  if (action === "tools") {
    return send({
      id: id2,
      result: DRIVE_MCP_TOOLS.map((tool2) => ({
        ...tool2,
        description: tool2.description.replace("\u5F53\u524D\u684C\u9762\u8D26\u53F7", "\u5F53\u524D\u6388\u6743\u8D26\u53F7").replace("\u672C\u673A path", "\u5B9E\u4F8B\u5185 path").replace("\u4EC5\u9002\u7528\u4E8E\u4E0E\u684C\u9762\u540C\u673A\u7684 Hermes\u3002", "").replace("\u5F53\u524D\u673A\u5668", "\u5F53\u524D\u7528\u6237\u5B9E\u4F8B")
      }))
    });
  }
  if (action === "cancel") {
    running.get(input.target)?.abort();
    return send({ id: id2, result: {} });
  }
  const controller = new AbortController();
  running.set(id2, controller);
  let counted;
  let lastProgress = 0;
  const notifyProgress = (value) => {
    if (value.phase || Date.now() - lastProgress >= 200 || value.completed === value.total) {
      lastProgress = Date.now();
      void send({ id: id2, progress: value });
    }
  };
  try {
    if (action === "logout") {
      const old = contexts.get(input.key);
      if (old) {
        old.identity = null;
        old.transfers.cancelAll();
        contexts.delete(input.key);
      }
      return await send({ id: id2, result: {} });
    }
    const now = Date.now();
    for (const [key, value] of contexts) {
      if (!value.identity || value.identity.expiresAt <= now) {
        value.identity = null;
        value.transfers.cancelAll();
        contexts.delete(key);
      }
    }
    let context = contexts.get(input.key);
    if (!context) {
      if (contexts.size >= 64) {
        const idle = [...contexts].find(([, value]) => value.active === 0);
        if (!idle) {
          throw new CloudDriveOperationError("failed", "SERVICE_BUSY");
        }
        idle[1].identity = null;
        idle[1].transfers.cancelAll();
        contexts.delete(idle[0]);
      }
      context = { identity: input.identity, drive: null, transfers: null, usage: null, active: 0 };
      const captured = context;
      context.drive = new CloudDriveClient(() => captured.identity, limitedRequest);
      context.usage = new PlanUsageClient(() => captured.identity, limitedRequest);
      context.transfers = new CloudDriveTransfers(context.drive, path2.join(input.root, "previews"));
      contexts.set(input.key, context);
    }
    if (!context.identity || context.identity.token !== input.identity.token) {
      throw new Error("Invalid identity");
    }
    context.active++;
    counted = context;
    const scope = AbortSignal.any([controller.signal, AbortSignal.timeout(72e4)]);
    const parsedAction = async () => {
      const parsed = parseDriveMcpInput(input.name, input.args);
      if (!parsed) {
        throw new CloudDriveOperationError("failed", "INVALID_ARGUMENT");
      }
      return action === "parse" ? parsed : executeDriveMcpAction(context.drive, input.name, parsed, scope);
    };
    const handlers = {
      welcome: () => new WelcomeCatalogClient(limitedRequest, () => context.identity).load(input.locale),
      "plan-usage": () => context.usage.load(input.force === true),
      "plan-subscription": async () => {
        let url = "";
        const subscription = new PlanSubscriptionClient(
          () => context.identity,
          async (value) => {
            url = value;
          },
          limitedRequest
        );
        const result2 = await subscription.open();
        if (result2.status === "opened") {
          context.usage = new PlanUsageClient(() => context.identity, limitedRequest);
          return { status: "ready", url };
        }
        return result2;
      },
      request: async () => {
        const route = new URL(input.request.route, "https://drive.invalid");
        if (route.searchParams.has("space_id") && route.searchParams.get("space_id") !== "personal" || input.request.body?.space_id && input.request.body.space_id !== "personal") {
          throw new CloudDriveOperationError("failed", "INVALID_ARGUMENT");
        }
        return context.drive.execute(input.request, scope, () => {
          void send({ id: id2, progress: { phase: "verifying" } });
        });
      },
      action: parsedAction,
      parse: parsedAction,
      "release-preview": async () => {
        await context.transfers.clearPreviews(input.owner);
        return {};
      },
      name: async () => {
        const details = await context.drive.execute(
          { route: "/unicom/FileDetails", method: "POST", body: { fileId: input.assetId } },
          scope
        );
        return { name: driveFileName(details) };
      },
      transfer: async () => {
        const currentOwner = ++owner;
        controller.signal.addEventListener("abort", () => context.transfers.cancel(currentOwner), { once: true });
        const result2 = await context.transfers.run(currentOwner, input.request, {
          selectUpload: async () => input.file,
          selectDownload: async () => input.file,
          progress: notifyProgress
        });
        return result2.status === "succeeded" && result2.preview ? { ...result2, workerPreviewOwner: currentOwner } : result2;
      }
    };
    const handler = handlers[action];
    if (!handler) {
      throw new CloudDriveOperationError("failed", "INVALID_ARGUMENT");
    }
    const result = await handler();
    await send({ id: id2, result });
  } catch (error) {
    await send({
      id: id2,
      result: error instanceof CloudDriveOperationError ? error.result : {
        protocol: "uniwork.drive-result.v1",
        ok: false,
        status: action === "request" && !isCloudDriveReadOperation(input.request) ? "outcome_unknown" : "failed",
        code: controller.signal.aborted ? "CANCELLED" : "SERVICE_ERROR"
      }
    });
  } finally {
    running.delete(id2);
    if (counted) {
      counted.active--;
    }
  }
}
function startDriveWorker(request = fetch) {
  upstreamRequest = request;
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    try {
      void handle(JSON.parse(line));
    } catch {
      process.exitCode = 1;
    }
  }).on("close", () => {
    for (const value of running.values()) {
      value.abort();
    }
    process.exit(0);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDriveWorker();
}
export {
  startDriveWorker
};
