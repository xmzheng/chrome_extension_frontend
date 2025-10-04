async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showTemporaryStatus(button, originalText, tempText, duration = 1200) {
  button.textContent = tempText;
  setTimeout(() => {
    button.textContent = originalText;
    button.disabled = false;
  }, duration);
}

document.addEventListener("DOMContentLoaded", () => {
  const saveBtn = document.getElementById("save-btn");
  const refreshBtn = document.getElementById("refresh-btn");

  saveBtn.addEventListener("click", async () => {
    if (saveBtn.disabled) return;
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error("No active tab");
      const response = await chrome.runtime.sendMessage({
        type: "SAVE_URL",
        url: tab.url,
        tabId: tab.id,
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Save failed");
      }
      showTemporaryStatus(saveBtn, originalText, "Saved!");
      window.close();
    } catch (error) {
      console.error("Save failed", error);
      showTemporaryStatus(saveBtn, originalText, "Save failed");
    }
  });

  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    const originalText = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error("No active tab");
      await chrome.tabs.sendMessage(tab.id, { type: "FORCE_RESCAN" });
      showTemporaryStatus(refreshBtn, originalText, "Requested!");
      window.close();
    } catch (error) {
      console.error("Refresh failed", error);
      showTemporaryStatus(refreshBtn, originalText, "Refresh failed");
    }
  });
});
