(() => {
    "use strict";

    const {
        FREQUENCY_MS, getSettings, isCustomLink, copyFor,
        parseItemFromPath, listedReason, reasonFromDetails, reasonFromEconomy, warningCopy
    } = window.RoDeals;

    const OVERLAY_ID = "roblox-catalog-overlay";
    const POPUP_ID = "roblox-catalog-popup";
    const SAVE_BTN_ID = "roblox-save-btn";
    const NOTICE_ID = "rodeals-unsupported-note";

    // /catalog, /bundles/123/..., /looks/..., with an optional language prefix (/de/catalog/...)
    const CATALOG_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:catalog|bundles|looks)(?:\/|$)/i;

    let settings = null; // filled in by init(); nothing renders before then
    let lastPath = location.pathname;
    let popupTimer = null;
    let observerTimer = null;
    let urlWatcher = null;
    let observer = null;

    // Per-page verdict: is this item supported by the 40% method?
    // Nothing item-specific is shown until `ready` is true.
    let pageState = { key: null, ready: false, unsupported: null, promise: null };
    const verdictCache = new Map(); // "Asset:123" -> reason | null

    /* =========================
       HELPERS
    ========================= */
    function isCatalogPage() {
        return CATALOG_PATH.test(location.pathname);
    }

    // After the extension is reloaded/updated, old content scripts are orphaned.
    // Detect that and stop quietly instead of throwing on every tick.
    function isAlive() {
        try {
            return !!(chrome.runtime && chrome.runtime.id);
        } catch (e) {
            return false;
        }
    }

    function shutDown() {
        clearTimeout(popupTimer);
        clearTimeout(observerTimer);
        clearInterval(urlWatcher);
        if (observer) observer.disconnect();
    }

    function h(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (key === "text") node.textContent = value;
            else node.setAttribute(key, value);
        }
        node.append(...children);
        return node;
    }

    function isRobloxDarkTheme() {
        const body = document.body;
        if (body.classList.contains("dark-theme")) return true;
        if (body.classList.contains("light-theme")) return false;

        const rgb = getComputedStyle(body).backgroundColor.match(/[\d.]+/g);
        if (!rgb || rgb.length < 3 || (rgb.length > 3 && parseFloat(rgb[3]) === 0)) {
            return true; // transparent or unreadable: Roblox's default is dark
        }
        const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
        return brightness < 128;
    }

    /* =========================
       IS THIS ITEM SUPPORTED?
    ========================= */
    // GET json from a Roblox API. Sends cookies like the site itself does; if the
    // browser's CORS check rejects that, retries anonymously. null on any failure.
    async function fetchJson(url) {
        for (const credentials of ["include", "omit"]) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            try {
                const res = await fetch(url, { credentials, signal: controller.signal });
                if (!res.ok) return null; // a real HTTP answer: no point retrying
                return await res.json();
            } catch (e) {
                // network/CORS failure: loop and try the other credentials mode
            } finally {
                clearTimeout(timeout);
            }
        }
        return null;
    }

    // Returns a reason string ("headless", "roblox-limited") or null (supported / unknown).
    // Hand-picked items are decided instantly with no network. Everything else
    // asks Roblox (catalog API, then economy API as a fallback). If neither
    // gives a recognisable answer we fail open (treat as supported) and don't cache it.
    async function getUnsupportedReason(item) {
        const listed = listedReason(item);
        if (listed) return listed;
        if (item.type !== "Asset") return null; // bundles can't be Limited

        const key = item.type + ":" + item.id;
        if (verdictCache.has(key)) return verdictCache.get(key);

        // Catalog API first: it states restrictions explicitly (itemRestrictions).
        // Economy API second, using only its unambiguous fields.
        const catalog = await fetchJson(
            "https://catalog.roblox.com/v1/catalog/items/" + item.id + "/details?itemType=Asset");
        let reason = reasonFromDetails(catalog);
        let source = "catalog";
        let seen = catalog && { restrictions: catalog.itemRestrictions, creator: catalog.creatorName, creatorId: catalog.creatorTargetId };

        if (reason === undefined) {
            const economy = await fetchJson("https://economy.roblox.com/v2/assets/" + item.id + "/details");
            reason = reasonFromEconomy(economy);
            source = "economy";
            seen = economy && {
                IsLimited: economy.IsLimited, IsLimitedUnique: economy.IsLimitedUnique,
                ProductType: economy.ProductType, creator: economy.Creator && economy.Creator.Name
            };
        }

        // One compact line per item, so a wrong verdict can be diagnosed from DevTools.
        console.info("[RoDeals] " + key + " ->",
            reason === undefined ? "no recognisable data from Roblox (treated as supported)"
                                 : (reason || "supported") + " (via " + source + " API)",
            seen ? JSON.stringify(seen) : "");

        if (reason === undefined) return null;
        verdictCache.set(key, reason);
        return reason;
    }

    function resolvePage() {
        const key = location.pathname;
        const item = parseItemFromPath(key);
        const state = { key, ready: !item, unsupported: null, promise: null };
        pageState = state;

        state.promise = (async () => {
            if (!item) return;
            const reason = await getUnsupportedReason(item);
            if (pageState !== state) return; // navigated away meanwhile
            state.unsupported = reason;
            state.ready = true;
            syncPage();
        })();
    }

    /* =========================
       FULLSCREEN POPUPS
    ========================= */
    async function dueFor(storageKey) {
        const gap = FREQUENCY_MS[settings.popupFrequency];
        if (!gap) return true; // "every visit"
        const stored = await chrome.storage.local.get(storageKey);
        return Date.now() - (stored[storageKey] || 0) >= gap;
    }

    function closePopup() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) overlay.remove();
        document.removeEventListener("keydown", onPopupKeydown, true);
    }

    function onPopupKeydown(e) {
        if (e.key === "Escape") closePopup();
    }

    // kind: "promo" (the normal reminder) or "warning" (unsupported item)
    function openOverlay(kind, popupChildren, extraClass) {
        const closeBtn = h("button", { id: "roblox-popup-close", type: "button", "aria-label": "Close", text: "×" });
        const popup = h("div", {
            id: POPUP_ID,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "rodeals-popup-title",
            tabindex: "-1"
        }, closeBtn, ...popupChildren);

        popup.classList.add(isRobloxDarkTheme() ? "rodeals-dark" : "rodeals-light");
        if (extraClass) popup.classList.add(extraClass);

        const overlay = h("div", { id: OVERLAY_ID, "data-kind": kind }, popup);
        document.body.appendChild(overlay);

        closeBtn.addEventListener("click", closePopup);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closePopup();
        });
        document.addEventListener("keydown", onPopupKeydown, true);

        popup.focus({ preventScroll: true }); // dialog gets focus; Tab reaches the buttons
        return { popup, overlay };
    }

    function showPopup() {
        if (!settings.popup) return;
        if (document.getElementById(OVERLAY_ID)) return;

        const text = copyFor(isCustomLink(settings.gameLink));

        const children = [
            h("h2", { id: "rodeals-popup-title", text: text.title }),
            h("p", { text: text.body }),
            h("a", {
                id: "roblox-popup-link",
                href: settings.gameLink,
                target: "_blank",
                rel: "noopener noreferrer",
                text: text.link
            })
        ];
        if (text.note) children.push(h("p", { class: "rodeals-note", text: text.note }));

        const dismiss = h("button", { id: "rodeals-popup-dismiss", type: "button", text: "Don't show this again" });
        children.push(dismiss);

        openOverlay("promo", children);

        dismiss.addEventListener("click", () => {
            chrome.storage.sync.set({ popup: false });
            closePopup();
        });
        chrome.storage.local.set({ lastPopupShown: Date.now() });
    }

    function showWarningPopup(reason) {
        if (!settings.warnings) return;
        if (document.getElementById(OVERLAY_ID)) return;

        const text = warningCopy(reason);
        const ok = h("button", { id: "rodeals-popup-ok", type: "button", text: "Got it" });

        openOverlay("warning", [
            h("h2", { id: "rodeals-popup-title", text: text.title }),
            h("p", { text: text.body }),
            ok,
            h("p", { class: "rodeals-note", text: text.note })
        ], "rodeals-warning");

        ok.addEventListener("click", closePopup);
        chrome.storage.local.set({ lastWarningShown: Date.now() });
    }

    function schedulePopup() {
        clearTimeout(popupTimer);
        if (!isCatalogPage()) return;

        const state = pageState;
        popupTimer = setTimeout(async () => {
            if (!isAlive() || !isCatalogPage()) return;
            await state.promise; // wait for the supported/unsupported verdict
            if (pageState !== state) return;

            if (state.unsupported) {
                if (settings.warnings && await dueFor("lastWarningShown")) showWarningPopup(state.unsupported);
            } else if (settings.popup && await dueFor("lastPopupShown")) {
                showPopup();
            }
        }, 1000);
    }

    /* =========================
       INLINE ITEM-PAGE ELEMENTS
    ========================= */
    function removeInline() {
        for (const id of [SAVE_BTN_ID, NOTICE_ID]) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
    }

    // Where to put things: right under Roblox's Buy button.
    function findHost() {
        const buyButton = document.querySelector(".PurchaseButton");
        if (!buyButton) return null;
        const container = buyButton.closest(".btn-container") || buyButton.parentElement;
        return container && (container.parentElement || container);
    }

    function addSaveButton() {
        if (document.getElementById(SAVE_BTN_ID)) return;
        const host = findHost();
        if (!host) return;

        host.appendChild(h("a", {
            id: SAVE_BTN_ID,
            class: "rodeals-save-btn",
            href: settings.gameLink,
            target: "_blank",
            rel: "noopener noreferrer",
            text: copyFor(isCustomLink(settings.gameLink)).itemButton
        }));
    }

    function addNotice() {
        if (document.getElementById(NOTICE_ID)) return;
        const host = findHost();
        if (!host) return;

        host.appendChild(h("div", {
            id: NOTICE_ID,
            class: "rodeals-notice",
            role: "note",
            text: warningCopy(pageState.unsupported).inline
        }));
    }

    function removeById(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    /* =========================
       RUNNER
    ========================= */
    function syncPage() {
        if (!isCatalogPage() || !pageState.ready) return removeInline();

        if (pageState.unsupported) {
            // Never show the "get 40% back" button on an item that doesn't qualify.
            removeById(SAVE_BTN_ID);
            if (settings.warnings) addNotice();
            else removeById(NOTICE_ID);
        } else {
            removeById(NOTICE_ID);
            if (settings.button) addSaveButton();
            else removeById(SAVE_BTN_ID);
        }
    }

    function onUrlChange() {
        if (!isAlive()) return shutDown();
        // Compare paths, not full URLs: changing catalog filters shouldn't re-trigger popups.
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;

        closePopup();
        removeInline();
        resolvePage();
        schedulePopup();
        syncPage();
    }

    // Re-render anything the user changed in the toolbar popup, without a page reload.
    function applySettings(next) {
        settings = next;

        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) {
            const kind = overlay.getAttribute("data-kind");
            if ((kind === "promo" && !settings.popup) || (kind === "warning" && !settings.warnings)) {
                closePopup();
            }
        }

        removeInline(); // re-added below with current link + wording
        syncPage();
    }

    async function init() {
        settings = await getSettings(); // load BEFORE rendering, so "off" really means off

        resolvePage();
        schedulePopup();
        syncPage();

        // Roblox is a single-page app: catch in-page navigation.
        if (window.navigation && window.navigation.addEventListener) {
            window.navigation.addEventListener("navigatesuccess", onUrlChange);
        }
        window.addEventListener("popstate", onUrlChange);
        urlWatcher = setInterval(onUrlChange, 1000); // safety net

        // Roblox renders the buy button late and re-renders it often.
        // Debounced, so a busy page doesn't trigger a DOM query per mutation.
        observer = new MutationObserver(() => {
            if (observerTimer) return;
            observerTimer = setTimeout(() => {
                observerTimer = null;
                if (!isAlive()) return shutDown();
                syncPage();
            }, 250);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        chrome.storage.onChanged.addListener(async (changes, area) => {
            if (area !== "sync" || !isAlive()) return;
            applySettings(await getSettings());
        });
    }

    init();
})();
