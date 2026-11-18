import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import {
  checkUpgradeSchemaStatus,
  ensureSupabaseSeeded,
  getSupabaseAdmin,
  getSupabaseConfigStatus,
} from './server/supabaseAdmin.ts';
import {
  attachAuthUser,
  getOwnerBootstrapSecret,
  normalizeUiLanguage,
  recordAdminAudit,
  requireAdmin,
  requireAuth,
  type AuthRequest,
} from './server/auth.ts';
import {
  disambiguateAirWritingWithAI,
  isGeminiConfigured,
  refineAccessibilityText,
  translateAccessibilityText,
} from './server/geminiAssist.ts';
import {
  attachMeetingWebSocketServer,
  getLiveMeetingAnalyticsSnapshot,
  registerMeetingRoutes,
} from './server/meetings.ts';
import { VERIFIED_LESSONS_SEED, VERIFIED_SIGN_DATASET } from './src/data/signDataset.ts';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

// Trust reverse proxy headers cleanly behind Cloud Run / Render / Railway
app.set('trust proxy', 1);

// Defensive security headers (compatible with preview iframe & camera/mic/screen sharing)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

// Lightweight sliding-window in-memory rate limiter (no external Redis required)
function createRateLimiter(opts: { windowMs: number; max: number; keyPrefix: string; message?: string }) {
  const hits = new Map<string, number[]>();
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - opts.windowMs;
    for (const [k, stamps] of hits.entries()) {
      const kept = stamps.filter((t) => t > cutoff);
      if (kept.length === 0) hits.delete(k);
      else hits.set(k, kept);
    }
  }, Math.max(30_000, opts.windowMs));
  cleanupTimer.unref();

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();
    const cutoff = now - opts.windowMs;
    const recent = (hits.get(key) || []).filter((t) => t > cutoff);
    if (recent.length >= opts.max) {
      const retrySec = Math.max(1, Math.ceil((recent[0] + opts.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({
        error: opts.message || 'Too many requests. Please wait a moment and try again.',
      });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

const apiBaselineLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 300,
  keyPrefix: 'api-base',
});
const contactLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  keyPrefix: 'contact',
  message: 'Too many contact submissions. Please wait before sending another message.',
});
const ownerBootstrapLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  keyPrefix: 'owner-bootstrap',
  message: 'Too many owner verification attempts. Please wait 15 minutes before retrying.',
});
const aiAssistLimiter = createRateLimiter({
  windowMs: 5 * 60_000,
  max: 45,
  keyPrefix: 'ai-assist',
  message: 'AI assistant request limit reached. Please wait a few minutes.',
});

app.use(express.json({ limit: '1mb' }));
app.use('/api', apiBaselineLimiter);
app.use(attachAuthUser);

// Serve MediaPipe Tasks Vision WASM assets locally with clean MIME types
const mediapipeWasmDir = path.resolve('node_modules/@mediapipe/tasks-vision/wasm');
if (fs.existsSync(mediapipeWasmDir)) {
  app.use(
    '/mediapipe/wasm',
    express.static(mediapipeWasmDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
      },
    })
  );
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeMediaUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const val = String(raw ?? '').trim().slice(0, 500);
  if (!val) return { ok: true, url: '' };
  if (val.startsWith('/') && !val.startsWith('//')) return { ok: true, url: val };
  try {
    const parsed = new URL(val);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { ok: true, url: val };
    }
  } catch {
    // invalid URL
  }
  return { ok: false, error: 'Media/video URL must use https://, http://, or a safe root-relative path.' };
}

// =========================================================
// PUBLIC ENDPOINTS
// =========================================================
app.get('/api/health', async (_req, res) => {
  const status = getSupabaseConfigStatus();
  const upgrade = status.supabaseServerConfigured
    ? await checkUpgradeSchemaStatus()
    : { upgradedSchemaReady: false, missingUpgradeItems: ['Supabase not configured'] };
  res.json({
    ok: true,
    service: 'HANDVOX',
    database: 'supabase-postgresql',
    aiAssistConfigured: isGeminiConfigured(),
    ...status,
    ...upgrade,
  });
});

app.get('/api/public/settings', async (_req, res) => {
  const status = getSupabaseConfigStatus();
  const admin = getSupabaseAdmin();

  if (!admin) {
    return res.json({
      settings: {
        platform_name: 'HANDVOX',
        tagline: 'Every Gesture Deserves to Be Understood.',
        default_sign_language: 'ASL',
        public_registration_enabled: 'true',
        confidence_threshold_default: '0.78',
        maintenance_notice: '',
      },
      ownerExists: false,
      ...status,
    });
  }

  try {
    await ensureSupabaseSeeded();
    const { data: settingsRows } = await admin.from('platform_settings').select('key, value');
    const settings: Record<string, string> = {};
    for (const r of settingsRows || []) {
      settings[r.key] = r.value;
    }

    const { count: ownerCount } = await admin
      .from('user_roles')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'owner');

    res.json({
      settings,
      ownerExists: (ownerCount ?? 0) > 0,
      ...status,
    });
  } catch (err) {
    console.error('Error loading Supabase settings:', err);
    res.status(500).json({ error: 'Unable to load platform settings from PostgreSQL.' });
  }
});

