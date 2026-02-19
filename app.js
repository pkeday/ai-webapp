const status = document.getElementById("status");
const apiStatus = document.getElementById("api-status");
const apiForm = document.getElementById("api-form");
const apiBaseInput = document.getElementById("api-base-input");
const form = document.getElementById("note-form");
const input = document.getElementById("note-input");
const notesEl = document.getElementById("notes");

const notes = [];
const apiBaseKey = "ai_webapp_api_base";
const defaultApiBase = "https://pkeday-ai-webapp-api.onrender.com";

status.textContent = `App loaded at ${new Date().toLocaleString()}`;

function getApiBase() {
  const saved = localStorage.getItem(apiBaseKey);
  if (!saved) {
    return defaultApiBase;
  }

  return saved.replace(/\/$/, "");
}

async function testApiConnection(baseUrl) {
  apiStatus.textContent = "API status: checking...";

  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) {
      apiStatus.textContent = `API status: failed (HTTP ${response.status})`;
      return;
    }

    const data = await response.json();
    apiStatus.textContent = `API status: connected (${data.env})`;
  } catch {
    apiStatus.textContent = "API status: connection failed";
  }
}

apiBaseInput.value = getApiBase();
testApiConnection(getApiBase());

apiForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const value = apiBaseInput.value.trim().replace(/\/$/, "");
  if (!value) {
    return;
  }

  localStorage.setItem(apiBaseKey, value);
  await testApiConnection(value);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const value = input.value.trim();
  if (!value) {
    return;
  }

  notes.push(value);
  input.value = "";

  notesEl.innerHTML = "";
  for (const note of notes) {
    const li = document.createElement("li");
    li.textContent = note;
    notesEl.appendChild(li);
  }
});
