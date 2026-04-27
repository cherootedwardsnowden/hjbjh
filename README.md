# StrangerText 💬

Omegle-style anonymous text + media chat. Apple iOS UI theme.

## Features
- 🔐 Register / Login (JWT auth)
- 💬 Real-time anonymous stranger matching (Socket.IO)
- 📎 Media upload (image & video, max 5MB each, max 10 per session)
- 🗑️ Media auto-deleted when chat ends
- ⏭️ Skip button to find new stranger
- ✍️ Typing indicator
- 🏅 Badges & achievements (10 → 10,000 messages)
- 👤 Profile page with avatar, bio, username edit
- 🛡️ Admin panel (IP-restricted to 176.42.131.129)
- 🍎 Apple iOS design system

## Deploy on Railway

1. Create project on railway.app
2. Add MongoDB plugin or use MongoDB Atlas
3. Set env variables:
   - `MONGO_URI` → your MongoDB connection string
   - `JWT_SECRET` → any random secret string
4. Deploy — Railway auto-detects Node.js

## Admin Access
Admin panel is only accessible from IP: `176.42.131.129`

## Local Dev
```bash
npm install
cp .env.example .env
# Edit .env with your MongoDB URI
node server.js
```