app.get('/api/public/vocabulary', async (req, res) => {
  const language = req.query.language === 'ISL' ? 'ISL' : req.query.language === 'ASL' ? 'ASL' : null;
  const category = typeof req.query.category === 'string' && req.query.category !== 'All' ? req.query.category : null;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';

  const admin = getSupabaseAdmin();
  if (!admin) {
    // Graceful pre-configuration dataset preview when Supabase env vars are not yet added
    const items = VERIFIED_SIGN_DATASET.filter((item) => {
      if (language && item.language !== language) return false;
      if (category && item.category !== category) return false;
      if (search) {
        return (
          item.gloss.toLowerCase().includes(search) ||
          item.englishText.toLowerCase().includes(search) ||
          item.category.toLowerCase().includes(search)
        );
      }
      return true;
    }).map((item, idx) => ({
      id: `seed-${item.language}-${idx}`,
      language: item.language,
      gloss: item.gloss,
      englishText: item.englishText,
      category: item.category,
      difficulty: item.difficulty,
      description: item.description,
      handshapeNotes: item.handshapeNotes,
      videoUrl: '',
      twoHanded: item.twoHanded,
      landmarks: item.landmarks,
      secondaryLandmarks: item.secondaryLandmarks ?? null,
      verified: true,
    }));
    return res.json({ items, source: 'static-preview' });
  }

  try {
    await ensureSupabaseSeeded();
    let query = admin
      .from('sign_vocabulary')
      .select('id, language, gloss, english_text, category, difficulty, description, handshape_notes, video_url, landmark_template, verified')
      .eq('verified', true);

    if (language) query = query.eq('language', language);
    if (category) query = query.eq('category', category);

    const { data, error } = await query.order('gloss', { ascending: true });
    if (error) throw error;

    const formatted = (data || [])
      .map((r: any) => ({
        id: r.id,
        language: r.language,
        gloss: r.gloss,
        englishText: r.english_text,
        category: r.category,
        difficulty: r.difficulty,
        description: r.description,
        handshapeNotes: r.handshape_notes,
        videoUrl: r.video_url || '',
        twoHanded: Boolean(r.landmark_template?.twoHanded),
        landmarks: r.landmark_template?.landmarks || null,
        secondaryLandmarks: r.landmark_template?.secondaryLandmarks || null,
        verified: Boolean(r.verified),
      }))
      .sort((a, b) => {
        if (a.category === 'Alphabet' && b.category !== 'Alphabet') return -1;
        if (a.category !== 'Alphabet' && b.category === 'Alphabet') return 1;
        return a.gloss.localeCompare(b.gloss);
      })
      .filter((item) => {
        if (!search) return true;
        return (
          item.gloss.toLowerCase().includes(search) ||
          item.englishText.toLowerCase().includes(search) ||
          item.category.toLowerCase().includes(search)
        );
      });

    res.json({ items: formatted, source: 'supabase-postgresql' });
  } catch (err) {
    console.error('Error fetching vocabulary from Supabase:', err);
    res.status(500).json({ error: 'Unable to load verified sign vocabulary.' });
  }
});

app.get('/api/public/lessons', async (req, res) => {
  const language = req.query.language === 'ISL' ? 'ISL' : req.query.language === 'ASL' ? 'ASL' : null;
  const admin = getSupabaseAdmin();

  if (!admin) {
    const lessons = VERIFIED_LESSONS_SEED.filter((l) => (!language ? true : l.language === language)).map((l) => ({
      id: l.slug,
      language: l.language,
      title: l.title,
      slug: l.slug,
      level: l.level,
      moduleOrder: l.moduleOrder,
      summary: l.summary,
      vocabularyGlosses: l.vocabularyGlosses,
      practicePrompt: l.practicePrompt,
      tutorialVideoUrl: l.tutorialVideoUrl || '',
      verified: true,
    }));
    return res.json({ lessons, source: 'static-preview' });
  }

  try {
    await ensureSupabaseSeeded();
    let query = admin
      .from('learning_lessons')
      .select('id, language, title, slug, level, module_order, summary, vocabulary_glosses, practice_prompt, tutorial_video_url, verified')
      .eq('verified', true);

    if (language) query = query.eq('language', language);
    let { data, error } = await query.order('module_order', { ascending: true });

    // Graceful fallback if 002_handvox_platform_upgrade.sql (tutorial_video_url) is not yet run
    if (error && error.code === '42703') {
      let fallbackQuery = admin
        .from('learning_lessons')
        .select('id, language, title, slug, level, module_order, summary, vocabulary_glosses, practice_prompt, verified')
        .eq('verified', true);
      if (language) fallbackQuery = fallbackQuery.eq('language', language);
      const fbRes = await fallbackQuery.order('module_order', { ascending: true });
      data = fbRes.data as any;
      error = fbRes.error;
    }

    if (error) throw error;

    const lessons = (data || []).map((r: any) => ({
      id: r.id,
      language: r.language,
      title: r.title,
      slug: r.slug,
      level: r.level,
      moduleOrder: r.module_order,
      summary: r.summary,
      vocabularyGlosses: Array.isArray(r.vocabulary_glosses) ? r.vocabulary_glosses : [],
      practicePrompt: r.practice_prompt,
      tutorialVideoUrl: r.tutorial_video_url || '',
      verified: Boolean(r.verified),
    }));

    res.json({ lessons, source: 'supabase-postgresql' });
  } catch (err) {
    console.error('Error fetching lessons from Supabase:', err);
    res.status(500).json({ error: 'Unable to load learning lessons.' });
  }
});

app.post('/api/public/contact', contactLimiter, async (req, res) => {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return res.status(503).json({ error: 'Supabase PostgreSQL is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const organization = String(req.body?.organization || '').trim();
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();

    if (!name || !validateEmail(email) || !subject || message.length < 10) {
      return res.status(400).json({ error: 'Please provide your name, a valid email, a subject, and a message (at least 10 characters).' });
    }

    const { data, error } = await admin
      .from('contact_submissions')
      .insert({
        name: name.slice(0, 120),
        email: email.slice(0, 180),
        organization: organization.slice(0, 140),
        subject: subject.slice(0, 180),
        message: message.slice(0, 3000),
      })
      .select('id')
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, id: data.id, message: 'Thank you. Your inquiry has been saved to HANDVOX.' });
  } catch (err) {
    console.error('Contact submission error:', err);
    res.status(500).json({ error: 'Failed to submit contact form.' });
  }
});

// =========================================================
// AUTHENTICATION PROFILE & OWNER BOOTSTRAP
// =========================================================
app.get('/api/auth/me', (req: AuthRequest, res) => {
  if (!req.authUser) {
    return res.json({ user: null });
  }
  res.json({ user: req.authUser });
});

