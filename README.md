# RP Companion - Railway Deployment
version v1.2.2i make button add character visble in PWA

## 🚀 Quick Deploy to Railway (No CLI Needed!)

### Step 1: Upload to GitHub

1. Go to https://github.com
2. Click "New repository"
3. Name it: `rp-companion`
4. Click "Create repository"
5. Click "uploading an existing file"
6. Drag all these files:
   - `index.html`
   - `server.js`
   - `package.json`
   - `README.md`
7. Click "Commit changes"

### Step 2: Deploy on Railway

1. Go to https://railway.app
2. Sign up (use GitHub account - easiest)
3. Click "New Project"
4. Click "Deploy from GitHub repo"
5. Select your `rp-companion` repository
6. Railway will auto-detect Node.js and deploy!

### Step 3: Add Environment Variables

1. In Railway project dashboard, click on your service
2. Go to "Variables" tab
3. Add your API key(s):

```
MANCER_API_KEY=your-mancer-key-here
```

Or add others:
```
OPENROUTER_API_KEY=your-openrouter-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

4. Click "Deploy" (top right)

### Step 4: Get Your URL

1. Go to "Settings" tab
2. Under "Domains" → Click "Generate Domain"
3. Your app will be at: `something.up.railway.app`

---

## ✅ Done!

Visit your Railway URL and your app is live!

---

## Key Differences from Netlify:

| Feature | Netlify | Railway |
|---|---|---|
| Timeout | 10 seconds | No limit ✅ |
| API endpoint | `/.netlify/functions/chat` | `/api/chat` |
| Deployment | Drag & drop | GitHub only |
| Cost | Free (125k calls) | Free ($5 credit/month) |

---

## If You Get Stuck:

### "Build failed"
- Make sure all 4 files are uploaded
- Check Railway logs for error

### "Cannot find module"
- Railway installs dependencies automatically
- Just wait for build to complete

### "API Key not configured"
- Go to Variables tab
- Add your API key
- Click Deploy again

---

## Local Testing (Optional):

If you want to test locally first:

```bash
# Install Node.js first (if not installed)
# Then:

npm install
npm start

# Visit: http://localhost:3000
```

---

## Benefits of Railway:

✅ No 10-second timeout limit
✅ GLM-4.7 works perfectly
✅ Long AI responses supported
✅ Same code as Netlify (easy migration)
✅ Free for hobby use

---

## Your Files:

```
rp-companion/
├── index.html       ← Your app frontend
├── server.js        ← Backend API server
├── package.json     ← Node.js dependencies
└── README.md        ← This file
```

---

## Environment Variables Needed:

**For Mancer (default):**
```
MANCER_API_KEY=your-key-here
```

**For others, add as needed:**
```
OPENROUTER_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
```

---

Good luck! 🎉
