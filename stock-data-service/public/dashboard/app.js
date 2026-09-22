/* ============================================================
 * Ark 模型股票 Dashboard
 * 原生 JS，无构建；图表复用用户脚本方案（Lightweight Charts v4）的
 * 配置结构与本地时区处理，配色为 dashboard 独立方案。
 * ============================================================ */
(function () {
  "use strict";

  /* ---------------- CONFIG ---------------- */
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const RANGES = [
    { key: "1d", label: "1天", seconds: 86400 },
    { key: "3d", label: "3天", seconds: 259200 },
    { key: "7d", label: "7天", seconds: 604800 },
    { key: "all", label: "全部", seconds: Infinity },
  ];
  const SPARKLINE_MAX_POINTS = 120;
  const THEME_STORAGE_KEY = "ark_dashboard_theme";
  const FAV_STORAGE_KEY = "ark_dashboard_favorites";
  const DATA_DAYS = 7; // 与服务端保留期一致

  // 图表配色（canvas 不读 CSS 变量，JS 字面量表；与 style.css --chart-bg 对齐）
  function CHART_COLORS(theme) {
    if (theme === "light") {
      return {
        bg: "#ffffff",
        text: "#555555",
        grid: "#ece5d8",
        scaleBorder: "#d9d2c3",
        line: "#111111",
        crosshairLabelBg: "#111111",
      };
    }
    return {
      bg: "#242424",
      text: "#a3a3a3",
      grid: "#333333",
      scaleBorder: "#444444",
      line: "#ffd43b",
      crosshairLabelBg: "#f5f5f5",
    };
  }

  /* ---------------- State ---------------- */
  const State = {
    models: [], // [{id, name, stale, price}]
    priceData: {}, // {[stockId]: [{timestamp(秒), price}]}
    range: "1d", // 详情视图默认可视区间（图表始终加载全量数据，区间仅控制可视窗口）
    detailId: null,
    timer: null,
    lastUpdated: 0,
    loading: false,
  };

  /* ---------------- Utils ---------------- */
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function formatPrice(n) {
    return n === null || n === undefined || Number.isNaN(n)
      ? "—"
      : Number(n).toFixed(2);
  }

  // 本地时区时间格式化（时间戳为秒）
  function formatTimestamp(sec, fmt) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, "0");
    if (fmt === "time")
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    if (fmt === "short")
      return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // 涨跌计算：最新价与次新价比较（最近一次变动的幅度；涨红跌绿，中文市场惯例）
  function latestTrendOf(series) {
    if (!series || series.length < 2) return null;
    const prev = series[series.length - 2].price;
    const last = series[series.length - 1].price;
    if (!Number.isFinite(prev) || !Number.isFinite(last)) return null;
    if (last === prev) return { dir: "flat", pct: 0, delta: 0 };
    const pct = ((last - prev) / prev) * 100;
    return { dir: last > prev ? "up" : "down", pct, delta: last - prev };
  }

  // 卡片排序：四档 收藏正常 > 收藏停滞 > 未收藏正常 > 未收藏停滞，组内按模型名字典序
  function sortModels(models) {
    // 4 - 收藏+正常, 3 - 收藏+停滞, 2 - 未收藏+正常, 1 - 未收藏+停滞
    const rank = (m) => 2 * (Favorites.has(m.id) ? 1 : 0) + (m.stale ? 0 : 1);
    return models.slice().sort((a, b) => {
      const d = rank(b) - rank(a);
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    });
  }

  /* ---------------- Favorites（收藏，localStorage 持久化） ---------------- */
  const Favorites = {
    _ids: new Set(),
    init() {
      try {
        const raw = localStorage.getItem(FAV_STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) {
          this._ids = new Set(arr.map(String)); // 统一转字符串，规避 id 类型不一致
        }
      } catch (e) {
        /* 解析失败按无收藏处理 */
      }
    },
    has(id) {
      return this._ids.has(String(id));
    },
    toggle(id) {
      const key = String(id);
      if (!this._ids.delete(key)) this._ids.add(key);
      try {
        localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...this._ids]));
      } catch (e) {
        /* 隐私模式等场景忽略，本次会话内仍生效 */
      }
    },
  };

  /* ---------------- Theme ---------------- */
  const Theme = {
    _subs: [],
    current() {
      return document.documentElement.classList.contains("theme-light")
        ? "light"
        : "dark";
    },
    init() {
      // 首选已由 index.html 内联脚本写入 <html> class；此处仅同步按钮图标与持久化
      // （图标必须按实际主题刷新一次，否则刷新页面后按钮停留在 HTML 里写死的默认 ☾）
      document.getElementById("btn-theme").textContent =
        this.current() === "light" ? "☀" : "☾";
      this._syncStorage();
      document
        .getElementById("btn-theme")
        .addEventListener("click", () => this.toggle());
    },
    apply(theme) {
      document.documentElement.className =
        theme === "light" ? "theme-light" : "theme-dark";
      this._syncStorage();
      document.getElementById("btn-theme").textContent =
        theme === "light" ? "☀" : "☾";
      this._subs.forEach((fn) => fn(theme));
    },
    toggle() {
      this.apply(this.current() === "light" ? "dark" : "light");
    },
    subscribe(fn) {
      this._subs.push(fn);
    },
    unsubscribe(fn) {
      this._subs = this._subs.filter((f) => f !== fn);
    },
    _syncStorage() {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, this.current());
      } catch (e) {
        /* 隐私模式等场景忽略 */
      }
    },
  };

  /* ---------------- Manual（说明弹窗，内容按 HTML 渲染） ---------------- */
  const Manual = {
    _onKey: null,
    _loaded: false,

    init() {
      document
        .getElementById("btn-manual")
        .addEventListener("click", () => this.open());
    },

    async open() {
      const body = document.getElementById("manual-body");
      const overlay = document.getElementById("manual-overlay");
      overlay.hidden = false;

      // 内容按 HTML 渲染：来源是服务端管理员在 .env 里配置的说明，非不可信输入
      if (!this._loaded) {
        body.innerHTML = '<p class="manual-empty">加载中...</p>';
        try {
          const data = await fetchManual();
          const content = data && data.content ? data.content : "";
          body.innerHTML =
            content.trim() || '<p class="manual-empty">暂无说明</p>';
          this._loaded = true; // 会话内缓存：成功一次后不再重复请求
        } catch (e) {
          body.innerHTML = '<p class="manual-empty">说明加载失败</p>';
        }
      }

      // 遮罩交互（onclick 幂等赋值，重复开关不会累积监听器）
      document.getElementById("manual-backdrop").onclick = () => this.close();
      document.getElementById("btn-manual-close").onclick = () => this.close();
      this._onKey = (e) => {
        if (e.key === "Escape") this.close();
      };
      document.addEventListener("keydown", this._onKey);
    },

    close() {
      if (this._onKey) {
        document.removeEventListener("keydown", this._onKey);
        this._onKey = null;
      }
      document.getElementById("manual-overlay").hidden = true;
    },
  };

  /* ---------------- Api ---------------- */
  async function _fetchJson(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* 非 JSON 响应 */
    }
    if (!res.ok || !body || body.success !== true) {
      const msg = body && body.error ? body.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body.data;
  }

  function fetchModels() {
    return _fetchJson("/api/models");
  }

  function fetchBatchPrices(stockIds, days) {
    return _fetchJson("/api/prices/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stockIds, days: days || DATA_DAYS }),
    });
  }

  function fetchManual() {
    return _fetchJson("/api/manual");
  }

  /* ---------------- Sparkline（内联 SVG，无交互） ---------------- */
  // min-max 桶降采样：每桶保留最大/最小两个点，防峰谷丢失
  function downsample(values, maxPoints) {
    if (values.length <= maxPoints) return values;
    const bucketSize = Math.ceil(values.length / (maxPoints / 2));
    const out = [];
    for (let i = 0; i < values.length; i += bucketSize) {
      const bucket = values.slice(i, i + bucketSize);
      let min = bucket[0],
        max = bucket[0];
      for (const v of bucket) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out.push(min, max);
    }
    return out;
  }

  // 归一化到 viewBox 坐标，返回 polyline points 字符串
  function buildPoints(values, w, h, pad) {
    if (values.length === 0) return "";
    let min = values[0],
      max = values[0];
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min;
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    return values
      .map((v, i) => {
        const x =
          pad +
          (values.length === 1
            ? innerW / 2
            : (i / (values.length - 1)) * innerW);
        const y = span === 0 ? h / 2 : pad + (1 - (v - min) / span) * innerH;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  const Sparkline = {
    W: 200,
    H: 64,
    PAD: 4,
    // 渲染/更新卡片内 sparkline；rising: true 涨红 / false 跌绿；stale 用中性色
    render(el, series, { stale }) {
      el.innerHTML = "";
      if (!series || series.length === 0) {
        const empty = document.createElement("div");
        empty.className = "spark-empty";
        empty.textContent = "暂无历史数据";
        el.appendChild(empty);
        return;
      }
      const values = downsample(
        series.map((p) => p.price),
        SPARKLINE_MAX_POINTS,
      );
      const trend = latestTrendOf(series);
      const cls = stale
        ? "stale-line"
        : trend && trend.dir === "down"
          ? "falling"
          : "rising";

      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${this.W} ${this.H}`);
      svg.setAttribute("preserveAspectRatio", "none");
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("class", `spark-line ${cls}`);
      poly.setAttribute(
        "points",
        buildPoints(values, this.W, this.H, this.PAD),
      );
      poly.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(poly);
      el.appendChild(svg);
    },
  };

  /* ---------------- Cards ---------------- */
  const grid = document.getElementById("grid");

  const Cards = {
    // 首次全量建卡（priceData 缺失的 id 也建卡）
    renderAll() {
      grid.innerHTML = "";
      if (!State.models.length) {
        const block = document.createElement("div");
        block.className = "state-block";
        block.textContent = "暂无模型数据";
        grid.appendChild(block);
        return;
      }
      for (const model of State.models) {
        grid.appendChild(this.buildCard(model));
      }
    },
    buildCard(model) {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.stockId = model.id;

      const head = document.createElement("div");
      head.className = "card-head";
      const name = document.createElement("h3");
      name.className = "card-name";
      name.textContent = model.name; // textContent 防 XSS
      head.appendChild(name);
      // 状态徽章（两态常显：正常绿 / 停滞红）
      const stale = document.createElement("span");
      stale.className = "badge";
      head.appendChild(stale);

      // 价格行：价格在左，收藏星标按钮靠右（位于 stale 徽章正下方）
      const priceRow = document.createElement("div");
      priceRow.className = "card-price-row";
      const price = document.createElement("div");
      price.className = "card-price";
      priceRow.appendChild(price);
      priceRow.appendChild(this._buildFavBtn(model));
      const change = document.createElement("div");
      change.className = "card-change";

      const spark = document.createElement("div");
      spark.className = "card-spark";

      card.appendChild(head);
      card.appendChild(priceRow);
      card.appendChild(change);
      card.appendChild(spark);
      card.addEventListener("click", () => Detail.open(model.id));

      this.updateOne(model, card);
      return card;
    },
    // 收藏星标按钮（☆ 未收藏 / ★ 已收藏着色）；点击需阻止冒泡，避免触发卡片进详情
    _buildFavBtn(model) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fav-btn";
      btn.dataset.stockId = model.id;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        Favorites.toggle(model.id);
        this.syncFavBtn(btn, Favorites.has(model.id));
        this.reorder();
      });
      return btn;
    },
    // 按钮两态：aria-pressed=true 表示已收藏（★ 着色）
    syncFavBtn(btn, fav) {
      btn.textContent = fav ? "★" : "☆";
      btn.classList.toggle("faved", fav);
      btn.setAttribute("aria-pressed", fav ? "true" : "false");
      btn.title = fav ? "取消收藏" : "收藏";
    },
    // 收藏/排序变化后移动既有卡片归位（DOM 移动，不重建不闪烁）
    reorder() {
      if (!State.models.length) return;
      for (const model of State.models) {
        const card = grid.querySelector(`.card[data-stock-id="${model.id}"]`);
        if (card) grid.appendChild(card);
      }
    },
    // 增量更新（刷新时不重建 DOM，防闪烁）；card 缺省时按 id 查找
    updateOne(model, card) {
      card = card || grid.querySelector(`.card[data-stock-id="${model.id}"]`);
      if (!card) return;

      card.querySelector(".card-name").textContent = model.name;
      // 状态徽章两态切换（updateOne 与 buildCard 共用；buildCard 阶段 updateOne 会补文案）
      const stale = card.querySelector(".badge");
      stale.textContent = model.stale ? "停滞" : "正常";
      stale.className = model.stale ? "badge badge-stale" : "badge badge-ok";

      card.querySelector(".card-price").textContent = formatPrice(model.price);
      // 星标两态（跨会话存储在 localStorage，卡片重建后需恢复）
      this.syncFavBtn(card.querySelector(".fav-btn"), Favorites.has(model.id));

      const change = card.querySelector(".card-change");
      const series = State.priceData[model.id];
      const trend = latestTrendOf(series);
      if (!trend) {
        change.textContent = "—";
        change.className = "card-change flat";
      } else if (trend.dir === "flat") {
        change.textContent = "0.00%";
        change.className = "card-change flat";
      } else {
        const sign = trend.dir === "up" ? "+" : "";
        change.textContent = `${sign}${trend.pct.toFixed(2)}%`;
        change.className = `card-change ${trend.dir}`;
      }

      Sparkline.render(card.querySelector(".card-spark"), series, {
        stale: model.stale,
      });
    },
  };

  /* ---------------- Detail（Lightweight Charts 大图） ---------------- */
  // 本地时区处理：Lightweight Charts 以 UTC 渲染时间戳，
  // 减去 getTimezoneOffset()*60 秒把"本地墙上时间"伪装成 UTC（沿用用户脚本方案）
  const localTimezoneOffset = new Date().getTimezoneOffset() * 60;

  // 轴刻度/十字线时间格式化：按 tickMarkType 选择格式（0=年 1=月 2=日 3=时:分 4=时:分:秒）
  function formatTickMark(time, tickMarkType) {
    const d = new Date((time - localTimezoneOffset) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    switch (tickMarkType) {
      case 0:
        return `${d.getUTCFullYear()}`;
      case 1:
        return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}`;
      case 2:
        return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
      case 3:
        return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
      case 4:
        return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
      default:
        return formatTimestamp(time, "short");
    }
  }

  const Detail = {
    chart: null,
    series: null,
    tooltip: null,
    observer: null,
    _onKey: null,
    _themeSub: null,
    _raf: 0,
    _priceLines: null,

    open(stockId) {
      const model = State.models.find((m) => m.id === stockId);
      if (!model) return;
      State.detailId = stockId;
      State.range = "1d"; // 每次进入详情默认 1 天区间

      // 填充头部
      document.getElementById("detail-name").textContent = model.name;
      const staleBadge = document.getElementById("detail-stale");
      staleBadge.textContent = model.stale ? "停滞" : "正常";
      staleBadge.className = model.stale
        ? "badge badge-stale"
        : "badge badge-ok";
      document.getElementById("detail-price").textContent = formatPrice(
        model.price,
      );
      this._updateChangeLabel();

      // range 标签
      const tabs = document.getElementById("range-tabs");
      tabs.innerHTML = "";
      for (const r of RANGES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `range-tab${r.key === State.range ? " active" : ""}`;
        btn.textContent = r.label;
        btn.addEventListener("click", () => this.setRange(r.key));
        tabs.appendChild(btn);
      }

      // 遮罩交互（onclick 幂等赋值，重复开关详情不会累积监听器）
      document.getElementById("detail-overlay").hidden = false;
      document.getElementById("detail-backdrop").onclick = () => this.close();
      document.getElementById("btn-detail-close").onclick = () => this.close();

      // 图表
      const container = document.getElementById("chart-container");
      container.innerHTML = "";
      this.chart = this._createChart(container);
      this.series = this._createSeries();
      this._createTooltip(container);

      this.applyRange(State.range);
      this._onKey = (e) => {
        if (e.key === "Escape") this.close();
      };
      document.addEventListener("keydown", this._onKey);

      // resize（rAF 去抖）
      this.observer = new ResizeObserver(() => {
        cancelAnimationFrame(this._raf);
        this._raf = requestAnimationFrame(() => this._resize());
      });
      this.observer.observe(container);

      // 主题热切换（不重建实例）
      this._themeSub = (theme) => this.applyChartTheme();
      Theme.subscribe(this._themeSub);
    },

    // 复刻脚本 createThemedChart 的配置结构（配色用 CHART_COLORS 新方案）
    _createChart(container) {
      const c = CHART_COLORS(Theme.current());
      const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
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
          timeFormatter: (time, tickMarkType, locale) =>
            formatTickMark(time, tickMarkType),
        },
        timeScale: {
          borderColor: c.scaleBorder,
          timeVisible: true,
          secondsVisible: true,
          fixLeftEdge: true,
          fixRightEdge: true,
          tickMarkFormatter: (time, tickMarkType, locale) =>
            formatTickMark(time, tickMarkType),
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true,
        },
      });
      return chart;
    },

    _createSeries() {
      const c = CHART_COLORS(Theme.current());
      return this.chart.addLineSeries({
        color: c.line,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        lastPriceAnimation: 1,
      });
    },

    _createTooltip(container) {
      const tooltip = document.createElement("div");
      tooltip.className = "chart-tooltip";
      tooltip.style.display = "none";
      container.appendChild(tooltip);
      this.tooltip = tooltip;

      this._crosshairHandler = (param) => {
        if (!param.point || !param.time || !param.seriesData) {
          tooltip.style.display = "none";
          return;
        }
        const data = param.seriesData.get(this.series);
        if (!data) {
          tooltip.style.display = "none";
          return;
        }
        tooltip.innerHTML = `
          <div style="margin-bottom: 4px;"><strong>时间:</strong> ${formatTimestamp(data.time, "full")}</div>
          <div><strong>价格:</strong> ${formatPrice(data.value)}</div>
        `;
        tooltip.style.display = "block";
        // 定位在光标上方，避免溢出右缘
        const rect = container.getBoundingClientRect();
        const x = Math.min(
          param.point.x + 14,
          rect.width - tooltip.offsetWidth - 8,
        );
        const y = Math.max(param.point.y - tooltip.offsetHeight - 12, 4);
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
      };
      this.chart.subscribeCrosshairMove(this._crosshairHandler);
    },

    // 时间范围：图表始终 setData 全量数据，区间仅切换可视窗口（setVisibleRange）
    // （setData 会重置视口，因此每次之后都必须重设 setVisibleRange）
    applyRange(key) {
      State.range = key;
      const range = RANGES.find((r) => r.key === key) || RANGES[0];

      // 标签激活态
      document.querySelectorAll(".range-tab").forEach((el, i) => {
        el.classList.toggle("active", RANGES[i].key === key);
      });

      const series = State.priceData[State.detailId] || [];
      const data = series.map((p) => ({ time: p.timestamp, value: p.price }));
      this.series.setData(data);

      this._updateStats(series);

      // 最高/最低价线：沿用用户脚本 createPriceLine 方案（虚线 + 轴标签）
      this._updatePriceLines(series);
      if (data.length > 0) {
        const from =
          range.seconds === Infinity
            ? data[0].time
            : Math.max(
                Math.floor(Date.now() / 1000) - range.seconds,
                data[0].time,
              );
        this.chart.timeScale().setVisibleRange({
          from,
          to: data[data.length - 1].time,
        });
      }
    },

    setRange(key) {
      this.applyRange(key);
    },

    // 最高/最低价线（参考用户脚本：LineStyle.Dashed=2，买绿卖红沿用其高/低线配色）
    // 先移除旧线再重建，避免残留已消失的价格水平
    _updatePriceLines(series) {
      if (!this.series) return;
      if (this._priceLines) {
        for (const line of Object.values(this._priceLines)) {
          if (line) this.series.removePriceLine(line);
        }
        this._priceLines = null;
      }
      if (!series || series.length === 0) return;

      let max = series[0].price,
        min = series[0].price;
      for (const p of series) {
        if (p.price > max) max = p.price;
        if (p.price < min) min = p.price;
      }

      this._priceLines = {
        highLine: this.series.createPriceLine({
          price: max,
          color: "#00A854",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "最高价",
        }),
        lowLine: this.series.createPriceLine({
          price: min,
          color: "#F55454",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "最低价",
        }),
      };
    },

    _updateChangeLabel() {
      const model = State.models.find((m) => m.id === State.detailId);
      const change = document.getElementById("detail-change");
      if (!model) return;
      document.getElementById("detail-price").textContent = formatPrice(
        model.price,
      );
      const trend = latestTrendOf(State.priceData[model.id]);
      if (!trend) {
        change.textContent = "—";
        change.className = "detail-change flat";
      } else if (trend.dir === "flat") {
        change.textContent = "0.00%";
        change.className = "detail-change flat";
      } else {
        const sign = trend.dir === "up" ? "+" : "";
        change.textContent = `${sign}${trend.pct.toFixed(2)}%`;
        change.className = `detail-change ${trend.dir}`;
      }
    },

    // 区间统计（最高/最低/采样点数）
    _updateStats(slice) {
      const stats = document.getElementById("detail-stats");
      if (!slice || slice.length === 0) {
        stats.innerHTML = "<span>暂无数据</span>";
        return;
      }
      let max = slice[0].price,
        min = slice[0].price;
      for (const p of slice) {
        if (p.price > max) max = p.price;
        if (p.price < min) min = p.price;
      }
      stats.innerHTML = "";
      const items = [
        ["最高价", formatPrice(max)],
        ["最低价", formatPrice(min)],
        ["采样点数", String(slice.length)],
      ];
      for (const [label, value] of items) {
        const span = document.createElement("span");
        const labelEl = document.createElement("span");
        labelEl.textContent = `${label} `;
        const valueEl = document.createElement("span");
        valueEl.className = "stat-value";
        valueEl.textContent = value;
        span.appendChild(labelEl);
        span.appendChild(valueEl);
        stats.appendChild(span);
      }
    },

    // 定时刷新且详情打开时：重切片 → setData → 恢复可视范围
    updateData() {
      if (!this.chart || State.detailId === null) return;
      this._updateChangeLabel();
      this.applyRange(State.range);
    },

    // 主题热切换：applyOptions 不重建实例（沿用脚本 Theme.apply 模式）
    applyChartTheme() {
      if (!this.chart || !this.series) return;
      const c = CHART_COLORS(Theme.current());
      this.chart.applyOptions({
        layout: {
          background: { type: "solid", color: c.bg },
          textColor: c.text,
        },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        rightPriceScale: { borderColor: c.scaleBorder },
        timeScale: { borderColor: c.scaleBorder },
      });
      this.series.applyOptions({ color: c.line });
    },

    _resize() {
      if (!this.chart) return;
      const container = document.getElementById("chart-container");
      this.chart.resize(container.clientWidth, container.clientHeight);
    },

    close() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this._themeSub) {
        Theme.unsubscribe(this._themeSub);
        this._themeSub = null;
      }
      if (this._onKey) {
        document.removeEventListener("keydown", this._onKey);
        this._onKey = null;
      }
      if (this.chart) {
        this.chart.remove();
        this.chart = null;
      }
      this.series = null;
      this.tooltip = null;
      this._priceLines = null; // 价格线随 chart.remove() 一并销毁
      State.detailId = null;
      document.getElementById("detail-overlay").hidden = true;
    },
  };

  /* ---------------- 刷新 ---------------- */
  const errorBanner = document.getElementById("error-banner");
  const errorText = document.getElementById("error-text");

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.hidden = true;
  }

  async function run({ isAuto } = {}) {
    if (State.loading) return;
    State.loading = true;
    // 加载中提示：更新时间位置改为文案（不在按钮上做，按钮保留按压动画）
    document.getElementById("last-updated").textContent = "数据加载中...";

    try {
      // 串行：先拿模型列表（缓存命中，快），再按最新 id 列表拉价格
      const modelsData = await fetchModels();
      const models = modelsData.models || [];

      let priceData = {};
      if (models.length > 0) {
        priceData = await fetchBatchPrices(
          models.map((m) => m.id),
          DATA_DAYS,
        );
      }

      const prevIds = new Set(State.models.map((m) => m.id));
      State.models = sortModels(models);
      State.priceData = priceData || {};
      State.lastUpdated = Date.now();
      hideError();

      const staleCache = modelsData.staleCache === true;
      document.getElementById("last-updated").textContent =
        `更新时间： ${formatTimestamp(Math.floor(State.lastUpdated / 1000), "full")}` +
        (staleCache ? "（模型列表可能过期）" : "");

      if (prevIds.size === 0) {
        // 首次：全量建卡
        Cards.renderAll();
      } else {
        // 增量更新；新出现的模型补建卡，已消失的模型移除，最后按新排序归位
        for (const model of State.models) Cards.updateOne(model);
        const curIds = new Set(State.models.map((m) => m.id));
        for (const id of prevIds) {
          if (!curIds.has(id)) {
            const card = grid.querySelector(`.card[data-stock-id="${id}"]`);
            if (card) card.remove();
          }
        }
        Cards.reorder();
        if (State.models.length === 0) Cards.renderAll();
      }

      // 详情打开时同步更新
      Detail.updateData();
    } catch (err) {
      // 刷新失败保留旧数据，仅弹横条
      showError(`数据加载失败：${err.message}`);
    } finally {
      State.loading = false;
    }
  }

  function startAutoRefresh() {
    State.timer = setInterval(run, REFRESH_INTERVAL_MS);
    // 浏览器后台标签节流补偿：回到可见且超期则立即补拉
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - State.lastUpdated > REFRESH_INTERVAL_MS
      ) {
        run({ isAuto: true });
      }
    });
  }

  /* ---------------- App ---------------- */
  async function init() {
    Theme.init();
    Favorites.init();
    Manual.init();
    document
      .getElementById("btn-refresh")
      .addEventListener("click", () => run());
    document.getElementById("btn-retry").addEventListener("click", () => run());

    await run();
    startAutoRefresh();
  }

  init();
})();
