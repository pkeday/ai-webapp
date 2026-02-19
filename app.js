const status = document.getElementById("status");
const form = document.getElementById("note-form");
const input = document.getElementById("note-input");
const notesEl = document.getElementById("notes");

const notes = [];

status.textContent = `App loaded at ${new Date().toLocaleString()}`;

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
