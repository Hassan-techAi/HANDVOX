# HANDVOX

**Every Gesture Deserves to Be Understood.**

HANDVOX is an accessibility-focused communication project designed to help Deaf, hard-of-hearing, and hearing people communicate through a collection of voice, text, sign-learning, and video-conversation tools.

**Created & Powered by Mohammed Hassan**

## Project overview

HANDVOX brings several communication and learning experiences into one web application. The project is built with React, TypeScript, Vite, Express, Supabase, browser media APIs, MediaPipe, and optional LiveKit services.

## Current feature areas

- Voice and text communication tools
- Two-way conversation interface
- Sign-recognition and air-writing experiments
- Face and speech-related accessibility tools
- Sign-learning academy and vocabulary
- Video meeting experience
- Account, profile, and administration interfaces
- Multilingual interface support, including right-to-left layouts where configured

Feature availability depends on browser permissions, configured services, database migrations, and the language/sign dataset. Sign recognition and lip-related features are assistive/experimental and should not be treated as a certified or complete sign-language translation system.

## Technology stack

- React + TypeScript
- Vite
- Express + Node.js
- Supabase Auth and PostgreSQL
- MediaPipe Tasks Vision
- WebRTC / WebSocket meeting transport, with optional LiveKit SFU
- Google GenAI integration (optional, server-side)

## Run locally

### Requirements

- Node.js (a current LTS release is recommended)
- npm
- A Supabase project for authentication and database-backed features

### Setup

1. Clone this repository.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the values required for the features you want to run. Never commit `.env` or paste secret values into source files.
4. Configure the Supabase database using the SQL migrations in `supabase/migrations/`. Review the migration files and back up your database before applying schema changes.
5. Start the development server:

   ```bash
   npm run dev
   ```

6. Create a production build:

   ```bash
   npm run build
   ```

The application server uses port `3000` by default; hosting platforms may provide `PORT` automatically.

## Environment variables

See [`.env.example`](.env.example) for the variable names and descriptions. Important security notes:

- `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `LIVEKIT_API_SECRET`, `OWNER_BOOTSTRAP_SECRET`, and `MEETING_TOKEN_SECRET` are server-side secrets. Do not prefix them with `VITE_` or expose them in browser code.
- Only publishable/anonymous Supabase client credentials belong in frontend-exposed `VITE_` variables.
- Configure production secrets through your hosting provider's secret/environment settings, not through committed files.

## Database

SQL migrations are stored in `supabase/migrations/`. Apply them deliberately in the intended order after reviewing them and backing up the database. A migration file being present in this repository does not mean it has already been applied to a live database.

## Verification status and limitations

This repository is provided as a development/portfolio project. Build, browser permissions, microphone/camera access, sign recognition quality, external meeting links, and multi-device meeting behavior should be tested in the target deployment environment. Synthetic/unit checks are not a substitute for real-world accessibility testing with users.

The project does not claim complete continuous sign-language translation or reliable word-level silent lip-reading. Some integrations require environment variables and database schema updates before they are available.

## Privacy and security

- Do not commit `.env` files, API keys, passwords, tokens, private keys, database dumps, or personal user data.
- Use least-privilege credentials and server-side secrets.
- Obtain consent before recording, saving, or sharing communication data.
- Review authentication, authorization, Row Level Security policies, and deployment settings before public production use.

## License

No open-source license has been added yet. Unless a license is added, the default copyright rules apply; public visibility on GitHub does not automatically grant permission to reuse the code.