app.post('/api/auth/owner-bootstrap', ownerBootstrapLimiter, requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const { count: ownerCount } = await admin
      .from('user_roles')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'owner');

    if ((ownerCount ?? 0) > 0) {
      return res.status(403).json({ error: 'An owner account is already configured for this platform.' });
    }

    const expectedEmail = process.env.OWNER_BOOTSTRAP_EMAIL?.trim().toLowerCase();
    if (expectedEmail && req.authUser!.email.toLowerCase() !== expectedEmail) {
      return res.status(403).json({ error: 'Your signed-in email does not match OWNER_BOOTSTRAP_EMAIL.' });
    }

    const submittedSecret = String(req.body?.bootstrapSecret || '').trim();
    const { secret, isEnvConfigured } = getOwnerBootstrapSecret();
    if (!isEnvConfigured) {
      return res.status(503).json({
        error: 'OWNER_BOOTSTRAP_SECRET is not set on the server. Set OWNER_BOOTSTRAP_SECRET in environment variables or promote your role directly in Supabase SQL Editor.',
      });
    }

    const a = Buffer.from(submittedSecret);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'Invalid owner bootstrap secret.' });
    }

    const { error: updateErr } = await admin
      .from('user_roles')
      .upsert({ user_id: req.authUser!.id, role: 'owner', granted_by: req.authUser!.id }, { onConflict: 'user_id' });

    if (updateErr) throw updateErr;

    await recordAdminAudit(
      req.authUser!.id,
      req.authUser!.email,
      'OWNER_BOOTSTRAP_CLAIMED',
      'user_roles',
      req.authUser!.id,
      'Initial platform owner verified via bootstrap secret'
    );

    res.json({ ok: true, role: 'owner' });
  } catch (err) {
    console.error('Owner bootstrap error:', err);
    res.status(500).json({ error: 'Owner verification failed.' });
  }
});

// =========================================================
// USER WORKSPACE ROUTES (Private user-scoped PostgreSQL rows)
// =========================================================
app.get('/api/workspace/overview', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const uid = req.authUser!.id;
  try {
    const [
      { count: totalTranslations },
      { data: recentSessions },
      { data: progress },
      { count: totalLessons },
      savedRes,
      quizRes,
    ] = await Promise.all([
      admin.from('translation_sessions').select('id', { count: 'exact', head: true }).eq('user_id', uid),
      admin
        .from('translation_sessions')
        .select('id, mode, sign_language, input_summary, output_text, confidence_avg, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(12),
      admin
        .from('learning_progress')
        .select('lesson_id, status, mastery_score, attempts, updated_at, learning_lessons(title, language, level, slug)')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false }),
      admin.from('learning_lessons').select('id', { count: 'exact', head: true }).eq('verified', true),
      admin
        .from('saved_vocabulary')
        .select('id, vocabulary_id, language, gloss, english_text, notes, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(60),
      admin
        .from('quiz_results')
        .select('id, language, level, score, total_questions, percentage, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const formattedProgress = (progress || []).map((p: any) => ({
      lesson_id: p.lesson_id,
      status: p.status,
      mastery_score: p.mastery_score,
      attempts: p.attempts,
      updated_at: p.updated_at,
      title: p.learning_lessons?.title || 'Lesson',
      language: p.learning_lessons?.language || 'ASL',
      level: p.learning_lessons?.level || 'Beginner',
      slug: p.learning_lessons?.slug || '',
    }));

    const completedLessons = formattedProgress.filter((p) => p.status === 'completed').length;
    const savedVocabulary = savedRes.error ? [] : savedRes.data || [];
    const quizResults = quizRes.error ? [] : quizRes.data || [];
    const avgQuizPercentage =
      quizResults.length > 0
        ? Math.round(quizResults.reduce((acc: number, q: any) => acc + Number(q.percentage || 0), 0) / quizResults.length)
        : 0;

    res.json({
      stats: {
        totalTranslations: totalTranslations ?? 0,
        completedLessons,
        totalLessons: totalLessons ?? 0,
        savedVocabularyCount: savedVocabulary.length,
        quizCount: quizResults.length,
        avgQuizPercentage,
      },
      recentSessions: recentSessions || [],
      progress: formattedProgress,
      savedVocabulary,
      quizResults,
    });
  } catch (err) {
    console.error('Workspace overview error:', err);
    res.status(500).json({ error: 'Unable to load workspace overview.' });
  }
});

app.patch('/api/workspace/profile', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const uid = req.authUser!.id;
  try {
    const fullName =
      typeof req.body?.fullName === 'string' ? req.body.fullName.trim().slice(0, 120) : req.authUser!.fullName;
    const preferredSignLanguage =
      req.body?.preferredSignLanguage === 'ISL'
        ? 'ISL'
        : req.body?.preferredSignLanguage === 'ASL'
        ? 'ASL'
        : req.authUser!.preferredSignLanguage;
    const preferredUiLanguage =
      typeof req.body?.preferredUiLanguage === 'string'
        ? normalizeUiLanguage(req.body.preferredUiLanguage)
        : req.authUser!.preferredUiLanguage || 'en';
    const consentSaveHistory =
      typeof req.body?.consentSaveHistory === 'boolean'
        ? req.body.consentSaveHistory
        : req.authUser!.consentSaveHistory;

    const incomingPrefs = req.body?.accessibilityPrefs || {};
    const mergedPrefs = {
      highContrast: Boolean(incomingPrefs.highContrast ?? req.authUser!.accessibilityPrefs.highContrast),
      largeText: Boolean(incomingPrefs.largeText ?? req.authUser!.accessibilityPrefs.largeText),
      reducedMotion: Boolean(incomingPrefs.reducedMotion ?? req.authUser!.accessibilityPrefs.reducedMotion),
      captionsAlwaysOn: Boolean(incomingPrefs.captionsAlwaysOn ?? req.authUser!.accessibilityPrefs.captionsAlwaysOn),
      uiLanguage: preferredUiLanguage,
    };

    const updatePayload: Record<string, any> = {
      full_name: fullName,
      preferred_sign_language: preferredSignLanguage,
      preferred_ui_language: preferredUiLanguage,
      accessibility_prefs: mergedPrefs,
      consent_save_history: consentSaveHistory,
      updated_at: new Date().toISOString(),
    };

    let { error } = await admin.from('profiles').update(updatePayload).eq('id', uid);

    // Graceful fallback if migration 003 (preferred_ui_language column) is not yet applied
    if (error && error.code === '42703') {
      delete updatePayload.preferred_ui_language;
      const fb = await admin.from('profiles').update(updatePayload).eq('id', uid);
      error = fb.error;
    }

    if (error) throw error;

    res.json({
      ok: true,
      user: {
        ...req.authUser,
        fullName,
        preferredSignLanguage,
        preferredUiLanguage,
        accessibilityPrefs: mergedPrefs,
        consentSaveHistory,
      },
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Unable to update profile settings.' });
  }
});

app.get('/api/workspace/history', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const { data, error } = await admin
      .from('translation_sessions')
      .select('id, mode, sign_language, input_summary, output_text, confidence_avg, created_at')
      .eq('user_id', req.authUser!.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) {
    console.error('History fetch error:', err);
    res.status(500).json({ error: 'Unable to fetch translation history.' });
  }
});

