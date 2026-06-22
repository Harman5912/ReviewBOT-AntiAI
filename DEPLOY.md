# 🚀 Deploy ReviewBot to Render (Free)

## Step 1: Push to GitHub

1. Go to [github.com](https://github.com) and create a **new repository** (name it `reviewbot`)
2. **Do NOT** initialize with README, .gitignore, or license
3. Copy the repository URL (looks like `https://github.com/YOUR_USERNAME/reviewbot.git`)

4. Open a terminal in your project folder and run:

```bash
cd "d:\anti ai\reviewbot"

# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - ReviewBot dashboard"

# Connect to GitHub
git remote add origin https://github.com/YOUR_USERNAME/reviewbot.git

# Push
git push -u origin main
```

> ⚠️ **IMPORTANT**: Your `.env` file is NOT uploaded (it's in .gitignore). This is good! It contains your secret API keys.

---

## Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and **sign up** (use GitHub login)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository (`reviewbot`)
4. Fill in the settings:
   - **Name**: `reviewbot`
   - **Environment**: `Node`
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm run start:prod`
5. Click **"Create Web Service"**

---

## Step 3: Add Environment Variables on Render

After creating the service, go to **"Environment"** tab and add these variables:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DATABASE_TYPE` | `sqlite` |
| `OPENROUTER_API_KEY` | `sk-or-v1-...your key...` |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `OPENROUTER_DEFAULT_MODEL` | `google/gemini-2.5-flash` |
| `OPENROUTER_REVIEW_MODEL` | `openrouter/owl-alpha` |
| `GITHUB_APP_ID` | `4067255` |
| `GITHUB_PRIVATE_KEY` | `-----BEGIN RSA PRIVATE KEY-----\n...your key...\n-----END RSA PRIVATE KEY-----` |
| `GITHUB_WEBHOOK_SECRET` | `dev_webhook_secret` |
| `CONFIDENCE_THRESHOLD` | `0.70` |
| `MAX_RETRIES` | `3` |
| `REVIEW_CONCURRENCY` | `5` |
| `REVIEW_TIMEOUT_MS` | `480000` |
| `CLONE_BASE_PATH` | `/tmp/reviewbot` |

> ⚠️ For `GITHUB_PRIVATE_KEY`, paste the ENTIRE key including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` on one line with `\n` for line breaks.

---

## Step 4: Access Your Dashboard

Once deployed, Render will give you a URL like:
`https://reviewbot.onrender.com`

Open it in your browser and enter PIN: **0759**

---

## ⚠️ Important Notes

1. **Free tier limitations**: Render's free tier spins down after 15 minutes of inactivity. It may take 30-60 seconds to wake up when you first visit.

2. **Redis**: The free tier doesn't include Redis. The app will work but queue features may be limited. For full functionality, consider upgrading or using a free Redis cloud instance.

3. **GitHub App**: For full PR review functionality, you'll need to install your GitHub App on your repositories and configure the webhook URL to point to your Render URL.

4. **Updates**: To update your app after making changes:
```bash
git add .
git commit -m "Your update message"
git push
```
Render will automatically redeploy when you push.
