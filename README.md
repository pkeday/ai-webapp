# AI Web App Starter (Noob Friendly)

This project gives you a full beginner workflow:
- Build locally with AI agents.
- Test on phone/tablet on the same Wi-Fi.
- Push to GitHub.
- Auto-deploy live via GitHub Pages.

## 1) Run locally

From terminal:

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
chmod +x scripts/run-local.sh
./scripts/run-local.sh
```

Open the URL shown in terminal:
- Laptop: `http://localhost:5173`
- Other device (same Wi-Fi): `http://YOUR_LOCAL_IP:5173`

## 2) Create a GitHub repo and push code

This project is already initialized as a local git repo with an initial commit.
Create an empty repo on GitHub (no README/license), then run:

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
./scripts/connect-github.sh https://github.com/YOUR_USERNAME/YOUR_REPO.git
```

If you prefer manual commands:

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## 3) Live URL (already configured)

Your site is live at:
`https://pkeday.github.io/ai-webapp/`

## 4) Update site after changes

Whenever you edit files with AI and want to publish:

```bash
git add .
git commit -m "Describe update"
git push
```

GitHub Pages auto-updates the site after each push to `main`.

Optional helper (already included in this project):

```bash
./scripts/publish.sh "Describe update"
```

## 5) How to work with AI agents

Use prompts like:
- "Add a pricing section with 3 cards and animations."
- "Create a login form UI only (no backend)."
- "Refactor CSS to be mobile-first and cleaner."
- "Add a contact form that saves to localStorage."

## Notes

- This starter is plain HTML/CSS/JS, so no npm install is needed.
- If you later want React/Next.js, we can upgrade this project when npm/network access is available.
- You only need a custom domain later if you want your own URL. GitHub Pages URL works now.