const ALLOWED_COMMUNICATION_MODES = new Set([
  'sign_to_text',
  'speech_to_text',
  'text_to_sign',
  'text_to_speech',
  'face_speech',
  'air_writing',
  'two_way',
  'accessibility_assistant',
]);

app.post('/api/workspace/history', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    if (!req.authUser!.consentSaveHistory) {
      return res.status(403).json({ error: 'History saving is disabled in your privacy consent settings.' });
    }
    const mode = String(req.body?.mode || '');
    if (!ALLOWED_COMMUNICATION_MODES.has(mode)) {
      return res.status(400).json({ error: 'Invalid translation mode.' });
    }
    const signLanguage = req.body?.signLanguage === 'ISL' ? 'ISL' : 'ASL';
    const inputSummary = String(req.body?.inputSummary || '').slice(0, 500);
    const outputText = String(req.body?.outputText || '').trim().slice(0, 2000);
    const confidenceAvg = typeof req.body?.confidenceAvg === 'number' ? req.body.confidenceAvg : null;

    if (!outputText) {
      return res.status(400).json({ error: 'Translation output cannot be empty.' });
    }

    const { data, error } = await admin
      .from('translation_sessions')
      .insert({
        user_id: req.authUser!.id,
        mode,
        sign_language: signLanguage,
        input_summary: inputSummary,
        output_text: outputText,
        confidence_avg: confidenceAvg,
        consented: true,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23514') {
        return res.status(409).json({
          error: 'Run supabase/migrations/002_handvox_platform_upgrade.sql to enable saving this mode in PostgreSQL.',
        });
      }
      throw error;
    }
    res.status(201).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Save history error:', err);
    res.status(500).json({ error: 'Unable to save translation session.' });
  }
});

app.delete('/api/workspace/history/:id', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  await admin.from('translation_sessions').delete().eq('id', req.params.id).eq('user_id', req.authUser!.id);
  res.json({ ok: true });
});

app.delete('/api/workspace/history', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  await admin.from('translation_sessions').delete().eq('user_id', req.authUser!.id);
  res.json({ ok: true });
});

// User-scoped Saved Vocabulary Bookmarks
app.get('/api/workspace/saved-vocabulary', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const { data, error } = await admin
    .from('saved_vocabulary')
    .select('id, vocabulary_id, language, gloss, english_text, notes, created_at')
    .eq('user_id', req.authUser!.id)
    .order('created_at', { ascending: false });

  if (error) {
    if (error.code === '42P01') return res.json({ items: [], migrationPending: true });
    return res.status(500).json({ error: 'Unable to fetch saved vocabulary.' });
  }
  res.json({ items: data || [] });
});

app.post('/api/workspace/saved-vocabulary', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const language = req.body?.language === 'ISL' ? 'ISL' : 'ASL';
    const gloss = String(req.body?.gloss || '').trim().toUpperCase().slice(0, 60);
    const englishText = String(req.body?.englishText || '').trim().slice(0, 140);
    const vocabularyId = typeof req.body?.vocabularyId === 'string' && req.body.vocabularyId.length === 36 ? req.body.vocabularyId : null;
    const notes = String(req.body?.notes || '').trim().slice(0, 400);

    if (!gloss || !englishText) {
      return res.status(400).json({ error: 'Gloss and English label are required.' });
    }

    const { data, error } = await admin
      .from('saved_vocabulary')
      .upsert(
        {
          user_id: req.authUser!.id,
          vocabulary_id: vocabularyId,
          language,
          gloss,
          english_text: englishText,
          notes,
        },
        { onConflict: 'user_id,language,gloss' }
      )
      .select('id, language, gloss, english_text, notes, created_at')
      .single();

    if (error) {
      if (error.code === '42P01') {
        return res.status(503).json({ error: 'Run supabase/migrations/002_handvox_platform_upgrade.sql to save vocabulary bookmarks.' });
      }
      throw error;
    }
    res.status(201).json({ ok: true, item: data });
  } catch (err) {
    console.error('Save vocabulary error:', err);
    res.status(500).json({ error: 'Unable to save vocabulary item.' });
  }
});

app.delete('/api/workspace/saved-vocabulary/:id', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  await admin.from('saved_vocabulary').delete().eq('id', req.params.id).eq('user_id', req.authUser!.id);
  res.json({ ok: true });
});

// User-scoped Learning Quiz Results
app.get('/api/workspace/quiz-results', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const { data, error } = await admin
    .from('quiz_results')
    .select('id, language, level, score, total_questions, percentage, details, created_at')
    .eq('user_id', req.authUser!.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    if (error.code === '42P01') return res.json({ results: [], migrationPending: true });
    return res.status(500).json({ error: 'Unable to load quiz results.' });
  }
  res.json({ results: data || [] });
});

