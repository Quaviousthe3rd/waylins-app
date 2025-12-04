<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1wmnBaSfhDdgAcsYzTv-7SUCdsTp_oenE

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`


## Setting Up Local Development

1. **Copy the environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Fill in your Firebase credentials:**
   Edit `.env` and add your Firebase project credentials:
   - `VITE_API_KEY`: Your Firebase API key
   - `VITE_AUTH_DOMAIN`: Your Firebase auth domain
   - `VITE_PROJECT_ID`: Your Firebase project ID
   - `VITE_STORAGE_BUCKET`: Your Firebase storage bucket
   - `VITE_MESSAGING_SENDER_ID`: Your Firebase messaging sender ID
   - `VITE_APP_ID`: Your Firebase app ID

3. **Install dependencies:**
   ```bash
   npm ci
   # or
   npm install
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

## Automated Deployments

Every time you push to the `main` branch, the GitHub Actions workflow automatically:
1. Builds your React application
2. Uses the Firebase credentials from GitHub Secrets
3. Deploys to Firebase Hosting at: https://waylans-barbershop-app.web.app

You can track the deployment progress in the **Actions** tab of your repository.
