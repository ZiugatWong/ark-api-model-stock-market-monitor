// ==UserScript==
// @name         Ark API 模型股市监控
// @description  Ark 模型股市数据聚合分析与价格变动通知（game.arkengine.me）
// @namespace    http://tampermonkey.net/
// @version      1.0.9
// @author       ziugat
// @license      GPL-3.0
// @homepage     https://github.com/ZiugatWong/ark-api-model-stock-market-monitor
// @supportURL   https://github.com/ZiugatWong/ark-api-model-stock-market-monitor
// @icon         https://img.cdn1.vip/i/69be11f7070b0_1774064119.webp
// @match        https://game.arkengine.me/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/lightweight-charts@4.0.1/dist/lightweight-charts.standalone.production.js
// ==/UserScript==

(function () {
  "use strict";

  // ==================== 配置 ====================
  const CONFIG = {
    STORAGE_KEY: "ark_game_stock_data",
    LEGACY_STORAGE_KEY: "windhub_stock_data",
    TABLE_DISPLAY_LIMIT: 5,
    CACHE_DURATION: 5 * 60 * 1000,
    MODEL_COLORS: [
      { name: "红", value: "#F55454" },
      { name: "绿", value: "#00A854" },
      { name: "黄", value: "#EAB308" },
      { name: "橙", value: "#F97316" },
      { name: "粉", value: "#EC4899" },
      { name: "青", value: "#06B6D4" },
    ],
  };

  const DEFAULT_DATA = {
    // 监控的 stockId 数组
    stockIds: [],
    autoTriggerMinuteEnds: "3,8",
    autoTrigger: false,
    lastUpdateTime: null,
    // 模型名称映射（stockId → modelName），每次拉取刷新；模型选择器从 Object.keys 取列表
    idToModel: {},
    // 上次模型列表拉取时间（用于 fetchAvailableModels 缓存判断）
    availableModelsLastFetched: null,
    notificationSettings: {
      enablePopup: false,
      enableSound: false,
      enableTelegram: false,
      telegramBotToken: null,
      telegramChatId: null,
      enableBark: false,
      barkUrl: null,
    },
    // 键为 stockId
    notifications: {},
    priceData: {},
    // 单一实时榜，元素含 stockId + model_name（展示用冗余）
    arbitrageData: [],
    // 键为 stockId
    positions: {},
    // 交易历史（键为 stockId，仅记录通过本脚本成功买入/卖出的记录）
    tradeHistory: {},
    modelColors: {},
    priceDataDaysLimit: 7,
    lastPriceDataCleanDate: null,
    dataServiceUrl: "http://localhost:3210",
    // 市场状态与规则快照
    marketRules: { enabled: null, rules: null },
    // 可用代币（来自 /api/me/balance 的 tokens）
    userTokens: null,
    // 持仓总值（本地累加，代币口径）
    holdingsTotalValue: null,
    theme: "dark",
    // 旧版数据迁移标志（迁移成功后置 true，避免每次启动重复迁移覆盖用户新设置）
    legacyMigrated: false,
  };

  // ==================== 存储 ====================
  const Storage = {
    _cache: null,
    _persistTimer: null,

    load() {
      if (this._cache) return this._cache;

      const raw = GM_getValue(CONFIG.STORAGE_KEY, null);
      if (!raw) {
        this._cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
        return this._cache;
      }
      try {
        const d = typeof raw === "string" ? JSON.parse(raw) : raw;
        this._cache = {
          stockIds: d.stockIds || [],
          autoTriggerMinuteEnds: d.autoTriggerMinuteEnds || "1,6",
          autoTrigger: !!d.autoTrigger,
          priceData: d.priceData || {},
          lastUpdateTime: d.lastUpdateTime || null,
          idToModel: d.idToModel || {},
          availableModelsLastFetched: d.availableModelsLastFetched || null,
          notificationSettings: d.notificationSettings || {
            enablePopup: false,
            enableSound: false,
            enableTelegram: false,
            telegramBotToken: null,
            telegramChatId: null,
            enableBark: false,
            barkUrl: null,
          },
          notifications: d.notifications || {},
          arbitrageData: d.arbitrageData || [],
          positions: d.positions || {},
          tradeHistory: d.tradeHistory || {},
          modelColors: d.modelColors || {},
          priceDataDaysLimit: d.priceDataDaysLimit || 7,
          lastPriceDataCleanDate: d.lastPriceDataCleanDate || null,
          dataServiceUrl: d.dataServiceUrl || "http://localhost:3210",
          marketRules: d.marketRules || { enabled: null, rules: null },
          userTokens: d.userTokens !== undefined ? d.userTokens : null,
          holdingsTotalValue:
            d.holdingsTotalValue !== undefined ? d.holdingsTotalValue : null,
          theme: d.theme === "light" ? "light" : "dark",
          legacyMigrated: !!d.legacyMigrated,
        };
        return this._cache;
      } catch {
        this._cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
        return this._cache;
      }
    },

    save(data) {
      this._cache = data;
      this._schedulePersist();
    },

    _schedulePersist() {
      if (this._persistTimer) clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => {
        GM_setValue(CONFIG.STORAGE_KEY, this._cache);
        this._persistTimer = null;
      }, 100);
    },

    flush() {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      if (this._cache) {
        GM_setValue(CONFIG.STORAGE_KEY, this._cache);
      }
    },

    // 从旧版 windhub_stock_data 迁移数据（主键 modelName → stockId）
    async migrateFromLegacy() {
      // 已迁移过则跳过，避免每次启动重复迁移覆盖用户新设置
      if (Storage.load().legacyMigrated) return;

      const raw = GM_getValue(CONFIG.LEGACY_STORAGE_KEY, null);
      if (!raw) {
        // 无旧数据，直接置标志位
        const d = this.load();
        d.legacyMigrated = true;
        this.save(d);
        return;
      }

      let oldData;
      try {
        oldData = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return;
      }

      const newData = this.load();

      // 1. 直接迁移与主键无关的通用配置
      newData.theme = oldData.theme === "light" ? "light" : "dark";
      newData.priceDataDaysLimit = oldData.priceDataDaysLimit ?? 7;
      newData.notificationSettings =
        oldData.notificationSettings ?? newData.notificationSettings;
      newData.autoTrigger = !!oldData.autoTrigger;
      newData.autoTriggerMinuteEnds = oldData.autoTriggerMinuteEnds ?? "3,8";
      newData.dataServiceUrl = oldData.dataServiceUrl ?? newData.dataServiceUrl;

      this.save(newData);

      // 2. 调用一次 API 查表，重建主键为 stockId 的数据
      try {
        const resp = await API.fetchMarketData();
        if (resp && Array.isArray(resp.stocks)) {
          // 构建 modelName → stockId 反查表
          const nameToId = {};
          for (const s of resp.stocks) nameToId[s.modelName] = s.id;

          // 重建 stockIds（旧存 modelName 数组 → stockId 数组）
          if (Array.isArray(oldData.models)) {
            newData.stockIds = oldData.models
              .map((name) => nameToId[name])
              .filter((id) => id !== undefined);
          }

          // 重建 notifications（旧键 modelName → stockId）
          if (oldData.notifications) {
            newData.notifications = {};
            for (const [name, cfg] of Object.entries(oldData.notifications)) {
              const id = nameToId[name];
              if (id !== undefined) newData.notifications[id] = cfg;
            }
          }

          // 重建 modelColors（旧键 modelName → stockId）
          if (oldData.modelColors) {
            newData.modelColors = {};
            for (const [name, color] of Object.entries(oldData.modelColors)) {
              const id = nameToId[name];
              if (id !== undefined) newData.modelColors[id] = color;
            }
          }

          // 刷新 idToModel 映射（模型选择器从 Object.keys 取列表）
          newData.idToModel = {};
          for (const s of resp.stocks) newData.idToModel[s.id] = s.modelName;
          newData.availableModelsLastFetched = Date.now();

          // 查表重建成功，置迁移完成标志（失败则不置，下次启动重试）
          newData.legacyMigrated = true;
          this.save(newData);

          // 迁移成功，删除旧数据（避免长期占用 storage 空间）
          GM_deleteValue(CONFIG.LEGACY_STORAGE_KEY);
        }
      } catch (e) {
        console.error("[Ark Stock Monitor] 旧数据迁移查表失败:", e);
        // 查表失败时通用配置已迁移，主键数据留待下次重试或用户手动重建
        // 旧数据保留不删除，供下次迁移重试
      }

      // 3. priceData / positions / arbitrageData / holdingsTotalValue 不迁移：
      //    priceData 单位与时间戳语义变更；其余 doFetch 会重写

      console.log("[Ark Stock Monitor] 旧数据迁移完成");
    },
  };

  // ==================== 主题 ====================
  const Theme = {
    current() {
      return Storage.load().theme === "light" ? "light" : "dark";
    },

    // Lightweight Charts 画布配色（canvas 不读 CSS 变量，需用字面量）
    chartColors(theme) {
      if (theme === "light") {
        return {
          bg: "#ffffff",
          text: "#4b5563",
          grid: "#eceff3",
          scaleBorder: "#d6dce3",
          line: "#1c7ed6",
        };
      }
      return {
        bg: "#1a1a1a",
        text: "#d1d4dc",
        grid: "#2b2b43",
        scaleBorder: "#2b2b43",
        line: "#4dabf7",
      };
    },

    apply(theme) {
      const isLight = theme === "light";
      document.body.classList.toggle("ark-theme-light", isLight);

      // 同步主面板切换按钮图标/title
      const btn = document.querySelector("#ark-theme-toggle-btn");
      if (btn) {
        btn.textContent = isLight ? "☀" : "\u{1F319}";
        btn.title = isLight ? "切换到夜间主题" : "切换到日间主题";
      }

      // 已打开的图表实时刷新（面板外壳/tooltip 走 CSS 变量自动翻转，无需处理）
      const mgr = ChartManager._manager;
      if (mgr && mgr.chartInstances) {
        const c = this.chartColors(theme);
        for (const inst of mgr.chartInstances.values()) {
          try {
            if (inst.chart) {
              inst.chart.applyOptions({
                layout: {
                  background: { type: "solid", color: c.bg },
                  textColor: c.text,
                },
                grid: {
                  vertLines: { color: c.grid },
                  horzLines: { color: c.grid },
                },
                rightPriceScale: { borderColor: c.scaleBorder },
                timeScale: { borderColor: c.scaleBorder },
              });
            }
            if (inst.series) {
              inst.series.applyOptions({
                color: c.line,
                crosshairMarkerBackgroundColor: c.line,
              });
            }
          } catch (e) {
            console.error("[Ark Stock Monitor] 图表主题切换失败:", e);
          }
        }
      }
    },

    toggle() {
      const d = Storage.load();
      const next = d.theme === "light" ? "dark" : "light";
      d.theme = next;
      Storage.save(d);
      this.apply(next);
    },
  };

  // ==================== 工具函数 ====================
  const Utils = {
    getBaseUrl() {
      return window.location.origin;
    },

    escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    },

    // 模型名展示：通过 idToModel 反查，找不到则回退显示 id
    getModelName(stockId) {
      const data = Storage.load();
      return data.idToModel?.[stockId] ?? String(stockId);
    },

    pad(n) {
      return String(n).padStart(2, "0");
    },

    // 千分位分隔（支持小数，仅对整数部分分隔）
    formatThousands(value) {
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        isNaN(Number(value))
      )
        return "-";
      const num = Number(value);
      const [intPart, decPart] = String(num).split(".");
      const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return decPart ? `${formattedInt}.${decPart}` : formattedInt;
    },

    formatDateTime(timestampMs, format = "full") {
      const date = new Date(timestampMs);
      const year = date.getFullYear();
      const month = this.pad(date.getMonth() + 1);
      const day = this.pad(date.getDate());
      const hours = this.pad(date.getHours());
      const minutes = this.pad(date.getMinutes());
      const seconds = this.pad(date.getSeconds());

      switch (format) {
        case "date":
          return `${year}-${month}-${day}`;
        case "time":
          return `${hours}:${minutes}:${seconds}`;
        case "short":
          return `${month}-${day} ${hours}:${minutes}:${seconds}`;
        case "full":
        default:
          return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      }
    },

    formatSecondsTimestamp(secondsTimestamp, format = "full") {
      return this.formatDateTime(secondsTimestamp * 1000, format);
    },

    getCurrentTimestamp() {
      return Date.now();
    },

    getCurrentSecondsTimestamp() {
      return Math.floor(Date.now() / 1000);
    },

    calculateStorageSize() {
      const data = Storage.load();
      const jsonString = JSON.stringify(data);
      const sizeInBytes = new Blob([jsonString]).size;

      // 格式化展示
      if (sizeInBytes < 1024) {
        return `${sizeInBytes} B`;
      } else if (sizeInBytes < 1024 * 1024) {
        return `${(sizeInBytes / 1024).toFixed(2)} KB`;
      } else {
        return `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
      }
    },

    // 转换 stock-data-service 返回的数据格式（主键为 stockId）
    convertPriceDataFormat(serviceData) {
      // 输入: { 1: [{timestamp: 1718380800, price: 99.5}] }（key 为整数 stockId）
      // 输出: { "1": [["1718380800", 99.5]] }（key 归一化为整数字符串）
      const converted = {};
      for (const [stockId, records] of Object.entries(serviceData)) {
        if (!records || records.length === 0) continue;
        // key 归一化为整数字符串，与本地 priceData 的键保持一致
        converted[Number(stockId)] = records.map((r) => [
          Number(r.timestamp),
          r.price,
        ]);
      }
      return converted;
    },

    // 智能合并价格数据
    mergePriceData(existingData, newData) {
      // existingData: 当前存储的 data.priceData
      // newData: 从服务获取的数据（已转换格式）

      const merged = { ...existingData };
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const [stockId, newRecords] of Object.entries(newData)) {
        if (!newRecords || newRecords.length === 0) continue;

        // 获取新数据的时间范围
        const newTimestamps = newRecords.map((r) => r[0]);
        const minTs = Math.min(...newTimestamps);
        const maxTs = Math.max(...newTimestamps);

        // 获取现有数据
        const existing = merged[stockId] || [];

        // 删除时间范围内的现有数据
        const filtered = existing.filter((record) => {
          const ts = record[0];
          return ts < minTs || ts > maxTs;
        });

        totalRemoved += existing.length - filtered.length;

        // 合并新数据
        merged[stockId] = [...filtered, ...newRecords];

        // 按时间戳排序
        merged[stockId].sort((a, b) => a[0] - b[0]);

        totalAdded += newRecords.length;
      }

      return { merged, totalAdded, totalRemoved };
    },
  };

  // 时间格式化工具
  const TimeUtils = {
    pad: Utils.pad,
    formatDateTime: Utils.formatDateTime,
    formatSecondsTimestamp: Utils.formatSecondsTimestamp,
    getCurrentTimestamp: Utils.getCurrentTimestamp,
    getCurrentSecondsTimestamp: Utils.getCurrentSecondsTimestamp,
  };

  // ==================== API ====================
  const API = {
    // GET /api/stock — 市场行情（同源 cookie 鉴权）
    fetchMarketData() {
      return fetch(`${Utils.getBaseUrl()}/api/stock`, {
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "cache-control": "no-cache",
        },
        credentials: "include",
        method: "GET",
      }).then((resp) => {
        if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
        return resp.json();
      });
    },

    // GET /api/me/balance — 代币余额（取 tokens）
    fetchBalance() {
      return fetch(`${Utils.getBaseUrl()}/api/me/balance`, {
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "cache-control": "no-cache",
        },
        credentials: "include",
        method: "GET",
      }).then((resp) => {
        if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
        return resp.json();
      });
    },

    // 买入/卖出面板专用：并行拉取行情与余额（纯展示用，不写 Storage）
    async fetchTradePanelData() {
      const requestedAt = Date.now(); // 数据时间 = 发起请求的时间
      const [market, balance] = await Promise.all([
        this.fetchMarketData(),
        // 余额失败不阻塞行情展示，渲染时按 null 显示 "-"
        this.fetchBalance().catch(() => null),
      ]);
      return { requestedAt, market, balance };
    },

    fetchAvailableModels(forceRefresh = false) {
      const data = Storage.load();
      const now = Date.now();
      const cachedKeys = Object.keys(data.idToModel || {});

      if (
        !forceRefresh &&
        data.availableModelsLastFetched &&
        cachedKeys.length > 0 &&
        now - data.availableModelsLastFetched < CONFIG.CACHE_DURATION
      ) {
        return Promise.resolve(cachedKeys);
      }

      return this.fetchMarketData()
        .then((response) => {
          if (response && Array.isArray(response.stocks)) {
            const stockIds = response.stocks.map((s) => s.id);
            // 仅刷新 idToModel 映射，模型选择器从 Object.keys 取列表
            data.idToModel = {};
            for (const s of response.stocks) data.idToModel[s.id] = s.modelName;
            data.availableModelsLastFetched = now;
            Storage.save(data);
            return stockIds;
          }
          return cachedKeys;
        })
        .catch((error) => {
          console.error("[Ark Stock Monitor] 获取模型列表失败:", error);
          return cachedKeys;
        });
    },

    async syncBatchData(serviceUrl, endpoint, payload) {
      // 通用的批量数据同步函数
      return new Promise((resolve, reject) => {
        const url = `${serviceUrl.replace(/\/$/, "")}${endpoint}`;

        GM_xmlhttpRequest({
          method: "POST",
          url: url,
          headers: {
            "Content-Type": "application/json",
          },
          data: JSON.stringify(payload),
          timeout: 30000,
          onload: (response) => {
            try {
              if (response.status !== 200) {
                reject(
                  new Error(
                    `请求失败: HTTP ${response.status} ${response.statusText}`,
                  ),
                );
                return;
              }

              const result = JSON.parse(response.responseText);

              if (!result.success) {
                reject(new Error(result.error || "服务返回失败"));
                return;
              }

              resolve(result.data);
            } catch (e) {
              reject(new Error(`解析响应失败: ${e.message}`));
            }
          },
          onerror: () => {
            reject(new Error("网络请求失败，请检查服务地址"));
          },
          ontimeout: () => {
            reject(new Error("请求超时（30秒）"));
          },
        });
      });
    },

    // POST /api/stock — 买入/卖出（同源 cookie 鉴权）
    async submitTrade({ action, stockId, shares }) {
      const payload = {
        action, // "buy" | "sell"
        idempotencyKey: `stock:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        modelName: Utils.getModelName(stockId),
        shares,
      };
      const resp = await fetch(`${Utils.getBaseUrl()}/api/stock`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      let body = null;
      try {
        body = await resp.json();
      } catch {
        // 非 JSON 响应体，忽略
      }
      if (!resp.ok) {
        // 错误体格式未知，保守提取：优先 message / error 字段，回退 HTTP 状态码
        const msg =
          (body && (body.message || body.error)) || `交易失败: ${resp.status}`;
        throw new Error(msg);
      }
      return body; // { replayed, tradeId, totalTokens, balanceAfter }
    },
  };

  // ==================== 数据处理 ====================
  const DataProcessor = {
    // 处理市场行情数据。
    // 注意：response.stocks[].id（即 stockId）是数字而非字符串（API 返回数值型 id），
    // 因此本函数写入的 priceData 键、deduplicatedStockIds 元素、positions 键、
    // arbitrageData[].stockId 等均为 number。下游做 Set.has / Array.includes 等
    // 类型敏感比较时，需确保参与比较的另一方也是 number，否则 "123" !== 123 会漏匹配
    // （见 checkNotifications 中对 notifications 字符串键的 Number() 归一处理）。
    processMarketData(response) {
      if (!response || !Array.isArray(response.stocks)) {
        return { data: null, deduplicatedStockIds: [] };
      }

      const data = Storage.load();
      const stocks = response.stocks;
      const monitoredIdSet = new Set(data.stockIds); // stockIds 即用户监控的 stockId 数组
      const deduplicatedStockIds = []; // 收集"无新数据点"的 stockId

      // 缓存市场状态与规则
      data.marketRules = { enabled: response.enabled, rules: response.rules };

      // 刷新 idToModel 映射 + 构建现价映射（stockId → 代币）
      const idToModel = {};
      const priceMap = {}; // stockId → 现价(代币)
      for (const s of stocks) {
        idToModel[s.id] = s.modelName;
        priceMap[s.id] = s.priceCents / 100;
      }
      data.idToModel = idToModel;

      // 价格历史：用 stale=false 过滤活跃（新鲜）模型，ticks 前 n 条与活跃模型按 stockId 一一对应
      // 注：stale=false 表示数据新鲜（本轮有 tick），stale=true 表示数据陈旧（无 tick）。
      //     ticks 每轮把活跃模型放最前面，前 n 条与活跃模型一一对应（不重复，降序）。
      const activeStocks = stocks.filter((s) => s.stale === false);
      const n = activeStocks.length;
      const ticks = Array.isArray(response.ticks) ? response.ticks : [];
      const ticksSlice = ticks.slice(0, n);

      // 时间戳归一化：收集所有活跃 tick 的时间戳，统一为最大时间戳
      const activeTimestamps = ticksSlice.map((t) =>
        Math.floor(Date.parse(t.createdAt) / 1000),
      );

      let unifiedTimestamp = null;
      if (activeTimestamps.length > 0) {
        const maxTimestamp = Math.max(...activeTimestamps);
        const minTimestamp = Math.min(...activeTimestamps);

        // 如果最大最小时间戳差距超过 5 分钟（300 秒），说明存在旧数据
        // 过滤掉超过 5 分钟的旧数据，只保留最新一批
        const threshold =
          maxTimestamp - minTimestamp > 300 ? maxTimestamp - 300 : minTimestamp;

        // 统一时间戳为最大时间戳
        unifiedTimestamp = maxTimestamp;

        // 过滤 ticksSlice，只保留时间戳 >= threshold 的 tick
        const filteredTicksSlice = ticksSlice.filter((t) => {
          const ts = Math.floor(Date.parse(t.createdAt) / 1000);
          return ts >= threshold;
        });

        // 重新构建 tickByStockId，使用统一时间戳
        var tickByStockId = {}; // stockId → 统一后的时间戳
        for (const t of filteredTicksSlice) {
          if (tickByStockId[t.stockId] === undefined) {
            tickByStockId[t.stockId] = unifiedTimestamp;
          }
        }
      } else {
        var tickByStockId = {};
      }

      for (const s of activeStocks) {
        if (!monitoredIdSet.has(s.id)) continue; // 仅处理用户监控的 stockId
        const price = parseFloat((s.priceCents / 100).toFixed(2));
        const ts = tickByStockId[s.id];
        if (ts === undefined) continue; // 无对应 tick，跳过

        if (!data.priceData[s.id]) data.priceData[s.id] = [];
        const list = data.priceData[s.id];
        if (list.length && list[list.length - 1][0] === ts) {
          deduplicatedStockIds.push(s.id); // 同时间戳已存在
        } else {
          list.push([ts, price]);
        }
      }

      // 持仓处理（费率从 rules 取，回退默认 2%/2.5%；键=stockId）
      const buyFee = (response.rules?.buyFeePct ?? 2) / 100;
      const sellFee = (response.rules?.sellFeePct ?? 2.5) / 100;
      const round2 = (n) => parseFloat(n.toFixed(2));

      data.positions = {};
      if (Array.isArray(response.positions)) {
        for (const pos of response.positions) {
          const modelName = idToModel[pos.stockId] ?? null;
          const avgCost = pos.avgCostCents / 100;
          const currentPrice = priceMap[pos.stockId] ?? null;
          const costWithFee = round2(avgCost * pos.shares * (1 + buyFee));
          const incomeAfterFee =
            currentPrice !== null
              ? round2(currentPrice * pos.shares * (1 - sellFee))
              : null;
          const actualPnl =
            incomeAfterFee !== null
              ? round2(incomeAfterFee - costWithFee)
              : null;
          const pnlPercent =
            incomeAfterFee !== null && costWithFee !== 0
              ? round2((actualPnl / costWithFee) * 100)
              : null;
          data.positions[pos.stockId] = {
            stockId: pos.stockId,
            model_name: modelName, // 冗余存名称便于渲染
            shares: pos.shares,
            avg_cost: round2(avgCost),
            locked_until: pos.holdUntil
              ? Math.floor(Date.parse(pos.holdUntil) / 1000)
              : 0,
            current_price: currentPrice !== null ? round2(currentPrice) : null,
            cost_with_fee: costWithFee,
            income_after_fee: incomeAfterFee,
            actual_pnl: actualPnl,
            pnl_percent: pnlPercent,
          };
        }
      }

      // 持仓总值本地累加（代币口径）
      let holdingsTotal = 0;
      for (const sid of Object.keys(data.positions)) {
        const p = data.positions[sid];
        if (p.current_price !== null)
          holdingsTotal += p.current_price * p.shares;
      }
      data.holdingsTotalValue = round2(holdingsTotal);

      // 检查是否需要清理旧数据（每天只清理一次）
      const today = new Date()
        .toLocaleDateString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
        .replace(/\//g, "-");

      if (data.lastPriceDataCleanDate !== today) {
        // 计算 (N-1) 天前的0点时间戳，保留最近N个自然天
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - (data.priceDataDaysLimit - 1));
        daysAgo.setHours(0, 0, 0, 0);
        const cutoffTime = Math.floor(daysAgo.getTime() / 1000);

        for (const stockId of Object.keys(data.priceData)) {
          data.priceData[stockId] = data.priceData[stockId].filter((item) => {
            const ts = item[0];
            return ts >= cutoffTime;
          });
        }
        data.lastPriceDataCleanDate = today;
      }

      Storage.save(data);
      return { data, deduplicatedStockIds };
    },

    processArbitrageData(response) {
      if (!response || !Array.isArray(response.stocks)) return [];

      // 映射全部模型（不再按 stale 过滤）；元素含 stockId + model_name + stale（展示用冗余）。
      // high_24h/low_24h 保留自接口的 24h 最高/最低，同时被图表（今日高/低线）消费。
      const list = response.stocks.map((s) => {
        const high = s.high24hCents / 100;
        const low = s.low24hCents / 100;
        return {
          stockId: s.id,
          model_name: s.modelName,
          stale: s.stale === true, // true=行情停滞
          high_24h: parseFloat(high.toFixed(2)),
          low_24h: parseFloat(low.toFixed(2)),
        };
      });

      const data = Storage.load();
      data.arbitrageData = list;
      Storage.save(data);

      return list;
    },

    // deduplicatedStockIds 即 stockId 数组
    checkNotifications(deduplicatedStockIds) {
      const data = Storage.load();
      const notifications = data.notifications;
      const settings = data.notificationSettings;

      if (
        !settings.enablePopup &&
        !settings.enableSound &&
        !settings.enableTelegram &&
        !settings.enableBark
      ) {
        return;
      }

      const notificationKeys = Object.keys(notifications);
      if (notificationKeys.length === 0) return;

      const triggered = [];
      const monitoredIds = new Set(data.stockIds);

      for (const key of notificationKeys) {
        const stockId = Number(key);
        if (!monitoredIds.has(stockId)) continue;
        if (deduplicatedStockIds.includes(stockId)) continue;

        const config = notifications[stockId];
        const modelData = data.priceData[stockId];
        if (!modelData || modelData.length < 2) continue;

        const latest = modelData[modelData.length - 1];
        const previous = modelData[modelData.length - 2];
        const latestPrice = latest[1];
        const previousPrice = previous[1];

        if (config.upperLimit !== null && config.upperLimit !== undefined) {
          if (
            previousPrice < config.upperLimit &&
            latestPrice >= config.upperLimit
          ) {
            triggered.push({
              model: Utils.getModelName(stockId),
              price: latestPrice,
              limit: config.upperLimit,
              type: "upper",
            });
          }
        }

        if (config.lowerLimit !== null && config.lowerLimit !== undefined) {
          if (
            previousPrice > config.lowerLimit &&
            latestPrice <= config.lowerLimit
          ) {
            triggered.push({
              model: Utils.getModelName(stockId),
              price: latestPrice,
              limit: config.lowerLimit,
              type: "lower",
            });
          }
        }
      }

      if (triggered.length > 0) {
        Notification.sendBatch(triggered);
      }
    },

    // 记录一次通过本脚本成功买/卖的交易（仅本地保存，接口不提供交易历史）
    // 记录字段沿用旧版 windhub 脚本：{ id, side, shares, price, gross, fee, net, created_at }
    // 主键策略：tradeHistory 以 stockId 为键（见模块头注释），展示模型名时经 idToModel 查表
    recordTrade({ id, side, stockId, shares, price, feePct }) {
      if (!stockId || !shares || price == null) return;
      const gross = shares * price; // 成交额（代币）
      const fee = gross * (feePct / 100); // 手续费（代币）
      // net 为带符号的余额变化：买入支付本金+手续费为负，卖出收入本金-手续费为正
      const net = side === "buy" ? -(gross + fee) : gross - fee;
      const record = {
        id:
          id != null
            ? id
            : `trade:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        side, // "buy" | "sell"
        shares,
        price,
        gross,
        fee,
        net,
        created_at: Math.floor(Date.now() / 1000),
      };

      const data = Storage.load();
      const list = data.tradeHistory || {};
      const existing = list[stockId] || [];
      // 按 id 去重（幂等重放可能返回同一 tradeId，避免重复记录）
      if (existing.some((t) => t.id === record.id)) return; // 已存在，仅防御；正常只写一次
      list[stockId] = [...existing, record].sort((a, b) => a.id - b.id);
      data.tradeHistory = list;
      Storage.save(data);
      return record;
    },
  };

  // ==================== 通知 ====================
  const Notification = {
    playSound() {
      try {
        const audioCtx = new (
          window.AudioContext || window.webkitAudioContext
        )();
        const playTone = (freq, startTime, duration) => {
          const oscillator = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          oscillator.type = "sine";
          oscillator.frequency.value = freq;
          gainNode.gain.setValueAtTime(0.4, startTime);
          gainNode.gain.exponentialRampToValueAtTime(
            0.01,
            startTime + duration,
          );
          oscillator.start(startTime);
          oscillator.stop(startTime + duration);
        };
        playTone(880, audioCtx.currentTime, 0.15);
        playTone(440, audioCtx.currentTime + 0.15, 0.25);
        playTone(880, audioCtx.currentTime + 0.55, 0.15);
        playTone(440, audioCtx.currentTime + 0.7, 0.25);
      } catch (e) {
        console.error("[Ark Stock Monitor] 播放提示音失败:", e);
      }
    },

    showPopup(triggered) {
      const count = triggered.length;
      const borderColor = triggered[0].type === "upper" ? "#ff6b6b" : "#4caf50";

      let content = `<div style="position: absolute; top: 8px; right: 12px; font-size: 20px; color: var(--ark-muted); cursor: pointer; line-height: 1;" onclick="this.parentElement.remove()">&times;</div>`;
      content += `<div style="font-size: 18px; font-weight: 600; margin-bottom: 15px; color: ${borderColor}">`;
      content += `🔔 价格突破提醒 (${count}个模型)</div>`;
      content += `<div style="border-top: 1px solid var(--ark-border-2); padding-top: 10px; margin-top: 10px;">`;

      triggered.forEach((item) => {
        const label = item.type === "upper" ? "突破上限" : "突破下限";
        content += `<div style="margin: 10px 0; padding: 8px; background: var(--ark-popup-item); border-radius: 6px;">`;
        content += `<div style="margin: 4px 0;">模型: <strong>${Utils.escapeHtml(item.model)}</strong></div>`;
        content += `<div style="margin: 4px 0;">当前价格: <strong class="price-pulse" style="font-size: 28px;">${item.price.toFixed(2)}</strong></div>`;
        content += `<div style="margin: 4px 0;">${label}: <strong>${item.limit}</strong></div>`;
        content += `</div>`;
      });

      content += `</div>`;
      content += `<div style="border-top: 1px solid var(--ark-border-2); padding-top: 10px; margin-top: 15px; font-size: 12px; color: var(--ark-muted);">`;
      content += `时间: ${TimeUtils.formatDateTime(Date.now())}</div>`;

      const notificationEl = document.createElement("div");
      notificationEl.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 20px 25px;
        background: var(--ark-popup-bg);
        border: 2px solid ${borderColor};
        border-radius: 12px;
        color: var(--ark-text);
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        text-align: center;
        box-shadow: 0 8px 32px var(--ark-shadow);
        max-width: 400px;
        width: 90%;
        max-height: 80vh;
        overflow-y: auto;
        cursor: move;
      `;
      notificationEl.innerHTML = content;
      document.body.appendChild(notificationEl);

      let isDragging = false;
      let dragOffsetX, dragOffsetY;

      notificationEl.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON" || e.target.closest("[onclick]"))
          return;
        isDragging = true;
        const rect = notificationEl.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        notificationEl.style.cursor = "grabbing";
        notificationEl.style.transform = "none";
        notificationEl.style.top = rect.top + "px";
        notificationEl.style.left = rect.left + "px";
        notificationEl.style.right = "auto";
      });

      const onMouseMove = (e) => {
        if (!isDragging) return;
        notificationEl.style.left = e.clientX - dragOffsetX + "px";
        notificationEl.style.top = e.clientY - dragOffsetY + "px";
      };

      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          notificationEl.style.cursor = "move";
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },

    sendTelegram(triggered) {
      const settings = Storage.load().notificationSettings;
      const token = settings.telegramBotToken;
      const chatId = settings.telegramChatId;

      if (!token || !chatId) {
        console.warn("[Ark Stock Monitor] Telegram 未配置");
        return;
      }

      const count = triggered.length;
      let message = `🔔 价格突破提醒 (${count}个模型)\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;

      triggered.forEach((item) => {
        const label = item.type === "upper" ? "突破上限" : "突破下限";
        message += `模型: ${item.model}\n`;
        message += `当前价格: ${item.price.toFixed(2)}\n`;
        message += `${label}: ${item.limit}\n\n`;
      });

      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `时间: ${TimeUtils.formatDateTime(Date.now())}`;

      GM_xmlhttpRequest({
        method: "POST",
        url: `https://api.telegram.org/bot${token}/sendMessage`,
        data: JSON.stringify({ chat_id: chatId, text: message }),
        headers: { "Content-Type": "application/json" },
        onload(response) {
          try {
            const result = JSON.parse(response.responseText);
            if (result.ok) {
              console.log("[Ark Stock Monitor] Telegram 批量通知发送成功");
            } else {
              console.error(
                "[Ark Stock Monitor] Telegram 批量通知发送失败:",
                result.description,
              );
            }
          } catch (e) {
            console.error("[Ark Stock Monitor] 解析 Telegram 响应失败:", e);
          }
        },
        onerror(error) {
          console.error("[Ark Stock Monitor] Telegram 请求失败:", error);
        },
      });
    },

    sendBark(triggered) {
      const settings = Storage.load().notificationSettings;
      const barkUrl = settings.barkUrl;

      if (!barkUrl) {
        console.warn("[Ark Stock Monitor] Bark 未配置");
        return;
      }

      const count = triggered.length;
      let title = `🔔 价格突破提醒`;
      let body = `${count}个模型触发通知\n`;

      triggered.forEach((item, index) => {
        const label = item.type === "upper" ? "突破上限" : "突破下限";
        body += `\n${index + 1}. ${item.model}\n`;
        body += `   价格: ${item.price.toFixed(2)} | ${label}: ${item.limit}`;
      });

      body += `\n\n时间: ${TimeUtils.formatDateTime(Date.now())}`;

      // Bark URL 格式: https://api.day.app/YOUR_KEY/title/body?params
      // 或者用 POST 方式
      const urlEncoded = `${barkUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=股市监控&sound=alarm&level=timeSensitive`;

      GM_xmlhttpRequest({
        method: "GET",
        url: urlEncoded,
        onload(response) {
          try {
            const result = JSON.parse(response.responseText);
            if (result.code === 200) {
              console.log("[Ark Stock Monitor] Bark 批量通知发送成功");
            } else {
              console.error(
                "[Ark Stock Monitor] Bark 批量通知发送失败:",
                result.message,
              );
            }
          } catch (e) {
            console.error("[Ark Stock Monitor] 解析 Bark 响应失败:", e);
          }
        },
        onerror(error) {
          console.error("[Ark Stock Monitor] Bark 请求失败:", error);
        },
      });
    },

    sendBatch(triggered) {
      const settings = Storage.load().notificationSettings;
      if (settings.enablePopup) this.showPopup(triggered);
      if (settings.enableSound) this.playSound();
      if (settings.enableTelegram) this.sendTelegram(triggered);
      if (settings.enableBark) this.sendBark(triggered);
    },

    sendTest() {
      const settings = Storage.load().notificationSettings;
      const enabledCount = [
        settings.enablePopup,
        settings.enableSound,
        settings.enableTelegram,
        settings.enableBark,
      ].filter(Boolean).length;
      if (enabledCount === 0) {
        alert("没有启用任何通知方式，请在设置中开启至少一种通知方式");
        return;
      }
      this.sendBatch([
        { model: "测试模型", price: 100.0, limit: 90.0, type: "upper" },
      ]);
    },
  };

  // ==================== 定时任务 ====================
  const Scheduler = {
    timerInterval: null,

    start() {
      if (this.timerInterval) return;

      // 计算到下一分钟的毫秒数，确保每次都在分钟开头执行
      const now = new Date();
      const delayToNextMinute =
        (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

      // 同步赋值setTimeout ID，防止等待阶段重复调用
      this.timerInterval = setTimeout(() => {
        this._checkAndTrigger();
        // 替换为interval的ID
        this.timerInterval = setInterval(() => {
          this._checkAndTrigger();
        }, 60 * 1000);
      }, delayToNextMinute);
    },

    _checkAndTrigger() {
      const data = Storage.load();
      if (!data.autoTrigger) return;

      const now = new Date();
      const minuteLastDigit = now.getMinutes() % 10;

      const ends = data.autoTriggerMinuteEnds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (ends.includes(String(minuteLastDigit))) {
        App.doFetch();
      }
    },

    stop() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    },
  };

  // ==================== 样式 ====================
  const Styles = {
    inject() {
      GM_addStyle(`
    /* ===== 主题调色板：:root 为夜间默认值，body.ark-theme-light 覆盖为日间值 ===== */
    :root {
      --ark-surface: #1a1a1a;
      --ark-elevated: #222;
      --ark-input: #2a2a2a;
      --ark-chip: #333;
      --ark-border: #333;
      --ark-border-2: #444;
      --ark-btn-2: #555;
      --ark-btn-2-hover: #666;
      --ark-text: #f0f0f0;
      --ark-text-strong: #ffffff;
      --ark-label: #cccccc;
      --ark-muted: #888;
      --ark-accent: #89b4fa;
      --ark-accent-2: #6ab0f3;
      --ark-shadow: rgba(0,0,0,0.5);
      --ark-overlay: rgba(26,26,26,0.8);
      --ark-tooltip-bg: rgba(26,26,26,0.9);
      --ark-popup-bg: rgba(26,26,26,0.95);
      --ark-popup-item: rgba(255,255,255,0.05);
    }

    @keyframes pricePulse {
      from { transform: scale(1); text-shadow: 0 0 0 transparent; }
      to { transform: scale(1.15); text-shadow: 0 0 10px currentColor; }
    }
    .price-pulse {
      display: inline-block;
      animation: pricePulse 0.5s ease-in-out infinite alternate;
    }
    @keyframes chart-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .chart-loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #444;
      border-top: 3px solid #4dabf7;
      border-radius: 50%;
      animation: chart-spin 1s linear infinite;
    }

    /* Button styles - link appearance */
    .ark-btn {
      background: none;
      border: none;
      padding: 0;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
      transition: color 0.2s ease;
    }
    .ark-btn-xs {
      font-size: 11px;
    }
    .ark-btn-primary {
      color: #339af0;
    }
    .ark-btn-primary:hover {
      color: #4dabf7;
    }
    .ark-btn-danger {
      color: #ff6b6b;
    }
    .ark-btn-danger:hover {
      color: #ff8787;
    }

    #ark-stock-panel {
      position: fixed;
      top: 60px;
      right: 20px;
      width: 400px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-stock-panel.visible { display: flex; }
    /* ===== 通用面板标题栏 ===== */
    .ark-panel-header {
      display: flex;
      align-items: center;
      padding: 10px 14px;
      background: #222;
      cursor: move;
      user-select: none;
      border-bottom: 1px solid #333;
      border-radius: 10px 10px 0 0;
    }
    .ark-panel-header .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ark-panel-header .header-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .ark-panel-header .title {
      font-weight: 600;
      font-size: 14px;
      color: #f0f0f0;
    }
    .ark-panel-header .close-btn {
      background: none;
      border: none;
      color: #ff6b6b;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-panel-header .close-btn:hover { color: #ff8e8e; }
    .ark-panel-header .data-maintenance-btn {
      background: none;
      border: none;
      color: var(--ark-muted);
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-panel-header .data-maintenance-btn:hover { color: #89b4fa; }
    .ark-panel-header .theme-toggle-btn {
      background: none;
      border: none;
      color: var(--ark-muted);
      font-size: 15px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-panel-header .theme-toggle-btn:hover { color: #89b4fa; }
    .ark-panel-header .settings-btn {
      background: none;
      border: none;
      color: var(--ark-muted);
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-panel-header .settings-btn:hover { color: #89b4fa; }
    /* 价格面板标题栏特有样式 */
    .ark-panel-header .info-btn-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .ark-panel-header .info-btn {
      background: none;
      border: none;
      font-size: 12px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      filter: grayscale(0.3);
      transition: filter 0.2s;
    }
    .ark-panel-header .info-btn:hover { filter: grayscale(0); }
    .ark-panel-header .info-tooltip {
      display: none;
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 6px;
      padding: 8px 12px;
      background: var(--ark-tooltip-bg, rgba(26,26,26,0.9));
      border: 1px solid var(--ark-border, #333);
      border-radius: 6px;
      color: var(--ark-text, #f0f0f0);
      font-size: 12px;
      white-space: nowrap;
      z-index: 2000;
      backdrop-filter: blur(4px);
      pointer-events: none;
      line-height: 1.8;
    }
    .ark-panel-header .info-btn-wrap:hover .info-tooltip { display: block; }
    #ark-stock-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-settings-panel {
      position: fixed;
      top: 60px;
      right: 560px;
      width: 480px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-settings-panel.visible { display: flex; }
    #ark-settings-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-data-maintenance-panel {
      position: fixed;
      top: 60px;
      right: 560px;
      width: 480px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-data-maintenance-panel.visible { display: flex; }
    #ark-data-maintenance-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-price-panel {
      position: fixed;
      top: 12.5vh;
      left: 50%;
      transform: translateX(-50%);
      min-width: 400px;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
    }
    #ark-price-panel.visible { display: flex; }
    #ark-price-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-trade-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 240px;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-trade-panel.visible { display: flex; }
    #ark-trade-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-positions-panel {
      position: fixed;
      top: 60px;
      right: 540px;
      width: max-content;
      max-width: 900px;
      min-width: 760px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-positions-panel.visible { display: flex; }
    #ark-positions-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-arbitrage-panel {
      position: fixed;
      top: 60px;
      right: 540px;
      width: max-content;
      max-width: 700px;
      min-width: 500px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
    }
    #ark-arbitrage-panel.visible { display: flex; }
    #ark-arbitrage-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }
    .ark-arbitrage-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ark-arbitrage-date-wrapper {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .ark-arbitrage-sort-select {
      background: #2a2a2a;
      color: #f0f0f0;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .ark-arbitrage-sort-select:focus {
      outline: none;
      border-color: #89b4fa;
    }
    .ark-arbitrage-filter-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--ark-label);
      cursor: pointer;
      white-space: nowrap;
    }
    .ark-arbitrage-filter-label input[type="checkbox"] {
      accent-color: #89b4fa;
      cursor: pointer;
    }
    .ark-arbitrage-table-wrap {
      max-height: 400px;
      overflow-y: auto;
    }
    .ark-arbitrage-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .ark-arbitrage-table th {
      background: #2a2a2a;
      padding: 8px 10px;
      text-align: center;
      font-weight: 600;
      color: var(--ark-label);
      border-bottom: 1px solid #444;
      position: sticky;
      top: 0;
    }
    .ark-arbitrage-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #333;
      text-align: center;
    }
    .ark-arbitrage-table tr:nth-child(even) td {
      background: #222;
    }
    .ark-arbitrage-table tr:hover td {
      background: #2a2a2a;
    }
    .ark-arbitrage-table .price-low { color: #F55454; }
    .ark-arbitrage-table .price-high { color: #00A854; }

    #ark-trades-panel {
      position: fixed;
      top: 60px;
      right: 540px;
      width: max-content;
      max-width: 900px;
      min-width: 600px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1998;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #ark-trades-panel.visible { display: flex; }
    #ark-trades-panel .panel-body {
      padding: 6px 10px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }
    .ark-trades-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .ark-trades-model-select {
      background: #2a2a2a;
      color: #f0f0f0;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      min-width: 240px;
    }
    .ark-trades-model-select:focus {
      outline: none;
      border-color: #89b4fa;
    }
    .ark-trades-count {
      color: var(--ark-label);
      font-size: 12px;
    }
    .ark-trades-note {
      color: var(--ark-muted);
      font-size: 11px;
      margin-bottom: 8px;
    }
    .ark-trades-table-wrap {
      max-height: 400px;
      overflow-y: auto;
    }
    .ark-trades-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .ark-trades-table th {
      background: #2a2a2a;
      padding: 8px 10px;
      text-align: center;
      font-weight: 600;
      color: var(--ark-label);
      border-bottom: 1px solid #444;
      position: sticky;
      top: 0;
    }
    .ark-trades-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #333;
      text-align: center;
    }
    .ark-trades-table tr:nth-child(even) td {
      background: #222;
    }
    .ark-trades-table tr:hover td {
      background: #2a2a2a;
    }
    .ark-trades-table td.side-buy { color: #F55454; }
    .ark-trades-table td.side-sell { color: #00A854; }

    .ark-market-entrance {
      display: flex;
      justify-content: center;
      gap: 20px;
      padding: 16px;
    }
    .ark-latest-price-link, .ark-historical-trades-link, .ark-arbitrage-link, .ark-positions-link {
      color: #89b4fa;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
    }
    .ark-latest-price-link:hover, .ark-historical-trades-link:hover, .ark-arbitrage-link:hover, .ark-positions-link:hover { text-decoration: underline; }

    .ark-section {
      margin: 5px 0;
      padding: 10px;
      background: #222;
      border-radius: 8px;
      border: 1px solid #333;
    }
    .ark-section-label {
      font-size: 13px;
      color: #ffffff;
      margin-bottom: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #444;
      padding-bottom: 6px;
    }
    .ark-section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .ark-last-update {
      font-size: 12px;
      color: var(--ark-muted);
      font-style: italic;
    }
    .ark-user-id {
      font-size: 13px;
      color: #6ab0f3;
      padding: 4px 8px;
      background: #2a2a2a;
      border-radius: 6px;
      white-space: nowrap;
    }

    #ark-holdings-total:hover {
      text-decoration: underline;
    }

    .ark-model-input-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .ark-model-input-row input {
      flex: 1;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #2a2a2a;
      color: #f0f0f0;
      font-size: 13px;
      outline: none;
    }
    .ark-model-input-row input:focus { border-color: #89b4fa; }
    .ark-model-input-row button {
      padding: 5px 12px;
      border-radius: 5px;
      border: none;
      background: #89b4fa;
      color: #1e1e2e;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-model-input-row button:hover { background: #b4befe; }

    .ark-model-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .ark-model-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: #333;
      border-radius: 4px;
      font-size: 12px;
      color: #f0f0f0;
    }
    .ark-model-tag .del-btn {
      background: none;
      border: none;
      color: #ff6b6b;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .ark-model-tag .del-btn:hover { color: #ff8e8e; }
    .ark-model-tag.dragging { opacity: 0.5; border: 1px dashed #fff; }
    .ark-model-tag.drag-over { border: 1px solid #4fc3f7; }

    .ark-trigger-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .ark-toggle {
      position: relative;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .ark-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .ark-toggle .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #555;
      border-radius: 22px;
      transition: 0.3s;
    }
    .ark-toggle .slider:before {
      content: "";
      position: absolute;
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background: #f0f0f0;
      border-radius: 50%;
      transition: 0.3s;
    }
    .ark-toggle input:checked + .slider { background: #4caf50; }
    .ark-toggle input:checked + .slider:before {
      transform: translateX(18px);
      background: #1a1a1a;
    }

    .ark-minute-input {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #2a2a2a;
      color: #f0f0f0;
      font-size: 13px;
      width: 120px;
      outline: none;
    }
    .ark-minute-input:focus { border-color: #89b4fa; }

    .ark-blue-btn {
      padding: 5px 14px;
      border-radius: 5px;
      border: none;
      background: #89b4fa;
      color: #1e1e2e;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-blue-btn:hover { background: #b4befe; }
    .ark-blue-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .ark-green-btn {
      padding: 5px 14px;
      border-radius: 5px;
      border: none;
      background: var(--ark-btn-2);
      color: var(--ark-text);
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-green-btn:hover { background: var(--ark-btn-2-hover); }

    .ark-table-wrap {
      overflow-x: auto;
      margin-top: 4px;
    }
    .ark-price-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12px;
      table-layout: fixed;
    }
    .ark-price-table th,
    .ark-price-table td {
      padding: 5px 8px;
      border-right: 1px solid #333;
      border-bottom: 1px solid #333;
      text-align: center;
      white-space: nowrap;
    }
    .ark-price-table th {
      background: #222;
      color: #f0f0f0;
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 2;
      white-space: normal;
      word-break: break-word;
    }
    .ark-price-table td.price-up { color: #00A854; }
    .ark-price-table td.price-down { color: #F55454; }
    .ark-price-table td.price-neutral { }
    /* 时间列：容纳 MM-DD HH:MM:SS（14字符）短时间串，不换行；
       横向滚动时固定在最左，背景与面板同步避免透字。
       th 的 z-index 需高于其他表头单元格(2)，否则滚动时被模型名列覆盖 */
    .ark-price-table th.time-cell,
    .ark-price-table td.time-cell {
      white-space: nowrap;
      width: 9.5em;
      position: sticky;
      left: 0;
      background: #222;
    }
    .ark-price-table th.time-cell {
      z-index: 3;
    }
    .ark-price-table td.time-cell {
      background: #1a1a1a;
      z-index: 1;
    }
    /* 价格列：按最多4位整数+2位小数（如 9999.99，7字符）估算，保证不换行；
       表头（模型名）跟随数据单元格宽度，在固定列宽内允许换行 */
    .ark-price-table th:not(.time-cell),
    .ark-price-table td.price-up,
    .ark-price-table td.price-down,
    .ark-price-table td.price-neutral {
      width: 5.4em;
    }

    .ark-positions-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .ark-positions-table th,
    .ark-positions-table td {
      padding: 5px 8px;
      border: 1px solid #333;
      text-align: center;
    }
    .ark-positions-table th {
      background: #222;
      color: #f0f0f0;
      font-weight: 600;
    }

    .ark-empty-hint {
      color: var(--ark-muted);
      font-size: 12px;
      text-align: center;
      padding: 12px;
    }

    .ark-chart-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 800px;
      height: 500px;
      background: #1a1a1a;
      color: #f0f0f0;
      border: 1px solid #333;
      border-radius: 10px;
      z-index: 1000;
      display: none;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7);
    }
    .ark-chart-panel.visible { display: flex; }
    .ark-chart-panel .resize-handle {
      position: absolute;
      z-index: 10;
    }
    .ark-chart-panel .resize-handle-n { top: -4px; left: 10px; right: 10px; height: 8px; cursor: n-resize; }
    .ark-chart-panel .resize-handle-s { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: s-resize; }
    .ark-chart-panel .resize-handle-e { right: -4px; top: 10px; bottom: 10px; width: 8px; cursor: e-resize; }
    .ark-chart-panel .resize-handle-w { left: -4px; top: 10px; bottom: 10px; width: 8px; cursor: w-resize; }
    .ark-chart-panel .resize-handle-ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .ark-chart-panel .resize-handle-nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .ark-chart-panel .resize-handle-se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .ark-chart-panel .resize-handle-sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
    .ark-chart-panel .resize-handle:hover { background: rgba(137, 180, 250, 0.3); border-radius: 4px; }
    .ark-chart-panel .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #222;
      cursor: move;
      user-select: none;
      border-bottom: 1px solid #333;
    }
    .ark-chart-panel .chart-header .chart-title {
      font-weight: 600;
      font-size: 14px;
      color: #f0f0f0;
    }
    .ark-chart-panel .chart-header .close-btn {
      background: none;
      border: none;
      color: #ff6b6b;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-chart-panel .chart-header .close-btn:hover { color: #ff8e8e; }
    .ark-chart-panel .chart-header .chart-download-btn {
      background: none;
      border: none;
      color: #8ab4f8;
      font-size: 15px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .ark-chart-panel .chart-header .chart-download-btn:hover { color: #a5c8ff; }
    .ark-chart-panel .chart-body {
      flex: 1;
      padding: 12px;
      overflow: hidden;
    }
    .ark-chart-container {
      width: 100%;
      height: 100%;
      min-height: 400px;
    }

    .ark-chart-tooltip {
      position: absolute;
      display: none;
      padding: 8px 12px;
      background: var(--ark-tooltip-bg);
      border: 1px solid var(--ark-border);
      border-radius: 6px;
      color: var(--ark-text);
      font-size: 12px;
      pointer-events: none;
      z-index: 100;
      backdrop-filter: blur(4px);
    }

    .ark-price-table th a.model-chart-link {
      color: #f0f0f0;
      text-decoration: none;
      cursor: pointer;
    }
    .ark-price-table th a.model-chart-link:hover { color: #4dabf7; text-decoration: underline; }

    .ark-model-selector {
      position: relative;
      margin-bottom: 8px;
    }
    .ark-model-selector-input {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #2a2a2a;
      min-height: 36px;
      cursor: text;
    }
    .ark-model-selector-input:focus-within { border-color: #89b4fa; }
    .ark-model-selected-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .ark-model-selected-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      background: #444;
      border-radius: 4px;
      font-size: 11px;
      color: #f0f0f0;
    }
    .ark-model-selected-tag .remove-tag-btn {
      background: none;
      border: none;
      color: #ff6b6b;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 0 2px;
    }
    .ark-model-selected-tag .remove-tag-btn:hover { color: #ff8e8e; }
    .ark-model-search-input {
      flex: 1;
      border: none;
      background: transparent;
      color: #f0f0f0;
      font-size: 13px;
      outline: none;
      min-width: 120px;
    }
    .ark-model-toggle-btn {
      background: none;
      border: none;
      color: var(--ark-muted);
      cursor: pointer;
      font-size: 12px;
      padding: 0 4px;
      transition: transform 0.2s;
    }
    .ark-model-toggle-btn.open { transform: rotate(180deg); }

    .ark-model-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: #2a2a2a;
      border: 1px solid #444;
      border-radius: 6px;
      margin-top: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 100;
      display: none;
    }
    .ark-model-dropdown.visible { display: block; }
    .ark-model-dropdown-header {
      padding: 8px;
      border-bottom: 1px solid #444;
      display: flex;
      gap: 6px;
    }
    .ark-model-dropdown-search {
      flex: 1;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #1a1a1a;
      color: #f0f0f0;
      font-size: 12px;
      outline: none;
    }
    .ark-model-dropdown-header button {
      padding: 4px 8px;
      border-radius: 4px;
      border: none;
      background: #555;
      color: #f0f0f0;
      font-size: 11px;
      cursor: pointer;
    }
    .ark-model-dropdown-header button:hover { background: #666; }
    .ark-model-dropdown-list {
      max-height: 200px;
      overflow-y: auto;
    }
    .ark-model-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      cursor: pointer;
      border-bottom: 1px solid #333;
    }
    .ark-model-option:hover { background: #333; }
    .ark-model-option input[type="checkbox"] { margin: 0; cursor: pointer; }
    .ark-model-option-label {
      flex: 1;
      font-size: 12px;
      color: #f0f0f0;
    }
    .ark-model-loading, .ark-model-error {
      padding: 12px;
      text-align: center;
      font-size: 12px;
      color: var(--ark-muted);
    }
    .ark-model-error { color: #ff6b6b; }
    .ark-model-error button {
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      border: none;
      background: #555;
      color: #f0f0f0;
      font-size: 11px;
      cursor: pointer;
    }
    .ark-model-error button:hover { background: #666; }
    .ark-model-actions {
      padding: 8px;
      border-top: 1px solid #444;
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
    .ark-model-actions button {
      padding: 4px 12px;
      border-radius: 4px;
      border: none;
      font-size: 12px;
      cursor: pointer;
    }
    .ark-model-clear-btn { background: #555; color: #f0f0f0; }
    .ark-model-clear-btn:hover { background: #666; }
    .ark-model-add-btn {
      background: #89b4fa;
      color: #1e1e2e;
      font-weight: 600;
    }
    .ark-model-add-btn:hover { background: #b4befe; }

    .chart-loading-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(26, 26, 26, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    .ark-chart-error {
      display: none;
      color: #ff6b6b;
      margin-top: 10px;
      padding: 8px 12px;
      background: rgba(255, 107, 107, 0.1);
      border-radius: 4px;
      border: 1px solid #ff6b6b;
    }

    /* 刷新按钮样式 */
    .ark-refresh-btn {
      background: none;
      border: none;
      color: var(--ark-label);
      font-size: 16px;
      cursor: pointer;
      margin-right: 8px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .ark-refresh-btn:hover {
      background-color: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .ark-refresh-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .ark-refresh-btn.loading {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* ============================================================
       日间（浅色）主题覆盖
       - 仅在 body.ark-theme-light 下生效，夜间完全不受影响
       - 选择器均锚定本脚本的 ID / 命名空间类，避免影响宿主页面
       - 语义色（红跌绿涨、持仓紫、买卖标记、高低/成本线）刻意保留
       ============================================================ */
    body.ark-theme-light {
      --ark-surface: #ffffff;
      --ark-elevated: #f1f3f5;
      --ark-input: #ffffff;
      --ark-chip: #e9ecef;
      --ark-border: #e2e5e9;
      --ark-border-2: #ced4da;
      --ark-btn-2: #e9ecef;
      --ark-btn-2-hover: #dde1e6;
      --ark-text: #1f2933;
      --ark-text-strong: #0b1220;
      --ark-label: #5a6066;
      --ark-muted: #6c757d;
      --ark-accent: #1c7ed6;
      --ark-accent-2: #1971c2;
      --ark-shadow: rgba(0,0,0,0.15);
      --ark-overlay: rgba(255,255,255,0.7);
      --ark-tooltip-bg: rgba(255,255,255,0.95);
      --ark-popup-bg: rgba(255,255,255,0.97);
      --ark-popup-item: rgba(0,0,0,0.04);
    }

    /* 面板容器 */
    body.ark-theme-light #ark-stock-panel,
    body.ark-theme-light #ark-settings-panel,
    body.ark-theme-light #ark-data-maintenance-panel,
    body.ark-theme-light #ark-price-panel,
    body.ark-theme-light #ark-trade-panel,
    body.ark-theme-light #ark-positions-panel,
    body.ark-theme-light #ark-arbitrage-panel,
    body.ark-theme-light #ark-trades-panel,
    body.ark-theme-light .ark-chart-panel {
      background: var(--ark-surface);
      color: var(--ark-text);
      border-color: var(--ark-border);
      box-shadow: 0 8px 32px var(--ark-shadow);
      /* 让原生控件（滚动条、数字输入加减按钮等）随日间主题变浅，
         覆盖宿主页面可能设置的 color-scheme: dark */
      color-scheme: light;
    }

    /* 滚动条：兜底覆盖宿主页面可能手写的深色 ::-webkit-scrollbar */
    body.ark-theme-light [id^="ark-"] ::-webkit-scrollbar,
    body.ark-theme-light .ark-chart-panel ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    body.ark-theme-light [id^="ark-"] ::-webkit-scrollbar-track,
    body.ark-theme-light .ark-chart-panel ::-webkit-scrollbar-track {
      background: var(--ark-surface);
    }
    body.ark-theme-light [id^="ark-"] ::-webkit-scrollbar-thumb,
    body.ark-theme-light .ark-chart-panel ::-webkit-scrollbar-thumb {
      background: var(--ark-border-2);
      border-radius: 4px;
    }
    body.ark-theme-light [id^="ark-"] ::-webkit-scrollbar-thumb:hover,
    body.ark-theme-light .ark-chart-panel ::-webkit-scrollbar-thumb:hover {
      background: var(--ark-muted);
    }

    /* 标题栏 */
    body.ark-theme-light .ark-panel-header,
    body.ark-theme-light .ark-chart-panel .chart-header {
      background: var(--ark-elevated);
      border-bottom-color: var(--ark-border);
    }

    /* 正文区 */
    body.ark-theme-light #ark-stock-panel .panel-body,
    body.ark-theme-light #ark-settings-panel .panel-body,
    body.ark-theme-light #ark-data-maintenance-panel .panel-body,
    body.ark-theme-light #ark-price-panel .panel-body,
    body.ark-theme-light #ark-trade-panel .panel-body,
    body.ark-theme-light #ark-positions-panel .panel-body,
    body.ark-theme-light #ark-arbitrage-panel .panel-body,
    body.ark-theme-light #ark-trades-panel .panel-body {
      background: var(--ark-surface);
    }

    /* 标题文字 */
    body.ark-theme-light .ark-panel-header .title,
    body.ark-theme-light .ark-chart-panel .chart-header .chart-title {
      color: var(--ark-text);
    }

    /* 区块卡片 */
    body.ark-theme-light .ark-section {
      background: var(--ark-elevated);
      border-color: var(--ark-border);
    }
    body.ark-theme-light .ark-section-label {
      color: var(--ark-text-strong);
      border-bottom-color: var(--ark-border-2);
    }

    /* 用户ID / chips */
    body.ark-theme-light .ark-user-id {
      background: var(--ark-elevated);
      color: var(--ark-accent-2);
    }
    body.ark-theme-light .ark-model-tag,
    body.ark-theme-light .ark-model-selected-tag {
      background: var(--ark-chip);
      color: var(--ark-text);
    }

    /* 行情入口链接 */
    body.ark-theme-light .ark-latest-price-link,
    body.ark-theme-light .ark-historical-trades-link,
    body.ark-theme-light .ark-arbitrage-link,
    body.ark-theme-light .ark-positions-link {
      color: var(--ark-accent);
    }

    /* 表格 */
    body.ark-theme-light .ark-price-table th,
    body.ark-theme-light .ark-price-table td,
    body.ark-theme-light .ark-trades-table th,
    body.ark-theme-light .ark-trades-table td,
    body.ark-theme-light .ark-positions-table th,
    body.ark-theme-light .ark-positions-table td {
      border-color: var(--ark-border);
    }
    body.ark-theme-light .ark-price-table th,
    body.ark-theme-light .ark-trades-table th,
    body.ark-theme-light .ark-positions-table th {
      background: var(--ark-elevated);
      color: var(--ark-text);
    }
    /* 亮色下时间列（横向固定）背景与面板/表头一致，避免滚动透字 */
    body.ark-theme-light .ark-price-table th.time-cell {
      background: var(--ark-elevated);
    }
    body.ark-theme-light .ark-price-table td.time-cell {
      background: var(--ark-surface);
    }
    body.ark-theme-light .ark-price-table th a.model-chart-link {
      color: var(--ark-text);
    }
    body.ark-theme-light .ark-arbitrage-table th {
      background: var(--ark-elevated);
      color: var(--ark-muted);
      border-bottom-color: var(--ark-border-2);
    }
    body.ark-theme-light .ark-arbitrage-table td {
      border-bottom-color: var(--ark-border);
    }
    body.ark-theme-light .ark-arbitrage-table tr:nth-child(even) td {
      background: var(--ark-elevated);
    }
    body.ark-theme-light .ark-arbitrage-table tr:hover td {
      background: var(--ark-chip);
    }
    body.ark-theme-light .ark-trades-table tr:nth-child(even) td {
      background: var(--ark-elevated);
    }
    body.ark-theme-light .ark-trades-table tr:hover td {
      background: var(--ark-chip);
    }

    /* 表单：输入框 / 下拉框 */
    body.ark-theme-light .ark-minute-input,
    body.ark-theme-light .ark-model-input-row input,
    body.ark-theme-light .ark-trades-model-select,
    body.ark-theme-light .ark-arbitrage-sort-select,
    body.ark-theme-light .ark-model-selector-input,
    body.ark-theme-light .ark-model-dropdown,
    body.ark-theme-light .ark-model-dropdown-search {
      background: var(--ark-input);
      color: var(--ark-text);
      border-color: var(--ark-border-2);
    }
    body.ark-theme-light .ark-model-search-input,
    body.ark-theme-light .ark-model-option-label {
      color: var(--ark-text);
    }
    body.ark-theme-light .ark-model-dropdown-header,
    body.ark-theme-light .ark-model-actions {
      border-color: var(--ark-border-2);
    }
    body.ark-theme-light .ark-model-option {
      border-bottom-color: var(--ark-border);
    }
    body.ark-theme-light .ark-model-option:hover {
      background: var(--ark-elevated);
    }

    /* 表单：次级按钮 */
    body.ark-theme-light .ark-model-dropdown-header button,
    body.ark-theme-light .ark-model-clear-btn,
    body.ark-theme-light .ark-model-error button {
      background: var(--ark-btn-2);
      color: var(--ark-text);
    }
    body.ark-theme-light .ark-model-dropdown-header button:hover,
    body.ark-theme-light .ark-model-clear-btn:hover,
    body.ark-theme-light .ark-model-error button:hover {
      background: var(--ark-btn-2-hover);
    }

    /* 开关关闭态 */
    body.ark-theme-light .ark-toggle .slider {
      background: var(--ark-border-2);
    }

    /* 颜色选择菜单 */
    .ark-color-menu {
      position: absolute;
      z-index: 9999;
      background: var(--ark-popup-bg);
      border: 1px solid var(--ark-border);
      border-radius: 8px;
      box-shadow: 0 4px 20px var(--ark-shadow);
      padding: 12px;
      min-width: 100px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .ark-color-menu-title {
      font-size: 12px;
      color: var(--ark-muted);
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--ark-border);
      text-align: center;
    }
    .ark-color-options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
    }
    .ark-color-option {
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 6px;
      border-radius: 6px;
      transition: background 0.2s ease;
      width: 100%;
    }
    .ark-color-option:hover {
      background: var(--ark-popup-item);
    }
    .ark-color-swatch {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: 2px solid transparent;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .ark-color-option:hover .ark-color-swatch {
      transform: scale(1.1);
    }
    .ark-color-remove {
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--ark-chip);
      color: var(--ark-text);
      font-size: 12px;
      margin-top: 8px;
      border: none;
      width: 100%;
      transition: background 0.2s ease;
    }
    .ark-color-remove:hover {
      background: var(--ark-btn-2-hover);
    }

    /* 右键交易菜单（一级项目录） */
    .ark-trade-menu {
      min-width: 120px;
      padding: 6px;
    }
    .ark-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--ark-text);
      cursor: pointer;
      transition: background 0.15s ease;
      user-select: none;
    }
    .ark-menu-item:hover {
      background: var(--ark-popup-item);
    }
    .ark-menu-item-disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .ark-menu-item-disabled:hover {
      background: none;
    }
    .ark-menu-arrow {
      color: var(--ark-muted);
      font-size: 12px;
    }

    /* 交易面板（买入/卖出） */
    .ark-trade-info {
      font-size: 12px;
      color: var(--ark-muted);
      margin-bottom: 10px;
    }
    .ark-trade-info-row {
      display: flex;
      align-items: baseline;
      line-height: 1.7;
    }
    .ark-trade-info-label {
      color: var(--ark-label);
      width: 72px;
      flex-shrink: 0;
    }
    /* 数据时间行的内联刷新按钮（紧凑版） */
    .ark-trade-info .ark-refresh-btn {
      font-size: 12px;
      margin: 0 0 0 6px;
      padding: 0 4px;
      line-height: 1.7;
    }
    .ark-trade-value-hint {
      font-size: 12px;
      color: var(--ark-muted);
      margin-bottom: 4px;
      min-height: 1.4em;
    }
    .ark-trade-value-hint.ok {
      color: #4caf50;
      font-weight: 600;
    }
    .ark-trade-value-hint.err {
      color: #ef4444;
      font-weight: 600;
    }
    .ark-trade-quick-label {
      font-size: 12px;
      color: var(--ark-label);
      margin-bottom: 4px;
      margin-top: 14px;
    }
    .ark-trade-quick-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 4px;
    }
    .ark-trade-lock {
      color: #ef4444;
      font-size: 12px;
      margin: 6px 0;
      line-height: 1.6;
    }
    .ark-trade-status {
      min-height: 18px;
      font-size: 12px;
      margin: 8px 0;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ark-trade-status.ok {
      color: #1db110;
    }
    .ark-trade-status.err {
      color: #af0837;
    }
    .ark-trade-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .ark-trade-actions button {
      flex: 1;
      padding: 7px 14px;
    }

    /* 开关打开态 */
    body.ark-theme-light .ark-toggle input:checked + .slider {
      background: #4caf50;
    }

    /* 图表面板：tooltip / loading 遮罩 */
    body.ark-theme-light .chart-loading-overlay {
      background: var(--ark-overlay);
    }

    /* 刷新按钮悬停（夜间用白字/白底，日间需反转） */
    body.ark-theme-light .ark-refresh-btn:hover {
      background-color: rgba(0,0,0,0.06);
      color: var(--ark-text);
    }
  `);
    },
  };

  // ==================== 图表 ====================
  const localTimezoneOffset = new Date().getTimezoneOffset() * 60;

  function defaultTickMarkFormatter(timePoint, tickMarkType, locale) {
    const formatOptions = {};
    switch (tickMarkType) {
      case 0:
        formatOptions.year = "numeric";
        break;
      case 1:
        formatOptions.month = "short";
        break;
      case 2:
        formatOptions.day = "numeric";
        break;
      case 3:
        formatOptions.hour12 = false;
        formatOptions.hour = "2-digit";
        formatOptions.minute = "2-digit";
        break;
      case 4:
        formatOptions.hour12 = false;
        formatOptions.hour = "2-digit";
        formatOptions.minute = "2-digit";
        formatOptions.second = "2-digit";
        break;
    }

    const date =
      timePoint.businessDay === undefined
        ? new Date(timePoint.timestamp * 1000)
        : new Date(
            Date.UTC(
              timePoint.businessDay.year,
              timePoint.businessDay.month - 1,
              timePoint.businessDay.day,
            ),
          );

    const localDateFromUtc = new Date(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    );

    return localDateFromUtc.toLocaleString(locale, formatOptions);
  }

  function getYesterdayMorningTimestamp() {
    const now = new Date();
    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      0,
      0,
      0,
      0,
    );
    return Math.floor(yesterday.getTime() / 1000);
  }

  const Chart = {
    convertToChartData(rawData) {
      if (!Array.isArray(rawData)) return [];
      return rawData
        .map((item) => {
          if (!item || item[0] === undefined || item[1] === undefined)
            return null;
          return { time: item[0], value: parseFloat(item[1]) };
        })
        .filter(Boolean)
        .sort((a, b) => a.time - b.time);
    },

    calculatePriceStats(chartData, todayData) {
      const dataToUse =
        todayData && todayData.length > 0 ? todayData : chartData;
      if (!dataToUse || !dataToUse.length) return null;
      const values = dataToUse.map((d) => d.value);
      const max = Math.max(...values);
      const min = Math.min(...values);
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / values.length;
      const firstPrice = dataToUse[0].value;
      const lastPrice = dataToUse[dataToUse.length - 1].value;
      const changePercent = ((lastPrice - firstPrice) / firstPrice) * 100;
      return {
        max,
        min,
        avg,
        firstPrice,
        lastPrice,
        changePercent,
        dataPoints: dataToUse.length,
        timeRange: {
          start: chartData[0].time,
          end: chartData[chartData.length - 1].time,
        },
      };
    },

    // 二分查找：在有序数组中找 <= target 的最大索引，没有则返回 -1
    findFloor(sortedArr, target) {
      let lo = 0,
        hi = sortedArr.length - 1,
        best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] <= target) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    },

    // 将间隔过大的交易价格作为数据点补入 chartData，使标记垂直位置准确
    enrichWithTradePrices(chartData, trades, maxGapSeconds = 300) {
      if (!chartData || chartData.length === 0) return chartData;
      if (!trades || trades.length === 0) return chartData;

      const timestamps = chartData.map((d) => d.time);
      const newPointsMap = new Map();

      for (const trade of trades) {
        if (!trade.created_at || trade.price === undefined) continue;
        const idx = this.findFloor(timestamps, trade.created_at);
        // 交易时间早于价格数据最早时间，跳过（不补为价格数据点）
        if (idx === -1) continue;
        if (trade.created_at - timestamps[idx] > maxGapSeconds) {
          newPointsMap.set(trade.created_at, parseFloat(trade.price));
        }
      }

      if (newPointsMap.size === 0) return chartData;

      const newPoints = Array.from(newPointsMap, ([time, value]) => ({
        time,
        value,
      }));
      const enriched = [...chartData, ...newPoints];
      enriched.sort((a, b) => a.time - b.time);
      return enriched;
    },

    convertToMarkers(trades, chartData) {
      if (!Array.isArray(trades) || trades.length === 0) return [];

      const timestamps = chartData ? chartData.map((d) => d.time) : [];

      return trades
        .filter((t) => t.created_at && t.side)
        .map((trade) => {
          const idx =
            timestamps.length > 0
              ? this.findFloor(timestamps, trade.created_at)
              : -1;
          // 交易时间早于价格数据最早时间，无法确定吸附位置，跳过该标记
          if (idx === -1) return null;
          const markerTime = timestamps[idx];
          return {
            time: markerTime,
            position: "inBar",
            color: trade.side === "buy" ? "#F55454" : "#00A854",
            shape: "circle",
            text: trade.side === "buy" ? "买" : "卖",
            size: 1,
          };
        })
        .filter(Boolean);
    },

    createThemedChart(container) {
      const c = Theme.chartColors(Theme.current());
      container.style.cssText = `
        display: block !important;
        visibility: visible !important;
        position: relative !important;
        width: 100% !important;
        height: 100% !important;
        min-height: 200px !important;
      `;
      const parent = container.parentElement;
      if (parent) {
        parent.style.cssText = `
          display: flex !important;
          flex-direction: column !important;
          flex: 1 !important;
          min-height: 200px !important;
          height: 100% !important;
        `;
      }
      const grandParent = parent?.parentElement;
      if (grandParent) {
        grandParent.style.cssText = `
          background: var(--ark-surface) !important;
          color: var(--ark-text) !important;
          border: 1px solid var(--ark-border) !important;
          border-radius: 10px !important;
          z-index: 1000 !important;
          display: flex !important;
          flex-direction: column !important;
          overflow: hidden !important;
          box-shadow: 0 8px 32px var(--ark-shadow) !important;
        `;
      }

      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          const chart = LightweightCharts.createChart(container, {
            layout: {
              background: { type: "solid", color: c.bg },
              textColor: c.text,
            },
            grid: {
              vertLines: { color: c.grid },
              horzLines: { color: c.grid },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: {
              borderColor: c.scaleBorder,
              scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            localization: {
              timeFormatter: (time, tickMarkType, locale) => {
                return defaultTickMarkFormatter(
                  { timestamp: time - localTimezoneOffset },
                  tickMarkType,
                  locale,
                );
              },
            },
            timeScale: {
              borderColor: c.scaleBorder,
              timeVisible: true,
              secondsVisible: true,
              fixLeftEdge: true,
              fixRightEdge: true,
              tickMarkFormatter: (time, tickMarkType, locale) => {
                return defaultTickMarkFormatter(
                  { timestamp: time - localTimezoneOffset },
                  tickMarkType,
                  locale,
                );
              },
            },
            handleScroll: { mouseWheel: true, pressedMouseMove: true },
            handleScale: {
              axisPressedMouseMove: true,
              mouseWheel: true,
              pinch: true,
            },
          });
          resolve(chart);
        });
      });
    },

    createPriceLineSeries(chart, data) {
      const c = Theme.chartColors(Theme.current());
      const series = chart.addLineSeries({
        color: c.line,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: "#ffffff",
        crosshairMarkerBackgroundColor: c.line,
        lastPriceAnimation: 1,
      });
      if (data && data.length > 0) series.setData(data);
      return series;
    },

    createChartTooltip(container, chart, series) {
      const tooltip = document.createElement("div");
      tooltip.id = "ark-chart-tooltip";
      tooltip.className = "ark-chart-tooltip";
      container.appendChild(tooltip);

      chart.subscribeCrosshairMove((param) => {
        if (
          !param.point ||
          !param.time ||
          param.point.x < 0 ||
          param.point.y < 0
        ) {
          tooltip.style.display = "none";
          return;
        }
        const priceData = param.seriesData.get(series);
        if (!priceData) {
          tooltip.style.display = "none";
          return;
        }
        const timeStr = TimeUtils.formatSecondsTimestamp(param.time, "full");
        const price = priceData.value.toFixed(2);
        tooltip.innerHTML = `
          <div style="margin-bottom: 4px;"><strong>时间:</strong> ${timeStr}</div>
          <div><strong>价格:</strong> ${price}</div>
        `;
        tooltip.style.left = param.point.x + "px";
        tooltip.style.top = param.point.y - 50 + "px";
        tooltip.style.display = "block";
      });

      return () => {
        if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
      };
    },

    createChartPanelElement(panelId, modelName) {
      const panel = document.createElement("div");
      panel.id = panelId;
      panel.className = "ark-chart-panel";

      panel.innerHTML = `
        <div class="chart-header">
          <div class="chart-title" id="${panelId}-title">分时走势图 > ${Utils.escapeHtml(modelName)}</div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <button class="chart-download-btn" title="保存为图片">&#11015;</button>
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="chart-body">
          <div id="${panelId}-container" class="ark-chart-container"></div>
          <div id="${panelId}-stats" class="ark-chart-stats" style="margin-top: 16px; font-size: 12px; color: var(--ark-muted); display: flex; justify-content: space-between; align-items: center;"></div>
          <div id="${panelId}-error" class="ark-chart-error" style="display: none;"></div>
        </div>
        <div class="resize-handle resize-handle-n"></div>
        <div class="resize-handle resize-handle-s"></div>
        <div class="resize-handle resize-handle-e"></div>
        <div class="resize-handle resize-handle-w"></div>
        <div class="resize-handle resize-handle-ne"></div>
        <div class="resize-handle resize-handle-nw"></div>
        <div class="resize-handle resize-handle-se"></div>
        <div class="resize-handle resize-handle-sw"></div>
      `;

      document.body.appendChild(panel);
      return panel;
    },

    updateChartStatsDisplay(panel, stats, panelId = null) {
      const statsEl = panelId
        ? panel.querySelector(`#${panelId}-stats`)
        : panel.querySelector("#ark-chart-stats");
      if (!statsEl || !stats) return;
      statsEl.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 16px;">
          <div><strong>更新至：</strong>${TimeUtils.formatSecondsTimestamp(stats.timeRange.end, "full")}</div>
          <div><strong>今日最高价：</strong> ${stats.max.toFixed(2)}</div>
          <div><strong>今日最低价：</strong> ${stats.min.toFixed(2)}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" id="${panelId}-show-labels" checked style="cursor: pointer;" />
          <label for="${panelId}-show-labels" style="cursor: pointer; font-size: 12px; user-select: none;">显示价格线标签</label>
        </div>
      `;
    },

    showChartError(message) {
      console.error("[Ark Stock Monitor] 图表错误:", message);
      const errorEl = document.createElement("div");
      errorEl.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        padding: 10px 16px;
        background: #ff6b6b;
        color: white;
        border-radius: 6px;
        z-index: 50;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      `;
      errorEl.textContent = message;
      document.body.appendChild(errorEl);
      setTimeout(() => {
        if (errorEl.parentNode) errorEl.parentNode.removeChild(errorEl);
      }, 3000);
    },
  };

  // ==================== 图表管理 ====================
  const ChartManager = {
    _manager: null,

    getInstance() {
      if (!this._manager) {
        this._manager = new MultiPanelManagerClass();
      }
      return this._manager;
    },

    showChartPanel(modelName) {
      return this.getInstance().showChartPanel(modelName);
    },
  };

  class MultiPanelManagerClass {
    constructor() {
      this.panels = new Map();
      this.panelZIndex = 100000;
      this.activePanelId = null;
      this.chartInstances = new Map();
      this.escKeyHandler = null;
    }

    generatePanelId(modelName) {
      const timestamp = Date.now();
      const random = Math.random().toString(36).substr(2, 9);
      return `ark-chart-panel-${modelName.replace(/[^a-zA-Z0-9-]/g, "-")}-${timestamp}-${random}`;
    }

    _updateChartSeriesData(
      series,
      chartData,
      stockId,
      data,
      showLabels = true,
    ) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000);
      const todayData = chartData.filter((d) => d.time >= todayStartTimestamp);

      const stats = Chart.calculatePriceStats(chartData, todayData);
      const modelArbitrage = (data.arbitrageData || []).find(
        (a) => a.stockId === stockId,
      );
      const modelPosition = data.positions?.[stockId];
      if (stats && modelArbitrage) {
        stats.max = modelArbitrage.high_24h;
        stats.min = modelArbitrage.low_24h;
      }

      let priceLines = null;
      if (modelArbitrage) {
        const highLine = series.createPriceLine({
          price: modelArbitrage.high_24h,
          color: "#00A854",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: showLabels ? "今日最高" : "",
        });
        const lowLine = series.createPriceLine({
          price: modelArbitrage.low_24h,
          color: "#F55454",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: showLabels ? "今日最低" : "",
        });
        let positionLine = null;
        if (modelPosition) {
          positionLine = series.createPriceLine({
            price: modelPosition.avg_cost,
            color: "#A0522D",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: showLabels ? "持仓价" : "",
          });
        }
        priceLines = { highLine, lowLine, positionLine };
      }

      // 交易标记：把通过本脚本买入/卖出的记录作为买卖点标注在图表上
      const tradeHistory = data.tradeHistory?.[stockId];
      if (tradeHistory && tradeHistory.length > 0 && chartData.length > 0) {
        const minTime = chartData[0].time;
        const filteredTrades = tradeHistory.filter(
          (t) => t.created_at >= minTime,
        );
        if (filteredTrades.length > 0) {
          const markers = Chart.convertToMarkers(filteredTrades, chartData);
          if (markers.length > 0) {
            series.setMarkers(markers);
          }
        }
      }

      return { stats, priceLines };
    }

    async showChartPanel(stockId) {
      const existingPanelId = this.findPanelByModel(stockId);
      if (existingPanelId) {
        this.activatePanel(existingPanelId);
        return existingPanelId;
      }

      const panelId = this.generatePanelId(String(stockId));
      const position = this.getNewPanelPosition();

      this.panels.set(panelId, {
        id: panelId,
        element: null,
        stockId: stockId, // 存 stockId
        chartInstance: null,
        tooltipCleanup: null,
        position: position,
        zIndex: this.panelZIndex,
        isRefreshing: false,
        lastActiveTime: Date.now(),
      });

      const panel = await this.createTimeChartPanel(stockId, panelId);
      if (!panel) {
        this.panels.delete(panelId);
        return null;
      }

      const panelInfo = this.panels.get(panelId);
      panelInfo.element = panel;
      panelInfo.zIndex = this.panelZIndex++;

      panel.style.transform = "none !important";
      panel.style.left = `${position.x}px !important`;
      panel.style.top = `${position.y}px !important`;
      panel.style.right = "auto !important";
      panel.style.zIndex = panelInfo.zIndex;

      this.activatePanel(panelId);

      const closeBtn = panel.querySelector(".chart-header .close-btn");
      if (closeBtn) closeBtn.onclick = () => this.closePanel(panelId);

      const downloadBtn = panel.querySelector(
        ".chart-header .chart-download-btn",
      );
      if (downloadBtn)
        downloadBtn.onclick = () => this.downloadChartScreenshot(panelId);

      Interactions.initDrag(panel, panelId, this);
      Interactions.initResize(panel, panelId, this);

      if (!this.escKeyHandler) {
        this.escKeyHandler = (event) => {
          if (event.key === "Escape" || event.keyCode === 27) {
            this.closeActivePanel();
          }
        };
        document.addEventListener("keydown", this.escKeyHandler);
      }

      return panelId;
    }

    async createTimeChartPanel(stockId, panelId) {
      try {
        const data = Storage.load();
        const modelData = data.priceData[stockId];
        if (!modelData || !Array.isArray(modelData) || modelData.length === 0) {
          throw new Error(`模型 "${Utils.getModelName(stockId)}" 暂无价格数据`);
        }

        const chartPanel = Chart.createChartPanelElement(
          panelId,
          Utils.getModelName(stockId),
        );
        if (!chartPanel) throw new Error("无法创建面板元素");

        const container = chartPanel.querySelector(`#${panelId}-container`);
        if (!container) throw new Error("无法找到图表容器");

        const chartData = Chart.convertToChartData(modelData);
        if (chartData.length === 0) throw new Error("数据转换失败");

        // 将交易价格作为数据点补入 chartData，保证买卖点标记垂直位置准确
        const trades = data.tradeHistory?.[stockId] || [];
        const enrichedChartData = Chart.enrichWithTradePrices(
          chartData,
          trades,
        );

        const chart = await Chart.createThemedChart(container);
        const series = Chart.createPriceLineSeries(chart, enrichedChartData);

        const { stats, priceLines } = this._updateChartSeriesData(
          series,
          enrichedChartData,
          stockId,
          data,
          true, // 默认显示标签
        );

        const cleanupTooltip = Chart.createChartTooltip(
          container,
          chart,
          series,
        );
        this.setTooltipCleanup(panelId, cleanupTooltip);

        const chartId = `chart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        container.dataset.chartId = chartId;
        this.setChartInstance(panelId, chartId, {
          chart,
          series,
          chartData: enrichedChartData,
          priceLines,
        });

        Chart.updateChartStatsDisplay(chartPanel, stats, panelId);

        // 绑定勾选框事件
        const checkbox = chartPanel.querySelector(`#${panelId}-show-labels`);
        if (checkbox) {
          checkbox.addEventListener("change", () => {
            this._togglePriceLineLabels(panelId, checkbox.checked);
          });
        }

        if (enrichedChartData.length > 1) {
          const lastTime = enrichedChartData[enrichedChartData.length - 1].time;
          chart.timeScale().setVisibleRange({
            from: getYesterdayMorningTimestamp(),
            to: lastTime,
          });
        }

        document.body.appendChild(chartPanel);
        chartPanel.classList.add("visible");

        await new Promise((resolve) => requestAnimationFrame(resolve));
        return chartPanel;
      } catch (error) {
        console.error("[Ark Stock Monitor] 创建分时走势图失败:", error);
        Chart.showChartError(error.message);
        return null;
      }
    }

    findPanelByModel(stockId) {
      for (const [panelId, panelInfo] of this.panels) {
        if (panelInfo.stockId === stockId) return panelId;
      }
      return null;
    }

    getNewPanelPosition() {
      const baseX = 100;
      const baseY = 100;
      const offsetX = 30;
      const offsetY = 30;
      const panelCount = this.panels.size;
      const x = baseX + ((panelCount * offsetX) % (window.innerWidth - 800));
      const y = baseY + ((panelCount * offsetY) % (window.innerHeight - 500));
      return { x, y };
    }

    activatePanel(panelId) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;
      panelInfo.zIndex = this.panelZIndex++;
      panelInfo.element.style.zIndex = panelInfo.zIndex;
      panelInfo.element.classList.add("visible");
      panelInfo.lastActiveTime = Date.now();
      this.activePanelId = panelId;
    }

    closePanel(panelId) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;

      if (panelInfo.tooltipCleanup) {
        panelInfo.tooltipCleanup();
        panelInfo.tooltipCleanup = null;
      }

      const container = panelInfo.element.querySelector(".ark-chart-container");
      if (container) {
        const chartId = container.dataset.chartId;
        if (chartId && this.chartInstances.has(chartId)) {
          const instance = this.chartInstances.get(chartId);
          if (instance.chart) instance.chart.remove();
          this.chartInstances.delete(chartId);
        }
      }

      panelInfo.element.style.cssText = "";
      const parent = panelInfo.element.querySelector(".chart-body");
      if (parent) parent.style.cssText = "";
      if (container) container.style.cssText = "";

      panelInfo.element.classList.remove("visible");
      if (panelInfo.element.parentNode) {
        panelInfo.element.parentNode.removeChild(panelInfo.element);
      }

      this.panels.delete(panelId);

      if (this.activePanelId === panelId) {
        this.activePanelId = null;
      }

      if (this.panels.size === 0 && this.escKeyHandler) {
        document.removeEventListener("keydown", this.escKeyHandler);
        this.escKeyHandler = null;
      }
    }

    closeActivePanel() {
      if (this.activePanelId) this.closePanel(this.activePanelId);
    }

    closeAllPanels() {
      const panelIds = Array.from(this.panels.keys());
      panelIds.forEach((panelId) => this.closePanel(panelId));
    }

    getPanelCount() {
      return this.panels.size;
    }

    getAllPanelIds() {
      return Array.from(this.panels.keys());
    }

    downloadChartScreenshot(panelId) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;

      const chartId = panelInfo.chartInstance;
      const instance = chartId && this.chartInstances.get(chartId);
      const chart = instance && instance.chart;
      if (!chart || typeof chart.takeScreenshot !== "function") {
        Chart.showChartError("该图表暂无法截图");
        return;
      }

      // 图表本体（含坐标轴、价格线、交易标记）——官方 API 返回绘制好的 canvas
      const chartCanvas = chart.takeScreenshot();

      const headerEl = panelInfo.element.querySelector(".chart-header");
      const titleEl = headerEl && headerEl.querySelector(".chart-title");
      if (!headerEl || !titleEl) return;

      const cw = chartCanvas.width;
      const ch = chartCanvas.height;
      const headerH = Math.round(headerEl.getBoundingClientRect().height);

      // 组合：标题栏（手动按真实样式重绘）+ 图表本体
      const offscreen = document.createElement("canvas");
      offscreen.width = cw;
      offscreen.height = headerH + ch;
      const ctx = offscreen.getContext("2d");

      ctx.drawImage(chartCanvas, 0, headerH);

      const hs = getComputedStyle(headerEl);
      const ts = getComputedStyle(titleEl);
      ctx.fillStyle = hs.backgroundColor;
      ctx.fillRect(0, 0, cw, headerH);
      ctx.fillStyle = hs.borderBottomColor;
      ctx.fillRect(0, headerH - 1, cw, 1);

      // 标题文字（与 CSS 8px 12px 对齐），字体/颜色取自真实 computed style 以适配主题
      const titleText = titleEl.textContent.trim();
      ctx.fillStyle = ts.color;
      ctx.font = `${ts.fontWeight} ${ts.fontSize} ${ts.fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(titleText, 12, headerH / 2);

      // 触发下载：走势图_模型名_时间戳.png
      const modelName = Utils.getModelName(panelInfo.stockId);
      const stamp = Date.now();
      const a = document.createElement("a");
      a.download = `走势图_${modelName}_${stamp}.png`;
      a.href = offscreen.toDataURL("image/png");
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
    }

    setChartInstance(panelId, chartId, instance) {
      const panelInfo = this.panels.get(panelId);
      if (panelInfo) {
        panelInfo.chartInstance = chartId;
        this.chartInstances.set(chartId, instance);
      }
    }

    setTooltipCleanup(panelId, cleanupFn) {
      const panelInfo = this.panels.get(panelId);
      if (panelInfo) panelInfo.tooltipCleanup = cleanupFn;
    }

    _togglePriceLineLabels(panelId, showLabels) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;

      const chartId = panelInfo.chartInstance;
      if (!chartId || !this.chartInstances.has(chartId)) return;

      const instance = this.chartInstances.get(chartId);
      if (!instance.series || !instance.priceLines) return;

      const data = Storage.load();

      // 移除旧的价格线
      if (instance.priceLines.highLine) {
        instance.series.removePriceLine(instance.priceLines.highLine);
      }
      if (instance.priceLines.lowLine) {
        instance.series.removePriceLine(instance.priceLines.lowLine);
      }
      if (instance.priceLines.positionLine) {
        instance.series.removePriceLine(instance.priceLines.positionLine);
      }

      // 重新创建价格线（带或不带标签）
      const modelArbitrage = (data.arbitrageData || []).find(
        (a) => a.stockId === panelInfo.stockId,
      );
      const modelPosition = data.positions?.[panelInfo.stockId];

      if (modelArbitrage) {
        const highLine = instance.series.createPriceLine({
          price: modelArbitrage.high_24h,
          color: "#00A854",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: showLabels ? "今日最高" : "",
        });
        const lowLine = instance.series.createPriceLine({
          price: modelArbitrage.low_24h,
          color: "#F55454",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: showLabels ? "今日最低" : "",
        });
        let positionLine = null;
        if (modelPosition) {
          positionLine = instance.series.createPriceLine({
            price: modelPosition.avg_cost,
            color: "#A0522D",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: showLabels ? "持仓价" : "",
          });
        }
        instance.priceLines = { highLine, lowLine, positionLine };
      }
    }

    async refreshChartData(panelId) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo || panelInfo.isRefreshing) return false;

      try {
        panelInfo.isRefreshing = true;
        panelInfo.lastRefreshTime = Date.now();
        this.showChartLoading(panelId, true);

        const data = Storage.load();
        const modelData = data.priceData[panelInfo.stockId];
        if (!modelData || !Array.isArray(modelData)) {
          throw new Error(
            `模型 "${Utils.getModelName(panelInfo.stockId)}" 暂无数据`,
          );
        }

        const chartId = panelInfo.chartInstance;
        if (!chartId || !this.chartInstances.has(chartId)) {
          throw new Error("图表实例不存在");
        }

        const instance = this.chartInstances.get(chartId);
        if (!instance.chart || !instance.series) {
          throw new Error("图表实例无效");
        }

        const chartData = Chart.convertToChartData(modelData);
        if (chartData.length === 0) throw new Error("数据转换失败");

        // 将交易价格作为数据点补入 chartData，保证买卖点标记垂直位置准确
        const trades = data.tradeHistory?.[panelInfo.stockId] || [];
        const enrichedChartData = Chart.enrichWithTradePrices(
          chartData,
          trades,
        );

        instance.series.setData(enrichedChartData);
        instance.chartData = enrichedChartData;

        if (instance.priceLines) {
          if (instance.priceLines.highLine) {
            instance.series.removePriceLine(instance.priceLines.highLine);
          }
          if (instance.priceLines.lowLine) {
            instance.series.removePriceLine(instance.priceLines.lowLine);
          }
          if (instance.priceLines.positionLine) {
            instance.series.removePriceLine(instance.priceLines.positionLine);
          }
        }

        // 获取勾选框状态
        const checkbox = panelInfo.element?.querySelector(
          `#${panelId}-show-labels`,
        );
        const showLabels = checkbox ? checkbox.checked : true;

        const { stats, priceLines } = this._updateChartSeriesData(
          instance.series,
          enrichedChartData,
          panelInfo.stockId,
          data,
          showLabels,
        );
        instance.priceLines = priceLines;

        if (stats) {
          Chart.updateChartStatsDisplay(panelInfo.element, stats, panelId);
          // 重新绑定勾选框事件
          const newCheckbox = panelInfo.element?.querySelector(
            `#${panelId}-show-labels`,
          );
          if (newCheckbox) {
            newCheckbox.checked = showLabels;
            newCheckbox.addEventListener("change", () => {
              this._togglePriceLineLabels(panelId, newCheckbox.checked);
            });
          }
        }

        if (enrichedChartData.length > 1) {
          const lastTime = enrichedChartData[enrichedChartData.length - 1].time;
          instance.chart.timeScale().setVisibleRange({
            from: getYesterdayMorningTimestamp(),
            to: lastTime,
          });
        }

        return true;
      } catch (error) {
        console.error("[Ark Stock Monitor] 图表数据刷新失败:", error);
        this.showChartError(panelId, `刷新失败: ${error.message}`);
        return false;
      } finally {
        panelInfo.isRefreshing = false;
        this.showChartLoading(panelId, false);
      }
    }

    showChartLoading(panelId, show) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;
      const container = panelInfo.element.querySelector(".ark-chart-container");
      if (!container) return;

      if (show) {
        let loadingOverlay = container.querySelector(".chart-loading-overlay");
        if (!loadingOverlay) {
          loadingOverlay = document.createElement("div");
          loadingOverlay.className = "chart-loading-overlay";
          loadingOverlay.innerHTML =
            '<div class="chart-loading-spinner"></div>';
          container.appendChild(loadingOverlay);
        }
        loadingOverlay.style.display = "flex";
      } else {
        const loadingOverlay = container.querySelector(
          ".chart-loading-overlay",
        );
        if (loadingOverlay) loadingOverlay.style.display = "none";
      }
    }

    showChartError(panelId, message) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo) return;
      const errorEl = panelInfo.element.querySelector(".ark-chart-error");
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = "block";
        setTimeout(() => {
          errorEl.style.display = "none";
        }, 3000);
      }
    }

    updatePanelPosition(panelId, x, y) {
      const panelInfo = this.panels.get(panelId);
      if (panelInfo) {
        panelInfo.position = { x, y };
        panelInfo.element.style.left = `${x}px`;
        panelInfo.element.style.top = `${y}px`;
      }
    }
  }

  // ==================== UI 面板工厂 ====================
  const UIPanels = {
    _mainPanel: null,
    _settingsPanel: null,
    _pricePanel: null,
    _tradePanel: null, // 买入/卖出交易面板（单例，按 action 切换内容）
    _tradeBusy: false, // 交易请求进行中守卫（防重复提交）
    _tradeRefreshBusy: false, // 交易面板数据刷新进行中守卫（防重复请求）
    _tradeRefreshQueued: false, // 刷新进行中又有新刷新请求时，结束后补一次
    _tradeRefreshQueuedMsg: null, // 排队刷新要回显的状态提示
    _tradeState: null, // 交易面板打开时的数据快照
    _positionsPanel: null,
    _arbitragePanel: null,
    _tradesPanel: null, // 交易记录面板（本地交易历史，单例）
    _dataMaintenancePanel: null,
    _currentZIndex: 2000, // 动态 z-index 起始值，每次打开面板时递增

    // 将面板置顶
    bringToFront(panel) {
      if (!panel) return;
      this._currentZIndex++;
      panel.style.zIndex = this._currentZIndex;
    },

    createMainPanel() {
      if (this._mainPanel) return this._mainPanel;

      const data = Storage.load();
      this._mainPanel = document.createElement("div");
      this._mainPanel.id = "ark-stock-panel";

      this._mainPanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">Ark 模型股市监控</span>
            <span style="color:var(--ark-label);font-size:12px;"> ver ${GM_info.script.version}</span>
          </div>
          <div class="header-right">
            <button class="theme-toggle-btn" id="ark-theme-toggle-btn" title="${data.theme === "light" ? "切换到夜间主题" : "切换到日间主题"}">${data.theme === "light" ? "&#x2600;" : "&#x1F319;"}</button>
            <button class="data-maintenance-btn" id="ark-data-maintenance-btn" title="数据维护">&#x26C1;</button>
            <button class="settings-btn" id="ark-settings-btn" title="设置">&#x2699;</button>
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-section-label">选择监控模型</div>
            <div class="ark-model-selector">
              <div class="ark-model-selector-input" id="ark-model-selector-input">
                <div class="ark-model-selected-tags" id="ark-model-selected-tags"></div>
                <input type="text" class="ark-model-search-input" id="ark-model-search-input" placeholder="点击选择模型..." readonly />
                <button class="ark-model-toggle-btn" id="ark-model-toggle-btn">▼</button>
              </div>
              <div class="ark-model-dropdown" id="ark-model-dropdown">
                <div class="ark-model-dropdown-header">
                  <input type="text" class="ark-model-dropdown-search" id="ark-model-dropdown-search" placeholder="搜索模型..." />
                  <button class="ark-model-select-all" id="ark-model-select-all">全选</button>
                  <button class="ark-model-clear-all" id="ark-model-clear-all">清空</button>
                </div>
                <div class="ark-model-dropdown-list" id="ark-model-dropdown-list">
                  <div class="ark-model-loading">加载模型中...</div>
                </div>
                <div class="ark-model-actions">
                  <button class="ark-model-clear-btn" id="ark-model-clear-selection">清空选择</button>
                  <button class="ark-model-add-btn" id="ark-model-add-selected">添加选中的模型</button>
                </div>
              </div>
            </div>
            <div class="ark-model-list" id="ark-model-list"></div>
          </div>
          <div class="ark-section">
            <div class="ark-section-label">行情数据</div>
            <div class="ark-market-entrance">
              <a href="javascript:void(0)" class="ark-latest-price-link" id="ark-latest-price-btn">最新价格</a>
              <a href="javascript:void(0)" class="ark-arbitrage-link" id="ark-arbitrage-btn">套利幅度榜</a>
              <a href="javascript:void(0)" class="ark-positions-link" id="ark-positions-btn">我的持仓</a>
              <a href="javascript:void(0)" class="ark-positions-link" id="ark-trades-btn">交易记录</a>
            </div>
          </div>
          <div class="ark-section">
            <div class="ark-section-label">市场状态</div>
            <div class="ark-user-id" id="ark-market-status">加载中...</div>
          </div>
        </div>
      `;

      document.body.appendChild(this._mainPanel);
      Interactions.initDrag(
        this._mainPanel,
        this._mainPanel.querySelector(".ark-panel-header"),
      );

      this._mainPanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._mainPanel.classList.remove("visible");
        });

      this._mainPanel
        .querySelector("#ark-settings-btn")
        .addEventListener("click", () => {
          if (!UIPanels._settingsPanel) {
            UIPanels._settingsPanel = UIPanels.createSettingsPanel();
          }
          const isVisible =
            UIPanels._settingsPanel.classList.contains("visible");
          UIPanels._settingsPanel.classList.toggle("visible");
          // 如果面板已经显示，或者刚切换为显示状态，则置顶
          if (
            isVisible ||
            UIPanels._settingsPanel.classList.contains("visible")
          ) {
            UIPanels.bringToFront(UIPanels._settingsPanel);
          }
        });

      this._mainPanel
        .querySelector("#ark-data-maintenance-btn")
        .addEventListener("click", () => {
          if (!UIPanels._dataMaintenancePanel) {
            UIPanels._dataMaintenancePanel =
              UIPanels.createDataMaintenancePanel();
          }
          const isVisible =
            UIPanels._dataMaintenancePanel.classList.contains("visible");
          UIPanels._dataMaintenancePanel.classList.toggle("visible");
          // 如果面板已经显示，或者刚切换为显示状态，则置顶
          if (
            isVisible ||
            UIPanels._dataMaintenancePanel.classList.contains("visible")
          ) {
            UIPanels.bringToFront(UIPanels._dataMaintenancePanel);
          }
        });

      this._mainPanel
        .querySelector("#ark-theme-toggle-btn")
        .addEventListener("click", () => {
          Theme.toggle();
        });

      this._mainPanel
        .querySelector("#ark-latest-price-btn")
        .addEventListener("click", () => {
          if (!UIPanels._pricePanel) {
            UIPanels._pricePanel = UIPanels.createPricePanel();
          }
          UIPanels._pricePanel.classList.add("visible");
          UIPanels.bringToFront(UIPanels._pricePanel);
          UIRenderers.refreshPricePanelFull();
        });

      this._mainPanel
        .querySelector("#ark-positions-btn")
        .addEventListener("click", () => {
          if (!UIPanels._positionsPanel) {
            UIPanels._positionsPanel = UIPanels.createPositionsPanel();
          }
          UIPanels._positionsPanel.classList.add("visible");
          UIPanels.bringToFront(UIPanels._positionsPanel);
          const data = Storage.load();
          UIRenderers.refreshPositionsPanel(data);
        });

      this._mainPanel
        .querySelector("#ark-trades-btn")
        .addEventListener("click", () => {
          UIPanels.openTradesHistoryPanel();
        });

      this._mainPanel
        .querySelector("#ark-arbitrage-btn")
        .addEventListener("click", () => {
          if (!UIPanels._arbitragePanel) {
            UIPanels._arbitragePanel = UIPanels.createArbitragePanel();
          }
          UIPanels._arbitragePanel.classList.add("visible");
          UIPanels.bringToFront(UIPanels._arbitragePanel);
          const data = Storage.load();
          UIRenderers.renderArbitrageTable(data.arbitrageData || []);
          if (data.lastUpdateTime) {
            UIRenderers.updateArbitrageLastUpdateDisplay(data.lastUpdateTime);
          }
        });

      UIRenderers.renderMarketStatus(data);

      UIRenderers.renderModelList(data.stockIds);
      this._setupModelSelector();

      return this._mainPanel;
    },

    _setupModelSelector() {
      const panel = this._mainPanel;
      const modelSelectorInput = panel.querySelector(
        "#ark-model-selector-input",
      );
      const modelSelectedTags = panel.querySelector("#ark-model-selected-tags");
      const modelSearchInput = panel.querySelector("#ark-model-search-input");
      const modelToggleBtn = panel.querySelector("#ark-model-toggle-btn");
      const modelDropdown = panel.querySelector("#ark-model-dropdown");
      const modelDropdownSearch = panel.querySelector(
        "#ark-model-dropdown-search",
      );
      const modelSelectAllBtn = panel.querySelector("#ark-model-select-all");
      const modelClearAllBtn = panel.querySelector("#ark-model-clear-all");
      const modelDropdownList = panel.querySelector("#ark-model-dropdown-list");
      const modelClearSelectionBtn = panel.querySelector(
        "#ark-model-clear-selection",
      );
      const modelAddSelectedBtn = panel.querySelector(
        "#ark-model-add-selected",
      );

      let selectedModels = new Set();
      let allModels = [];
      let isDropdownOpen = false;
      let isLoadingModels = false;

      function addModels(stockIds) {
        if (!stockIds || !stockIds.length) return;
        const d = Storage.load();
        const existingIds = new Set(d.stockIds);
        const newIds = stockIds.filter((id) => !existingIds.has(id));
        if (newIds.length === 0) return;
        d.stockIds.push(...newIds);
        newIds.forEach((id) => {
          if (!d.priceData[id]) d.priceData[id] = [];
        });
        Storage.save(d);
        UIRenderers.renderModelList(d.stockIds);
        UIRenderers.refreshPriceTable(d);
      }

      function updateSelectedTags() {
        modelSelectedTags.innerHTML = "";
        selectedModels.forEach((stockId) => {
          const name = Utils.getModelName(stockId);
          const tag = document.createElement("span");
          tag.className = "ark-model-selected-tag";
          tag.innerHTML = `${Utils.escapeHtml(name)}<button class="remove-tag-btn" data-stock-id="${Utils.escapeHtml(String(stockId))}" title="移除">&times;</button>`;
          modelSelectedTags.appendChild(tag);
        });
        modelSearchInput.placeholder =
          selectedModels.size > 0 ? "" : "点击选择模型...";
      }

      function removeSelectedTag(stockId) {
        selectedModels.delete(stockId);
        updateSelectedTags();
        updateCheckboxStates();
      }

      function updateCheckboxStates() {
        const checkboxes = modelDropdownList.querySelectorAll(
          'input[type="checkbox"]',
        );
        checkboxes.forEach((checkbox) => {
          checkbox.checked = selectedModels.has(checkbox.value);
        });
      }

      async function loadModelList() {
        if (isLoadingModels) return;
        isLoadingModels = true;
        modelDropdownList.innerHTML =
          '<div class="ark-model-loading">加载模型中...</div>';

        try {
          allModels = await API.fetchAvailableModels();
          if (allModels.length === 0) {
            modelDropdownList.innerHTML =
              '<div class="ark-model-error">未找到可用模型<br/><button id="ark-model-retry-btn">重试</button></div>';
            panel
              .querySelector("#ark-model-retry-btn")
              ?.addEventListener("click", loadModelList);
            return;
          }
          renderModelOptions(allModels);
        } catch (error) {
          console.error("[Ark Stock Monitor] 加载模型列表失败:", error);
          modelDropdownList.innerHTML =
            '<div class="ark-model-error">加载失败<br/><button id="ark-model-retry-btn">重试</button></div>';
          panel
            .querySelector("#ark-model-retry-btn")
            ?.addEventListener("click", loadModelList);
        } finally {
          isLoadingModels = false;
        }
      }

      function renderModelOptions(stockIds) {
        modelDropdownList.innerHTML = "";
        stockIds.forEach((stockId) => {
          const name = Utils.getModelName(stockId);
          const safeId = String(stockId).replace(/[^a-zA-Z0-9-]/g, "-");
          const option = document.createElement("div");
          option.className = "ark-model-option";
          option.innerHTML = `
            <input type="checkbox" id="model-${Utils.escapeHtml(safeId)}" value="${Utils.escapeHtml(String(stockId))}" ${selectedModels.has(stockId) ? "checked" : ""}>
            <label class="ark-model-option-label" for="model-${Utils.escapeHtml(safeId)}">${Utils.escapeHtml(name)}</label>
          `;
          modelDropdownList.appendChild(option);
        });

        const checkboxes = modelDropdownList.querySelectorAll(
          'input[type="checkbox"]',
        );
        checkboxes.forEach((checkbox) => {
          checkbox.addEventListener("change", (e) => {
            const stockId = Number(e.target.value);
            if (e.target.checked) {
              selectedModels.add(stockId);
            } else {
              selectedModels.delete(stockId);
            }
            updateSelectedTags();
          });
        });
      }

      function filterModelOptions(searchTerm) {
        if (!searchTerm.trim()) {
          renderModelOptions(allModels);
          return;
        }
        const term = searchTerm.toLowerCase();
        const filtered = allModels.filter((stockId) =>
          Utils.getModelName(stockId).toLowerCase().includes(term),
        );
        renderModelOptions(filtered);
      }

      function toggleDropdown() {
        isDropdownOpen = !isDropdownOpen;
        if (isDropdownOpen) {
          modelDropdown.classList.add("visible");
          modelToggleBtn.classList.add("open");
          if (allModels.length === 0 && !isLoadingModels) {
            loadModelList();
          }
          setTimeout(() => modelDropdownSearch.focus(), 100);
        } else {
          modelDropdown.classList.remove("visible");
          modelToggleBtn.classList.remove("open");
        }
      }

      function closeDropdown(e) {
        if (
          !modelDropdown.contains(e.target) &&
          !modelSelectorInput.contains(e.target)
        ) {
          isDropdownOpen = false;
          modelDropdown.classList.remove("visible");
          modelToggleBtn.classList.remove("open");
        }
      }

      modelSelectorInput.addEventListener("click", toggleDropdown);
      modelToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDropdown();
      });

      modelDropdownSearch.addEventListener("input", (e) =>
        filterModelOptions(e.target.value),
      );

      modelSelectAllBtn.addEventListener("click", () => {
        allModels.forEach((stockId) => selectedModels.add(stockId));
        updateSelectedTags();
        updateCheckboxStates();
      });

      modelClearAllBtn.addEventListener("click", () => {
        selectedModels.clear();
        updateSelectedTags();
        updateCheckboxStates();
      });

      modelClearSelectionBtn.addEventListener("click", () => {
        selectedModels.clear();
        updateSelectedTags();
        updateCheckboxStates();
      });

      modelAddSelectedBtn.addEventListener("click", () => {
        if (selectedModels.size === 0) return;
        addModels([...selectedModels]);
        selectedModels.clear();
        updateSelectedTags();
        updateCheckboxStates();
        isDropdownOpen = false;
        modelDropdown.classList.remove("visible");
        modelToggleBtn.classList.remove("open");
      });

      modelSelectedTags.addEventListener("click", (e) => {
        if (e.target.classList.contains("remove-tag-btn")) {
          const stockId = Number(e.target.getAttribute("data-stock-id"));
          removeSelectedTag(stockId);
        }
      });

      document.addEventListener("click", closeDropdown);

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isDropdownOpen) {
          toggleDropdown();
        }
      });
    },

    createSettingsPanel() {
      if (this._settingsPanel) return this._settingsPanel;

      const data = Storage.load();
      this._settingsPanel = document.createElement("div");
      this._settingsPanel.id = "ark-settings-panel";

      this._settingsPanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">监控设置</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-section-label">定时获取最新价格</div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">启用：</span>
              <label class="ark-toggle">
                <input type="checkbox" id="ark-auto-toggle" />
                <span class="slider"></span>
              </label>
              <button class="ark-blue-btn" id="ark-fetch-btn">手动获取</button>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">匹配分钟尾数：</span>
              <input type="text" class="ark-minute-input" id="ark-minute-ends" placeholder="如 3,8" title="如填 3,8 代表每小时的 03、08、13、18...分钟，会自动触发行情获取" />
              <button class="ark-green-btn" id="ark-save-minute-btn">保存</button>
            </div>
          </div>

          <div class="ark-section" id="ark-notification-section">
            <div class="ark-section-label">价格突破提醒</div>
            <div class="ark-trigger-row">
              <button class="ark-blue-btn" id="ark-test-notif-btn">测试已打开的提醒</button>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">开启浏览器弹窗提醒：</span>
              <label class="ark-toggle">
                <input type="checkbox" id="ark-notif-popup-toggle" />
                <span class="slider"></span>
              </label>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">开启提示音：</span>
              <label class="ark-toggle">
                <input type="checkbox" id="ark-notif-sound-toggle" />
                <span class="slider"></span>
              </label>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">开启 Telegram 提醒：</span>
              <label class="ark-toggle">
                <input type="checkbox" id="ark-notif-telegram-toggle" />
                <span class="slider"></span>
              </label>
            </div>
            <div id="ark-telegram-config" style="display:none; margin-top: 10px;">
              <div class="ark-trigger-row">
                <span style="color:var(--ark-label);font-size:12px;width:80px;">Bot Token：</span>
                <input type="text" class="ark-minute-input" id="ark-telegram-token" placeholder="请输入 Token" style="width: 320px;" />
              </div>
              <div class="ark-trigger-row">
                <span style="color:var(--ark-label);font-size:12px;width:80px;">Chat ID：</span>
                <input type="text" class="ark-minute-input" id="ark-telegram-chatid" placeholder="请输入 Chat ID" style="width: 320px;" />
              </div>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">开启 Bark 提醒：</span>
              <label class="ark-toggle">
                <input type="checkbox" id="ark-notif-bark-toggle" />
                <span class="slider"></span>
              </label>
            </div>
            <div id="ark-bark-config" style="display:none; margin-top: 10px;">
              <div class="ark-trigger-row">
                <span style="color:var(--ark-label);font-size:12px;width:80px;">Bark URL：</span>
                <input type="text" class="ark-minute-input" id="ark-bark-url" placeholder="https://api.day.app/YOUR_KEY" style="width: 320px;" />
              </div>
              <div style="font-size:10px;color:var(--ark-muted);margin-top:4px;margin-left:80px;">
                从 Bark App 复制完整推送地址
              </div>
            </div>
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ark-border-2);">
              <div class="ark-section-label" style="font-size: 11px; color: var(--ark-muted); border-bottom: none; margin-bottom: 6px;">添加模型价格突破提醒</div>
              <div class="ark-trigger-row">
                <span style="color:var(--ark-label);font-size:12px;">模型：</span>
                <select id="ark-notif-model-select" class="ark-minute-input" style="width: 300px; background: var(--ark-input); border: 1px solid var(--ark-border-2); color: var(--ark-text); padding: 5px 10px; border-radius: 6px;">
                  <option value="">请选择模型</option>
                </select>
              </div>
              <div class="ark-trigger-row">
                <span style="color:var(--ark-label);font-size:12px;">向上突破：</span>
                <input type="number" class="ark-minute-input" id="ark-notif-upper" style="width: 80px;" min="0" step="1" />
                <span style="color:var(--ark-label);font-size:12px; margin-left: 10px;">向下突破：</span>
                <input type="number" class="ark-minute-input" id="ark-notif-lower" style="width: 80px;" min="0" step="1" />
                <button class="ark-green-btn" id="ark-save-notif-btn" style="margin-left: 10px;">添加</button>
              </div>
            </div>
            <div id="ark-notif-list" style="margin-top: 10px; max-height: 250px; overflow-y: auto;"></div>
          </div>
        </div>
      `;

      document.body.appendChild(this._settingsPanel);
      Interactions.initDrag(
        this._settingsPanel,
        this._settingsPanel.querySelector(".ark-panel-header"),
      );

      this._settingsPanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._settingsPanel.classList.remove("visible");
        });

      const toggle = this._settingsPanel.querySelector("#ark-auto-toggle");
      const minuteInput = this._settingsPanel.querySelector("#ark-minute-ends");
      toggle.checked = data.autoTrigger;
      minuteInput.value = data.autoTriggerMinuteEnds;

      toggle.addEventListener("change", () => {
        const d = Storage.load();
        d.autoTrigger = toggle.checked;
        Storage.save(d);
        if (toggle.checked) Scheduler.start();
        else Scheduler.stop();
      });

      minuteInput.addEventListener("change", () => {
        const d = Storage.load();
        d.autoTriggerMinuteEnds = minuteInput.value.trim();
        Storage.save(d);
      });

      const saveMinuteBtn = this._settingsPanel.querySelector(
        "#ark-save-minute-btn",
      );
      saveMinuteBtn.addEventListener("click", () => {
        const d = Storage.load();
        d.autoTriggerMinuteEnds = minuteInput.value.trim();
        Storage.save(d);
        const originalText = saveMinuteBtn.textContent;
        saveMinuteBtn.textContent = "已保存";
        setTimeout(() => {
          saveMinuteBtn.textContent = originalText;
        }, 1000);
      });

      const fetchBtn = this._settingsPanel.querySelector("#ark-fetch-btn");
      fetchBtn.addEventListener("click", async () => {
        fetchBtn.disabled = true;
        fetchBtn.textContent = "获取中...";
        await App.doFetch();
        fetchBtn.disabled = false;
        fetchBtn.textContent = "手动获取";
      });

      const notifPopupToggle = this._settingsPanel.querySelector(
        "#ark-notif-popup-toggle",
      );
      const notifSoundToggle = this._settingsPanel.querySelector(
        "#ark-notif-sound-toggle",
      );
      const notifTelegramToggle = this._settingsPanel.querySelector(
        "#ark-notif-telegram-toggle",
      );
      const telegramConfig = this._settingsPanel.querySelector(
        "#ark-telegram-config",
      );
      const telegramTokenInput = this._settingsPanel.querySelector(
        "#ark-telegram-token",
      );
      const telegramChatIdInput = this._settingsPanel.querySelector(
        "#ark-telegram-chatid",
      );
      const notifBarkToggle = this._settingsPanel.querySelector(
        "#ark-notif-bark-toggle",
      );
      const barkConfig = this._settingsPanel.querySelector("#ark-bark-config");
      const barkUrlInput = this._settingsPanel.querySelector("#ark-bark-url");
      const notifModelSelect = this._settingsPanel.querySelector(
        "#ark-notif-model-select",
      );
      const notifUpperInput =
        this._settingsPanel.querySelector("#ark-notif-upper");
      const notifLowerInput =
        this._settingsPanel.querySelector("#ark-notif-lower");
      const saveNotifBtn = this._settingsPanel.querySelector(
        "#ark-save-notif-btn",
      );
      const notifList = this._settingsPanel.querySelector("#ark-notif-list");
      const testNotifBtn = this._settingsPanel.querySelector(
        "#ark-test-notif-btn",
      );

      const settings = data.notificationSettings;
      notifPopupToggle.checked = settings.enablePopup;
      notifSoundToggle.checked = settings.enableSound;
      notifTelegramToggle.checked = settings.enableTelegram;
      telegramTokenInput.value = settings.telegramBotToken || "";
      telegramChatIdInput.value = settings.telegramChatId || "";
      telegramConfig.style.display = settings.enableTelegram ? "block" : "none";
      notifBarkToggle.checked = settings.enableBark;
      barkUrlInput.value = settings.barkUrl || "";
      barkConfig.style.display = settings.enableBark ? "block" : "none";

      notifPopupToggle.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.enablePopup = notifPopupToggle.checked;
        Storage.save(d);
      });

      notifSoundToggle.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.enableSound = notifSoundToggle.checked;
        Storage.save(d);
      });

      notifTelegramToggle.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.enableTelegram = notifTelegramToggle.checked;
        Storage.save(d);
        telegramConfig.style.display = notifTelegramToggle.checked
          ? "block"
          : "none";
      });

      telegramTokenInput.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.telegramBotToken =
          telegramTokenInput.value.trim() || null;
        Storage.save(d);
      });

      telegramChatIdInput.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.telegramChatId =
          telegramChatIdInput.value.trim() || null;
        Storage.save(d);
      });

      notifBarkToggle.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.enableBark = notifBarkToggle.checked;
        Storage.save(d);
        barkConfig.style.display = notifBarkToggle.checked ? "block" : "none";
      });

      barkUrlInput.addEventListener("change", () => {
        const d = Storage.load();
        d.notificationSettings.barkUrl = barkUrlInput.value.trim() || null;
        Storage.save(d);
      });

      function populateNotifModelSelect() {
        const data = Storage.load();
        notifModelSelect.innerHTML = '<option value="">请选择模型</option>';
        data.stockIds.forEach((stockId) => {
          const option = document.createElement("option");
          option.value = stockId;
          option.textContent = Utils.getModelName(stockId);
          notifModelSelect.appendChild(option);
        });
      }

      function renderNotificationList() {
        const data = Storage.load();
        const notifications = data.notifications;
        const keys = Object.keys(notifications);

        if (keys.length === 0) {
          notifList.innerHTML =
            '<div style="color:var(--ark-muted);font-size:12px;text-align:center;">暂无提醒设置</div>';
          return;
        }

        notifList.innerHTML = keys
          .map((stockId) => {
            const config = notifications[stockId];
            const upper =
              config.upperLimit !== null && config.upperLimit !== undefined
                ? config.upperLimit
                : "-";
            const lower =
              config.lowerLimit !== null && config.lowerLimit !== undefined
                ? config.lowerLimit
                : "-";
            return `
          <div style="display:flex;align-items:center;padding:6px 8px;background:var(--ark-input);border:1px solid var(--ark-border);border-radius:4px;margin-bottom:4px;">
            <span style="color:var(--ark-text);font-size:12px;flex-shrink:0;margin-right:auto;">${Utils.escapeHtml(Utils.getModelName(stockId))}</span>
            <span style="color:var(--ark-muted);font-size:11px;width:100px;text-align:left;">向上突破：${upper}</span>
            <span style="color:var(--ark-muted);font-size:11px;width:100px;text-align:left;">向下突破：${lower}</span>
            <button class="del-btn" data-stock-id="${Utils.escapeHtml(String(stockId))}" title="删除" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:14px;padding:0 4px;margin-left:8px;flex-shrink:0;">&times;</button>
          </div>
        `;
          })
          .join("");

        notifList.querySelectorAll(".del-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const stockId = Number(btn.getAttribute("data-stock-id"));
            const d = Storage.load();
            delete d.notifications[stockId];
            Storage.save(d);
            renderNotificationList();
          });
        });
      }

      saveNotifBtn.addEventListener("click", () => {
        const stockId = notifModelSelect.value;
        const upperInput = notifUpperInput.value.trim();
        const lowerInput = notifLowerInput.value.trim();
        let upper = null;
        let lower = null;

        if (upperInput) {
          upper = parseFloat(upperInput);
          if (isNaN(upper) || upper < 0 || !Number.isInteger(upper)) {
            alert("上限价格必须是不小于0的整数");
            return;
          }
        }
        if (lowerInput) {
          lower = parseFloat(lowerInput);
          if (isNaN(lower) || lower < 0 || !Number.isInteger(lower)) {
            alert("下限价格必须是不小于0的整数");
            return;
          }
        }
        if (!stockId) {
          alert("请选择模型");
          return;
        }
        if (upper === null && lower === null) {
          alert("请至少填写上限或下限");
          return;
        }

        const d = Storage.load();
        if (!d.notifications[stockId]) {
          d.notifications[stockId] = { upperLimit: null, lowerLimit: null };
        }
        if (upper !== null) d.notifications[stockId].upperLimit = upper;
        if (lower !== null) d.notifications[stockId].lowerLimit = lower;
        Storage.save(d);
        notifUpperInput.value = "";
        notifLowerInput.value = "";
        notifModelSelect.value = "";
        renderNotificationList();
      });

      testNotifBtn.addEventListener("click", () => {
        Notification.sendTest();
      });
      notifModelSelect.addEventListener("mousedown", () => {
        populateNotifModelSelect();
      });

      populateNotifModelSelect();
      renderNotificationList();

      return this._settingsPanel;
    },

    createDataMaintenancePanel() {
      if (this._dataMaintenancePanel) return this._dataMaintenancePanel;

      const data = Storage.load();
      this._dataMaintenancePanel = document.createElement("div");
      this._dataMaintenancePanel.id = "ark-data-maintenance-panel";

      this._dataMaintenancePanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">数据维护</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-section-label">数据清理</div>
            <!-- 存储占用展示 -->
            <div class="ark-trigger-row">
              <span style="font-size: 12px; color: var(--ark-label);">全部数据大小：</span>
              <span style="font-size: 14px; font-weight: 600; color: var(--ark-text-primary);" id="ark-storage-size">计算中...</span>
              <button class="ark-refresh-btn" id="ark-storage-size-refresh-btn" title="重新计算数据大小" style="margin-left: 8px;">↻</button>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">价格数据保留天数：</span>
              <input type="number" class="ark-minute-input" id="ark-price-days-limit"
                    placeholder="天数" min="1" step="1" value="${data.priceDataDaysLimit}"
                    style="width: 80px;" />
              <button class="ark-green-btn" id="ark-save-price-days-btn">保存</button>
            </div>
            <div style="margin-top: 8px; font-size: 11px; color: var(--ark-muted);">
              注：设置后不会立即清理，待第二天第一次获取数据时才自动清理超出时间范围的数据
            </div>
          </div>

          <div class="ark-section">
            <div class="ark-section-label">数据同步</div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">数据服务地址：</span>
              <input type="text"
                     id="ark-data-service-url"
                     value="${data.dataServiceUrl || ""}"
                     style="flex: 1; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--ark-border); background: var(--ark-input-bg); color: var(--ark-text-primary);" />
            </div>
            <div class="ark-trigger-row" style="margin-top: 12px;">
              <button class="ark-blue-btn" id="ark-sync-price-data-btn" title="同步最近7天的价格数据">
                价格同步
              </button>
            </div>
            <div id="ark-sync-status" style="margin-top: 8px; font-size: 11px; color: var(--ark-muted); min-height: 16px;">
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(this._dataMaintenancePanel);
      Interactions.initDrag(
        this._dataMaintenancePanel,
        this._dataMaintenancePanel.querySelector(".ark-panel-header"),
      );

      this._dataMaintenancePanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._dataMaintenancePanel.classList.remove("visible");
        });

      // 计算并展示存储大小
      const storageSizeEl =
        this._dataMaintenancePanel.querySelector("#ark-storage-size");
      const updateStorageSize = () => {
        if (storageSizeEl) {
          try {
            const size = Utils.calculateStorageSize();
            storageSizeEl.textContent = size;
          } catch (e) {
            storageSizeEl.textContent = "计算失败";
            console.error("[Ark Stock Monitor] 计算存储大小失败:", e);
          }
        }
      };

      updateStorageSize();

      // 添加刷新按钮事件
      const storageSizeRefreshBtn = this._dataMaintenancePanel.querySelector(
        "#ark-storage-size-refresh-btn",
      );
      if (storageSizeRefreshBtn) {
        storageSizeRefreshBtn.addEventListener("click", () => {
          if (storageSizeRefreshBtn.disabled) return;

          storageSizeRefreshBtn.disabled = true;
          storageSizeRefreshBtn.classList.add("loading");

          // 使用 setTimeout 让动画效果可见
          setTimeout(() => {
            updateStorageSize();
            storageSizeRefreshBtn.disabled = false;
            storageSizeRefreshBtn.classList.remove("loading");
          }, 300);
        });
      }

      const saveDaysBtn = this._dataMaintenancePanel.querySelector(
        "#ark-save-price-days-btn",
      );
      const daysInput = this._dataMaintenancePanel.querySelector(
        "#ark-price-days-limit",
      );

      saveDaysBtn.addEventListener("click", () => {
        const value = daysInput.value.trim();
        const days = parseInt(value, 10);

        if (
          !value ||
          isNaN(days) ||
          days < 2 ||
          !Number.isInteger(parseFloat(value))
        ) {
          alert("价格数据保留天数必须是大于1的整数");
          return;
        }

        const d = Storage.load();
        d.priceDataDaysLimit = days;
        Storage.save(d);

        const originalText = saveDaysBtn.textContent;
        saveDaysBtn.textContent = "已保存";
        setTimeout(() => {
          saveDaysBtn.textContent = originalText;
        }, 1000);
      });

      // 数据服务地址输入（参考 Telegram 输入框的 change 事件自动保存）
      const serviceUrlInput = this._dataMaintenancePanel.querySelector(
        "#ark-data-service-url",
      );

      serviceUrlInput.addEventListener("change", () => {
        const url = serviceUrlInput.value.trim();

        // 简单的 URL 验证
        if (url && !url.match(/^https?:\/\/.+/)) {
          alert("请输入有效的服务地址（以 http:// 或 https:// 开头）");
          serviceUrlInput.value = Storage.load().dataServiceUrl || ""; // 恢复原值
          return;
        }

        const d = Storage.load();
        d.dataServiceUrl = url;
        Storage.save(d);
      });

      // 价格同步按钮
      const syncPriceBtn = this._dataMaintenancePanel.querySelector(
        "#ark-sync-price-data-btn",
      );
      const syncStatusEl =
        this._dataMaintenancePanel.querySelector("#ark-sync-status");

      syncPriceBtn.addEventListener("click", async () => {
        const d = Storage.load();

        // 验证必要条件
        if (!d.dataServiceUrl) {
          alert("请先输入数据服务地址");
          return;
        }

        if (!d.stockIds || d.stockIds.length === 0) {
          alert("请先在主面板设置要监控的模型");
          return;
        }

        // 确认操作
        if (
          !confirm(
            `将从服务获取 ${d.stockIds.length} 个模型的7天价格数据并合并到本地，是否继续？`,
          )
        ) {
          return;
        }

        // 禁用按钮，显示加载状态
        syncPriceBtn.disabled = true;
        syncPriceBtn.textContent = "同步中...";
        syncStatusEl.textContent = "正在从服务获取数据...";
        syncStatusEl.style.color = "var(--ark-accent)";

        try {
          // 调用通用 API，传入价格批量接口的端点和参数（主键为 stockId）
          const serviceData = await API.syncBatchData(
            d.dataServiceUrl,
            "/api/prices/batch",
            { stockIds: d.stockIds, days: 7 },
          );

          syncStatusEl.textContent = "数据获取成功，正在处理...";

          // 转换格式（价格特定）
          const converted = Utils.convertPriceDataFormat(serviceData);

          // 合并数据（价格特定）
          const { merged, totalAdded, totalRemoved } = Utils.mergePriceData(
            d.priceData,
            converted,
          );

          // 保存
          d.priceData = merged;
          Storage.save(d);

          // 更新存储大小显示
          updateStorageSize();

          // 成功反馈
          syncStatusEl.textContent = `✓ 同步成功！同步了 ${totalAdded} 条价格数据`;
          syncStatusEl.style.color = "#1db110";

          syncPriceBtn.textContent = "同步完成";
          setTimeout(() => {
            syncPriceBtn.textContent = "价格同步";
            syncPriceBtn.disabled = false;
          }, 2000);
        } catch (error) {
          console.error("[Ark Stock Monitor] 价格同步失败:", error);

          syncStatusEl.textContent = `✗ 同步失败：${error.message}`;
          syncStatusEl.style.color = "#af0837";

          syncPriceBtn.textContent = "价格同步";
          syncPriceBtn.disabled = false;
        }
      });

      return this._dataMaintenancePanel;
    },

    createPricePanel() {
      if (this._pricePanel) return this._pricePanel;

      const data = Storage.load();
      this._pricePanel = document.createElement("div");
      this._pricePanel.id = "ark-price-panel";

      this._pricePanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">最新价格<span style="color:var(--ark-label);font-size:12px;">（最近 ${CONFIG.TABLE_DISPLAY_LIMIT} 条）</span></span>
          </div>
          <div class="header-right">
          <span class="info-btn-wrap">
              <button class="info-btn" title="">💡</button>
              <span class="info-tooltip">
                <div>小提示：</div>
                <div>1. <span style="color:#F55454">红字</span>表示较前一时刻价格下跌，<span style="color:#00A854">绿字</span>表示较前一时刻价格上涨</div>
                <div>2. 表头模型名称为<span style="color:#a855f7">紫色</span>表示有持仓，名称前的🔒表示持仓锁定中</div>
                <div>3. 表头模型名称处右键点击可打开交易菜单：买入 / 卖出 / 颜色标识（红/绿/黄/橙/粉/青，优先级低于持仓颜色）</div>
                <div>4. 点击表头模型名称可查看该模型分时图：</div>
                <pre>① 分时图窗口可拖拽改变大小\n② 分时图内拖拽可移动时间窗口\n③ 数据线和坐标轴处可通过鼠标滚轮实现范围缩放</pre>
              </span>
            </span>
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-section-header" style="justify-content: space-between;">
              <div style="display: flex; align-items: center;">
                <button class="ark-refresh-btn" id="ark-price-refresh-btn" title="手动刷新数据">↻</button>
                <div class="ark-last-update">最近更新：<span id="ark-last-update-time-price" style="white-space: nowrap;">从未更新</span></div>
              </div>
              <div style="display: flex; gap: 12px; font-size: 12px;">
                <div><span style="color:var(--ark-label);">可用代币：</span><span style="color:#4caf50;font-weight:600;" id="ark-user-quota">-</span></div>
                <div><span style="color:var(--ark-label);">持仓总值：</span><span style="color:var(--ark-accent);font-weight:600;cursor:pointer;" id="ark-holdings-total" title="点击查看我的持仓">-</span></div>
              </div>
            </div>
            <div class="ark-table-wrap" id="ark-price-table-wrap">
              <div class="ark-empty-hint">暂无数据，请添加模型后获取</div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(this._pricePanel);
      Interactions.initDrag(
        this._pricePanel,
        this._pricePanel.querySelector(".ark-panel-header"),
      );

      this._pricePanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._pricePanel.classList.remove("visible");
        });

      // 添加刷新按钮点击事件
      const refreshBtn = this._pricePanel.querySelector(
        "#ark-price-refresh-btn",
      );
      refreshBtn.addEventListener("click", async () => {
        if (refreshBtn.disabled) return;

        refreshBtn.disabled = true;
        refreshBtn.classList.add("loading");

        try {
          await App.doFetch();
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.classList.remove("loading");
        }
      });

      // 添加持仓金额点击事件
      const holdingsTotalEl = this._pricePanel.querySelector(
        "#ark-holdings-total",
      );
      holdingsTotalEl.addEventListener("click", () => {
        if (!UIPanels._positionsPanel) {
          UIPanels._positionsPanel = UIPanels.createPositionsPanel();
        }
        UIPanels._positionsPanel.classList.add("visible");
        UIPanels.bringToFront(UIPanels._positionsPanel);
        const data = Storage.load();
        UIRenderers.refreshPositionsPanel(data);
      });

      if (data.lastUpdateTime) {
        UIRenderers.updateLastUpdateDisplayForPricePanel(data.lastUpdateTime);
      }

      return this._pricePanel;
    },

    createPositionsPanel() {
      if (this._positionsPanel) return this._positionsPanel;

      const data = Storage.load();
      this._positionsPanel = document.createElement("div");
      this._positionsPanel.id = "ark-positions-panel";

      this._positionsPanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">我的持仓</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-last-update" style="margin-bottom: 10px;">
              最近更新：<span class="last-update-time">${data.lastUpdateTime ? TimeUtils.formatDateTime(data.lastUpdateTime, "full") : "从未更新"}</span>
            </div>
            <div class="ark-table-wrap">
              <table class="ark-positions-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>股数</th>
                    <th>成本价</th>
                    <th>现价</th>
                    <th title="成本价 × 份额 × (1+买入手续费)">含费成本</th>
                    <th title="现价 × 份额 × (1-卖出手续费)">费后收入</th>
                    <th title="费后收入 - 含费成本">实际盈亏</th>
                    <th title="实际盈亏 / 含费成本">盈亏幅度</th>
                    <th title="红色表示未解锁，绿色表示已解锁">解锁时间</th>
                  </tr>
                </thead>
                <tbody id="ark-positions-tbody">
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(this._positionsPanel);
      Interactions.initDrag(
        this._positionsPanel,
        this._positionsPanel.querySelector(".ark-panel-header"),
      );

      this._positionsPanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._positionsPanel.classList.remove("visible");
        });

      return this._positionsPanel;
    },

    createArbitragePanel() {
      if (this._arbitragePanel) return this._arbitragePanel;

      const data = Storage.load();
      // 面板级选择状态（关闭/重开期间保留；跨页面刷新不保留）
      this._arbitrageSelection = this._arbitrageSelection || {
        days: 1,
        activeOnly: true,
      };
      const sel = this._arbitrageSelection;
      this._arbitragePanel = document.createElement("div");
      this._arbitragePanel.id = "ark-arbitrage-panel";

      this._arbitragePanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">套利幅度榜</span>
          </div>
          <div class="header-right">
            <span class="info-btn-wrap">
              <button class="info-btn" title="">💡</button>
              <span class="info-tooltip">
                <div>小提示：</div>
                <div>行情停滞的模型在无指定天数的历史数据时，会取停滞前的 24 小时数据来计算，</div>
                <div>可能与其他模型数据不在同一时间段，此时排行结果仅供参考！</div>
              </span>
            </span>
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-arbitrage-controls">
            <div class="ark-last-update">
              最近更新：<span id="ark-arbitrage-last-update-time">${data.lastUpdateTime ? TimeUtils.formatDateTime(data.lastUpdateTime, "full") : "从未更新"}</span>
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
              <label class="ark-arbitrage-filter-label">
                <input type="checkbox" id="ark-arbitrage-active-only" ${sel.activeOnly ? "checked" : ""}>
                只看未停滞模型
              </label>
              <div class="ark-arbitrage-sort-wrapper">
                <span style="color:var(--ark-label);font-size:12px;">最近天数：</span>
                <select class="ark-arbitrage-sort-select" id="ark-arbitrage-days-select">
                  <option value="1"${sel.days === 1 ? " selected" : ""}>1 天</option>
                  <option value="2"${sel.days === 2 ? " selected" : ""}>2 天</option>
                  <option value="3"${sel.days === 3 ? " selected" : ""}>3 天</option>
                  <option value="4"${sel.days === 4 ? " selected" : ""}>4 天</option>
                  <option value="5"${sel.days === 5 ? " selected" : ""}>5 天</option>
                  <option value="6"${sel.days === 6 ? " selected" : ""}>6 天</option>
                  <option value="7"${sel.days === 7 ? " selected" : ""}>7 天</option>
                </select>
              </div>
            </div>
          </div>
          <div class="ark-arbitrage-table-wrap" id="ark-arbitrage-table-wrap">
            <div class="ark-empty-hint">暂无活跃套利数据</div>
          </div>
        </div>
      `;

      document.body.appendChild(this._arbitragePanel);
      Interactions.initDrag(
        this._arbitragePanel,
        this._arbitragePanel.querySelector(".ark-panel-header"),
      );

      this._arbitragePanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._arbitragePanel.classList.remove("visible");
        });

      const daysSelect = this._arbitragePanel.querySelector(
        "#ark-arbitrage-days-select",
      );
      const activeBox = this._arbitragePanel.querySelector(
        "#ark-arbitrage-active-only",
      );

      const rerenderArbitrage = () => {
        const d = Storage.load();
        const dataToRender = d.arbitrageData || [];
        UIRenderers.renderArbitrageTable(dataToRender);
      };

      daysSelect.addEventListener("change", () => {
        this._arbitrageSelection.days = Number(daysSelect.value) || 1;
        rerenderArbitrage();
      });
      activeBox.addEventListener("change", () => {
        this._arbitrageSelection.activeOnly = activeBox.checked;
        rerenderArbitrage();
      });

      if (data.lastUpdateTime) {
        const dataToRender = data.arbitrageData || [];
        UIRenderers.renderArbitrageTable(dataToRender);
        UIRenderers.updateArbitrageLastUpdateDisplay(data.lastUpdateTime);
      }

      return this._arbitragePanel;
    },

    // ==================== 交易记录面板 ====================

    // 打开交易记录面板（懒创建单例），渲染前先从本地数据刷新下拉与表格
    openTradesHistoryPanel() {
      if (!this._tradesPanel) {
        this._tradesPanel = this.createTradesPanel();
      }
      this._tradesPanel.classList.add("visible");
      this.bringToFront(this._tradesPanel);
      UIRenderers.refreshTradesPanel();
    },

    createTradesPanel() {
      if (this._tradesPanel) return this._tradesPanel;

      const data = Storage.load();
      this._tradesPanel = document.createElement("div");
      this._tradesPanel.id = "ark-trades-panel";

      this._tradesPanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">交易记录</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-trades-note">注意：由于站点无交易查询接口，故仅记录通过本脚本完成的交易</div>
            <div class="ark-trades-controls">选择模型：
              <select class="ark-trades-model-select" id="ark-trades-model-select">
                <option value="">全部</option>
              </select>
              <span class="ark-trades-count" id="ark-trades-count"></span>
            </div>
            <div class="ark-table-wrap" id="ark-trades-table-wrap">
              <div class="ark-empty-hint">暂无交易记录</div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(this._tradesPanel);
      Interactions.initDrag(
        this._tradesPanel,
        this._tradesPanel.querySelector(".ark-panel-header"),
      );

      this._tradesPanel
        .querySelector(".close-btn")
        .addEventListener("click", () => {
          this._tradesPanel.classList.remove("visible");
        });

      this._tradesPanel
        .querySelector("#ark-trades-model-select")
        .addEventListener("change", () => {
          UIRenderers.renderTradesTable(
            this._tradesPanel.querySelector("#ark-trades-model-select").value,
          );
        });

      return this._tradesPanel;
    },

    // ==================== 买入/卖出交易面板 ====================

    // 打开交易面板（单例复用，按 action 重渲染表单区）
    openTradePanel(action, stockId) {
      const panel =
        this._tradePanel || (this._tradePanel = this.createTradePanel());
      panel.classList.add("visible");
      this.bringToFront(panel);
      this._renderTradeForm(action, stockId); // 先用本地快照即时展示
      this._refreshTradePanelData(); // 再实时拉取覆盖
    },

    createTradePanel() {
      const panel = document.createElement("div");
      panel.id = "ark-trade-panel";

      panel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title" id="ark-trade-title"></span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-trade-info" id="ark-trade-info"></div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">股数：</span>
              <input type="number" class="ark-minute-input" id="ark-trade-shares" min="1" step="1" style="width:120px;" />
            </div>
            <div class="ark-trade-value-hint" id="ark-trade-value-hint"></div>
            <div class="ark-trade-quick-label" id="ark-trade-quick-label">填入全部可用量的：</div>
            <div class="ark-trade-quick-grid" id="ark-trade-quick-row">
              <button class="ark-green-btn" data-ratio="all">全部</button>
              <button class="ark-green-btn" data-ratio="half">1/2</button>
              <button class="ark-green-btn" data-ratio="quarter">1/4</button>
              <button class="ark-green-btn" data-ratio="tenth">1/10</button>
            </div>
            <div class="ark-trade-lock" id="ark-trade-lock" hidden></div>
            <div class="ark-trade-status" id="ark-trade-status"></div>
            <div class="ark-trade-actions">
              <button class="ark-blue-btn" id="ark-trade-confirm">确定</button>
              <button class="ark-green-btn" id="ark-trade-cancel">取消</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(panel);
      Interactions.initDrag(panel, panel.querySelector(".ark-panel-header"));

      // 关闭 / 取消：仅隐藏面板
      const closePanel = () => panel.classList.remove("visible");
      panel.querySelector(".close-btn").addEventListener("click", closePanel);
      panel
        .querySelector("#ark-trade-cancel")
        .addEventListener("click", closePanel);

      // 快捷按钮：按比例计算股数并填入输入框
      panel.querySelectorAll("#ark-trade-quick-row button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const state = this._tradeState;
          if (!state || btn.disabled) return;
          const ratios = { all: 1, half: 0.5, quarter: 0.25, tenth: 0.1 };
          const shares = Math.floor(
            state.maxShares * (ratios[btn.dataset.ratio] || 1),
          );
          const input = panel.querySelector("#ark-trade-shares");
          input.value = shares >= 1 ? shares : "";
          this._updateTradeValueHint();
        });
      });

      // 实时更新市值提示
      panel.querySelector("#ark-trade-shares").addEventListener("input", () => {
        this._updateTradeValueHint();
      });

      // 确定按钮：校验 → 提交 → 成功提示后自动关闭 → 刷新
      panel
        .querySelector("#ark-trade-confirm")
        .addEventListener("click", async () => {
          if (this._tradeBusy) return;
          const state = this._tradeState;
          if (!state || state.confirmDisabled) return;

          const input = panel.querySelector("#ark-trade-shares");
          const statusEl = panel.querySelector("#ark-trade-status");
          const confirmBtn = panel.querySelector("#ark-trade-confirm");
          const shares = Number(input.value);

          // 前端校验（服务端仍为最终防线）
          if (!Number.isInteger(shares) || shares < 1) {
            statusEl.textContent = "✗ 请输入正整数股数";
            statusEl.className = "ark-trade-status err";
            return;
          }
          if (shares > state.maxShares) {
            statusEl.textContent =
              state.action === "buy"
                ? "✗ 超出可用代币（含手续费）"
                : "✗ 超出持仓股数";
            statusEl.className = "ark-trade-status err";
            return;
          }

          this._tradeBusy = true;
          confirmBtn.disabled = true;
          confirmBtn.textContent = "提交中...";
          statusEl.textContent = "";
          statusEl.className = "ark-trade-status";

          try {
            const body = await API.submitTrade({
              action: state.action,
              stockId: state.stockId,
              shares,
            });

            // 交易成功：落库一条本地交易记录（接口不提供交易历史，仅供本脚本展示）
            DataProcessor.recordTrade({
              id: body?.tradeId,
              side: state.action,
              stockId: state.stockId,
              shares,
              price: state.price,
              feePct:
                state.action === "buy" ? state.buyFeePct : state.sellFeePct,
            });

            statusEl.textContent = `✓ ${state.action === "buy" ? "买入" : "卖出"} ${shares} 股成功`;
            statusEl.className = "ark-trade-status ok";

            // 保持面板打开，仅复位按钮与忙碌标记，便于继续交易
            this._tradeBusy = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent =
              state.action === "buy" ? "确定买入" : "确定卖出";
            input.value = "";
            this._updateTradeValueHint();

            // 交易成功后实时拉取最新数据刷新面板（fire-and-forget，成功提示由刷新后回显）
            this._refreshTradePanelData(
              `✓ ${state.action === "buy" ? "买入" : "卖出"} ${shares} 股成功`,
            );
          } catch (err) {
            console.error("[Ark Stock Monitor] 交易失败:", err);
            statusEl.textContent = `✗ ${err.message}`;
            statusEl.className = "ark-trade-status err";
            this._tradeBusy = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent =
              state.action === "buy" ? "确定买入" : "确定卖出";
          }
        });

      return panel;
    },

    // 按输入股数实时展示对应市值（买入=需支付，卖出=收入），并按余额/持仓校验着色
    _updateTradeValueHint() {
      const panel = this._tradePanel;
      if (!panel) return;
      const hintEl = panel.querySelector("#ark-trade-value-hint");
      const input = panel.querySelector("#ark-trade-shares");
      const state = this._tradeState;
      if (!hintEl || !input || !state) return;
      const shares = Number(input.value);
      const isBuy = state.action === "buy";
      hintEl.textContent = "";
      hintEl.classList.remove("ok", "err");
      // 股数为空 / 非正整数 / 无现价时留空，避免干扰输入
      if (
        !Number.isInteger(shares) ||
        shares <= 0 ||
        state.price == null ||
        state.price <= 0
      )
        return;
      const pct = isBuy ? state.buyFeePct : state.sellFeePct;
      const factor = isBuy ? 1 + pct / 100 : 1 - pct / 100;
      const amount = shares * state.price * factor;
      const formatted = Utils.formatThousands(Math.round(amount * 100) / 100);

      if (isBuy) {
        if (state.balance == null || amount > state.balance) {
          // 买入：需支付金额（含手续费）超出可用代币
          hintEl.textContent = "✗ 超出可用代币";
          hintEl.classList.add("err");
          return;
        }
        hintEl.textContent = `需支付：${formatted} 代币`;
        hintEl.classList.add("ok");
      } else {
        const posShares = state.pos ? state.pos.shares : 0;
        if (shares > posShares) {
          // 卖出：填入股数超出持仓
          hintEl.textContent = "✗ 超出持仓";
          hintEl.classList.add("err");
          return;
        }
        hintEl.textContent = `收入为：${formatted} 代币`;
        hintEl.classList.add("ok");
      }
    },

    // 实时拉取行情+余额并重渲染交易面板（纯展示，不写 Storage）
    // statusMessage：交易成功提示，重渲染后回显到状态行
    async _refreshTradePanelData(statusMessage) {
      const panel = this._tradePanel;
      const state = this._tradeState;
      if (!panel || !state) return;
      // 交易提交中不刷新：重渲染会复位 _tradeBusy 与确认按钮，可能造成重复提交
      if (this._tradeBusy) return;
      // 已有刷新在进行：排队，结束后补一次（避免与交易回调互相丢弃）
      if (this._tradeRefreshBusy) {
        this._tradeRefreshQueued = true;
        if (statusMessage) this._tradeRefreshQueuedMsg = statusMessage;
        return;
      }
      this._tradeRefreshBusy = true;
      const refreshBtn = panel.querySelector(
        "#ark-trade-info .ark-refresh-btn",
      );
      if (refreshBtn) refreshBtn.classList.add("loading");
      const { action, stockId } = state;
      try {
        const fresh = await API.fetchTradePanelData();
        // 请求期间面板可能已切换模型、关闭或发起了交易
        const cur = this._tradeState;
        if (!cur || cur.action !== action || cur.stockId !== stockId) return;
        if (!panel.classList.contains("visible")) return;
        if (this._tradeBusy) return;
        const input = panel.querySelector("#ark-trade-shares");
        const prevValue = input.value;
        this._renderTradeForm(action, stockId, fresh);
        if (prevValue) {
          // 保留用户已输入的股数
          input.value = prevValue;
          this._updateTradeValueHint();
        }
        if (statusMessage) {
          // 回显交易成功提示（重渲染会清空状态行）
          const statusEl = panel.querySelector("#ark-trade-status");
          statusEl.textContent = statusMessage;
          statusEl.className = "ark-trade-status ok";
        }
      } catch (e) {
        console.error("[Ark Stock Monitor] 交易面板数据刷新失败:", e);
      } finally {
        this._tradeRefreshBusy = false;
        const btn = panel.querySelector("#ark-trade-info .ark-refresh-btn");
        if (btn) btn.classList.remove("loading");
        // 处理排队中的刷新请求
        if (this._tradeRefreshQueued) {
          this._tradeRefreshQueued = false;
          const queuedMsg = this._tradeRefreshQueuedMsg;
          this._tradeRefreshQueuedMsg = null;
          this._refreshTradePanelData(queuedMsg);
        }
      }
    },

    // 打开时快照渲染表单（提交时服务端按实时数据兜底校验）
    // 传入 fresh（fetchTradePanelData 返回值）时改用实时数据渲染
    _renderTradeForm(action, stockId, fresh) {
      const panel = this._tradePanel;
      if (!panel) return;

      const data = Storage.load();
      const name = Utils.getModelName(stockId);
      // 实时数据（fresh.market.stocks 为数组视为有效），否则回退本地快照
      const useFresh = !!fresh && Array.isArray(fresh.market?.stocks);
      let price;
      let pos;
      let buyFeePct;
      let sellFeePct;
      let balance;
      let marketEnabled;
      if (useFresh) {
        const stock = fresh.market.stocks.find((s) => s.id === stockId);
        price = stock ? stock.priceCents / 100 : null;
        const rawPos = Array.isArray(fresh.market.positions)
          ? fresh.market.positions.find((p) => p.stockId === stockId)
          : null;
        pos = rawPos
          ? {
              shares: rawPos.shares,
              // 与 DataProcessor.processMarketData 同口径：holdUntil → 秒时间戳
              locked_until: rawPos.holdUntil
                ? Math.floor(Date.parse(rawPos.holdUntil) / 1000)
                : 0,
            }
          : null;
        buyFeePct = fresh.market.rules?.buyFeePct ?? 2;
        sellFeePct = fresh.market.rules?.sellFeePct ?? 2.5;
        balance = fresh.balance?.tokens ?? null;
        marketEnabled = fresh.market.enabled;
      } else {
        const priceList = data.priceData?.[stockId];
        price =
          priceList && priceList.length
            ? priceList[priceList.length - 1][1]
            : null;
        pos = data.positions?.[stockId] || null;
        const rules = data.marketRules?.rules || {};
        buyFeePct = rules.buyFeePct ?? 2;
        sellFeePct = rules.sellFeePct ?? 2.5;
        balance = data.userTokens; // 可能为 null（从未拉到余额）
        marketEnabled = data.marketRules?.enabled;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const locked = !!pos && pos.locked_until > nowSec;
      const modelNameMissing = !data.idToModel?.[stockId];

      // 计算最大可买/可卖股数
      let maxShares = 0;
      if (action === "buy") {
        if (price > 0 && balance > 0) {
          maxShares = Math.floor(
            balance / (price * (1 + buyFeePct / 100)) - 1e-9,
          );
        }
      } else {
        maxShares = pos ? pos.shares : 0;
      }

      this._tradeState = {
        action,
        stockId,
        price,
        pos,
        balance,
        buyFeePct,
        sellFeePct,
        locked,
        maxShares,
        confirmDisabled: false,
      };

      // 标题（textContent 赋值，天然免转义）
      const titleEl = panel.querySelector("#ark-trade-title");
      titleEl.textContent = action === "buy" ? "买入操作" : "卖出操作";

      // 摘要（纵向排列，textContent 赋值，天然免转义）
      const infoEl = panel.querySelector("#ark-trade-info");
      const priceText = price !== null ? price.toFixed(2) : "-";
      const balanceText =
        balance !== null ? Utils.formatThousands(balance) : "-";
      infoEl.textContent = "";
      const infoRow = (label, value) => {
        const row = document.createElement("div");
        row.className = "ark-trade-info-row";
        const labelEl = document.createElement("span");
        labelEl.className = "ark-trade-info-label";
        labelEl.textContent = label;
        const valueEl = document.createElement("span");
        valueEl.textContent = value;
        row.append(labelEl, valueEl);
        infoEl.appendChild(row);
      };
      infoRow("模型", name);
      infoRow("现价", `${priceText} 代币`);
      const quickLabel = panel.querySelector("#ark-trade-quick-label");
      if (quickLabel) {
        quickLabel.textContent =
          action === "buy" ? "买入可用代币的：" : "卖出持仓股数的：";
      }
      if (action === "buy") {
        infoRow("可用代币", balanceText);
        infoRow("买入手续费", `${buyFeePct}%`);
      } else {
        infoRow("持仓", pos ? `${pos.shares} 股` : "无持仓");
        infoRow("卖出手续费", `${sellFeePct}%`);
      }
      // 数据时间：发起实时请求的时间（快照渲染时尚未拉取，显示 "-"）
      const dataTimeRow = document.createElement("div");
      dataTimeRow.className = "ark-trade-info-row";
      const dataTimeLabel = document.createElement("span");
      dataTimeLabel.className = "ark-trade-info-label";
      dataTimeLabel.textContent = "数据时间";
      const dataTimeValue = document.createElement("span");
      dataTimeValue.textContent = useFresh
        ? TimeUtils.formatDateTime(fresh.requestedAt, "time")
        : "-";
      const refreshBtn = document.createElement("button");
      refreshBtn.className = "ark-refresh-btn";
      refreshBtn.title = "重新获取数据";
      refreshBtn.textContent = "↻";
      // 点击后重新调用数据接口并刷新面板数据（忙时在 _refreshTradePanelData 内排队/丢弃）
      refreshBtn.addEventListener("click", () => {
        this._refreshTradePanelData();
      });
      dataTimeRow.append(dataTimeLabel, dataTimeValue, refreshBtn);
      infoEl.appendChild(dataTimeRow);

      // 输入框复位并聚焦
      const input = panel.querySelector("#ark-trade-shares");
      input.value = "";
      input.max = maxShares >= 1 ? maxShares : 1;
      setTimeout(() => input.focus(), 0);

      // 最大股数提示已移除（快捷按钮仍按 maxShares 计算）
      const confirmBtn = panel.querySelector("#ark-trade-confirm");
      const statusEl = panel.querySelector("#ark-trade-status");
      const lockEl = panel.querySelector("#ark-trade-lock");
      statusEl.textContent = "";
      statusEl.className = "ark-trade-status";
      lockEl.hidden = true;
      lockEl.textContent = "";
      confirmBtn.disabled = false;
      confirmBtn.textContent = action === "buy" ? "确定买入" : "确定卖出";
      this._tradeBusy = false;

      // 快捷按钮可用性
      const quickBtns = panel.querySelectorAll("#ark-trade-quick-row button");
      quickBtns.forEach((b) => (b.disabled = maxShares < 1));
      this._updateTradeValueHint();

      // 各类禁用场景
      if (action === "buy") {
        if (price == null || balance == null || modelNameMissing) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "数据不足，请先刷新";
          statusEl.className = "ark-trade-status err";
        } else if (marketEnabled === false) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "休市中，无法交易";
          statusEl.className = "ark-trade-status err";
        } else if (maxShares < 1) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "可用代币不足（含手续费）";
          statusEl.className = "ark-trade-status err";
        }
      } else {
        if (!pos) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "暂无持仓";
          statusEl.className = "ark-trade-status err";
        } else if (modelNameMissing) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "数据不足，请先刷新";
          statusEl.className = "ark-trade-status err";
        } else if (marketEnabled === false) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "休市中，无法交易";
          statusEl.className = "ark-trade-status err";
        } else if (locked) {
          // 锁定期：提示锁定截止时间，确定按钮不可点击
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          lockEl.hidden = false;
          lockEl.textContent = `🔒 持仓锁定中，至 ${TimeUtils.formatSecondsTimestamp(pos.locked_until, "full")} 解锁`;
        } else if (maxShares < 1) {
          this._tradeState.confirmDisabled = true;
          confirmBtn.disabled = true;
          statusEl.textContent = "无持仓可卖出";
          statusEl.className = "ark-trade-status err";
        }
      }
    },
  };

  // ==================== UI 渲染器 ====================
  const UIRenderers = {
    // 渲染主面板的"市场状态"区块（enabled + 关键规则）
    renderMarketStatus(data) {
      const el = document.querySelector("#ark-market-status");
      if (!el) return;
      const mr = data.marketRules;
      if (!mr || mr.enabled === null) {
        el.textContent = "尚未获取";
        return;
      }
      const r = mr.rules || {};
      const enabledHtml = mr.enabled
        ? '<span style="color:#22c55e;font-weight:600;">● 开市</span>'
        : '<span style="color:#ef4444;font-weight:600;">● 休市</span>';
      const feeText = `买入 ${r.buyFeePct ?? "-"}% / 卖出 ${r.sellFeePct ?? "-"}%`;
      el.innerHTML = `
        ${enabledHtml}
        <div style="margin-top:6px;font-size:12px;line-height:1.7;">
          <div>买卖手续费：<strong>${feeText}</strong></div>
          <div>持仓锁定时长：<strong>${r.holdMinutes ?? "-"} 分钟</strong></div>
        </div>
      `;
    },

    renderModelList(stockIds) {
      const container = document.querySelector("#ark-model-list");
      if (!container) return;
      container.innerHTML = "";
      let dragSrcIdx = null;
      stockIds.forEach((stockId, idx) => {
        const name = Utils.getModelName(stockId);
        const tag = document.createElement("span");
        tag.className = "ark-model-tag";
        tag.draggable = true;
        tag.dataset.idx = idx;
        tag.innerHTML = `${Utils.escapeHtml(name)}<button class="del-btn" data-stock-id="${Utils.escapeHtml(String(stockId))}" title="删除">&times;</button>`;
        tag.querySelector(".del-btn").addEventListener("click", () => {
          const d = Storage.load();
          d.stockIds = d.stockIds.filter((m) => m !== stockId);
          Storage.save(d);
          UIRenderers.renderModelList(d.stockIds);
          UIRenderers.refreshPriceTable(d);
        });
        tag.addEventListener("dragstart", (e) => {
          dragSrcIdx = idx;
          tag.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        tag.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          tag.classList.add("drag-over");
        });
        tag.addEventListener("dragleave", () => {
          tag.classList.remove("drag-over");
        });
        tag.addEventListener("drop", (e) => {
          e.preventDefault();
          tag.classList.remove("drag-over");
          const dropIdx = parseInt(tag.dataset.idx);
          if (dragSrcIdx === null || dragSrcIdx === dropIdx) return;
          const d = Storage.load();
          const [moved] = d.stockIds.splice(dragSrcIdx, 1);
          d.stockIds.splice(dropIdx, 0, moved);
          Storage.save(d);
          UIRenderers.renderModelList(d.stockIds);
          UIRenderers.refreshPriceTable(d);
        });
        tag.addEventListener("dragend", () => {
          tag.classList.remove("dragging");
          container
            .querySelectorAll(".drag-over")
            .forEach((el) => el.classList.remove("drag-over"));
          dragSrcIdx = null;
        });
        container.appendChild(tag);
      });
    },

    refreshPriceTable(data) {
      const wrap = document.querySelector("#ark-price-table-wrap");
      if (!wrap) return;

      const stockIds = data.stockIds || [];
      const allData = data.priceData || {};

      if (stockIds.length === 0) {
        wrap.innerHTML =
          '<div class="ark-empty-hint">暂无数据，请添加模型后获取</div>';
        this._priceTableState = null;
        const pricePanel = document.querySelector("#ark-price-panel");
        if (pricePanel) {
          pricePanel.style.width = "400px";
        }
        return;
      }

      // 根据模型数量动态设置面板宽度
      const pricePanel = document.querySelector("#ark-price-panel");
      if (pricePanel) {
        const calculatedWidth = 80 * stockIds.length + 150;
        // 封顶不超过视口宽度 90%，避免模型过多时面板无限延伸
        const maxWidth = Math.floor(window.innerWidth * 0.9);
        const finalWidth = Math.max(400, Math.min(calculatedWidth, maxWidth));
        pricePanel.style.width = finalWidth + "px";
      }

      const tsSet = new Set();
      for (const id of stockIds) {
        const list = allData[id] || [];
        for (const item of list) {
          tsSet.add(item[0]);
        }
      }

      const timestampsAsc = [...tsSet]
        .sort((a, b) => a - b)
        .slice(-CONFIG.TABLE_DISPLAY_LIMIT);

      if (timestampsAsc.length === 0) {
        wrap.innerHTML =
          '<div class="ark-empty-hint">暂无数据，请获取价格</div>';
        this._priceTableState = null;
        return;
      }

      const priceMap = {};
      for (const id of stockIds) {
        priceMap[id] = {};
        const list = allData[id] || [];
        for (const item of list) {
          priceMap[id][item[0]] = item[1];
        }
      }

      const bgColorMap = {};

      for (const ts of timestampsAsc) {
        bgColorMap[ts] = {};
        for (const id of stockIds) {
          let cssClass = "price-neutral";
          const currentPrice = priceMap[id][ts];

          if (currentPrice !== undefined) {
            const prevTs = UIRenderers._findPreviousPriceTimestamp(
              ts,
              timestampsAsc,
              allData,
              priceMap,
            );
            if (prevTs) {
              const prevPrice = priceMap[id][prevTs];
              if (prevPrice !== undefined) {
                if (currentPrice > prevPrice) cssClass = "price-up";
                else if (currentPrice < prevPrice) cssClass = "price-down";
                else cssClass = bgColorMap[prevTs]?.[id] || "price-neutral";
              }
            }
          }

          bgColorMap[ts][id] = cssClass;
        }
      }

      const timestampsDesc = [...timestampsAsc].reverse();

      const now = Math.floor(Date.now() / 1000);
      const positions = data.positions || {};
      const modelColors = data.modelColors || {};

      const prevState = this._priceTableState;
      const sameStructure =
        prevState &&
        prevState.wrap === wrap &&
        this._arraysEqual(prevState.stockIds, stockIds) &&
        this._arraysEqual(prevState.timestamps, timestampsDesc);

      if (sameStructure) {
        // Header-only fields may have changed (color, positions); patch headers first
        if (
          !this._shallowEqual(prevState.modelColors, modelColors) ||
          !this._shallowEqual(prevState.positions, positions)
        ) {
          this._patchPriceHeader(wrap, stockIds, positions, modelColors, now);
          prevState.modelColors = { ...modelColors };
          prevState.positions = { ...positions };
        }
        this._patchPriceCells(
          wrap,
          stockIds,
          timestampsDesc,
          priceMap,
          bgColorMap,
        );
        return;
      }

      // Full rebuild with DOM API
      this._buildPriceTableDOM(
        wrap,
        stockIds,
        timestampsDesc,
        priceMap,
        bgColorMap,
        positions,
        modelColors,
        now,
      );

      this._priceTableState = {
        wrap,
        stockIds: [...stockIds],
        timestamps: [...timestampsDesc],
        modelColors: { ...modelColors },
        positions: { ...positions },
      };
    },

    _arraysEqual(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    },

    _shallowEqual(a, b) {
      if (a === b) return true;
      if (!a || !b) return a === b;
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if (a[k] !== b[k]) return false;
      }
      return true;
    },

    _ensurePriceTableDelegation(wrap) {
      if (wrap._priceDelegationDone) return;
      wrap._priceDelegationDone = true;

      wrap.addEventListener("click", (e) => {
        const link = e.target.closest(".model-chart-link");
        if (!link) return;
        e.preventDefault();
        const stockId = Number(link.getAttribute("data-stock-id"));
        ChartManager.showChartPanel(stockId).catch((error) => {
          console.error("[Ark Stock Monitor] 打开分时走势图失败:", error);
        });
      });

      wrap.addEventListener("contextmenu", (e) => {
        const link = e.target.closest(".model-chart-link");
        if (!link) return;
        e.preventDefault();
        const stockId = Number(link.getAttribute("data-stock-id"));
        UIRenderers.showTradeContextMenu(e, stockId, Storage.load());
      });
    },

    _buildPriceTableDOM(
      wrap,
      stockIds,
      timestampsDesc,
      priceMap,
      bgColorMap,
      positions,
      modelColors,
      now,
    ) {
      this._ensurePriceTableDelegation(wrap);

      const table = document.createElement("table");
      table.className = "ark-price-table";

      // Build header
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      const timeTh = document.createElement("th");
      timeTh.className = "time-cell";
      timeTh.textContent = "时间";
      headerRow.appendChild(timeTh);

      for (const id of stockIds) {
        const th = document.createElement("th");
        const link = document.createElement("a");
        link.className = "model-chart-link";
        link.href = "javascript:void(0)";
        link.setAttribute("data-stock-id", id);

        let displayName = Utils.getModelName(id);

        const pos = positions[id];
        if (pos) {
          if (pos.locked_until > now) {
            displayName = "🔒 " + displayName;
          }
          link.style.color = "#a855f7";
        } else if (modelColors[id]) {
          link.style.color = modelColors[id];
        }

        link.textContent = displayName;
        th.appendChild(link);
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      // Build body
      const tbody = document.createElement("tbody");
      for (const ts of timestampsDesc) {
        const row = document.createElement("tr");
        const timeCell = document.createElement("td");
        timeCell.className = "time-cell";
        timeCell.textContent = TimeUtils.formatSecondsTimestamp(ts, "short");
        row.appendChild(timeCell);

        for (const id of stockIds) {
          const td = document.createElement("td");
          const price = priceMap[id][ts];
          td.textContent = price !== undefined ? price.toFixed(2) : "-";
          td.className = bgColorMap[ts][id] || "price-neutral";
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
      table.appendChild(tbody);

      wrap.innerHTML = "";
      wrap.appendChild(table);
    },

    _patchPriceHeader(wrap, stockIds, positions, modelColors, now) {
      const headerCells = wrap.querySelectorAll("thead tr th");
      // headerCells[0] is the time column header, skip it
      for (let i = 0; i < stockIds.length; i++) {
        const th = headerCells[i + 1];
        if (!th) break;

        const stockId = stockIds[i];
        const link = th.querySelector(".model-chart-link");
        if (!link) continue;

        const pos = positions[stockId];
        if (pos) {
          link.style.color = "#a855f7";
          const lockPrefix = "🔒 ";
          const baseName = link.textContent.startsWith(lockPrefix)
            ? link.textContent.slice(lockPrefix.length)
            : link.textContent;
          link.textContent =
            pos.locked_until > now ? lockPrefix + baseName : baseName;
        } else if (modelColors[stockId]) {
          link.style.color = modelColors[stockId];
          // Remove lock prefix if no longer locked
          if (link.textContent.startsWith("🔒 ")) {
            link.textContent = link.textContent.slice(3);
          }
        } else {
          link.style.color = "";
          if (link.textContent.startsWith("🔒 ")) {
            link.textContent = link.textContent.slice(3);
          }
        }
      }
    },

    _patchPriceCells(wrap, stockIds, timestampsDesc, priceMap, bgColorMap) {
      const rows = wrap.querySelectorAll("tbody tr");
      for (let i = 0; i < timestampsDesc.length; i++) {
        const ts = timestampsDesc[i];
        const row = rows[i];
        if (!row) break;

        const cells = row.querySelectorAll("td");
        // cells[0] 是时间列，同一时间戳内容不变，跳过
        for (let j = 1; j < cells.length; j++) {
          const stockId = stockIds[j - 1];
          if (!stockId) break;

          const price = priceMap[stockId]?.[ts];
          const newContent = price !== undefined ? price.toFixed(2) : "-";
          const newClass = bgColorMap[ts]?.[stockId] || "price-neutral";

          const td = cells[j];
          if (td.textContent !== newContent) {
            td.textContent = newContent;
          }
          if (td.className !== newClass) {
            td.className = newClass;
          }
        }
      }
    },

    _findPreviousPriceTimestamp(currentTs, timestampsAsc, allData, priceMap) {
      const currentIndex = timestampsAsc.indexOf(currentTs);
      for (let i = currentIndex - 1; i >= 0; i--) {
        const prevTs = timestampsAsc[i];
        for (const stockId in priceMap) {
          if (priceMap[stockId][prevTs] !== undefined) return prevTs;
        }
      }

      const allTimestamps = [];
      for (const stockId in allData) {
        const list = allData[stockId] || [];
        for (const item of list) {
          allTimestamps.push(item[0]);
        }
      }

      const uniqueTimestamps = [...new Set(allTimestamps)].sort(
        (a, b) => a - b,
      );
      const fullIndex = uniqueTimestamps.indexOf(currentTs);
      if (fullIndex > 0) {
        for (let i = fullIndex - 1; i >= 0; i--) {
          const prevTs = uniqueTimestamps[i];
          for (const stockId in priceMap) {
            if (priceMap[stockId][prevTs] !== undefined) return prevTs;
          }
        }
      }

      return null;
    },

    // 关闭右键交易菜单（一级 + 颜色标识二级浮层），统一清理 document 级监听
    _closeTradeMenu() {
      if (this._tradeMenuClose) {
        this._tradeMenuClose();
        this._tradeMenuClose = null;
      }
    },

    // 表头模型名称右键菜单：买入 / 卖出 / 颜色标识（独立二级浮层）
    showTradeContextMenu(e, stockId, data) {
      // 右击已有菜单：先关旧的，再在新位置重建
      this._closeTradeMenu();

      const hasPosition = !!data.positions?.[stockId];

      // 一级菜单容器（复用 .ark-color-menu 外壳样式）
      const menu = document.createElement("div");
      menu.className = "ark-color-menu ark-trade-menu";
      menu.innerHTML = `
        <div class="ark-menu-item" data-action="buy"><span>买入</span></div>
        <div class="ark-menu-item${hasPosition ? "" : " ark-menu-item-disabled"}" data-action="sell"><span>卖出</span></div>
        <div class="ark-menu-item" data-action="colors"><span>颜色标识</span><span class="ark-menu-arrow">▸</span></div>
      `;
      document.body.appendChild(menu);
      this._clampMenuToViewport(menu, e.pageX, e.pageY);

      let submenu = null;
      const closeSubmenu = () => {
        if (submenu) {
          submenu.remove();
          submenu = null;
        }
      };

      const controller = new AbortController();
      const closeMenu = () => {
        controller.abort();
        closeSubmenu();
        menu.remove();
      };
      this._tradeMenuClose = closeMenu;

      // 一级菜单点击：买入/卖出 → 关菜单开面板；颜色标识 → 切换二级浮层
      menu.addEventListener("click", (ev) => {
        const item = ev.target.closest(".ark-menu-item");
        if (!item || item.classList.contains("ark-menu-item-disabled")) return;
        const action = item.dataset.action;
        if (action === "colors") {
          if (submenu) {
            closeSubmenu();
          } else {
            submenu = this._buildColorSubmenu(menu, stockId, data, closeMenu);
          }
          return;
        }
        closeMenu();
        UIPanels.openTradePanel(action, stockId);
      });

      // 外点 click / 右击其他位置 / Esc 统一关闭（AbortController 一次性清理）
      setTimeout(() => {
        if (controller.signal.aborted) return;
        document.addEventListener(
          "click",
          (ev) => {
            if (
              !menu.contains(ev.target) &&
              !(submenu && submenu.contains(ev.target))
            ) {
              closeMenu();
            }
          },
          { signal: controller.signal },
        );
        document.addEventListener(
          "contextmenu",
          (ev) => {
            if (
              !menu.contains(ev.target) &&
              !(submenu && submenu.contains(ev.target))
            ) {
              closeMenu();
            }
          },
          { signal: controller.signal },
        );
        document.addEventListener(
          "keydown",
          (ev) => {
            if (ev.key === "Escape") closeMenu();
          },
          { signal: controller.signal },
        );
      }, 0);
    },

    // 颜色标识二级浮层：在一级菜单右侧弹出，复用旧颜色菜单的结构与保存逻辑
    _buildColorSubmenu(anchorMenu, stockId, data, closeAll) {
      const currentColor = data.modelColors?.[stockId];

      const submenu = document.createElement("div");
      submenu.className = "ark-color-menu ark-color-submenu";

      let html = '<div class="ark-color-menu-title">选择颜色</div>';
      html += '<div class="ark-color-options">';
      for (const color of CONFIG.MODEL_COLORS) {
        if (!currentColor || color.value !== currentColor) {
          html += `
            <div class="ark-color-option" data-color="${color.value}">
              <div class="ark-color-swatch" style="background-color: ${color.value}"></div>
            </div>
          `;
        }
      }
      html += "</div>";
      if (currentColor) {
        html += '<button class="ark-color-remove">移除颜色</button>';
      }
      submenu.innerHTML = html;

      document.body.appendChild(submenu);

      // 定位到一级菜单右侧，垂直方向与其顶部对齐（absolute 需页面坐标，加上滚动偏移）
      const rect = anchorMenu.getBoundingClientRect();
      const left = rect.right + window.scrollX + 4;
      const top = rect.top + window.scrollY;
      submenu.style.left = left + "px";
      submenu.style.top = top + "px";
      this._clampMenuToViewport(submenu, left, top);

      // 选色 / 移除颜色：走既有保存逻辑，然后关闭全部菜单
      submenu.querySelectorAll(".ark-color-option").forEach((option) => {
        option.addEventListener("click", () => {
          UIRenderers.setModelColor(
            stockId,
            option.getAttribute("data-color"),
            data,
          );
          closeAll();
        });
      });
      const removeBtn = submenu.querySelector(".ark-color-remove");
      if (removeBtn) {
        removeBtn.addEventListener("click", () => {
          UIRenderers.removeModelColor(stockId, data);
          closeAll();
        });
      }

      return submenu;
    },

    // 防止菜单溢出视口：超出右/下边缘时向内回拉 8px
    _clampMenuToViewport(menu, pageX, pageY) {
      menu.style.left = pageX + "px";
      menu.style.top = pageY + "px";
      const rect = menu.getBoundingClientRect();
      const margin = 8;
      if (rect.right > window.innerWidth - margin) {
        menu.style.left =
          pageX - (rect.right - window.innerWidth + margin) + "px";
      }
      if (rect.bottom > window.innerHeight - margin) {
        const currentTop = rect.top + window.scrollY;
        menu.style.top =
          currentTop - (rect.bottom - window.innerHeight + margin) + "px";
      }
    },

    setModelColor(stockId, color, data) {
      if (!data.modelColors) {
        data.modelColors = {};
      }
      data.modelColors[stockId] = color;
      Storage.save(data);
      this.refreshPriceTable(data);
    },

    removeModelColor(stockId, data) {
      if (data.modelColors && data.modelColors[stockId]) {
        delete data.modelColors[stockId];
        Storage.save(data);
        this.refreshPriceTable(data);
      }
    },

    updateLastUpdateDisplayForPricePanel(timestamp) {
      const el = document.querySelector("#ark-last-update-time-price");
      if (!el) return;
      el.textContent = timestamp
        ? TimeUtils.formatDateTime(timestamp, "full")
        : "从未更新";
    },

    updateBalanceDisplay() {
      const data = Storage.load();
      const userTokensEl = document.querySelector("#ark-user-quota");
      const holdingsTotalEl = document.querySelector("#ark-holdings-total");

      if (userTokensEl) {
        userTokensEl.textContent =
          data.userTokens !== null
            ? Utils.formatThousands(data.userTokens)
            : "-";
      }
      if (holdingsTotalEl) {
        holdingsTotalEl.textContent =
          data.holdingsTotalValue !== null
            ? Utils.formatThousands(data.holdingsTotalValue.toFixed(2))
            : "-";
      }
    },

    refreshPricePanelFull() {
      const data = Storage.load();
      this.refreshPriceTable(data);
      if (data.lastUpdateTime) {
        this.updateLastUpdateDisplayForPricePanel(data.lastUpdateTime);
      }
      this.updateBalanceDisplay();
    },

    refreshPositionsPanel(data) {
      const panel = UIPanels._positionsPanel;
      if (!panel) return;

      // 更新时间
      const timeEl = panel.querySelector(".last-update-time");
      if (timeEl) {
        timeEl.textContent = data.lastUpdateTime
          ? TimeUtils.formatDateTime(data.lastUpdateTime, "full")
          : "尚未更新";
      }

      // 表格内容
      const tbody = panel.querySelector("#ark-positions-tbody");
      if (!tbody) return;

      tbody.innerHTML = "";

      const positions = data.positions || {};
      const stockIds = Object.keys(positions);

      if (stockIds.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="9" style="text-align:center">暂无持仓数据</td></tr>';
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      // 盈亏值的颜色（正绿、负红、零灰）与正负号格式化
      const pnlColor = (n) =>
        n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "#cccccc";
      const fmtSigned = (n, suffix = "") =>
        `${n > 0 ? "+" : ""}${n.toFixed(2)}${suffix}`;

      for (const stockId of stockIds) {
        const pos = positions[stockId];
        const isUnlocked = pos.locked_until < now;
        const unlockTimeColor = isUnlocked ? "#22c55e" : "#ef4444";

        const currentPriceHtml =
          pos.current_price !== null && pos.current_price !== undefined
            ? `<span style="color:${pos.current_price >= pos.avg_cost ? "#22c55e" : "#ef4444"}">${pos.current_price.toFixed(2)}</span>`
            : "-";
        const costHtml =
          pos.cost_with_fee !== null && pos.cost_with_fee !== undefined
            ? pos.cost_with_fee.toFixed(2)
            : "-";
        const incomeHtml =
          pos.income_after_fee !== null && pos.income_after_fee !== undefined
            ? pos.income_after_fee.toFixed(2)
            : "-";
        const pnlHtml =
          pos.actual_pnl !== null && pos.actual_pnl !== undefined
            ? `<span style="color:${pnlColor(pos.actual_pnl)}">${fmtSigned(pos.actual_pnl)}</span>`
            : "-";
        const pnlPctHtml =
          pos.pnl_percent !== null && pos.pnl_percent !== undefined
            ? `<span style="color:${pnlColor(pos.pnl_percent)}">${fmtSigned(pos.pnl_percent, "%")}</span>`
            : "-";

        const row = `
          <tr>
            <td>${Utils.escapeHtml(pos.model_name)}</td>
            <td>${pos.shares}</td>
            <td>${pos.avg_cost.toFixed(2)}</td>
            <td>${currentPriceHtml}</td>
            <td>${costHtml}</td>
            <td>${incomeHtml}</td>
            <td>${pnlHtml}</td>
            <td>${pnlPctHtml}</td>
            <td><span style="color:${unlockTimeColor}">${TimeUtils.formatSecondsTimestamp(pos.locked_until, "full")}</span></td>
          </tr>
        `;
        tbody.innerHTML += row;
      }
    },

    // 读取面板当前选择（最近天数 + 只看未停滞）
    getArbitrageSelection() {
      const panel = UIPanels._arbitragePanel;
      const daysSelect = panel?.querySelector("#ark-arbitrage-days-select");
      const activeOnly = panel?.querySelector("#ark-arbitrage-active-only");
      return {
        days: Number(daysSelect?.value) || 1,
        activeOnly: activeOnly ? activeOnly.checked : true,
      };
    },

    // 按所选天数计算区间的最低/最高价与套利幅度。
    // 1 天直接取接口 24h 高/低；>=2 天优先从本地 priceData 取区间 min/max，
    // 本地无匹配历史时回退用 24h 高/低。
    computeArbitrageMetrics(item, days, priceData) {
      const fallback = { high: item.high_24h, low: item.low_24h };
      let high, low;
      if (days === 1) {
        high = item.high_24h;
        low = item.low_24h;
      } else {
        const nowSec = Utils.getCurrentSecondsTimestamp();
        const cutoff = nowSec - days * 86400;
        const pts = (priceData[item.stockId] || []).filter(
          (p) => p[0] >= cutoff,
        );
        if (pts.length) {
          const prices = pts.map((p) => p[1]);
          high = Math.max(...prices);
          low = Math.min(...prices);
        } else {
          high = fallback.high;
          low = fallback.low;
        }
      }
      const percent = low > 0 ? ((high - low) / low) * 100 : null;
      return { high, low, percent };
    },

    renderArbitrageTable(arbitrageData) {
      const wrap = document.querySelector("#ark-arbitrage-table-wrap");
      if (!wrap) return;

      if (!arbitrageData || arbitrageData.length === 0) {
        wrap.innerHTML = '<div class="ark-empty-hint">暂无活跃套利数据</div>';
        return;
      }

      const sel = this.getArbitrageSelection();
      const d = Storage.load();
      const priceData = d.priceData || {};
      const monitoredIds = new Set(d.stockIds);

      // 可选：只看未停滞模型（默认勾选）
      let base = arbitrageData;
      if (sel.activeOnly) {
        base = base.filter((x) => x.stale !== true);
      }

      // 计算每行区间指标
      const rows = base.map((item) => {
        const metrics = this.computeArbitrageMetrics(item, sel.days, priceData);
        return { item, metrics };
      });

      // 默认按套利幅度降序，空值置底
      rows.sort(
        (a, b) =>
          (b.metrics.percent ?? -Infinity) - (a.metrics.percent ?? -Infinity),
      );

      let html = `
        <table class="ark-arbitrage-table">
          <thead>
            <tr>
              <th>排行</th>
              <th>模型</th>
              <th>每股最低价</th>
              <th>每股最高价</th>
              <th title="(最高价 - 最低价) / 最低价 × 100%">每股套利幅度</th>
              <th title="stale=true 表示该模型行情停滞">行情停滞</th>
              <th>监控操作</th>
            </tr>
          </thead>
          <tbody>
      `;

      rows.forEach(({ item, metrics }, index) => {
        const isMonitored = monitoredIds.has(item.stockId);
        const buttonText = isMonitored ? "取消" : "添加";
        const buttonClass = isMonitored
          ? "ark-btn ark-btn-danger ark-btn-xs"
          : "ark-btn ark-btn-primary ark-btn-xs";
        const fmt = (v) => (v == null ? "--" : v.toFixed(2));
        const pct =
          metrics.percent == null ? "--" : `+${metrics.percent.toFixed(2)}%`;
        const isStale = item.stale === true;
        html += `
          <tr>
            <td>${index + 1}</td>
            <td>${Utils.escapeHtml(item.model_name)}</td>
            <td class="price-low">${fmt(metrics.low)}</td>
            <td class="price-high">${fmt(metrics.high)}</td>
            <td class="price-high">${pct}</td>
            <td class="${isStale ? "price-low" : "price-high"}">${isStale ? "是" : "否"}</td>
            <td><button class="${buttonClass}" data-stock-id="${Utils.escapeHtml(String(item.stockId))}" data-action="${isMonitored ? "remove" : "add"}">${buttonText}</button></td>
          </tr>
        `;
      });

      html += "</tbody></table>";
      wrap.innerHTML = html;

      // Add event listeners to operation buttons
      wrap.querySelectorAll("button[data-stock-id]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const stockId = Number(e.target.dataset.stockId);
          const action = e.target.dataset.action;
          const data = Storage.load();

          if (action === "add") {
            // Add model to monitored list
            if (!data.stockIds.includes(stockId)) {
              data.stockIds.push(stockId);
              if (!data.priceData[stockId]) {
                data.priceData[stockId] = [];
              }
              Storage.save(data);
              UIRenderers.renderModelList(data.stockIds);
              UIRenderers.refreshPriceTable(data);
              // Re-render arbitrage table to update button state
              const dataToRender = data.arbitrageData || [];
              this.renderArbitrageTable(dataToRender);
            }
          } else if (action === "remove") {
            // Remove model from monitored list
            data.stockIds = data.stockIds.filter((m) => m !== stockId);
            Storage.save(data);
            UIRenderers.renderModelList(data.stockIds);
            UIRenderers.refreshPriceTable(data);
            // Re-render arbitrage table to update button state
            const dataToRender = data.arbitrageData || [];
            this.renderArbitrageTable(dataToRender);
          }
        });
      });
    },

    updateArbitrageLastUpdateDisplay(timestamp) {
      const el = document.querySelector("#ark-arbitrage-last-update-time");
      if (!el) return;
      el.textContent = timestamp
        ? TimeUtils.formatDateTime(timestamp, "full")
        : "从未更新";
    },

    // ==================== 交易记录渲染 ====================

    // 填充交易记录面板的模型下拉框（含"全部"项），保留当前选中值
    populateTradesModelSelect() {
      const panel = UIPanels._tradesPanel;
      if (!panel) return;
      const select = panel.querySelector("#ark-trades-model-select");
      if (!select) return;
      const data = Storage.load();
      const current = select.value;
      const stockIds = Object.keys(data.tradeHistory || {}).filter(
        (sid) => (data.tradeHistory[sid] || []).length > 0,
      );
      // 按模型名排序，展示更稳定（显式英文区域，确保任何语言环境下都按英文字母序）
      stockIds.sort((a, b) =>
        (data.idToModel[a] || "").localeCompare(data.idToModel[b] || "", "en"),
      );
      select.innerHTML = [
        '<option value="">全部</option>',
        ...stockIds.map(
          (sid) =>
            `<option value="${Utils.escapeHtml(sid)}">${Utils.escapeHtml(
              data.idToModel[sid] || Utils.getModelName(sid),
            )}</option>`,
        ),
      ].join("");
      // 选中值仍有效则保留，否则回退"全部"
      if (current && stockIds.includes(current)) select.value = current;
      else select.value = "";
    },

    // 渲染交易记录表格；modelKey 为 "" 时展示全部模型的记录
    renderTradesTable(modelKey) {
      const wrap = document.querySelector("#ark-trades-table-wrap");
      if (!wrap) return;
      const data = Storage.load();
      const history = data.tradeHistory || {};

      let trades = [];
      if (modelKey) {
        trades = history[modelKey] || [];
      } else {
        for (const sid of Object.keys(history)) {
          for (const t of history[sid])
            trades.push({ ...t, stockId: t.stockId || sid });
        }
      }
      // 后端/旧数据可能未存 stockId 到记录内，用"全部"视图按当前 key 补齐
      if (modelKey) {
        trades = trades.map((t) => ({ ...t, stockId: t.stockId || modelKey }));
      }

      if (trades.length === 0) {
        wrap.innerHTML = '<div class="ark-empty-hint">暂无交易记录</div>';
        return;
      }

      // 按成交时间倒序（最新在前）
      trades.sort((a, b) => b.created_at - a.created_at);

      let html = `<table class="ark-trades-table">
        <thead><tr><th>交易时间</th><th>模型</th><th>买卖方向</th><th>价格</th><th>股数</th><th>成交额</th><th>手续费</th><th>余额变化</th></tr></thead><tbody>`;

      for (const t of trades) {
        const timeStr = TimeUtils.formatSecondsTimestamp(t.created_at, "short");
        const modelName =
          (t.stockId != null && data.idToModel[t.stockId]) || "未知模型";
        const sideDisplay = t.side === "buy" ? "买入" : "卖出";
        const grossAmount = t.gross.toFixed(2);
        const feeAmount = t.fee.toFixed(2);
        const balanceChangeSign = t.side === "buy" ? "-" : "+";
        const balanceChange = balanceChangeSign + Math.abs(t.net).toFixed(2);

        html += `<tr>
          <td>${timeStr}</td>
          <td>${Utils.escapeHtml(modelName)}</td>
          <td class="side-${t.side}">${sideDisplay}</td>
          <td>${t.price.toFixed(2)}</td>
          <td>${t.shares}</td>
          <td>${grossAmount}</td>
          <td>${feeAmount}</td>
          <td class="side-${t.side}">${balanceChange}</td>
        </tr>`;
      }
      html += "</tbody></table>";
      wrap.innerHTML = html;
    },

    // 整体刷新交易记录面板：下拉 + 表格 + 总数统计
    refreshTradesPanel() {
      const panel = UIPanels._tradesPanel;
      if (!panel) return;
      const data = Storage.load();
      const history = data.tradeHistory || {};
      let total = 0;
      for (const sid of Object.keys(history))
        total += (history[sid] || []).length;
      const countEl = panel.querySelector("#ark-trades-count");
      if (countEl) countEl.textContent = `共 ${total} 条`;
      this.populateTradesModelSelect();
      const select = panel.querySelector("#ark-trades-model-select");
      this.renderTradesTable(select ? select.value : "");
    },
  };

  // ==================== 交互 ====================
  const Interactions = {
    initDrag(el, panelIdOrHandle, manager = null) {
      let handle;
      let panelId = null;

      if (typeof panelIdOrHandle === "string") {
        panelId = panelIdOrHandle;
        handle =
          el.querySelector(".chart-header") ||
          el.querySelector(".ark-panel-header");
      } else {
        handle = panelIdOrHandle;
      }

      if (!handle) return;

      let startX, startY, origX, origY;

      // 点击面板任何位置都置顶
      el.addEventListener("mousedown", (e) => {
        // 点击调整大小手柄时不置顶（resize handle 会处理自己的逻辑）
        if (e.target.classList.contains("resize-handle")) return;

        if (panelId && manager) {
          manager.activatePanel(panelId);
        } else {
          // 对于非图表面板，直接调用 UIPanels.bringToFront
          UIPanels.bringToFront(el);
        }
      });

      handle.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;

        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;

        el.style.transform = "none";
        el.style.left = origX + "px";
        el.style.top = origY + "px";
        el.style.right = "auto";

        const onMouseMove = (e) => {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          const newX = origX + dx;
          const newY = origY + dy;
          el.style.left = newX + "px";
          el.style.top = newY + "px";
          el.style.right = "auto";
          if (panelId && manager)
            manager.updatePanelPosition(panelId, newX, newY);
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    },

    initResize(panel, panelId, manager) {
      const MIN_WIDTH = 400;
      const MIN_HEIGHT = 300;
      const handles = panel.querySelectorAll(".resize-handle");

      handles.forEach((handle) => {
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const startX = e.clientX;
          const startY = e.clientY;
          const rect = panel.getBoundingClientRect();
          const startWidth = rect.width;
          const startHeight = rect.height;
          const startLeft = rect.left;
          const startTop = rect.top;

          const isN =
            handle.classList.contains("resize-handle-n") ||
            handle.classList.contains("resize-handle-ne") ||
            handle.classList.contains("resize-handle-nw");
          const isS =
            handle.classList.contains("resize-handle-s") ||
            handle.classList.contains("resize-handle-se") ||
            handle.classList.contains("resize-handle-sw");
          const isE =
            handle.classList.contains("resize-handle-e") ||
            handle.classList.contains("resize-handle-ne") ||
            handle.classList.contains("resize-handle-se");
          const isW =
            handle.classList.contains("resize-handle-w") ||
            handle.classList.contains("resize-handle-nw") ||
            handle.classList.contains("resize-handle-sw");

          const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;

            if (isE) newWidth = Math.max(MIN_WIDTH, startWidth + dx);
            if (isW) {
              newWidth = Math.max(MIN_WIDTH, startWidth - dx);
              newLeft = startLeft + (startWidth - newWidth);
            }
            if (isS) newHeight = Math.max(MIN_HEIGHT, startHeight + dy);
            if (isN) {
              newHeight = Math.max(MIN_HEIGHT, startHeight - dy);
              newTop = startTop + (startHeight - newHeight);
            }

            newWidth = Math.min(newWidth, window.innerWidth - newLeft);
            newHeight = Math.min(newHeight, window.innerHeight - newTop);

            panel.style.width = newWidth + "px";
            panel.style.height = newHeight + "px";
            panel.style.left = newLeft + "px";
            panel.style.top = newTop + "px";
            panel.style.right = "auto";
            panel.style.transform = "none";

            const container = panel.querySelector(".ark-chart-container");
            if (container) {
              const chartId = container.dataset.chartId;
              if (chartId && manager.chartInstances.has(chartId)) {
                const instance = manager.chartInstances.get(chartId);
                if (instance.chart) {
                  const containerRect = container.getBoundingClientRect();
                  instance.chart.resize(
                    containerRect.width,
                    containerRect.height,
                  );
                }
              }
            }
          };

          const onMouseUp = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);

            const container = panel.querySelector(".ark-chart-container");
            if (container) {
              const chartId = container.dataset.chartId;
              if (chartId && manager.chartInstances.has(chartId)) {
                const instance = manager.chartInstances.get(chartId);
                if (
                  instance.chart &&
                  instance.chartData &&
                  instance.chartData.length > 1
                ) {
                  instance.chart.timeScale().setVisibleRange({
                    from: getYesterdayMorningTimestamp(),
                    to: instance.chartData[instance.chartData.length - 1].time,
                  });
                }
              }
            }
          };

          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp);
        });
      });
    },
  };

  // ==================== 业务入口 ====================
  const App = {
    async doFetch() {
      try {
        let currentData = Storage.load();
        currentData.lastUpdateTime = Date.now();
        Storage.save(currentData);

        const resp = await API.fetchMarketData();
        const { data: processedData, deduplicatedStockIds } =
          DataProcessor.processMarketData(resp);

        // 拉取代币余额（失败静默，不影响主流程）
        try {
          const balance = await API.fetchBalance();
          if (balance && balance.tokens !== undefined) {
            currentData = Storage.load();
            currentData.userTokens = balance.tokens;
            Storage.save(currentData);
          }
        } catch (e) {
          console.error("[Ark Stock Monitor] 获取代币余额失败:", e);
        }

        if (processedData) {
          UIRenderers.refreshPricePanelFull();
          UIRenderers.renderMarketStatus(processedData);

          if (ChartManager.getInstance().getPanelCount() > 0) {
            const panelIds = ChartManager.getInstance().getAllPanelIds();
            panelIds.forEach((panelId) => {
              ChartManager.getInstance().refreshChartData(panelId);
            });
          }

          DataProcessor.checkNotifications(deduplicatedStockIds);
        }

        DataProcessor.processArbitrageData(resp);

        // 刷新活跃套利面板（如果可见）
        if (
          UIPanels._arbitragePanel &&
          UIPanels._arbitragePanel.classList.contains("visible")
        ) {
          currentData = Storage.load();
          const dataToRender = currentData.arbitrageData || [];
          UIRenderers.renderArbitrageTable(dataToRender);
          UIRenderers.updateArbitrageLastUpdateDisplay(
            currentData.lastUpdateTime,
          );
        }

        // 刷新持仓面板（如果可见）
        if (
          UIPanels._positionsPanel &&
          UIPanels._positionsPanel.classList.contains("visible")
        ) {
          UIRenderers.refreshPositionsPanel(currentData);
        }
      } catch (e) {
        console.error("[Ark Stock Monitor] 获取数据失败:", e);
      }
    },
  };

  // ==================== 启动 ====================
  Styles.inject();

  // 脚本加载时应用已保存主题
  const initialData = Storage.load();
  Theme.apply(initialData.theme);

  // 从旧版 windhub_stock_data 迁移数据（首次启动，异步）
  Storage.migrateFromLegacy()
    .catch((error) => {
      console.error("[Ark Stock Monitor] 数据迁移失败:", error);
    })
    .finally(() => {
      // 迁移完成（或失败）后启动定时调度（如果已开启自动获取）
      const data = Storage.load();
      if (data.autoTrigger) {
        Scheduler.start();
      }
    });

  GM_registerMenuCommand("主监控面板", () => {
    const p = UIPanels.createMainPanel();
    p.classList.add("visible");
    UIPanels.bringToFront(p);
  });
  GM_registerMenuCommand("最新价格面板", () => {
    if (!UIPanels._pricePanel) {
      UIPanels._pricePanel = UIPanels.createPricePanel();
    }
    UIPanels._pricePanel.classList.add("visible");
    UIPanels.bringToFront(UIPanels._pricePanel);
    UIRenderers.refreshPricePanelFull();
  });

  // 页面关闭 / 切到后台时立即持久化存储，防止 debounce 导致数据丢失
  window.addEventListener("beforeunload", () => Storage.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) Storage.flush();
  });
})();