app.post('/api/workspace/quiz-results', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const language = req.body?.language === 'ISL' ? 'ISL' : 'ASL';
    const level = ['Beginner', 'Intermediate', 'Advanced', 'Mixed'].includes(req.body?.level)
      ? req.body.level
      : 'Beginner';
    const totalQuestions = Math.max(1, Math.min(50, Number(req.body?.totalQuestions || 1)));
    const score = Math.max(0, Math.min(totalQuestions, Number(req.body?.score || 0)));
    const percentage = Math.round((score / totalQuestions) * 100);
    const details = Array.isArray(req.body?.details) ? req.body.details.slice(0, 30) : [];

    const { data, error } = await admin
      .from('quiz_results')
      .insert({
        user_id: req.authUser!.id,
        language,
        level,
        score,
        total_questions: totalQuestions,
        percentage,
        details,
      })
      .select('id, language, level, score, total_questions, percentage, created_at')
      .single();

    if (error) {
      if (error.code === '42P01') {
        return res.status(503).json({ error: 'Run supabase/migrations/002_handvox_platform_upgrade.sql to store quiz results.' });
      }
      throw error;
    }
    res.status(201).json({ ok: true, result: data });
  } catch (err) {
    console.error('Quiz result save error:', err);
    res.status(500).json({ error: 'Unable to record quiz score.' });
  }
});

app.post('/api/workspace/progress', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const lessonId = String(req.body?.lessonId || '');
    const status = ['not_started', 'in_progress', 'completed'].includes(req.body?.status)
      ? req.body.status
      : 'in_progress';
    const masteryScore = Math.max(0, Math.min(100, Number(req.body?.masteryScore || 0)));

    const { data: lesson } = await admin.from('learning_lessons').select('id').eq('id', lessonId).maybeSingle();
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found.' });
    }

    const { data: existing } = await admin
      .from('learning_progress')
      .select('id, attempts, mastery_score')
      .eq('user_id', req.authUser!.id)
      .eq('lesson_id', lessonId)
      .maybeSingle();

    if (existing) {
      const bestScore = Math.max(existing.mastery_score, masteryScore);
      await admin
        .from('learning_progress')
        .update({
          status,
          mastery_score: bestScore,
          attempts: existing.attempts + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await admin.from('learning_progress').insert({
        user_id: req.authUser!.id,
        lesson_id: lessonId,
        status,
        mastery_score: masteryScore,
        attempts: 1,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Progress update error:', err);
    res.status(500).json({ error: 'Unable to save learning progress.' });
  }
});

app.post('/api/workspace/feedback', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const category = String(req.body?.category || 'General').slice(0, 60);
    const rating = req.body?.rating ? Math.max(1, Math.min(5, Number(req.body.rating))) : null;
    const message = String(req.body?.message || '').trim();
    if (message.length < 5) {
      return res.status(400).json({ error: 'Please include at least 5 characters in your feedback.' });
    }

    const { data, error } = await admin
      .from('user_feedback')
      .insert({
        user_id: req.authUser!.id,
        category,
        rating,
        message: message.slice(0, 2000),
      })
      .select('id')
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: 'Unable to submit feedback.' });
  }
});

app.delete('/api/workspace/account', requireAuth, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    if (req.authUser!.role === 'owner') {
      const { count: otherOwners } = await admin
        .from('user_roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('role', 'owner')
        .neq('user_id', req.authUser!.id);
      if ((otherOwners ?? 0) === 0) {
        return res.status(400).json({ error: 'Transfer ownership to another administrator before deleting the sole owner account.' });
      }
    }

    const { error } = await admin.auth.admin.deleteUser(req.authUser!.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Unable to delete account.' });
  }
});

