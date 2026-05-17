const popupToggle = document.getElementById("popupToggle");
const buttonToggle = document.getElementById("buttonToggle");

// Load saved settings
chrome.storage.sync.get(["popup", "button"], (data) => {
    popupToggle.checked = data.popup ?? true;
    buttonToggle.checked = data.button ?? true;
});

// Save popup setting
popupToggle.addEventListener("change", () => {
    chrome.storage.sync.set({
        popup: popupToggle.checked
    });
});

// Save button setting
buttonToggle.addEventListener("change", () => {
    chrome.storage.sync.set({
        button: buttonToggle.checked
    });
});

// Open extension settings
document.getElementById("openSettings").addEventListener("click", () => {
    chrome.tabs.create({
        url: "chrome://extensions/"
    });
});