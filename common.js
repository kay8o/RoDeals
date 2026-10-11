/*
 * RoDeals shared code.
 * Loaded by the content script (roblox.com pages) AND by the popup/options
 * pages, so link validation and copy live in exactly one place.
 */
(function () {
  "use strict";

  /* The RoDeals creator's own game. Used until the user adds their own link. */
  const DEFAULT_GAME_LINK = "https://www.roblox.com/games/5728150404/";

  const DEFAULT_SETTINGS = {
    popup: true,
    button: true,
    warnings: true,
    gameLink: DEFAULT_GAME_LINK,
    popupFrequency: "hour"
  };

  /* Minimum gap between full-screen reminders (0 = every catalog visit). */
  const FREQUENCY_MS = {
    always: 0,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000
  };

  const ROBLOX_HOSTS = new Set(["www.roblox.com", "roblox.com", "web.roblox.com"]);

  function gameUrl(placeId) {
    return "https://www.roblox.com/games/" + placeId + "/";
  }

  /**
   * Turns whatever the user pasted into a clean, safe Roblox game URL.
   * Accepts: a bare place ID, a /games/<id>/<name> link (with or without
   * https://, with or without a language prefix), or a roblox.com/share link.
   * The returned URL is always rebuilt from parsed parts, so tracking
   * junk, odd ports, or look-alike hosts can never leak through.
   *
   * @returns {{ok: true, url: string} | {ok: false, error: string}}
   */
  function parseGameLink(raw) {
    let text = String(raw == null ? "" : raw).trim();
    if (!text) {
      return { ok: false, error: "Paste a Roblox game link first." };
    }

    if (/^\d{1,20}$/.test(text)) {
      return { ok: true, url: gameUrl(text) };
    }

    if (!/^https?:\/\//i.test(text)) {
      text = "https://" + text;
    }

    let u;
    try {
      u = new URL(text);
    } catch (e) {
      return { ok: false, error: "That doesn't look like a valid link." };
    }

    if (!ROBLOX_HOSTS.has(u.hostname.toLowerCase())) {
      return { ok: false, error: "Only roblox.com links are allowed." };
    }

    const segs = u.pathname.split("/").filter(Boolean);
    let i = 0;
    if (/^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0] || "") &&
        (segs[1] === "games" || segs[1] === "share")) {
      i = 1; // language prefix, e.g. /es/games/123
    }

    if (segs[i] === "games" && /^\d{1,20}$/.test(segs[i + 1] || "")) {
      return { ok: true, url: gameUrl(segs[i + 1]) };
    }

    if (segs[i] === "share") {
      const code = u.searchParams.get("code") || "";
      const type = u.searchParams.get("type") || "";
      if (/^[A-Za-z0-9]{8,64}$/.test(code) &&
          (type === "ExperienceDetails" || type === "Server")) {
        return {
          ok: true,
          url: "https://www.roblox.com/share?code=" + code + "&type=" + type
        };
      }
    }

    return {
      ok: false,
      error: "Use a game link like roblox.com/games/1234567890/My-Game"
    };
  }

  /** Fills in defaults and re-validates anything read from storage. */
  function normalizeSettings(data) {
    data = data || {};
    const parsed = parseGameLink(data.gameLink);
    return {
      popup: data.popup !== false,
      button: data.button !== false,
      warnings: data.warnings !== false,
      gameLink: parsed.ok ? parsed.url : DEFAULT_GAME_LINK,
      popupFrequency: Object.prototype.hasOwnProperty.call(FREQUENCY_MS, data.popupFrequency)
        ? data.popupFrequency
        : DEFAULT_SETTINGS.popupFrequency
    };
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), function (data) {
          resolve(normalizeSettings(chrome.runtime.lastError ? {} : data));
        });
      } catch (e) {
        resolve(normalizeSettings({}));
      }
    });
  }

  function isCustomLink(url) {
    return url !== DEFAULT_GAME_LINK;
  }

  /* =========================
     ITEMS THE 40% METHOD DOESN'T SUPPORT
     =========================
     Add more hand-picked items here as "Type:ID": "reason".
       Bundle URL  /bundles/201/...  ->  "Bundle:201"
       Item URL    /catalog/123/...  ->  "Asset:123"
     A reason must have an entry in warningCopy() below.
     Roblox-made Limiteds aren't listed: they're detected from Roblox's
     item data (see reasonFromEconomy / reasonFromDetails). UGC Limiteds are supported. */
  const UNSUPPORTED_ITEMS = {
    "Bundle:201": "headless" // Headless Horseman
  };

  /** "/de/catalog/123/Name" -> {type: "Asset", id: "123"}; null if not an item page. */
  function parseItemFromPath(pathname) {
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(catalog|bundles)\/(\d{1,20})(?:\/|$)/i
      .exec(String(pathname || ""));
    if (!m) return null;
    return { type: m[1].toLowerCase() === "bundles" ? "Bundle" : "Asset", id: m[2] };
  }

  function listedReason(item) {
    const key = item.type + ":" + item.id;
    return Object.prototype.hasOwnProperty.call(UNSUPPORTED_ITEMS, key)
      ? UNSUPPORTED_ITEMS[key]
      : null;
  }

  function isRobloxCreator(id, type, name) {
    const byName = String(name || "").toLowerCase() === "roblox";
    const byId = Number(id) === 1 && String(type || "User").toLowerCase() === "user";
    return byName || byId; // Roblox itself is user ID 1
  }

  /*
   * The two reason-from-data functions below return:
   *   "roblox-limited" -> a limited item made by Roblox (not supported)
   *   null             -> recognised response; item is fine
   *   undefined        -> response not recognised (caller tries another source)
   *
   * "Limited" means ANY limited-style item: classic Limited / Limited Unique,
   * or a Collectible (what Roblox's newer limiteds, including Roblox-made
   * ones, are), as stated explicitly by Roblox, never inferred. The rule is by CREATOR, not by type: limiteds made by anyone
   * other than Roblox (UGC Limiteds) stay supported.
   */

  /** Catalog API shape: { itemRestrictions: [...], creatorType, creatorTargetId, creatorName } */
  function reasonFromDetails(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.itemRestrictions)) return undefined;

    const r = d.itemRestrictions;
    const limited = r.indexOf("Limited") !== -1 ||
                    r.indexOf("LimitedUnique") !== -1 ||
                    r.indexOf("Collectible") !== -1;

    return limited && isRobloxCreator(d.creatorTargetId, d.creatorType, d.creatorName)
      ? "roblox-limited" : null;
  }

  /**
   * Economy API shape: { IsLimited, IsLimitedUnique, ProductType, Creator: {...} }
   * Only unambiguous fields count. CollectibleItemId / CollectiblesItemDetails are
   * deliberately NOT used: they can be present (empty or placeholder) on ordinary
   * items, which wrongly flagged every Roblox-made item.
   */
  function reasonFromEconomy(d) {
    if (!d || typeof d !== "object" ||
        typeof d.IsLimited !== "boolean" || !d.Creator || typeof d.Creator !== "object") {
      return undefined;
    }

    const limited = d.IsLimited === true ||
                    d.IsLimitedUnique === true ||
                    d.ProductType === "Collectible Item";

    const c = d.Creator;
    const creatorId = c.CreatorTargetId != null ? c.CreatorTargetId : c.Id;
    return limited && isRobloxCreator(creatorId, c.CreatorType, c.Name)
      ? "roblox-limited" : null;
  }

  function warningCopy(reason) {
    const common = {
      title: "Not supported by the 40% method",
      note: "You can turn these warnings off in RoDeals settings.",
      inline: "Not supported by the 40% method"
    };
    if (reason === "headless") {
      return Object.assign({}, common, {
        body: "The Headless Horseman bundle can't be used with the 40% method, " +
              "so buying it won't earn the commission."
      });
    }
    return Object.assign({}, common, {
      body: "Limiteds made by Roblox can't be used with the 40% method, so buying " +
            "this item won't earn the commission. UGC Limiteds aren't affected."
    });
  }

  /*
   * All user-facing wording for the on-page reminder. Edit here.
   *
   * Why two versions: Roblox pays the 40% in-experience commission to the
   * OWNER of the experience where the purchase happens. So "get 40% back" is
   * only true when the game is the user's own. With the default game, the
   * commission goes to the RoDeals creator, and the copy says so plainly.
   */
  function copyFor(custom) {
    if (custom) {
      return {
        title: "Looking for Roblox items?",
        body: "Buying eligible Marketplace items through your own Roblox game " +
              "can return up to 40% of the Robux spent as an experience commission.",
        link: "Open my game",
        note: "",
        itemButton: "Get up to 40% back on this item"
      };
    }
    return {
      title: "Looking for Roblox items?",
      body: "Roblox pays the owner of a game up to 40% of the Robux spent on " +
            "eligible Marketplace items bought inside it. Add your own game " +
            "from the RoDeals toolbar icon to collect that yourself.",
      link: "Open the RoDeals game",
      note: "Until you add your own game, purchases made here support the RoDeals creator.",
      itemButton: "Shop via the RoDeals game"
    };
  }

  window.RoDeals = {
    DEFAULT_GAME_LINK: DEFAULT_GAME_LINK,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    FREQUENCY_MS: FREQUENCY_MS,
    parseGameLink: parseGameLink,
    normalizeSettings: normalizeSettings,
    getSettings: getSettings,
    isCustomLink: isCustomLink,
    parseItemFromPath: parseItemFromPath,
    listedReason: listedReason,
    reasonFromDetails: reasonFromDetails,
    reasonFromEconomy: reasonFromEconomy,
    warningCopy: warningCopy,
    copyFor: copyFor
  };
})();