// =========================================================
// OWNER & ADMIN ROUTES (/api/admin/*)
// =========================================================
app.get('/api/admin/analytics', requireAdmin, async (_req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const [
      { data: profiles },
      { data: sessions },
      { data: progress },
      { count: openFeedback },
      { count: newContacts },
      savedVocabCountRes,
      quizStatsRes,
      upgradeStatus,
      meetingsRowsRes,
      meetingParticipantsCountRes,
    ] = await Promise.all([
      admin.from('profiles').select('id, status, preferred_sign_language, created_at'),
      admin.from('translation_sessions').select('mode'),
      admin.from('learning_progress').select('user_id'),
      admin.from('user_feedback').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      admin.from('contact_submissions').select('id', { count: 'exact', head: true }).eq('status', 'new'),
      admin.from('saved_vocabulary').select('id', { count: 'exact', head: true }),
      admin.from('quiz_results').select('percentage'),
      checkUpgradeSchemaStatus(),
      admin.from('meetings').select('id, status, is_scheduled, scheduled_for'),
      admin.from('meeting_participants').select('id', { count: 'exact', head: true }),
    ]);

    const profileList = profiles || [];
    const totalUsers = profileList.length;
    const activeUsers = profileList.filter((p: any) => p.status === 'active').length;
    const suspendedUsers = profileList.filter((p: any) => p.status === 'suspended').length;
    const activeLearners = new Set((progress || []).map((p: any) => p.user_id)).size;

    const quizRows = quizStatsRes.error ? [] : quizStatsRes.data || [];
    const totalQuizzes = quizRows.length;
    const avgQuizPercentage =
      totalQuizzes > 0
        ? Math.round(quizRows.reduce((acc: number, q: any) => acc + Number(q.percentage || 0), 0) / totalQuizzes)
        : 0;

    const liveSnapshot = getLiveMeetingAnalyticsSnapshot();
    const dbMeetings = !meetingsRowsRes.error && Array.isArray(meetingsRowsRes.data) ? meetingsRowsRes.data : null;
    const meetingAnalytics = dbMeetings
      ? {
          totalMeetings: dbMeetings.length,
          activeMeetings: dbMeetings.filter((m: any) => m.status !== 'ended').length,
          scheduledMeetings: dbMeetings.filter(
            (m: any) => (m.is_scheduled || m.scheduled_for) && m.status !== 'ended'
          ).length,
          endedMeetings: dbMeetings.filter((m: any) => m.status === 'ended').length,
          totalParticipantJoins: meetingParticipantsCountRes.error ? 0 : meetingParticipantsCountRes.count ?? 0,
          liveActiveParticipants: liveSnapshot.liveActiveParticipants,
          storageReady: true,
        }
      : {
          totalMeetings: liveSnapshot.memoryMeetingsCount,
          activeMeetings: liveSnapshot.memoryActiveCount,
          scheduledMeetings: liveSnapshot.memoryScheduledCount,
          endedMeetings: liveSnapshot.memoryEndedCount,
          totalParticipantJoins: 0,
          liveActiveParticipants: liveSnapshot.liveActiveParticipants,
          storageReady: false,
        };

    const dailyMap = new Map<string, number>();
    const monthlyMap = new Map<string, number>();
    const langMap = new Map<string, number>();

    for (const p of profileList as any[]) {
      const day = String(p.created_at).slice(0, 10);
      const month = String(p.created_at).slice(0, 7);
      dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
      monthlyMap.set(month, (monthlyMap.get(month) || 0) + 1);
      langMap.set(p.preferred_sign_language, (langMap.get(p.preferred_sign_language) || 0) + 1);
    }

    const modeMap = new Map<string, number>();
    for (const s of (sessions || []) as any[]) {
      modeMap.set(s.mode, (modeMap.get(s.mode) || 0) + 1);
    }

    res.json({
      summary: {
        totalUsers,
        activeUsers,
        suspendedUsers,
        totalTranslations: (sessions || []).length,
        activeLearners,
        openFeedback: openFeedback ?? 0,
        newContacts: newContacts ?? 0,
        totalSavedVocabulary: savedVocabCountRes.error ? 0 : savedVocabCountRes.count ?? 0,
        totalQuizzes,
        avgQuizPercentage,
      },
      meetingAnalytics,
      upgradedSchemaReady: upgradeStatus.upgradedSchemaReady,
      missingUpgradeItems: upgradeStatus.missingUpgradeItems,
      dailyRegistrations: Array.from(dailyMap.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 14)
        .map(([day, count]) => ({ day, count })),
      monthlyRegistrations: Array.from(monthlyMap.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 12)
        .map(([month, count]) => ({ month, count })),
      featureUsage: Array.from(modeMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([mode, count]) => ({ mode, count })),
      languageSplit: Array.from(langMap.entries()).map(([language, count]) => ({ language, count })),
    });
  } catch (err) {
    console.error('Admin analytics error:', err);
    res.status(500).json({ error: 'Unable to load platform analytics.' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const statusFilter = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : null;
    const roleFilter = typeof req.query.role === 'string' && req.query.role !== 'all' ? req.query.role : null;

    const [{ data: profiles }, { data: roles }] = await Promise.all([
      admin.from('profiles').select('id, email, full_name, preferred_sign_language, status, created_at').order('created_at', { ascending: false }),
      admin.from('user_roles').select('user_id, role'),
    ]);

    const roleMap = new Map<string, string>();
    for (const r of roles || []) {
      roleMap.set(r.user_id, r.role);
    }

    const users = (profiles || [])
      .map((u: any) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        preferredSignLanguage: u.preferred_sign_language,
        status: u.status,
        role: roleMap.get(u.id) || 'user',
        createdAt: u.created_at,
      }))
      .filter((u) => {
        if (statusFilter && u.status !== statusFilter) return false;
        if (roleFilter && u.role !== roleFilter) return false;
        if (search) {
          return u.email.toLowerCase().includes(search) || (u.fullName || '').toLowerCase().includes(search);
        }
        return true;
      });

    res.json({ users });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Unable to fetch user directory.' });
  }
});

app.patch('/api/admin/users/:id/status', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const targetId = req.params.id;
    const nextStatus = req.body?.status === 'suspended' ? 'suspended' : 'active';
    if (targetId === req.authUser!.id) {
      return res.status(400).json({ error: 'You cannot suspend or alter your own active administrator account.' });
    }

    const { data: targetRoleRow } = await admin.from('user_roles').select('role').eq('user_id', targetId).maybeSingle();
    if (!targetRoleRow) return res.status(404).json({ error: 'User not found.' });
    if (targetRoleRow.role === 'owner' && req.authUser!.role !== 'owner') {
      return res.status(403).json({ error: 'Only an owner can modify another owner account.' });
    }

    await admin.from('profiles').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', targetId);
    await recordAdminAudit(
      req.authUser!.id,
      req.authUser!.email,
      `USER_${nextStatus.toUpperCase()}`,
      'profiles',
      targetId,
      `Status changed to ${nextStatus}`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

app.patch('/api/admin/users/:id/role', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const targetId = req.params.id;
    const nextRole = req.body?.role;
    if (!['user', 'moderator', 'admin', 'owner'].includes(nextRole)) {
      return res.status(400).json({ error: 'Invalid role specified.' });
    }
    if (targetId === req.authUser!.id) {
      return res.status(400).json({ error: 'You cannot modify your own role.' });
    }

    const { data: currentRoleRow } = await admin.from('user_roles').select('role').eq('user_id', targetId).maybeSingle();
    if (!currentRoleRow) return res.status(404).json({ error: 'User not found.' });

    if ((nextRole === 'owner' || nextRole === 'admin' || currentRoleRow.role === 'owner') && req.authUser!.role !== 'owner') {
      return res.status(403).json({ error: 'Only the platform owner may assign administrator or owner roles.' });
    }

    await admin.from('user_roles').update({ role: nextRole, granted_by: req.authUser!.id }).eq('user_id', targetId);
    await recordAdminAudit(
      req.authUser!.id,
      req.authUser!.email,
      'ROLE_UPDATED',
      'user_roles',
      targetId,
      `Role updated from ${currentRoleRow.role} to ${nextRole}`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Role update error:', err);
    res.status(500).json({ error: 'Failed to update role.' });
  }
});

app.get('/api/admin/vocabulary', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin.from('sign_vocabulary').select('*').order('language').order('gloss');
  res.json({ items: data || [] });
});

