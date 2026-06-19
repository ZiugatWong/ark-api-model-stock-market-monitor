// ==UserScript==
// @name         Ark API 模型股市监控
// @description  Ark API 模型股市数据聚合分析与价格变动通知
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @author       ziugat
// @license      GPL-3.0
// @homepage     https://github.com/ZiugatWong/ark-api-model-stock-market-monitor
// @supportURL   https://github.com/ZiugatWong/ark-api-model-stock-market-monitor
// @icon         https://img.cdn1.vip/i/69be11f7070b0_1774064119.webp
// @match        https://windhub.cc/*
// @match        https://test-fast.windhub.cc/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/lightweight-charts@4.0.1/dist/lightweight-charts.standalone.production.js
// ==/UserScript==

(function () {
  "use strict";

  // ==================== 配置 ====================
  const CONFIG = {
    STORAGE_KEY: "windhub_stock_data",
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
    models: [],
    autoTriggerMinuteEnds: "3,8",
    autoTrigger: false,
    lastUpdateTime: null,
    availableModels: [],
    availableModelsLastFetched: null,
    notificationSettings: {
      enablePopup: false,
      enableSound: false,
      enableTelegram: false,
      telegramBotToken: null,
      telegramChatId: null,
    },
    notifications: {},
    data: {},
    tradeHistory: {},
    tradeHistoryLastFetched: null,
    arbitrageData: { today: [], yesterday: [] },
    arbitrageDataLastDate: null,
    positions: {},
    modelColors: {},
    priceDataDaysLimit: 7,
    lastPriceDataCleanDate: null,
    dataServiceUrl: "http://localhost:3210",
    userQuota: null,
    holdingsTotalValue: null,
    theme: "dark",
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
          models: d.models || [],
          autoTriggerMinuteEnds: d.autoTriggerMinuteEnds || "3,8",
          autoTrigger: !!d.autoTrigger,
          data: d.data || {},
          lastUpdateTime: d.lastUpdateTime || null,
          availableModels: d.availableModels || [],
          availableModelsLastFetched: d.availableModelsLastFetched || null,
          notificationSettings: d.notificationSettings || {
            enablePopup: false,
            enableSound: false,
            enableTelegram: false,
            telegramBotToken: null,
            telegramChatId: null,
          },
          notifications: d.notifications || {},
          tradeHistory: d.tradeHistory || {},
          tradeHistoryLastFetched: d.tradeHistoryLastFetched || null,
          arbitrageData: d.arbitrageData || { today: [], yesterday: [] },
          arbitrageDataLastDate: d.arbitrageDataLastDate || null,
          positions: d.positions || {},
          modelColors: d.modelColors || {},
          priceDataDaysLimit: d.priceDataDaysLimit || 7,
          lastPriceDataCleanDate: d.lastPriceDataCleanDate || null,
          dataServiceUrl: d.dataServiceUrl || "http://localhost:3210",
          userQuota: d.userQuota !== undefined ? d.userQuota : null,
          holdingsTotalValue:
            d.holdingsTotalValue !== undefined ? d.holdingsTotalValue : null,
          theme: d.theme === "light" ? "light" : "dark",
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

    getUserId() {
      try {
        const raw = localStorage.getItem("user");
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj.id || null;
      } catch {
        return null;
      }
    },

    pad(n) {
      return String(n).padStart(2, "0");
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

    // 转换 stock-data-service 返回的数据格式
    convertPriceDataFormat(serviceData) {
      // 输入: { "gpt-4": [{timestamp: 1718380800, price: 99.5}] }
      // 输出: { "gpt-4": [{"1718380800": 99.5}] }
      const converted = {};
      for (const [model, records] of Object.entries(serviceData)) {
        converted[model] = records.map((r) => ({
          [String(r.timestamp)]: r.price,
        }));
      }
      return converted;
    },

    // 智能合并价格数据
    mergePriceData(existingData, newData) {
      // existingData: 当前存储的 data.data
      // newData: 从服务获取的数据（已转换格式）

      const merged = { ...existingData };
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const [model, newRecords] of Object.entries(newData)) {
        if (!newRecords || newRecords.length === 0) continue;

        // 获取新数据的时间范围
        const newTimestamps = newRecords.map((r) =>
          parseInt(Object.keys(r)[0]),
        );
        const minTs = Math.min(...newTimestamps);
        const maxTs = Math.max(...newTimestamps);

        // 获取现有数据
        const existing = merged[model] || [];

        // 删除时间范围内的现有数据
        const filtered = existing.filter((record) => {
          const ts = parseInt(Object.keys(record)[0]);
          return ts < minTs || ts > maxTs;
        });

        totalRemoved += existing.length - filtered.length;

        // 合并新数据
        merged[model] = [...filtered, ...newRecords];

        // 按时间戳排序
        merged[model].sort((a, b) => {
          const tsA = parseInt(Object.keys(a)[0]);
          const tsB = parseInt(Object.keys(b)[0]);
          return tsA - tsB;
        });

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
    fetchMarketData() {
      const userId = Utils.getUserId();
      if (!userId) throw new Error("无法获取用户ID");

      return fetch(`${Utils.getBaseUrl()}/api/user/self/stock/market`, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "cache-control": "no-store",
          "new-api-user": String(userId),
          priority: "u=1, i",
          "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
          "sec-ch-ua-mobile": "?1",
          "sec-ch-ua-platform": '"Android"',
          cookie: document.cookie,
          Referer: `${Utils.getBaseUrl()}/console/model-stock`,
        },
        method: "GET",
      }).then((resp) => {
        if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
        return resp.json();
      });
    },

    fetchTradeHistory(forceRefresh = false) {
      const userId = Utils.getUserId();
      if (!userId) throw new Error("无法获取用户ID");

      const data = Storage.load();
      const now = Date.now();

      if (
        !forceRefresh &&
        data.tradeHistoryLastFetched &&
        now - data.tradeHistoryLastFetched < CONFIG.CACHE_DURATION
      ) {
        return Promise.resolve(data.tradeHistory);
      }

      return fetch(`${Utils.getBaseUrl()}/api/user/self/stock/my-trades`, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "cache-control": "no-store",
          "new-api-user": String(userId),
          priority: "u=1, i",
          cookie: document.cookie,
          Referer: `${Utils.getBaseUrl()}/console/model-stock`,
        },
        method: "GET",
      })
        .then((resp) => {
          if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
          return resp.json();
        })
        .then((response) => {
          if (
            response &&
            response.success &&
            response.data &&
            response.data.trades
          ) {
            return DataProcessor.processTradeHistory(response.data.trades);
          }
          return data.tradeHistory || {};
        });
    },

    fetchAvailableModels(forceRefresh = false) {
      const data = Storage.load();
      const now = Date.now();

      if (
        !forceRefresh &&
        data.availableModelsLastFetched &&
        now - data.availableModelsLastFetched < CONFIG.CACHE_DURATION
      ) {
        return Promise.resolve(data.availableModels);
      }

      return this.fetchMarketData()
        .then((response) => {
          if (
            response &&
            response.success &&
            response.data &&
            response.data.stocks
          ) {
            const models = response.data.stocks
              .map((stock) => stock.model_name)
              .filter(Boolean)
              .sort();
            const uniqueModels = [...new Set(models)];
            data.availableModels = uniqueModels;
            data.availableModelsLastFetched = now;
            Storage.save(data);
            return uniqueModels;
          }
          return data.availableModels || [];
        })
        .catch((error) => {
          console.error("[Ark Stock Monitor] 获取模型列表失败:", error);
          return data.availableModels || [];
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
  };

  // ==================== 数据处理 ====================
  const DataProcessor = {
    processTradeHistory(tradesArray) {
      if (!Array.isArray(tradesArray)) return {};

      const data = Storage.load();
      const existingHistory = data.tradeHistory || {};
      const newTradesByModel = {};

      for (const trade of tradesArray) {
        const modelName = trade.model_name;
        if (!modelName) continue;

        if (!newTradesByModel[modelName]) {
          newTradesByModel[modelName] = [];
        }

        newTradesByModel[modelName].push({
          id: trade.id,
          side: trade.side,
          shares: trade.shares,
          price: trade.price,
          gross: trade.gross,
          fee: trade.fee,
          net: trade.net,
          created_at: trade.created_at,
        });
      }

      for (const modelName of Object.keys(newTradesByModel)) {
        const existing = existingHistory[modelName] || [];
        const incoming = newTradesByModel[modelName];
        const merged = [...existing, ...incoming];
        const seen = new Set();
        const deduped = merged.filter((trade) => {
          if (seen.has(trade.id)) return false;
          seen.add(trade.id);
          return true;
        });
        deduped.sort((a, b) => a.id - b.id);
        existingHistory[modelName] = deduped;
      }

      data.tradeHistory = existingHistory;
      data.tradeHistoryLastFetched = Date.now();
      Storage.save(data);
      return existingHistory;
    },

    processMarketData(response) {
      if (
        !response ||
        !response.success ||
        !response.data ||
        !response.data.stocks
      ) {
        return { data: null, deduplicatedModels: [] };
      }

      const data = Storage.load();
      const stocks = response.data.stocks;
      const modelSet = new Set(data.models);
      const deduplicatedModels = [];

      for (const stock of stocks) {
        if (!modelSet.has(stock.model_name)) continue;

        const price = parseFloat(stock.current_price.toFixed(2));
        const ts = String(stock.last_update);

        if (!data.data[stock.model_name]) {
          data.data[stock.model_name] = [];
        }

        const list = data.data[stock.model_name];
        const exists = list.some((item) => Object.keys(item)[0] === ts);
        if (!exists) {
          list.push({ [ts]: price });
        } else {
          if (!deduplicatedModels.includes(stock.model_name)) {
            deduplicatedModels.push(stock.model_name);
          }
        }
      }

      // 提取持仓数据（仅保留最新，不保留历史）
      if (response.data.positions) {
        // 构建全模型现价映射表（持仓模型可能未被监控，需从完整 stocks 中取价）
        const priceMap = {};
        for (const stock of stocks) {
          priceMap[stock.model_name] = stock.current_price;
        }

        const round2 = (n) => parseFloat(n.toFixed(2));

        data.positions = {};
        for (const pos of response.data.positions) {
          const currentPrice = priceMap[pos.model_name];
          // 现价：取接口最新价格
          pos.current_price =
            currentPrice !== undefined ? round2(currentPrice) : null;
          // 含费成本：持仓均价 * 份额 * 1.02
          pos.cost_with_fee = round2(pos.avg_cost * pos.shares * 1.02);
          if (pos.current_price !== null) {
            // 费后收入：现价 * 份额 * 0.975
            pos.income_after_fee = round2(currentPrice * pos.shares * 0.975);
            // 实际盈亏：费后收入 - 含费成本（带正负号）
            pos.actual_pnl = round2(pos.income_after_fee - pos.cost_with_fee);
            // 盈亏幅度：实际盈亏 / 含费成本，转为带正负号的百分比
            pos.pnl_percent =
              pos.cost_with_fee !== 0
                ? round2((pos.actual_pnl / pos.cost_with_fee) * 100)
                : 0;
          } else {
            pos.income_after_fee = null;
            pos.actual_pnl = null;
            pos.pnl_percent = null;
          }
          data.positions[pos.model_name] = pos;
        }
      }

      // 提取实时余额和持仓金额
      if (response.data.user_quota !== undefined) {
        data.userQuota = parseFloat(
          ((response.data.user_quota * 2) / 1000000).toFixed(2),
        );
      }
      if (response.data.holdings_total_value !== undefined) {
        data.holdingsTotalValue = parseFloat(
          response.data.holdings_total_value.toFixed(2),
        );
      }

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

        for (const modelName of Object.keys(data.data)) {
          data.data[modelName] = data.data[modelName].filter((item) => {
            const ts = Number(Object.keys(item)[0]);
            return ts >= cutoffTime;
          });
        }
        data.lastPriceDataCleanDate = today;
      }

      Storage.save(data);
      return { data, deduplicatedModels };
    },

    processArbitrageData(response) {
      if (
        !response ||
        !response.success ||
        !response.data ||
        !response.data.stocks
      ) {
        return [];
      }

      const stocks = response.data.stocks;
      const now = Date.now() / 1000;
      const thirtyMinutesAgo = now - 30 * 60;

      const activeStocks = stocks.filter(
        (s) => s.last_update >= thirtyMinutesAgo,
      );

      const newArbitrageData = activeStocks.map((s) => ({
        model_name: s.model_name,
        high_24h: parseFloat(s.high_24h.toFixed(2)),
        low_24h: parseFloat(s.low_24h.toFixed(2)),
        arbitrage_diff: parseFloat((s.high_24h - s.low_24h).toFixed(2)),
        arbitrage_percent: parseFloat(
          (((s.high_24h - s.low_24h) / s.low_24h) * 100).toFixed(2),
        ),
      }));

      const data = Storage.load();
      const todayDate = new Date()
        .toLocaleDateString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
        .replace(/\//g, "-");

      // 判断是否跨天
      if (data.arbitrageDataLastDate !== todayDate) {
        // 跨天：将今日数据迁移到昨日
        data.arbitrageData.yesterday = data.arbitrageData.today || [];
        data.arbitrageDataLastDate = todayDate;
      }

      // 更新今日数据
      data.arbitrageData.today = newArbitrageData;
      Storage.save(data);

      return newArbitrageData;
    },

    getModelsWithTradeHistory() {
      const data = Storage.load();
      const tradeHistory = data.tradeHistory || {};
      return Object.keys(tradeHistory).filter(
        (model) => tradeHistory[model] && tradeHistory[model].length > 0,
      );
    },

    checkNotifications(deduplicatedModels) {
      const data = Storage.load();
      const notifications = data.notifications;
      const settings = data.notificationSettings;

      if (
        !settings.enablePopup &&
        !settings.enableSound &&
        !settings.enableTelegram
      ) {
        return;
      }

      const notificationKeys = Object.keys(notifications);
      if (notificationKeys.length === 0) return;

      const triggered = [];
      const savedModels = new Set(data.models);

      for (const model of notificationKeys) {
        if (!savedModels.has(model)) continue;
        if (deduplicatedModels.includes(model)) continue;

        const config = notifications[model];
        const modelData = data.data[model];
        if (!modelData || modelData.length < 2) continue;

        const latest = modelData[modelData.length - 1];
        const previous = modelData[modelData.length - 2];
        const latestTs = Object.keys(latest)[0];
        const previousTs = Object.keys(previous)[0];
        const latestPrice = latest[latestTs];
        const previousPrice = previous[previousTs];

        if (config.upperLimit !== null && config.upperLimit !== undefined) {
          if (
            previousPrice < config.upperLimit &&
            latestPrice >= config.upperLimit
          ) {
            triggered.push({
              model,
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
              model,
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

    sendBatch(triggered) {
      const settings = Storage.load().notificationSettings;
      if (settings.enablePopup) this.showPopup(triggered);
      if (settings.enableSound) this.playSound();
      if (settings.enableTelegram) this.sendTelegram(triggered);
    },

    sendTest() {
      const settings = Storage.load().notificationSettings;
      const enabledCount = [
        settings.enablePopup,
        settings.enableSound,
        settings.enableTelegram,
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
      overflow: visible;
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
      font-size: 16px;
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
      padding: 8px 14px;
      overflow-y: visible;
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
      padding: 12px 14px;
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
      padding: 12px 14px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-price-panel {
      position: fixed;
      top: 60px;
      right: 540px;
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
      padding: 12px 14px;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }

    #ark-trades-panel {
      position: fixed;
      top: 60px;
      right: 540px;
      width: max-content;
      max-width: 900px;
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
      overflow: hidden;
    }
    #ark-trades-panel.visible { display: flex; }
    #ark-trades-panel .panel-body {
      padding: 12px 14px;
      overflow-y: auto;
      flex: 1;
      background: #1a1a1a;
      border-radius: 0 0 10px 10px;
    }
    #ark-trades-table-wrap {
      max-height: 400px;
      overflow-y: auto;
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
      padding: 12px 14px;
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
      overflow: hidden;
    }
    #ark-arbitrage-panel.visible { display: flex; }
    #ark-arbitrage-panel .panel-body {
      padding: 12px 14px;
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
      margin-bottom: 10px;
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

    .ark-manual-btn {
      padding: 5px 14px;
      border-radius: 5px;
      border: none;
      background: #89b4fa;
      color: #1e1e2e;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-manual-btn:hover { background: #b4befe; }
    .ark-manual-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .ark-save-btn {
      padding: 5px 14px;
      border-radius: 5px;
      border: none;
      background: #a6e3a1;
      color: #1e1e2e;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-save-btn:hover { background: #94e2d5; }

    .ark-table-wrap {
      overflow-x: auto;
      margin-top: 4px;
    }
    .ark-price-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .ark-price-table th,
    .ark-price-table td {
      padding: 5px 8px;
      border: 1px solid #333;
      text-align: center;
      white-space: nowrap;
    }
    .ark-price-table th {
      background: #222;
      color: #f0f0f0;
      font-weight: 600;
      position: sticky;
      top: 0;
      white-space: normal;
      word-break: break-word;
    }
    .ark-price-table td.price-up { color: #00A854; }
    .ark-price-table td.price-down { color: #F55454; }
    .ark-price-table td.price-neutral { }
    .ark-price-table th.time-cell, .ark-price-table td.time-cell { white-space: nowrap; }

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

    .ark-trades-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .ark-trades-table th, .ark-trades-table td {
      padding: 5px 8px;
      border: 1px solid #333;
      text-align: center;
      white-space: nowrap;
    }
    .ark-trades-table th {
      background: #222;
      color: #f0f0f0;
      font-weight: 600;
      position: sticky;
      top: 0;
    }
    .ark-trades-table td.side-buy { color: #F55454; }
    .ark-trades-table td.side-sell { color: #00A854; }

    .ark-trades-controls {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
    }
    .ark-trades-model-select {
      flex: 1;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #2a2a2a;
      color: #f0f0f0;
      font-size: 13px;
      outline: none;
    }
    .ark-trades-model-select:focus { border-color: #89b4fa; }
    .ark-trades-refresh-btn {
      padding: 6px 14px;
      border-radius: 5px;
      border: none;
      background: #89b4fa;
      color: #1e1e2e;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .ark-trades-refresh-btn:hover { background: #b4befe; }
    .ark-trades-refresh-btn:disabled { background: #555; cursor: not-allowed; }

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
    body.ark-theme-light #ark-trades-panel,
    body.ark-theme-light #ark-positions-panel,
    body.ark-theme-light #ark-arbitrage-panel,
    body.ark-theme-light .ark-chart-panel {
      background: var(--ark-surface);
      color: var(--ark-text);
      border-color: var(--ark-border);
      box-shadow: 0 8px 32px var(--ark-shadow);
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
    body.ark-theme-light #ark-trades-panel .panel-body,
    body.ark-theme-light #ark-positions-panel .panel-body,
    body.ark-theme-light #ark-arbitrage-panel .panel-body {
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
    body.ark-theme-light .ark-trades-refresh-btn:disabled {
      background: var(--ark-btn-2);
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
      border-radius: 50%;
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
          const timestamp = Object.keys(item)[0];
          const price = item[timestamp];
          if (!timestamp || price === undefined) return null;
          return { time: Number(timestamp), value: parseFloat(price) };
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

    convertToMarkers(trades) {
      if (!Array.isArray(trades) || trades.length === 0) return [];
      return trades
        .filter((t) => t.created_at && t.side)
        .map((trade) => ({
          time: trade.created_at,
          position: trade.side === "buy" ? "belowBar" : "aboveBar",
          color: trade.side === "buy" ? "#F55454" : "#00A854",
          shape: "circle",
          text: trade.side === "buy" ? "买" : "卖",
          size: 1,
        }));
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
          <button class="close-btn" title="关闭">&times;</button>
        </div>
        <div class="chart-body">
          <div id="${panelId}-container" class="ark-chart-container"></div>
          <div id="${panelId}-stats" class="ark-chart-stats" style="margin-top: 16px; font-size: 12px; color: var(--ark-muted);"></div>
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
      `;
    },

    showChartError(message) {
      console.error("[Ark Stock Monitor] 图表错误:", message);
      const errorEl = document.createElement("div");
      errorEl.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
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

    _updateChartSeriesData(series, chartData, modelName, data) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000);
      const todayData = chartData.filter((d) => d.time >= todayStartTimestamp);

      const stats = Chart.calculatePriceStats(chartData, todayData);
      const modelArbitrage = (data.arbitrageData?.today || []).find(
        (a) => a.model_name === modelName,
      );
      const modelPosition = data.positions?.[modelName];
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
          title: "今日最高",
        });
        const lowLine = series.createPriceLine({
          price: modelArbitrage.low_24h,
          color: "#F55454",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "今日最低",
        });
        let positionLine = null;
        if (modelPosition) {
          positionLine = series.createPriceLine({
            price: modelPosition.avg_cost,
            color: "#A0522D",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "持仓价",
          });
        }
        priceLines = { highLine, lowLine, positionLine };
      }

      const tradeHistory = data.tradeHistory?.[modelName];
      if (tradeHistory && tradeHistory.length > 0 && chartData.length > 0) {
        const minTime = chartData[0].time;
        const filteredTrades = tradeHistory.filter(
          (t) => t.created_at >= minTime,
        );
        if (filteredTrades.length > 0) {
          const markers = Chart.convertToMarkers(filteredTrades);
          if (markers.length > 0) {
            series.setMarkers(markers);
          }
        }
      }

      return { stats, priceLines };
    }

    async showChartPanel(modelName) {
      const existingPanelId = this.findPanelByModel(modelName);
      if (existingPanelId) {
        this.activatePanel(existingPanelId);
        return existingPanelId;
      }

      const panelId = this.generatePanelId(modelName);
      const position = this.getNewPanelPosition();

      this.panels.set(panelId, {
        id: panelId,
        element: null,
        modelName: modelName,
        chartInstance: null,
        tooltipCleanup: null,
        position: position,
        zIndex: this.panelZIndex,
        isRefreshing: false,
        lastActiveTime: Date.now(),
      });

      const panel = await this.createTimeChartPanel(modelName, panelId);
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

    async createTimeChartPanel(modelName, panelId) {
      try {
        const data = Storage.load();
        const modelData = data.data[modelName];
        if (!modelData || !Array.isArray(modelData) || modelData.length === 0) {
          throw new Error(`模型 "${modelName}" 暂无价格数据`);
        }

        const chartPanel = Chart.createChartPanelElement(panelId, modelName);
        if (!chartPanel) throw new Error("无法创建面板元素");

        const container = chartPanel.querySelector(`#${panelId}-container`);
        if (!container) throw new Error("无法找到图表容器");

        const chartData = Chart.convertToChartData(modelData);
        if (chartData.length === 0) throw new Error("数据转换失败");

        const chart = await Chart.createThemedChart(container);
        const series = Chart.createPriceLineSeries(chart, chartData);

        const { stats, priceLines } = this._updateChartSeriesData(
          series,
          chartData,
          modelName,
          data,
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
          chartData,
          priceLines,
        });

        Chart.updateChartStatsDisplay(chartPanel, stats, panelId);

        if (chartData.length > 1) {
          const lastTime = chartData[chartData.length - 1].time;
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

    findPanelByModel(modelName) {
      for (const [panelId, panelInfo] of this.panels) {
        if (panelInfo.modelName === modelName) return panelId;
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

    async refreshChartData(panelId) {
      const panelInfo = this.panels.get(panelId);
      if (!panelInfo || panelInfo.isRefreshing) return false;

      try {
        panelInfo.isRefreshing = true;
        panelInfo.lastRefreshTime = Date.now();
        this.showChartLoading(panelId, true);

        const data = Storage.load();
        const modelData = data.data[panelInfo.modelName];
        if (!modelData || !Array.isArray(modelData)) {
          throw new Error(`模型 "${panelInfo.modelName}" 暂无数据`);
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

        instance.series.setData(chartData);
        instance.chartData = chartData;

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

        const { stats, priceLines } = this._updateChartSeriesData(
          instance.series,
          chartData,
          panelInfo.modelName,
          data,
        );
        instance.priceLines = priceLines;

        if (stats) {
          Chart.updateChartStatsDisplay(panelInfo.element, stats, panelId);
        }

        if (chartData.length > 1) {
          const lastTime = chartData[chartData.length - 1].time;
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
    _tradesPanel: null,
    _positionsPanel: null,
    _arbitragePanel: null,
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
            <span class="title">Ark API 模型股市监控</span>
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
            <div class="ark-section-label">基本信息</div>
            <div class="ark-user-id" id="ark-user-id">用户信息加载中...</div>
          </div>
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
              <a href="javascript:void(0)" class="ark-arbitrage-link" id="ark-arbitrage-btn">活跃套利榜</a>
              <a href="javascript:void(0)" class="ark-historical-trades-link" id="ark-historical-trades-btn">我的交易</a>
              <a href="javascript:void(0)" class="ark-positions-link" id="ark-positions-btn">我的持仓</a>
            </div>
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
        .querySelector("#ark-historical-trades-btn")
        .addEventListener("click", async () => {
          if (!UIPanels._tradesPanel) {
            UIPanels._tradesPanel = UIPanels.createTradesPanel();
          }
          UIPanels._tradesPanel.classList.add("visible");
          UIPanels.bringToFront(UIPanels._tradesPanel);
          const data = Storage.load();
          if (!data.tradeHistoryLastFetched) {
            const refreshBtn = UIPanels._tradesPanel.querySelector(
              "#ark-trades-refresh-btn",
            );
            if (refreshBtn) {
              refreshBtn.disabled = true;
              refreshBtn.textContent = "获取中...";
            }
            try {
              await API.fetchTradeHistory(false);
              UIRenderers.updateTradesLastUpdateDisplay();
              UIRenderers.populateTradesModelSelect();
            } catch (e) {
              console.error("[Ark Stock Monitor] 初始化交易历史失败:", e);
            } finally {
              if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = "刷新";
              }
            }
          }
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
        .querySelector("#ark-arbitrage-btn")
        .addEventListener("click", () => {
          if (!UIPanels._arbitragePanel) {
            UIPanels._arbitragePanel = UIPanels.createArbitragePanel();
          }
          UIPanels._arbitragePanel.classList.add("visible");
          UIPanels.bringToFront(UIPanels._arbitragePanel);
          const data = Storage.load();
          const sortSelect = UIPanels._arbitragePanel.querySelector(
            "#ark-arbitrage-sort-select",
          );
          UIRenderers.renderArbitrageTable(
            data.arbitrageData || [],
            sortSelect ? sortSelect.value : "arbitrage_diff",
          );
          if (data.lastUpdateTime) {
            UIRenderers.updateArbitrageLastUpdateDisplay(data.lastUpdateTime);
          }
        });

      const userId = Utils.getUserId();
      this._mainPanel.querySelector("#ark-user-id").textContent = userId
        ? `用户ID: ${userId}`
        : "用户ID: 未获取";

      UIRenderers.renderModelList(data.models);
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

      function addModels(modelNames) {
        if (!modelNames || !modelNames.length) return;
        const d = Storage.load();
        const existingModels = new Set(d.models);
        const newModels = modelNames.filter(
          (name) => !existingModels.has(name),
        );
        if (newModels.length === 0) return;
        d.models.push(...newModels);
        newModels.forEach((model) => {
          if (!d.data[model]) d.data[model] = [];
        });
        Storage.save(d);
        UIRenderers.renderModelList(d.models);
        UIRenderers.refreshPriceTable(d);
      }

      function updateSelectedTags() {
        modelSelectedTags.innerHTML = "";
        selectedModels.forEach((modelName) => {
          const tag = document.createElement("span");
          tag.className = "ark-model-selected-tag";
          tag.innerHTML = `${Utils.escapeHtml(modelName)}<button class="remove-tag-btn" data-model="${Utils.escapeHtml(modelName)}" title="移除">&times;</button>`;
          modelSelectedTags.appendChild(tag);
        });
        modelSearchInput.placeholder =
          selectedModels.size > 0 ? "" : "点击选择模型...";
      }

      function removeSelectedTag(modelName) {
        selectedModels.delete(modelName);
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

      function renderModelOptions(models) {
        modelDropdownList.innerHTML = "";
        models.forEach((modelName) => {
          const option = document.createElement("div");
          option.className = "ark-model-option";
          option.innerHTML = `
            <input type="checkbox" id="model-${Utils.escapeHtml(modelName)}" value="${Utils.escapeHtml(modelName)}" ${selectedModels.has(modelName) ? "checked" : ""}>
            <label class="ark-model-option-label" for="model-${Utils.escapeHtml(modelName)}">${Utils.escapeHtml(modelName)}</label>
          `;
          modelDropdownList.appendChild(option);
        });

        const checkboxes = modelDropdownList.querySelectorAll(
          'input[type="checkbox"]',
        );
        checkboxes.forEach((checkbox) => {
          checkbox.addEventListener("change", (e) => {
            const modelName = e.target.value;
            if (e.target.checked) {
              selectedModels.add(modelName);
            } else {
              selectedModels.delete(modelName);
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
        const filtered = allModels.filter((modelName) =>
          modelName.toLowerCase().includes(searchTerm.toLowerCase()),
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
        allModels.forEach((modelName) => selectedModels.add(modelName));
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
          const modelName = e.target.getAttribute("data-model");
          removeSelectedTag(modelName);
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
              <button class="ark-manual-btn" id="ark-fetch-btn">手动获取</button>
            </div>
            <div class="ark-trigger-row">
              <span style="color:var(--ark-label);font-size:12px;">匹配分钟尾数：</span>
              <input type="text" class="ark-minute-input" id="ark-minute-ends" placeholder="如 3,8" title="如填 3,8 代表每小时的 03、08、13、18...分钟，会自动触发行情获取" />
              <button class="ark-save-btn" id="ark-save-minute-btn">保存</button>
            </div>
          </div>

          <div class="ark-section" id="ark-notification-section">
            <div class="ark-section-label">价格突破提醒</div>
            <div class="ark-trigger-row">
              <button class="ark-manual-btn" id="ark-test-notif-btn">测试已打开的提醒</button>
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
                <button class="ark-save-btn" id="ark-save-notif-btn" style="margin-left: 10px;">添加</button>
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

      function populateNotifModelSelect() {
        const data = Storage.load();
        notifModelSelect.innerHTML = '<option value="">请选择模型</option>';
        data.models.forEach((model) => {
          const option = document.createElement("option");
          option.value = model;
          option.textContent = model;
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
          .map((model) => {
            const config = notifications[model];
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
            <span style="color:var(--ark-text);font-size:12px;flex-shrink:0;margin-right:auto;">${Utils.escapeHtml(model)}</span>
            <span style="color:var(--ark-muted);font-size:11px;width:100px;text-align:left;">向上突破：${upper}</span>
            <span style="color:var(--ark-muted);font-size:11px;width:100px;text-align:left;">向下突破：${lower}</span>
            <button class="del-btn" data-model="${Utils.escapeHtml(model)}" title="删除" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:14px;padding:0 4px;margin-left:8px;flex-shrink:0;">&times;</button>
          </div>
        `;
          })
          .join("");

        notifList.querySelectorAll(".del-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const model = btn.getAttribute("data-model");
            const d = Storage.load();
            delete d.notifications[model];
            Storage.save(d);
            renderNotificationList();
          });
        });
      }

      saveNotifBtn.addEventListener("click", () => {
        const model = notifModelSelect.value;
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
        if (!model) {
          alert("请选择模型");
          return;
        }
        if (upper === null && lower === null) {
          alert("请至少填写上限或下限");
          return;
        }

        const d = Storage.load();
        if (!d.notifications[model]) {
          d.notifications[model] = { upperLimit: null, lowerLimit: null };
        }
        if (upper !== null) d.notifications[model].upperLimit = upper;
        if (lower !== null) d.notifications[model].lowerLimit = lower;
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
              <button class="ark-save-btn" id="ark-save-price-days-btn">保存</button>
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
              <button class="ark-manual-btn" id="ark-sync-price-data-btn" title="同步最近7天的价格数据">
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

        if (!d.models || d.models.length === 0) {
          alert("请先在主面板设置要监控的模型");
          return;
        }

        // 确认操作
        if (
          !confirm(
            `将从服务获取 ${d.models.length} 个模型的7天价格数据并合并到本地，是否继续？`,
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
          // 调用通用 API，传入价格批量接口的端点和参数
          const serviceData = await API.syncBatchData(
            d.dataServiceUrl,
            "/api/prices/batch",
            { models: d.models, days: 7 },
          );

          syncStatusEl.textContent = "数据获取成功，正在处理...";

          // 转换格式（价格特定）
          const converted = Utils.convertPriceDataFormat(serviceData);

          // 合并数据（价格特定）
          const { merged, totalAdded, totalRemoved } = Utils.mergePriceData(
            d.data,
            converted,
          );

          // 保存
          d.data = merged;
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
                <div>3. 表头模型名称处右键点击可设置颜色标识（红/绿/黄/橙/粉/青），但优先级低于持仓颜色</div>
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
                <div><span style="color:var(--ark-label);">可用余额：</span><span style="color:#4caf50;font-weight:600;" id="ark-user-quota">-</span></div>
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

    createTradesPanel() {
      if (this._tradesPanel) return this._tradesPanel;

      const data = Storage.load();
      const modelsWithTrades = DataProcessor.getModelsWithTradeHistory();
      this._tradesPanel = document.createElement("div");
      this._tradesPanel.id = "ark-trades-panel";

      this._tradesPanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">我的交易</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-section">
            <div class="ark-trades-controls">
              <select class="ark-trades-model-select" id="ark-trades-model-select">
                <option value="">请选择模型...</option>
                ${modelsWithTrades.map((m) => `<option value="${Utils.escapeHtml(m)}">${Utils.escapeHtml(m)}</option>`).join("")}
              </select>
              <button class="ark-trades-refresh-btn" id="ark-trades-refresh-btn">刷新</button>
            </div>
            <div class="ark-last-update" style="margin-bottom: 8px;">
              最近更新：<span id="ark-trades-last-update-time">${data.tradeHistoryLastFetched ? TimeUtils.formatDateTime(data.tradeHistoryLastFetched, "full") : "从未更新"}</span>
            </div>
            <div class="ark-table-wrap" id="ark-trades-table-wrap">
              <div class="ark-empty-hint">请选择模型查看交易记录</div>
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

      const modelSelect = this._tradesPanel.querySelector(
        "#ark-trades-model-select",
      );
      modelSelect.addEventListener("change", () => {
        const selectedModel = modelSelect.value;
        if (selectedModel) {
          UIRenderers.renderTradesTable(selectedModel);
        } else {
          const wrap = this._tradesPanel.querySelector(
            "#ark-trades-table-wrap",
          );
          wrap.innerHTML =
            '<div class="ark-empty-hint">请选择模型查看交易记录</div>';
        }
      });

      const refreshBtn = this._tradesPanel.querySelector(
        "#ark-trades-refresh-btn",
      );
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "获取中...";
        try {
          await API.fetchTradeHistory(true);
          UIRenderers.updateTradesLastUpdateDisplay();
          UIRenderers.populateTradesModelSelect();
          const selectedModel = modelSelect.value;
          if (selectedModel) UIRenderers.renderTradesTable(selectedModel);
        } catch (e) {
          console.error("[Ark Stock Monitor] 刷新交易历史失败:", e);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = "刷新";
        }
      });

      return this._tradesPanel;
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
                    <th title="成本价 × 份额 × 1.02">含费成本</th>
                    <th title="现价 × 份额 × 0.975">费后收入</th>
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
      this._arbitragePanel = document.createElement("div");
      this._arbitragePanel.id = "ark-arbitrage-panel";

      this._arbitragePanel.innerHTML = `
        <div class="ark-panel-header">
          <div class="header-left">
            <span class="title">活跃套利榜</span>
          </div>
          <div class="header-right">
            <button class="close-btn" title="关闭">&times;</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="ark-arbitrage-controls">
            <div class="ark-last-update">
              最近更新：<span id="ark-arbitrage-last-update-time">${data.lastUpdateTime ? TimeUtils.formatDateTime(data.lastUpdateTime, "full") : "从未更新"}</span>
            </div>
            <div style="display:flex;gap:10px;">
              <div class="ark-arbitrage-date-wrapper">
                <span style="color:var(--ark-label);font-size:12px;">日期：</span>
                <select class="ark-arbitrage-sort-select" id="ark-arbitrage-date-select">
                  <option value="today">今日</option>
                  <option value="yesterday">昨日</option>
                </select>
              </div>
              <div class="ark-arbitrage-sort-wrapper">
                <span style="color:var(--ark-label);font-size:12px;">排序字段：</span>
                <select class="ark-arbitrage-sort-select" id="ark-arbitrage-sort-select">
                  <option value="arbitrage_diff">每股套利价差</option>
                  <option value="arbitrage_percent">每股套利幅度</option>
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

      const sortSelect = this._arbitragePanel.querySelector(
        "#ark-arbitrage-sort-select",
      );
      const dateSelect = this._arbitragePanel.querySelector(
        "#ark-arbitrage-date-select",
      );

      dateSelect.addEventListener("change", () => {
        const d = Storage.load();
        const selectedDate = dateSelect.value;
        const dataToRender = d.arbitrageData[selectedDate] || [];
        UIRenderers.renderArbitrageTable(dataToRender, sortSelect.value);
      });

      sortSelect.addEventListener("change", () => {
        const d = Storage.load();
        const selectedDate = dateSelect.value;
        const dataToRender = d.arbitrageData[selectedDate] || [];
        UIRenderers.renderArbitrageTable(dataToRender, sortSelect.value);
      });

      if (data.lastUpdateTime) {
        const dataToRender = data.arbitrageData?.today || [];
        UIRenderers.renderArbitrageTable(dataToRender, "arbitrage_diff");
        UIRenderers.updateArbitrageLastUpdateDisplay(data.lastUpdateTime);
      }

      return this._arbitragePanel;
    },
  };

  // ==================== UI 渲染器 ====================
  const UIRenderers = {
    renderModelList(models) {
      const container = document.querySelector("#ark-model-list");
      if (!container) return;
      container.innerHTML = "";
      let dragSrcIdx = null;
      models.forEach((name, idx) => {
        const tag = document.createElement("span");
        tag.className = "ark-model-tag";
        tag.draggable = true;
        tag.dataset.idx = idx;
        tag.innerHTML = `${Utils.escapeHtml(name)}<button class="del-btn" data-model="${Utils.escapeHtml(name)}" title="删除">&times;</button>`;
        tag.querySelector(".del-btn").addEventListener("click", () => {
          const d = Storage.load();
          d.models = d.models.filter((m) => m !== name);
          Storage.save(d);
          UIRenderers.renderModelList(d.models);
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
          const [moved] = d.models.splice(dragSrcIdx, 1);
          d.models.splice(dropIdx, 0, moved);
          Storage.save(d);
          UIRenderers.renderModelList(d.models);
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

      const models = data.models || [];
      const allData = data.data || {};

      if (models.length === 0) {
        wrap.innerHTML =
          '<div class="ark-empty-hint">暂无数据，请添加模型后获取</div>';
        // 重置面板宽度为最小宽度
        const pricePanel = document.querySelector("#ark-price-panel");
        if (pricePanel) {
          pricePanel.style.width = "400px";
        }
        return;
      }

      // 根据模型数量动态设置面板宽度
      const pricePanel = document.querySelector("#ark-price-panel");
      if (pricePanel) {
        const calculatedWidth = 80 * models.length + 150; // 50px per model + 150px for time column and padding
        const finalWidth = Math.max(400, calculatedWidth); // 确保不小于最小宽度
        pricePanel.style.width = finalWidth + "px";
      }

      const tsSet = new Set();
      for (const m of models) {
        const list = allData[m] || [];
        for (const item of list) {
          tsSet.add(Object.keys(item)[0]);
        }
      }

      const timestampsAsc = [...tsSet]
        .sort((a, b) => Number(a) - Number(b))
        .slice(-CONFIG.TABLE_DISPLAY_LIMIT);

      if (timestampsAsc.length === 0) {
        wrap.innerHTML =
          '<div class="ark-empty-hint">暂无数据，请获取价格</div>';
        return;
      }

      const priceMap = {};
      for (const m of models) {
        priceMap[m] = {};
        const list = allData[m] || [];
        for (const item of list) {
          const ts = Object.keys(item)[0];
          priceMap[m][ts] = item[ts];
        }
      }

      const bgColorMap = {};

      for (const ts of timestampsAsc) {
        bgColorMap[ts] = {};
        for (const m of models) {
          let cssClass = "price-neutral";
          const currentPrice = priceMap[m][ts];

          if (currentPrice !== undefined) {
            const prevTs = UIRenderers._findPreviousPriceTimestamp(
              ts,
              timestampsAsc,
              allData,
              priceMap,
            );
            if (prevTs) {
              const prevPrice = priceMap[m][prevTs];
              if (prevPrice !== undefined) {
                if (currentPrice > prevPrice) cssClass = "price-up";
                else if (currentPrice < prevPrice) cssClass = "price-down";
                else cssClass = bgColorMap[prevTs]?.[m] || "price-neutral";
              }
            }
          }

          bgColorMap[ts][m] = cssClass;
        }
      }

      const timestampsDesc = [...timestampsAsc].reverse();

      const now = Math.floor(Date.now() / 1000);
      const positions = data.positions || {};
      const modelColors = data.modelColors || {};

      let html =
        '<table class="ark-price-table"><thead><tr><th class="time-cell">时间</th>';
      for (const m of models) {
        const pos = positions[m];
        let displayName = Utils.escapeHtml(m);
        let linkStyle = "";

        if (pos) {
          if (pos.locked_until > now) {
            displayName = "🔒 " + displayName;
          }
          linkStyle = ' style="color:#a855f7"';
        } else if (modelColors[m]) {
          linkStyle = ` style="color:${modelColors[m]}"`;
        }

        html += `<th><a href="javascript:void(0)" class="model-chart-link" data-model="${Utils.escapeHtml(m)}"${linkStyle}>${displayName}</a></th>`;
      }
      html += "</tr></thead><tbody>";

      for (const ts of timestampsDesc) {
        const timeStr = TimeUtils.formatSecondsTimestamp(Number(ts), "short");
        html += `<tr><td class="time-cell">${timeStr}</td>`;
        for (const m of models) {
          const price = priceMap[m][ts];
          const cellContent = price !== undefined ? price.toFixed(2) : "-";
          const cssClass = bgColorMap[ts][m] || "price-neutral";
          html += `<td class="${cssClass}">${cellContent}</td>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";

      wrap.innerHTML = html;

      setTimeout(() => {
        const modelLinks = document.querySelectorAll(".model-chart-link");
        modelLinks.forEach((link) => {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const modelName = link.getAttribute("data-model");
            ChartManager.showChartPanel(modelName).catch((error) => {
              console.error("[Ark Stock Monitor] 打开分时走势图失败:", error);
            });
          });

          // 添加右键事件监听
          link.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const modelName = link.getAttribute("data-model");
            UIRenderers.showColorMenu(e, modelName, data);
          });
        });
      }, 100);
    },

    _findPreviousPriceTimestamp(currentTs, timestampsAsc, allData, priceMap) {
      const currentIndex = timestampsAsc.indexOf(currentTs);
      for (let i = currentIndex - 1; i >= 0; i--) {
        const prevTs = timestampsAsc[i];
        for (const model in priceMap) {
          if (priceMap[model][prevTs] !== undefined) return prevTs;
        }
      }

      const allTimestamps = [];
      for (const model in allData) {
        const list = allData[model] || [];
        for (const item of list) {
          allTimestamps.push(Object.keys(item)[0]);
        }
      }

      const uniqueTimestamps = [...new Set(allTimestamps)].sort(
        (a, b) => Number(a) - Number(b),
      );
      const fullIndex = uniqueTimestamps.indexOf(currentTs);
      if (fullIndex > 0) {
        for (let i = fullIndex - 1; i >= 0; i--) {
          const prevTs = uniqueTimestamps[i];
          for (const model in priceMap) {
            if (priceMap[model][prevTs] !== undefined) return prevTs;
          }
        }
      }

      return null;
    },

    showColorMenu(e, modelName, data) {
      // 移除现有的颜色菜单
      const existingMenu = document.querySelector(".ark-color-menu");
      if (existingMenu) {
        existingMenu.remove();
      }

      // 创建菜单容器
      const menu = document.createElement("div");
      menu.className = "ark-color-menu";

      // 设置菜单位置
      menu.style.left = e.pageX + "px";
      menu.style.top = e.pageY + "px";

      // 获取当前颜色
      const currentColor = data.modelColors?.[modelName];
      const hasPosition = data.positions?.[modelName];

      // 构建菜单内容
      let menuHtml = '<div class="ark-color-menu-title">选择颜色</div>';
      menuHtml += '<div class="ark-color-options">';

      // 显示可用颜色选项
      for (const color of CONFIG.MODEL_COLORS) {
        // 如果已经有颜色且不等于当前颜色，显示所有颜色
        // 如果还没有颜色，显示所有6种颜色
        if (!currentColor || color.value !== currentColor) {
          menuHtml += `
            <div class="ark-color-option" data-color="${color.value}">
              <div class="ark-color-swatch" style="background-color: ${color.value}"></div>
            </div>
          `;
        }
      }

      menuHtml += "</div>";

      // 如果已经有颜色，显示"取消标识"按钮
      if (currentColor) {
        menuHtml += '<button class="ark-color-remove">移除颜色</button>';
      }

      menu.innerHTML = menuHtml;

      // 添加到页面
      document.body.appendChild(menu);

      // 添加颜色选择事件
      menu.querySelectorAll(".ark-color-option").forEach((option) => {
        option.addEventListener("click", () => {
          const color = option.getAttribute("data-color");
          UIRenderers.setModelColor(modelName, color, data);
          menu.remove();
        });
      });

      // 添加取消标识事件
      const removeBtn = menu.querySelector(".ark-color-remove");
      if (removeBtn) {
        removeBtn.addEventListener("click", () => {
          UIRenderers.removeModelColor(modelName, data);
          menu.remove();
        });
      }

      // 点击外部关闭菜单
      const closeMenu = (event) => {
        if (!menu.contains(event.target)) {
          menu.remove();
          document.removeEventListener("click", closeMenu);
        }
      };

      // 使用 setTimeout 避免立即触发关闭
      setTimeout(() => {
        document.addEventListener("click", closeMenu);
      }, 0);
    },

    setModelColor(modelName, color, data) {
      if (!data.modelColors) {
        data.modelColors = {};
      }
      data.modelColors[modelName] = color;
      Storage.save(data);
      this.refreshPriceTable(data);
    },

    removeModelColor(modelName, data) {
      if (data.modelColors && data.modelColors[modelName]) {
        delete data.modelColors[modelName];
        Storage.save(data);
        this.refreshPriceTable(data);
      }
    },

    renderTradesTable(modelName) {
      const wrap = document.querySelector("#ark-trades-table-wrap");
      if (!wrap) return;

      const data = Storage.load();
      const trades = data.tradeHistory?.[modelName] || [];

      if (trades.length === 0) {
        wrap.innerHTML = '<div class="ark-empty-hint">该模型暂无交易记录</div>';
        return;
      }

      const tradesDesc = [...trades].reverse();

      let html = `
        <table class="ark-trades-table">
          <thead>
            <tr><th>交易时间</th><th>买卖方向</th><th>价格</th><th>股数</th><th>成交额</th><th>手续费</th><th>余额变化</th></tr>
          </thead>
          <tbody>
      `;

      for (const trade of tradesDesc) {
        const timeStr = TimeUtils.formatSecondsTimestamp(
          trade.created_at,
          "short",
        );
        const sideDisplay = trade.side === "buy" ? "买入" : "卖出";
        const grossAmount = ((trade.gross * 2) / 1000000).toFixed(2);
        const feeAmount = ((-trade.fee * 2) / 1000000).toFixed(2);
        const balanceChangeSign = trade.side === "buy" ? "-" : "+";
        const balanceChange =
          balanceChangeSign + ((trade.net * 2) / 1000000).toFixed(2);

        html += `
          <tr>
            <td>${timeStr}</td>
            <td class="side-${trade.side}">${sideDisplay}</td>
            <td>${trade.price.toFixed(2)}</td>
            <td>${trade.shares}</td>
            <td>${grossAmount}</td>
            <td>${feeAmount}</td>
            <td class="side-${trade.side}">${balanceChange}</td>
          </tr>
        `;
      }

      html += "</tbody></table>";
      wrap.innerHTML = html;
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
      const userQuotaEl = document.querySelector("#ark-user-quota");
      const holdingsTotalEl = document.querySelector("#ark-holdings-total");

      if (userQuotaEl) {
        userQuotaEl.textContent =
          data.userQuota !== null ? `$${data.userQuota.toFixed(2)}` : "-";
      }
      if (holdingsTotalEl) {
        holdingsTotalEl.textContent =
          data.holdingsTotalValue !== null
            ? `$${data.holdingsTotalValue.toFixed(2)}`
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

    updateTradesLastUpdateDisplay() {
      const data = Storage.load();
      const el = document.querySelector("#ark-trades-last-update-time");
      if (!el) return;
      el.textContent = data.tradeHistoryLastFetched
        ? TimeUtils.formatDateTime(data.tradeHistoryLastFetched, "full")
        : "从未更新";
    },

    populateTradesModelSelect() {
      const select = document.querySelector("#ark-trades-model-select");
      if (!select) return;

      const modelsWithTrades = DataProcessor.getModelsWithTradeHistory();
      const currentValue = select.value;

      select.innerHTML = '<option value="">请选择模型...</option>';
      modelsWithTrades.forEach((m) => {
        const option = document.createElement("option");
        option.value = m;
        option.textContent = m;
        select.appendChild(option);
      });

      if (currentValue && modelsWithTrades.includes(currentValue)) {
        select.value = currentValue;
      }
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
      const modelNames = Object.keys(positions);

      if (modelNames.length === 0) {
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

      for (const modelName of modelNames) {
        const pos = positions[modelName];
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

    renderArbitrageTable(arbitrageData, sortBy = "arbitrage_diff") {
      const wrap = document.querySelector("#ark-arbitrage-table-wrap");
      if (!wrap) return;

      if (!arbitrageData || arbitrageData.length === 0) {
        wrap.innerHTML = '<div class="ark-empty-hint">暂无活跃套利数据</div>';
        return;
      }

      const sortedData = [...arbitrageData].sort(
        (a, b) => b[sortBy] - a[sortBy],
      );

      // Load current monitored models
      const d = Storage.load();
      const monitoredModels = new Set(d.models);

      let html = `
        <table class="ark-arbitrage-table">
          <thead>
            <tr>
              <th>排行</th>
              <th title="只记录最近30分钟内有价格更新的模型">模型</th>
              <th>每股最低价</th>
              <th>每股最高价</th>
              <th title="最高价 - 最低价">每股套利价差</th>
              <th title="每股套利价差 / 最低价 × 100%">每股套利幅度</th>
              <th>监控操作</th>
            </tr>
          </thead>
          <tbody>
      `;

      sortedData.forEach((item, index) => {
        const isMonitored = monitoredModels.has(item.model_name);
        const buttonText = isMonitored ? "取消" : "添加";
        const buttonClass = isMonitored
          ? "ark-btn ark-btn-danger ark-btn-xs"
          : "ark-btn ark-btn-primary ark-btn-xs";
        html += `
          <tr>
            <td>${index + 1}</td>
            <td>${Utils.escapeHtml(item.model_name)}</td>
            <td class="price-low">${item.low_24h.toFixed(2)}</td>
            <td class="price-high">${item.high_24h.toFixed(2)}</td>
            <td class="price-high">+${item.arbitrage_diff.toFixed(2)}</td>
            <td class="price-high">+${item.arbitrage_percent.toFixed(2)}%</td>
            <td><button class="${buttonClass}" data-model="${Utils.escapeHtml(item.model_name)}" data-action="${isMonitored ? "remove" : "add"}">${buttonText}</button></td>
          </tr>
        `;
      });

      html += "</tbody></table>";
      wrap.innerHTML = html;

      // Add event listeners to operation buttons
      wrap.querySelectorAll("button[data-model]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const modelName = e.target.dataset.model;
          const action = e.target.dataset.action;
          const data = Storage.load();

          if (action === "add") {
            // Add model to monitored list
            if (!data.models.includes(modelName)) {
              data.models.push(modelName);
              if (!data.data[modelName]) {
                data.data[modelName] = [];
              }
              Storage.save(data);
              UIRenderers.renderModelList(data.models);
              UIRenderers.refreshPriceTable(data);
              // Re-render arbitrage table to update button state
              const dateSelect = document.querySelector(
                "#ark-arbitrage-date-select",
              );
              const selectedDate = dateSelect ? dateSelect.value : "today";
              const dataToRender = data.arbitrageData[selectedDate] || [];
              this.renderArbitrageTable(dataToRender, sortBy);
            }
          } else if (action === "remove") {
            // Remove model from monitored list
            data.models = data.models.filter((m) => m !== modelName);
            Storage.save(data);
            UIRenderers.renderModelList(data.models);
            UIRenderers.refreshPriceTable(data);
            // Re-render arbitrage table to update button state
            const dateSelect = document.querySelector(
              "#ark-arbitrage-date-select",
            );
            const selectedDate = dateSelect ? dateSelect.value : "today";
            const dataToRender = data.arbitrageData[selectedDate] || [];
            this.renderArbitrageTable(dataToRender, sortBy);
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
        const { data: processedData, deduplicatedModels } =
          DataProcessor.processMarketData(resp);

        if (processedData) {
          UIRenderers.refreshPricePanelFull();

          if (ChartManager.getInstance().getPanelCount() > 0) {
            const panelIds = ChartManager.getInstance().getAllPanelIds();
            panelIds.forEach((panelId) => {
              ChartManager.getInstance().refreshChartData(panelId);
            });
          }

          DataProcessor.checkNotifications(deduplicatedModels);
        }

        DataProcessor.processArbitrageData(resp);

        // 刷新活跃套利面板（如果可见）
        if (
          UIPanels._arbitragePanel &&
          UIPanels._arbitragePanel.classList.contains("visible")
        ) {
          currentData = Storage.load();
          const sortSelect = UIPanels._arbitragePanel.querySelector(
            "#ark-arbitrage-sort-select",
          );
          const dateSelect = UIPanels._arbitragePanel.querySelector(
            "#ark-arbitrage-date-select",
          );
          const selectedDate = dateSelect ? dateSelect.value : "today";
          const dataToRender = currentData.arbitrageData[selectedDate] || [];
          UIRenderers.renderArbitrageTable(
            dataToRender,
            sortSelect ? sortSelect.value : "arbitrage_diff",
          );
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

        if (!currentData.tradeHistoryLastFetched) {
          try {
            await API.fetchTradeHistory(false);
            UIRenderers.updateTradesLastUpdateDisplay();
          } catch (e) {
            console.error("[Ark Stock Monitor] 初始获取交易历史失败:", e);
          }
        }
      } catch (e) {
        console.error("[Ark Stock Monitor] 获取数据失败:", e);
      }
    },
  };

  // ==================== 启动 ====================
  Styles.inject();

  // 脚本加载时应用已保存主题、自动启动定时调度（如果已开启自动获取）
  const initialData = Storage.load();
  Theme.apply(initialData.theme);
  if (initialData.autoTrigger) {
    Scheduler.start();
  }

  // 脚本首次加载时自动获取一次交易数据
  API.fetchTradeHistory(false)
    .then(() => {
      console.log("[Ark Stock Monitor] 首次加载：交易数据获取成功");
    })
    .catch((error) => {
      console.error("[Ark Stock Monitor] 首次加载：交易数据获取失败:", error);
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
