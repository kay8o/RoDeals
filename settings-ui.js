/* Shared by popup.html and options.html. Wires up whichever controls exist. */
(() => {
    "use strict";

    const { DEFAULT_GAME_LINK, parseGameLink, getSettings, isCustomLink } = window.RoDeals;
    const $ = (id) => document.getElementById(id);

    const linkInput = $("gameLink");
    const statusEl = $("linkStatus");
    const saveBtn = $("saveLink");
    const testBtn = $("testLink");
    const resetBtn = $("resetLink");
    const popupToggle = $("popupToggle");
    const buttonToggle = $("buttonToggle");
    const warningsToggle = $("warningsToggle");
    const freqSelect = $("popupFrequency"); // options page only
    const optionsBtn = $("openOptions");    // popup only
    const versionEl = $("version");         // options page only

    /* ---------- link box ---------- */
    function setStatus(message, kind) {
        statusEl.textContent = message;
        statusEl.className = "status" + (kind ? " " + kind : "");
        linkInput.setAttribute("aria-invalid", kind === "error" ? "true" : "false");
    }

    function showLinkState(url, justSaved) {
        const custom = isCustomLink(url);
        linkInput.value = custom ? url : "";
        resetBtn.hidden = !custom;

        if (custom) {
            setStatus(justSaved ? "Saved. Using your game." : "Using your game.", "ok");
        } else {
            setStatus(justSaved
                ? "Back to the default RoDeals game."
                : "Using the default RoDeals game. Add yours to collect the commission yourself.", "");
        }
    }

    function resetLink() {
        chrome.storage.sync.remove("gameLink", () => {
            if (chrome.runtime.lastError) {
                setStatus("Couldn't save. Please try again.", "error");
                return;
            }
            showLinkState(DEFAULT_GAME_LINK, true);
        });
    }

    function saveLink() {
        const raw = linkInput.value.trim();
        if (!raw) return resetLink(); // clearing the box = go back to the default

        const result = parseGameLink(raw);
        if (!result.ok) {
            setStatus(result.error, "error");
            linkInput.focus();
            return;
        }
        if (!isCustomLink(result.url)) return resetLink();

        chrome.storage.sync.set({ gameLink: result.url }, () => {
            if (chrome.runtime.lastError) {
                setStatus("Couldn't save. Please try again.", "error");
                return;
            }
            showLinkState(result.url, true);
        });
    }

    saveBtn.addEventListener("click", saveLink);
    resetBtn.addEventListener("click", resetLink);

    linkInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveLink();
    });
    linkInput.addEventListener("input", () => {
        if (statusEl.classList.contains("error")) setStatus("", "");
    });

    testBtn.addEventListener("click", () => {
        const raw = linkInput.value.trim();
        const result = raw ? parseGameLink(raw) : { ok: true, url: DEFAULT_GAME_LINK };
        if (!result.ok) {
            setStatus(result.error, "error");
            return;
        }
        chrome.tabs.create({ url: result.url });
    });

    /* ---------- toggles & frequency ---------- */
    function syncFrequencyState() {
        if (freqSelect) freqSelect.disabled = !popupToggle.checked;
    }

    popupToggle.addEventListener("change", () => {
        chrome.storage.sync.set({ popup: popupToggle.checked });
        syncFrequencyState();
    });

    buttonToggle.addEventListener("change", () => {
        chrome.storage.sync.set({ button: buttonToggle.checked });
    });

    warningsToggle.addEventListener("change", () => {
        chrome.storage.sync.set({ warnings: warningsToggle.checked });
    });

    if (freqSelect) {
        freqSelect.addEventListener("change", () => {
            chrome.storage.sync.set({ popupFrequency: freqSelect.value });
        });
    }

    if (optionsBtn) {
        optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
    }

    if (versionEl) {
        versionEl.textContent = "RoDeals v" + chrome.runtime.getManifest().version;
    }

    /* ---------- load + stay in sync ---------- */
    function render(settings, isFirstRender) {
        popupToggle.checked = settings.popup;
        buttonToggle.checked = settings.button;
        warningsToggle.checked = settings.warnings;
        if (freqSelect) freqSelect.value = settings.popupFrequency;
        syncFrequencyState();

        // Never overwrite what the user is in the middle of typing.
        if (isFirstRender || document.activeElement !== linkInput) {
            showLinkState(settings.gameLink, false);
        }
    }

    getSettings().then((settings) => render(settings, true));

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") getSettings().then((settings) => render(settings, false));
    });
})();