app.post('/api/admin/vocabulary', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const language = req.body?.language === 'ISL' ? 'ISL' : 'ASL';
    const gloss = String(req.body?.gloss || '').trim().toUpperCase();
    const englishText = String(req.body?.englishText || '').trim();
    const category = String(req.body?.category || 'General').trim();
    const difficulty = ['Beginner', 'Intermediate', 'Advanced'].includes(req.body?.difficulty) ? req.body.difficulty : 'Beginner';
    const description = String(req.body?.description || '').trim();
    const handshapeNotes = String(req.body?.handshapeNotes || '').trim();
    const videoUrlCheck = sanitizeMediaUrl(req.body?.videoUrl);
    if (!videoUrlCheck.ok) {
      return res.status(400).json({ error: videoUrlCheck.error });
    }
    const videoUrl = videoUrlCheck.url;
    const verified = req.body?.verified === false ? false : true;

    if (!gloss || !englishText || !description) {
      return res.status(400).json({ error: 'Language, gloss, English text, and description are required.' });
    }

    const { data, error } = await admin
      .from('sign_vocabulary')
      .insert({
        language,
        gloss,
        english_text: englishText,
        category,
        difficulty,
        description,
        handshape_notes: handshapeNotes,
        video_url: videoUrl,
        verified,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A sign entry with that gloss already exists in this language.' });
      }
      throw error;
    }

    await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'VOCAB_CREATED', 'sign_vocabulary', data.id, `${language}:${gloss}`);
    res.status(201).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Create vocab error:', err);
    res.status(500).json({ error: 'Unable to create sign vocabulary entry.' });
  }
});

app.patch('/api/admin/vocabulary/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const patch: Record<string, any> = {};
    if (typeof req.body?.videoUrl === 'string') {
      const check = sanitizeMediaUrl(req.body.videoUrl);
      if (!check.ok) return res.status(400).json({ error: check.error });
      patch.video_url = check.url;
    }
    if (typeof req.body?.description === 'string' && req.body.description.trim()) {
      patch.description = req.body.description.trim();
    }
    if (['Beginner', 'Intermediate', 'Advanced'].includes(req.body?.difficulty)) {
      patch.difficulty = req.body.difficulty;
    }
    if (typeof req.body?.verified === 'boolean') patch.verified = req.body.verified;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid update fields supplied.' });
    }
    const { error } = await admin.from('sign_vocabulary').update(patch).eq('id', req.params.id);
    if (error) throw error;
    await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'VOCAB_UPDATED', 'sign_vocabulary', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update vocab error:', err);
    res.status(500).json({ error: 'Unable to update sign vocabulary.' });
  }
});

app.delete('/api/admin/vocabulary/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  await admin.from('sign_vocabulary').delete().eq('id', req.params.id);
  await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'VOCAB_DELETED', 'sign_vocabulary', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/lessons', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin.from('learning_lessons').select('*').order('language').order('module_order');
  res.json({ lessons: data || [] });
});

