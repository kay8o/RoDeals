let settings = {
    popup: true,
    button: true
};

// Load settings
chrome.storage.sync.get(["popup", "button"], (data) => {
    settings.popup = data.popup ?? true;
    settings.button = data.button ?? true;
});

let lastUrl = location.href;

function isCatalogPage(url) {
    return (
        url.includes("/catalog/") ||
        url.includes("/bundles/") ||
        url.includes("/looks/")
    );
}

/* =========================
   FULLSCREEN POPUP
========================= */
function createPopup() {
    if (!settings.popup) return;

    if (document.getElementById("roblox-catalog-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "roblox-catalog-overlay";

    const popup = document.createElement("div");
    popup.id = "roblox-catalog-popup";

    popup.innerHTML = `
        <button id="roblox-popup-close">×</button>

        <h2>Looking for Roblox items?</h2>

        <p>
            You may be able to save up to 40% on Roblox items using this game.
        </p>

        <a
            id="roblox-popup-link"
            href="https://www.roblox.com/games/5728150404/"
            target="_blank"
        >
            Open Roblox Game
        </a>
    `;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    document.getElementById("roblox-popup-close").onclick = () => {
        overlay.remove();
    };

    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.remove();
        }
    };
}

/* =========================
   SAVE 40% BUTTON
========================= */
function addSaveButton() {
    if (!settings.button) return;

    if (document.getElementById("roblox-save-btn")) return;

    const buyButton = document.querySelector(".PurchaseButton");

    if (!buyButton) return;

    const container = buyButton.closest(".btn-container");

    if (!container) return;

    const saveBtn = document.createElement("button");

    saveBtn.id = "roblox-save-btn";

    saveBtn.innerText = "Save 40% on this item";

    Object.assign(saveBtn.style, {
        marginTop: "8px",
        width: "100%",
        padding: "10px",
        borderRadius: "8px",
        border: "none",
        cursor: "pointer",
        background: "#00b06f",
        color: "white",
        fontWeight: "bold"
    });

    saveBtn.onclick = () => {
        window.open(
            "https://www.roblox.com/games/5728150404/",
            "_blank"
        );
    };

    container.parentElement.appendChild(saveBtn);
}

/* =========================
   RUNNER
========================= */
function run() {
    if (isCatalogPage(location.href)) {
        setTimeout(createPopup, 1000);
    }

    addSaveButton();
}

run();

/* detect roblox navigation */
setInterval(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        run();
    }
}, 500);

/* keep checking for dynamic roblox ui */
const observer = new MutationObserver(() => {
    addSaveButton();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});