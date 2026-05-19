# Ngoliba InfoTrack

[![Deployed on Render](https://img.shields.io/badge/Deployed%20on-Render-blue)](https://render.com)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15.x-blue)](https://postgresql.org)

**Real-time ward opinion polling system for Ngoliba Ward, Kiambu County, Kenya**

## Features

- 🔐 **Secure Authentication** - Phone number + password with session management
- 🗳️ **Real-time Voting** - 5-minute cycles with leaderboard
- 💰 **M-Pesa Integration** - Pay KES 10 per vote (Daraja API ready)
- 📊 **Live Analytics** - Heatmaps, turnout tracking, AI predictions
- 💬 **Community Forum** - Residents discuss ward issues
- 🏆 **Gamification** - Civic scores, badges, participation streaks
- 📱 **PWA Ready** - Installable on mobile devices
- 📢 **Noticeboard** - Business ads, events, public notices

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Frontend**: HTML5, CSS3, Vanilla JS
- **Payments**: M-Pesa Daraja API (Sandbox/Production)
- **SMS**: Africa's Talking
- **Hosting**: Render.com

## Deployment on Render

### Prerequisites

1. **GitHub Repository** - Push this code to GitHub
2. **Render Account** - [render.com](https://render.com)
3. **PostgreSQL Database** - Create via Render dashboard
4. **Environment Variables** - Set in Render dashboard

### Step-by-Step Deployment

#### 1. Create PostgreSQL Database on Render

```bash
# In Render Dashboard:
# New → PostgreSQL → Name: ngoliba-db → Create
# Copy the "Internal Connection String" (starts with postgresql://)