app.post('/api/admin/lessons', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const language = req.body?.language === 'ISL' ? 'ISL' : 'ASL';
    const title = String(req.body?.title || '').trim();
    const level = ['Beginner', 'Intermediate', 'Advanced'].includes(req.body?.level)
      ? req.body.level
      : 'Beginner';
    const moduleOrder = Number(req.body?.moduleOrder || 1);
    const summary = String(req.body?.summary || '').trim();
    const practicePrompt = String(req.body?.practicePrompt || '').trim();
    const tutorialVideoCheck = sanitizeMediaUrl(req.body?.tutorialVideoUrl);
    if (!tutorialVideoCheck.ok) {
      return res.status(400).json({ error: tutorialVideoCheck.error });
    }
    const tutorialVideoUrl = tutorialVideoCheck.url;
    const glosses = Array.isArray(req.body?.vocabularyGlosses)
      ? req.body.vocabularyGlosses.map((g: any) => String(g).trim().toUpperCase()).filter(Boolean)
      : String(req.body?.vocabularyGlosses || '')
          .split(',')
          .map((g) => g.trim().toUpperCase())
          .filter(Boolean);

    if (!title || !summary) {
      return res.status(400).json({ error: 'Lesson title and summary are required.' });
    }
    const slug = `${language.toLowerCase()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;

    const insertPayload: Record<string, any> = {
      language,
      title,
      slug,
      level,
      module_order: moduleOrder,
      summary,
      vocabulary_glosses: glosses,
      practice_prompt: practicePrompt,
      verified: true,
    };
    if (tutorialVideoUrl) insertPayload.tutorial_video_url = tutorialVideoUrl;

    let { data, error } = await admin.from('learning_lessons').insert(insertPayload).select('id').single();

    if (error && error.code === '42703') {
      delete insertPayload.tutorial_video_url;
      const fb = await admin.from('learning_lessons').insert(insertPayload).select('id').single();
      data = fb.data;
      error = fb.error;
    }

    if (error) throw error;
    await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'LESSON_CREATED', 'learning_lessons', data!.id, title);
    res.status(201).json({ ok: true, id: data!.id });
  } catch (err) {
    console.error('Create lesson error:', err);
    res.status(500).json({ error: 'Unable to create learning lesson.' });
  }
});

app.patch('/api/admin/lessons/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const patch: Record<string, any> = {};
    if (typeof req.body?.tutorialVideoUrl === 'string') {
      const check = sanitizeMediaUrl(req.body.tutorialVideoUrl);
      if (!check.ok) return res.status(400).json({ error: check.error });
      patch.tutorial_video_url = check.url;
    }
    if (['Beginner', 'Intermediate', 'Advanced'].includes(req.body?.level)) {
      patch.level = req.body.level;
    }
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      patch.title = req.body.title.trim().slice(0, 180);
    }
    if (typeof req.body?.summary === 'string' && req.body.summary.trim()) {
      patch.summary = req.body.summary.trim().slice(0, 1000);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid update fields supplied.' });
    }
    const { error } = await admin.from('learning_lessons').update(patch).eq('id', req.params.id);
    if (error) throw error;
    await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'LESSON_UPDATED', 'learning_lessons', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update lesson error:', err);
    res.status(500).json({ error: 'Unable to update lesson.' });
  }
});

app.delete('/api/admin/lessons/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  await admin.from('learning_lessons').delete().eq('id', req.params.id);
  await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'LESSON_DELETED', 'learning_lessons', req.params.id);
  res.json({ ok: true });
});

// =========================================================
// OPTIONAL SERVER-SIDE GEMINI ACCESSIBILITY ASSIST ROUTES
// =========================================================
app.get('/api/ai/status', (_req, res) => {
  res.json({
    configured: isGeminiConfigured(),
    model: isGeminiConfigured() ? 'gemini-4-hydrogen' : null,
  });
});

app.post('/api/ai/refine-transcript', aiAssistLimiter, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const task = ['simplify', 'punctuate', 'hinglish_to_devanagari', 'key_points'].includes(req.body?.task)
    ? req.body.task
    : 'simplify';

  if (!text) {
    return res.status(400).json({ error: 'Text cannot be empty.' });
  }

  const result = await refineAccessibilityText({ text, task });
  if (!result.ok) {
    return res.status(result.configured ? 500 : 503).json({ error: result.error, configured: result.configured });
  }
  res.json(result);
});

app.post('/api/ai/translate-caption', aiAssistLimiter, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const targetLanguageName = String(req.body?.targetLanguageName || 'English').trim().slice(0, 60);
  const targetCode = normalizeUiLanguage(req.body?.targetCode);

  if (!text) {
    return res.status(400).json({ error: 'Text cannot be empty.' });
  }

  const result = await translateAccessibilityText({ text, targetLanguageName, targetCode });
  if (!result.ok) {
    return res.status(result.configured ? 500 : 503).json({ error: result.error, configured: result.configured });
  }
  res.json(result);
});

// Register Live Video Meeting REST routes
registerMeetingRoutes(app);

app.post('/api/ai/airwriting-assist', aiAssistLimiter, async (req, res) => {
  const sampledStrokes = Array.isArray(req.body?.sampledStrokes) ? req.body.sampledStrokes : [];
  const topGeometricMatches = Array.isArray(req.body?.topGeometricMatches) ? req.body.topGeometricMatches : [];
  const includeNumbers = Boolean(req.body?.includeNumbers);

  if (sampledStrokes.length === 0) {
    return res.status(400).json({ error: 'Stroke coordinates are required.' });
  }

  const result = await disambiguateAirWritingWithAI({
    sampledStrokes,
    includeNumbers,
    topGeometricMatches,
  });
  if (!result.ok) {
    return res.status(result.configured ? 500 : 503).json({ error: result.error, configured: result.configured });
  }
  res.json(result);
});

app.get('/api/admin/feedback', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin
    .from('user_feedback')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false });
  const feedback = (data || []).map((f: any) => ({
    ...f,
    user_email: f.profiles?.email || null,
    user_name: f.profiles?.full_name || null,
  }));
  res.json({ feedback });
});

app.patch('/api/admin/feedback/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const status = ['open', 'reviewed', 'resolved'].includes(req.body?.status) ? req.body.status : 'reviewed';
  await admin.from('user_feedback').update({ status }).eq('id', req.params.id);
  await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'FEEDBACK_STATUS_UPDATED', 'user_feedback', req.params.id, status);
  res.json({ ok: true });
});

app.get('/api/admin/contacts', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin.from('contact_submissions').select('*').order('created_at', { ascending: false });
  res.json({ contacts: data || [] });
});

app.patch('/api/admin/contacts/:id', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const status = ['new', 'replied', 'archived'].includes(req.body?.status) ? req.body.status : 'replied';
  await admin.from('contact_submissions').update({ status }).eq('id', req.params.id);
  await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'CONTACT_STATUS_UPDATED', 'contact_submissions', req.params.id, status);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin.from('platform_settings').select('key, value, updated_at').order('key');
  res.json({ settings: data || [] });
});

app.patch('/api/admin/settings', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  try {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Invalid settings payload.' });
    }
    const allowedKeys = new Set([
      'platform_name',
      'tagline',
      'default_sign_language',
      'public_registration_enabled',
      'confidence_threshold_default',
      'maintenance_notice',
    ]);

    const rowsToUpsert = Object.entries(updates)
      .filter(([k]) => allowedKeys.has(k))
      .map(([key, value]) => ({
        key,
        value: String(value ?? ''),
        updated_by: req.authUser!.id,
        updated_at: new Date().toISOString(),
      }));

    if (rowsToUpsert.length > 0) {
      await admin.from('platform_settings').upsert(rowsToUpsert, { onConflict: 'key' });
    }

    await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'SETTINGS_UPDATED', 'platform_settings', 'global', Object.keys(updates).join(', '));
    res.json({ ok: true });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

app.get('/api/admin/audit-logs', requireAdmin, async (_req, res) => {
  const admin = getSupabaseAdmin()!;
  const { data } = await admin.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
  res.json({ logs: data || [] });
});

app.get('/api/admin/export', requireAdmin, async (req: AuthRequest, res) => {
  const admin = getSupabaseAdmin()!;
  const [{ data: vocabulary }, { data: lessons }, { data: settings }] = await Promise.all([
    admin.from('sign_vocabulary').select('id, language, gloss, english_text, category, difficulty, description, handshape_notes, video_url, verified'),
    admin.from('learning_lessons').select('*'),
    admin.from('platform_settings').select('key, value'),
  ]);
  await recordAdminAudit(req.authUser!.id, req.authUser!.email, 'DATASET_EXPORTED', 'platform', 'json_backup');
  res.json({
    exportedAt: new Date().toISOString(),
    vocabulary: vocabulary || [],
    lessons: lessons || [],
    settings: settings || [],
  });
});

// =========================================================
// VITE DEV MIDDLEWARE / PRODUCTION STATIC SPA
// =========================================================
async function startServer() {
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    const distIndex = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      if (!fs.existsSync(distIndex)) {
        return res.status(503).send('HANDVOX build output not found. Run npm run build first.');
      }
      res.sendFile(distIndex);
    });
  }

  const server = http.createServer(app);
  attachMeetingWebSocketServer(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HANDVOX server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start HANDVOX server:', err);
  process.exit(1);
});
