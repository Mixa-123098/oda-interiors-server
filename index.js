const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");
require('dotenv').config();
const { translateProject, translateUiContent } = require("./translate");
const app = express();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000,
};
// Shared by create_post, the POST /languages backfill, and the retranslate
// retry endpoint — all three write the same per-language project_translations
// rows once translateProject() has returned successfully.
const UPSERT_PROJECT_TRANSLATION_QUERY = `
  INSERT INTO project_translations
    (project_id, lang, name, city, country, brief, end_date, team, drawing_description)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (project_id, lang) DO UPDATE SET
    name = EXCLUDED.name, city = EXCLUDED.city, country = EXCLUDED.country,
    brief = EXCLUDED.brief, end_date = EXCLUDED.end_date, team = EXCLUDED.team,
    drawing_description = EXCLUDED.drawing_description`;

async function saveProjectTranslations(client, projectId, targetLangs, translations) {
  for (const { code: lang } of targetLangs) {
    const t = translations[lang];
    await client.query(UPSERT_PROJECT_TRANSLATION_QUERY, [
      projectId,
      lang,
      t.name,
      t.city,
      t.country,
      t.brief,
      t.end_date,
      t.team,
      t.drawing_description,
    ]);
  }
}

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true",
});

function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ error: "invalid_token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

// Content-editing routes (create/edit projects, images) are open to
// moderators too. User management and site-language management stay
// requireAdmin-only, and deleting a whole project stays admin-only even
// though the rest of project editing is shared with moderators.
function requireStaff(req, res, next) {
  if (req.user?.role !== "admin" && req.user?.role !== "moderator") {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

// For public endpoints that behave differently for staff (e.g. hidden
// projects): populates req.user from the cookie when present and valid,
// but — unlike authenticateToken — never rejects the request when it's
// missing or bad. Anonymous visitors just see req.user stay undefined.
function optionalAuth(req, res, next) {
  const token = req.cookies.token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      // ignore - treat as anonymous
    }
  }
  next();
}

function isStaffUser(req) {
  return req.user?.role === "admin" || req.user?.role === "moderator";
}

// Sends a Telegram message when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set,
// otherwise a silent no-op — so the contact form works (storing to the DB)
// with or without Telegram configured. Never throws: a notification failure
// must not fail the request that a lead depends on.
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
  }
}


app.get("/health", (req, res) => {
  res.status(200).send("OK");
});


app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(cookieParser());

app.get("/projects", optionalAuth, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      isStaffUser(req)
        ? "SELECT * FROM projects ORDER BY display_order NULLS LAST, id"
        : "SELECT * FROM projects WHERE is_hidden = false ORDER BY display_order NULLS LAST, id"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// Dynamic sitemap: the static pages plus one URL per published (non-hidden)
// project, so search engines can discover every project page. Served at the
// site root via an nginx proxy (see nginx.conf).
app.get("/sitemap.xml", async (req, res) => {
  const base = (process.env.CLIENT_URL || "https://oda-interiors.com").replace(
    /\/$/,
    ""
  );
  try {
    const client = await pool.connect();
    const { rows } = await client.query(
      "SELECT id FROM projects WHERE is_hidden = false ORDER BY id"
    );
    client.release();

    const staticUrls = [
      { loc: `${base}/`, priority: "1.0" },
      { loc: `${base}/projects`, priority: "0.9" },
      { loc: `${base}/about`, priority: "0.7" },
      { loc: `${base}/price`, priority: "0.7" },
      { loc: `${base}/contacts`, priority: "0.7" },
    ];
    const projectUrls = rows.map((r) => ({
      loc: `${base}/projects/${r.id}`,
      priority: "0.8",
    }));

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      [...staticUrls, ...projectUrls]
        .map(
          (u) =>
            `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`
        )
        .join("\n") +
      "\n</urlset>\n";

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    console.error("Error generating sitemap:", error);
    res.status(500).send("");
  }
});

// Draft projects (is_hidden) — an admin/moderator not ready to publish yet
// — must be completely invisible to the public: not just absent from the
// listing but unreachable by direct link too. That means every endpoint a
// public project page reads from (blueprints, gallery images, translations)
// has to hide rows belonging to a hidden project for anonymous requests,
// while staff (who need to preview a draft as it will actually look once
// published) still see everything.

app.delete("/delete_project/:id", authenticateToken, requireAdmin, async (req, res) => {
  const projectId = req.params.id;

  try {
    const client = await pool.connect();
    const result = await client.query("DELETE FROM projects WHERE id = $1", [
      projectId,
    ]);
    client.release();

    if (result.rowCount === 1) {
      res.json({ message: "project_deleted" });
    } else {
      res.status(404).json({ error: "project_not_found" });
    }
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// Moderators can't delete a project, but they can pull it out of public
// view (e.g. a draft that isn't ready) — same requireStaff as the rest of
// project editing.
app.put(
  "/projects/:id/visibility",
  authenticateToken,
  requireStaff,
  async (req, res) => {
    const { is_hidden } = req.body;
    if (typeof is_hidden !== "boolean") {
      return res.status(400).json({ error: "invalid_body" });
    }
    try {
      const client = await pool.connect();
      const result = await client.query(
        "UPDATE projects SET is_hidden = $1 WHERE id = $2",
        [is_hidden, req.params.id]
      );
      client.release();
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "project_not_found" });
      }
      res.json({ success: true, is_hidden });
    } catch (error) {
      console.error("Error updating project visibility:", error);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

app.get("/blueprints", optionalAuth, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      isStaffUser(req)
        ? "SELECT * FROM projects_blueprints ORDER BY project_id"
        : `SELECT pb.* FROM projects_blueprints pb
           JOIN projects p ON p.id = pb.project_id
           WHERE p.is_hidden = false ORDER BY pb.project_id`
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/project_imges", optionalAuth, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      isStaffUser(req)
        ? "SELECT * FROM projects_imges ORDER BY project_id"
        : `SELECT pi.* FROM projects_imges pi
           JOIN projects p ON p.id = pi.project_id
           WHERE p.is_hidden = false ORDER BY pi.project_id`
    );

    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.delete("/project_imges/:id", authenticateToken, requireStaff, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "DELETE FROM projects_imges WHERE id = $1",
      [req.params.id]
    );
    client.release();
    if (result.rowCount === 1) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "not_found" });
    }
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/project_translations", optionalAuth, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      isStaffUser(req)
        ? "SELECT * FROM project_translations ORDER BY project_id"
        : `SELECT pt.* FROM project_translations pt
           JOIN projects p ON p.id = pt.project_id
           WHERE p.is_hidden = false ORDER BY pt.project_id`
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/languages", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT code, name FROM languages ORDER BY code"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/languages/:code/translations", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT ui_translations FROM languages WHERE code = $1",
      [req.params.code]
    );
    client.release();
    if (result.rows.length === 0 || !result.rows[0].ui_translations) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json(result.rows[0].ui_translations);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// Lets an admin fix a UI string (typo, awkward AI phrasing, etc.) for any
// language — built-in or added — without touching code or a full re-translate.
app.put(
  "/languages/:code/translations",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { translations } = req.body;
    if (!translations || typeof translations !== "object") {
      return res.status(400).json({ error: "invalid_body" });
    }
    try {
      const client = await pool.connect();
      const result = await client.query(
        "UPDATE languages SET ui_translations = $1 WHERE code = $2",
        [translations, req.params.code]
      );
      client.release();
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not_found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving translations:", error);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

app.post("/languages", authenticateToken, requireAdmin, async (req, res) => {
  const { code, name, sourceContent } = req.body;

  if (!code || !/^[a-z]{2,3}$/.test(code)) {
    return res.status(400).json({ error: "invalid_code" });
  }
  if (!name || !sourceContent) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT code FROM languages WHERE code = $1",
      [code]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "language_exists" });
    }

    const uiTranslations = await translateUiContent(sourceContent, name);
    if (!uiTranslations) {
      return res.status(500).json({ error: "translation_failed" });
    }

    await client.query(
      "INSERT INTO languages (code, name, is_builtin, ui_translations) VALUES ($1, $2, false, $3)",
      [code, name, uiTranslations]
    );

    // Backfill: translate all existing projects into the new language too.
    // Failures here are tracked and returned (rather than only console-logged)
    // so the admin panel can tell the admin which projects still need a
    // manual retry instead of silently leaving them untranslated.
    const { rows: projects } = await client.query("SELECT * FROM projects");
    const failedProjectIds = [];

    const BATCH_SIZE = 4;
    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      const batch = projects.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (project) => {
          const { rows: blueprintRows } = await client.query(
            "SELECT description FROM projects_blueprints WHERE project_id = $1",
            [project.id]
          );
          const translationInput = {
            name: project.project_name,
            city: project.project_city,
            country: project.project_country,
            brief: project.project_brief,
            end_date: project.project_finish_date,
            team: project.project_team,
            drawing_description: blueprintRows[0]?.description || "",
          };
          const translated = await translateProject(translationInput, [{ code, name }]);
          return { project, translated };
        })
      );

      for (const { project, translated } of batchResults) {
        if (translated && translated[code]) {
          await saveProjectTranslations(client, project.id, [{ code, name }], translated);
        } else {
          failedProjectIds.push(project.id);
        }
      }
    }

    res.json({
      success: true,
      code,
      name,
      projects_translated: projects.length - failedProjectIds.length,
      projects_total: projects.length,
      failed_project_ids: failedProjectIds,
    });
  } catch (error) {
    console.error("Error adding language:", error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

// Lets an admin fix a typo'd code or display name after the language was
// already created (and possibly already has projects/translations using
// it). Renaming the code has to cascade to every other table that stores it
// by value - there's no FK enforcing this, so it's done in a transaction
// here instead.
app.put("/languages/:code", authenticateToken, requireAdmin, async (req, res) => {
  const oldCode = req.params.code;
  const newCode = (req.body.code || "").trim().toLowerCase();
  const newName = (req.body.name || "").trim();

  if (!/^[a-z]{2,3}$/.test(newCode)) {
    return res.status(400).json({ error: "invalid_code" });
  }
  if (!newName) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT code FROM languages WHERE code = $1",
      [oldCode]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    if (newCode !== oldCode) {
      const conflict = await client.query(
        "SELECT code FROM languages WHERE code = $1",
        [newCode]
      );
      if (conflict.rows.length > 0) {
        return res.status(409).json({ error: "language_exists" });
      }
    }

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE languages SET code = $1, name = $2 WHERE code = $3",
        [newCode, newName, oldCode]
      );
      if (newCode !== oldCode) {
        await client.query(
          "UPDATE project_translations SET lang = $1 WHERE lang = $2",
          [newCode, oldCode]
        );
        await client.query(
          "UPDATE projects SET source_lang = $1 WHERE source_lang = $2",
          [newCode, oldCode]
        );
      }
      await client.query("COMMIT");
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    }

    res.json({ success: true, code: newCode, name: newName });
  } catch (error) {
    console.error("Error updating language:", error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

// All languages are equal now — no built-in/added distinction, any language
// (including ua/en/sk) can be deleted. The one guard that remains: never let
// the last language go, or the site is left with no UI text at all — same
// idea as the last-admin protection on user deletion.
app.delete("/languages/:code", authenticateToken, requireAdmin, async (req, res) => {
  const { code } = req.params;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT code FROM languages WHERE code = $1",
      [code]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    const { rows: countRows } = await client.query(
      "SELECT COUNT(*) FROM languages"
    );
    if (Number(countRows[0].count) <= 1) {
      return res.status(400).json({ error: "cannot_delete_last_language" });
    }

    await client.query("DELETE FROM project_translations WHERE lang = $1", [code]);
    await client.query("DELETE FROM languages WHERE code = $1", [code]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting language:", error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

app.get("/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT id, username, email, role, status FROM users ORDER BY id"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// Account creation is admin-only: this site only needs a handful of staff
// accounts, so open self-registration was closed off (was previously public,
// unauthenticated) and replaced with an "add user" action in the admin panel.
app.post("/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const client = await pool.connect();

    const existing = await client.query(
      "SELECT username, email FROM users WHERE username = $1 OR email = $2",
      [username, email]
    );
    if (existing.rows.some((row) => row.username === username)) {
      client.release();
      return res.status(409).json({ error: "username_taken" });
    }
    if (existing.rows.some((row) => row.email === email)) {
      client.release();
      return res.status(409).json({ error: "email_taken" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const query =
      "INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, 'user') RETURNING id, username, email, role";
    const result = await client.query(query, [username, email, hashedPassword]);
    client.release();
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({
      error: "internal_error",
      details: error.message,
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const client = await pool.connect();
    const result = await client.query(
      "SELECT id, username, email, password, role, must_change_password FROM users WHERE username = $1",
      [username]
    );
    client.release();

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: "user_not_found" });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "invalid_password" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1d" }
    );
    res.cookie("token", token, COOKIE_OPTIONS);
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      must_change_password: !!user.must_change_password,
    });
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({
      error: "internal_error",
      details: error.message,
    });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("token", COOKIE_OPTIONS);
  res.json({ success: true });
});

app.get("/me", authenticateToken, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT id, username, email, role, must_change_password FROM users WHERE id = $1",
      [req.user.id]
    );
    client.release();

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    res.json({ ...user, must_change_password: !!user.must_change_password });
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.put(
  "/update_user_role/:username",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { username } = req.params;
      const { role } = req.body;

      const client = await pool.connect();

      const query = "UPDATE users SET role = $1 WHERE username = $2 ";

      const result = await client.query(query, [role, username]);

      client.release();

      if (result.rowCount > 0) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "user_not_found" });
      }
    } catch (error) {
      console.error("Error executing query:", error);
      res.status(500).json({
        error: "internal_error",
        details: error.message,
      });
    }
  }
);

// Delete a user account. Two guards: an admin can't delete themselves
// (avoids an accidental self-lockout mid-session) and can't delete the last
// remaining admin account (avoids locking everyone out of the admin panel
// entirely, since only an admin can create/promote other admins).
app.delete(
  "/users/:username",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { username } = req.params;
    if (username === req.user.username) {
      return res.status(400).json({ error: "cannot_delete_self" });
    }
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT role FROM users WHERE username = $1",
        [username]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "user_not_found" });
      }
      if (rows[0].role === "admin") {
        const { rows: adminCount } = await client.query(
          "SELECT COUNT(*) FROM users WHERE role = 'admin'"
        );
        if (Number(adminCount[0].count) <= 1) {
          return res.status(400).json({ error: "cannot_delete_last_admin" });
        }
      }
      await client.query("DELETE FROM users WHERE username = $1", [username]);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "internal_error" });
    } finally {
      client.release();
    }
  }
);

// Lets an admin reset another user's password from the admin panel instead of
// requiring shell access to the server (previously the only option was the
// reset-password.js CLI script run manually on the VPS).
app.put(
  "/admin_reset_password/:username",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { username } = req.params;
      const tempPassword = crypto
        .randomBytes(9)
        .toString("base64")
        .replace(/[+/=]/g, "")
        .slice(0, 12);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      const client = await pool.connect();
      const result = await client.query(
        "UPDATE users SET password = $1, must_change_password = true WHERE username = $2",
        [hashedPassword, username]
      );
      client.release();

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "user_not_found" });
      }
      res.json({ success: true, tempPassword });
    } catch (error) {
      console.error("Error resetting password:", error);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

// Lets any logged-in user (any role) change their own password — the
// counterpart to admin_reset_password above. Requires the current password
// so a hijacked/shared session can't silently take over the account; the
// forced-change screen after an admin reset satisfies this with the temp
// password the admin gave the user.
app.put("/me/password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "missing_fields" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "password_too_short" });
    }

    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT password FROM users WHERE id = $1",
        [req.user.id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "user_not_found" });
      }

      const matches = await bcrypt.compare(currentPassword, rows[0].password);
      if (!matches) {
        return res.status(401).json({ error: "invalid_current_password" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await client.query(
        "UPDATE users SET password = $1, must_change_password = false WHERE id = $2",
        [hashedPassword, req.user.id]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error changing password:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

let projectdir;
app.post("/create_post", authenticateToken, requireStaff, async (req, res) => {
  try {
    const {
      project_name,
      project_city,
      project_country,
      project_specialization,
      project_img_src,
      project_header_img,
      project_brief,
      project_finish_date,
      project_square,
      project_team,
      blueprint_img,
      blueprint_description,
      imges_list,
      source_lang,
    } = req.body;
    if (!source_lang) {
      return res.status(400).json({ error: "source_lang_required" });
    }
    projectdir = project_name;
    const client = await pool.connect();

    const insertProjectQuery = `
      INSERT INTO projects (project_name, project_city, project_country,
        project_specialization, project_img_src, project_header_img, project_brief,
         project_finish_date, project_square, project_team, source_lang)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`;

    const insertBlueprintQuery = `
      INSERT INTO projects_blueprints (img, description, project_id)
      VALUES ($1, $2, $3)`;

    const insertImgesQuery = `
      INSERT INTO projects_imges (img, project_id)
      VALUES ($1, $2)`;

    const values = [
      project_name,
      project_city,
      project_country,
      project_specialization,
      project_img_src,
      project_header_img,
      project_brief,
      project_finish_date,
      project_square,
      project_team,
      blueprint_img,
      blueprint_description,
    ];

    const result = await client.query(insertProjectQuery, [
      ...values.slice(0, 10),
      source_lang,
    ]);
    const projectId = result.rows[0].id;
    req.body.projectId = projectId;

    await client.query(insertBlueprintQuery, [
      blueprint_img,
      blueprint_description,
      projectId,
    ]);

    for (const imge of imges_list) {
      await client.query(insertImgesQuery, [imge, projectId]);
    }

    const translationInput = {
      name: project_name,
      city: project_city,
      country: project_country,
      brief: project_brief,
      end_date: project_finish_date,
      team: project_team,
      drawing_description: blueprint_description,
    };
    const { rows: targetLangs } = await client.query(
      "SELECT code, name FROM languages WHERE code != $1",
      [source_lang]
    );
    const translations = targetLangs.length
      ? await translateProject(translationInput, targetLangs)
      : null;

    let failedTranslations = [];
    if (translations) {
      await saveProjectTranslations(client, projectId, targetLangs, translations);
    } else if (targetLangs.length) {
      // translateProject is one all-or-nothing API call across every target
      // language, so a failure here means none of them got translated. The
      // project itself is still saved — the admin can retry translation for
      // it later from the Edit Project tab.
      failedTranslations = targetLangs.map((l) => l.code);
      console.error(`Translation failed for project ${projectId} — continuing without it`);
    }

    client.release();
    res.json({
      success: true,
      "project id": projectId,
      blueprint: values[12],
      desc: blueprint_description,
      project_name: project_name,
      failed_translations: failedTranslations,
    });
  } catch (error) {
    console.error("Error executing query:", error);
    res.json({ imges_list: imges_list });
    res.status(500).json({
      error: "internal_error",
      details: error.message,
    });
  }
});

// Retry translation for one project into a chosen set of languages —
// recovery path for when create_post's translation call failed (network
// hiccup, API error) and left the project saved but untranslated, without
// requiring the admin to delete/re-add a whole language to fix one project.
// Body: { langs: ["en","sk"] } — required and must be non-empty, so a
// misclick can't silently overwrite every language's translation, including
// ones an admin hand-edited via the Translations panel.
app.post(
  "/projects/:id/retranslate",
  authenticateToken,
  requireStaff,
  async (req, res) => {
    const projectId = req.params.id;
    const { langs } = req.body || {};
    if (!Array.isArray(langs) || langs.length === 0) {
      return res.status(400).json({ error: "langs_required" });
    }
    const client = await pool.connect();
    try {
      const { rows: projectRows } = await client.query(
        "SELECT * FROM projects WHERE id = $1",
        [projectId]
      );
      if (projectRows.length === 0) {
        return res.status(404).json({ error: "project_not_found" });
      }
      const project = projectRows[0];

      const { rows: blueprintRows } = await client.query(
        "SELECT description FROM projects_blueprints WHERE project_id = $1",
        [projectId]
      );
      const { rows: targetLangs } = await client.query(
        "SELECT code, name FROM languages WHERE code = ANY($1) AND code != $2",
        [langs, project.source_lang]
      );

      if (!targetLangs.length) {
        return res.json({ success: true, failed_translations: [] });
      }

      const translationInput = {
        name: project.project_name,
        city: project.project_city,
        country: project.project_country,
        brief: project.project_brief,
        end_date: project.project_finish_date,
        team: project.project_team,
        drawing_description: blueprintRows[0]?.description || "",
      };

      const translations = await translateProject(translationInput, targetLangs);
      if (!translations) {
        return res.status(502).json({
          error: "translation_failed",
          failed_translations: targetLangs.map((l) => l.code),
        });
      }

      await saveProjectTranslations(client, projectId, targetLangs, translations);
      res.json({ success: true, failed_translations: [] });
    } catch (error) {
      console.error("Error retranslating project:", error);
      res.status(500).json({ error: "internal_error" });
    } finally {
      client.release();
    }
  }
);

const PROJECT_TRANSLATION_FIELDS = [
  "name",
  "city",
  "country",
  "brief",
  "end_date",
  "team",
  "drawing_description",
];

// A project's own language (source_lang) lives directly on projects/
// projects_blueprints; every other language lives in project_translations.
// This lets the editor show/edit any language for a project through one
// consistent shape without the admin needing to know which is which.
app.get(
  "/projects/:id/translations",
  authenticateToken,
  requireStaff,
  async (req, res) => {
    const projectId = req.params.id;
    const client = await pool.connect();
    try {
      const { rows: projectRows } = await client.query(
        "SELECT * FROM projects WHERE id = $1",
        [projectId]
      );
      if (projectRows.length === 0) {
        return res.status(404).json({ error: "project_not_found" });
      }
      const project = projectRows[0];

      const { rows: blueprintRows } = await client.query(
        "SELECT description FROM projects_blueprints WHERE project_id = $1",
        [projectId]
      );
      const { rows: allLangs } = await client.query(
        "SELECT code FROM languages ORDER BY code"
      );
      const { rows: translationRows } = await client.query(
        "SELECT * FROM project_translations WHERE project_id = $1",
        [projectId]
      );

      const translations = {};
      for (const { code } of allLangs) {
        if (code === project.source_lang) {
          translations[code] = {
            name: project.project_name,
            city: project.project_city,
            country: project.project_country,
            brief: project.project_brief,
            end_date: project.project_finish_date,
            team: project.project_team,
            drawing_description: blueprintRows[0]?.description || "",
          };
        } else {
          const row = translationRows.find((r) => r.lang === code);
          translations[code] = row
            ? {
                name: row.name,
                city: row.city,
                country: row.country,
                brief: row.brief,
                end_date: row.end_date,
                team: row.team,
                drawing_description: row.drawing_description,
              }
            : null;
        }
      }

      res.json({ source_lang: project.source_lang, translations });
    } catch (error) {
      console.error("Error loading project translations:", error);
      res.status(500).json({ error: "internal_error" });
    } finally {
      client.release();
    }
  }
);

app.put(
  "/projects/:id/translations/:lang",
  authenticateToken,
  requireStaff,
  async (req, res) => {
    const projectId = req.params.id;
    const lang = req.params.lang;
    const fields = {};
    for (const key of PROJECT_TRANSLATION_FIELDS) {
      fields[key] = req.body[key] ?? "";
    }

    const client = await pool.connect();
    try {
      const { rows: projectRows } = await client.query(
        "SELECT source_lang FROM projects WHERE id = $1",
        [projectId]
      );
      if (projectRows.length === 0) {
        return res.status(404).json({ error: "project_not_found" });
      }

      if (lang === projectRows[0].source_lang) {
        await client.query(
          `UPDATE projects SET
            project_name = $1, project_city = $2, project_country = $3,
            project_brief = $4, project_finish_date = $5, project_team = $6
          WHERE id = $7`,
          [
            fields.name,
            fields.city,
            fields.country,
            fields.brief,
            fields.end_date,
            fields.team,
            projectId,
          ]
        );
        await client.query(
          `UPDATE projects_blueprints SET description = $1 WHERE project_id = $2`,
          [fields.drawing_description, projectId]
        );
      } else {
        await saveProjectTranslations(client, projectId, [{ code: lang }], {
          [lang]: fields,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error saving project translation:", error);
      res.status(500).json({ error: "internal_error" });
    } finally {
      client.release();
    }
  }
);

const uploadDir = process.env.UPLOAD_DIR;

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // path.basename strips any directory component (blocks path traversal
    // via a crafted originalname); the character allowlist keeps the rest of
    // the name filesystem-safe. Deliberately NOT forcing uniqueness here —
    // the crop-and-replace flow re-uploads under the SAME filename on purpose
    // to overwrite the existing image in place. New uploads instead get a
    // unique name client-side (see useFileUpload.js).
    const safeName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9_.-]/g, "_");
    cb(null, safeName || `file_${Date.now()}`);
  },
});

const ALLOWED_UPLOAD_MIMETYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("invalid_file_type"));
    }
  },
}).single("file");

app.post("/upload", authenticateToken, requireStaff, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "file_too_large" });
      }
      if (err.message === "invalid_file_type") {
        return res.status(400).json({ error: "invalid_file_type" });
      }
      console.error(err);
      return res.status(500).json({ error: "upload_failed" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "no_file" });
    }

    res.json({ success: true, filename: req.file.filename });
  });
});

// Public contact form. Stores the lead and fires a Telegram notification (if
// configured). Kept deliberately permissive on input but length-capped to
// blunt abuse; the honeypot field silently drops bots.
app.post("/inquiries", async (req, res) => {
  const { name, contact, message, website } = req.body || {};
  // Honeypot: real users never fill a hidden "website" field; bots do.
  if (website) return res.json({ success: true });

  const clean = (v) => (typeof v === "string" ? v.trim().slice(0, 2000) : "");
  const cName = clean(name);
  const cContact = clean(contact);
  const cMessage = clean(message);

  if (!cContact && !cMessage) {
    return res.status(400).json({ error: "empty_inquiry" });
  }

  try {
    const client = await pool.connect();
    await client.query(
      "INSERT INTO inquiries (name, contact, message) VALUES ($1, $2, $3)",
      [cName, cContact, cMessage]
    );
    client.release();

    await notifyTelegram(
      `🔔 Нова заявка з сайту\n\n` +
        `Ім'я: ${cName || "—"}\n` +
        `Контакт: ${cContact || "—"}\n` +
        `Повідомлення: ${cMessage || "—"}`
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving inquiry:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/inquiries", authenticateToken, requireStaff, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT id, name, contact, message, is_read, created_at FROM inquiries ORDER BY created_at DESC"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching inquiries:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.patch("/inquiries/:id/read", authenticateToken, requireStaff, async (req, res) => {
  const { is_read } = req.body;
  if (typeof is_read !== "boolean") {
    return res.status(400).json({ error: "invalid_body" });
  }
  try {
    const client = await pool.connect();
    const result = await client.query(
      "UPDATE inquiries SET is_read = $1 WHERE id = $2",
      [is_read, req.params.id]
    );
    client.release();
    if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.json({ success: true, is_read });
  } catch (error) {
    console.error("Error updating inquiry:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.delete("/inquiries/:id", authenticateToken, requireStaff, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "DELETE FROM inquiries WHERE id = $1",
      [req.params.id]
    );
    client.release();
    if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting inquiry:", error);
    res.status(500).json({ error: "internal_error" });
  }
});
app.put("/update_project/:projectId", authenticateToken, requireStaff, async (req, res) => {
  try {
    const projectId = req.params.projectId;

    const {
      project_name,
      project_city,
      project_country,
      project_specialization,
      project_brief,
      project_finish_date,
      project_square,
      project_team,

      project_img_src,
      project_header_img,

      prew_img,

      imges_list,
      new_images,
    } = req.body;

    const client = await pool.connect();

    const updateBlueprintQuery = `UPDATE projects_blueprints SET "img" = $1 WHERE project_id = $2`;

    const updateImgesQuery = `UPDATE projects_imges SET  "order" = $1  WHERE project_id = $2 And id = $3`;

    const updateProjectQuery = `
      UPDATE projects
      SET
        project_name = $1,
        project_city = $2,
        project_country = $3,
        project_specialization = $4,
        project_img_src = COALESCE($5, project_img_src),
        project_header_img = COALESCE($6, project_header_img),
        project_brief = $7,
        project_finish_date = $8,
        project_square = $9,
        project_team = $10
      WHERE id = $11`;
    await client.query(updateProjectQuery, [
      project_name,
      project_city,
      project_country,
      project_specialization,
      project_img_src || null,
      project_header_img || null,
      project_brief,
      project_finish_date,
      project_square,
      project_team,
      projectId,
    ]);

    if (prew_img) {
      await client.query(updateBlueprintQuery, [prew_img, projectId]);
    }

    for (const imge of imges_list) {
      await client.query(updateImgesQuery, [imge.order, projectId, imge.id]);
    }

    // Photos added via the "add new photos" input in DragAndDropImges —
    // gallery uploads weren't possible after project creation before this,
    // only replacing the header/preview/blueprint slots was.
    if (Array.isArray(new_images) && new_images.length > 0) {
      const { rows: orderRows } = await client.query(
        'SELECT COALESCE(MAX("order"), -1) AS max_order FROM projects_imges WHERE project_id = $1',
        [projectId]
      );
      let nextOrder = orderRows[0].max_order + 1;
      for (const img of new_images) {
        await client.query(
          'INSERT INTO projects_imges (img, project_id, "order") VALUES ($1, $2, $3)',
          [img, projectId, nextOrder]
        );
        nextOrder++;
      }
    }

    client.release();
    res.json({
      success: true,
      pp: projectId,
    });
  } catch (error) {
    console.error("Error executing request:", error);
    res.status(500).json({
      error: "An error occurred while executing the request",
      details: error.message,
    });
  }
});

// Lets the admin reorder projects on the public portfolio page from the admin
// panel (drag-and-drop in the Edit Project tab) instead of needing a manual
// DB update. Body: [{ id, order }, ...] for every project being reordered.
app.put("/projects_order", authenticateToken, requireStaff, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "invalid_body" });
  }

  const client = await pool.connect();
  try {
    for (const { id, order: position } of order) {
      await client.query(
        "UPDATE projects SET display_order = $1 WHERE id = $2",
        [position, id]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating project order:", error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

app.get("/get-file/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.resolve(__dirname, process.env.UPLOAD_DIR, fileName);

  res.sendFile(filePath, (err) => {
    if (err) {
      console.error(err);
      res.status(500).send("Internal Server Error");
    }
  });
});

// Idempotent startup migration: db/init/init.sql only runs on a brand-new
// Postgres volume, so an already-deployed database needs this to pick up new
// columns. Safe to re-run on every boot — IF NOT EXISTS / WHERE ... IS NULL
// guards make it a no-op once applied.
// Recursively copies keys present in `source` but missing from `target`,
// without ever touching a key `target` already has — used to add new UI
// strings to the DB on deploy without clobbering admin edits.
function mergeMissingKeys(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (!(key in result)) {
      result[key] = value;
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object"
    ) {
      result[key] = mergeMissingKeys(result[key], value);
    }
  }
  return result;
}

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_order INTEGER"
    );
    await client.query(
      "UPDATE projects SET display_order = id WHERE display_order IS NULL"
    );
    await client.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false"
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_lang TEXT NOT NULL DEFAULT 'ua'"
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false"
    );

    // Lead-capture: submissions from the public contact form. Stored here so a
    // lead is never lost even if the Telegram notification fails or isn't
    // configured; staff read them in the admin panel.
    await client.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id SERIAL PRIMARY KEY,
        name TEXT,
        contact TEXT,
        message TEXT,
        is_read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Built-in UI copy (ua/en/sk) used to ship only as static JSON files in
    // the client image, so it could never be edited from the admin panel.
    // It now lives in languages.ui_translations instead, seeded from these
    // files. Every boot MERGES IN any key present in the seed file but
    // missing from the DB (so new keys added by a future code change reach
    // production on the next deploy) without ever overwriting a value that's
    // already there — that's what protects an admin's in-panel edits.
    for (const lang of ["ua", "en", "sk"]) {
      const seedPath = path.join(__dirname, "seed-translations", `${lang}.json`);
      if (!fs.existsSync(seedPath)) continue;
      const seedContent = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      const { rows } = await client.query(
        "SELECT ui_translations FROM languages WHERE code = $1",
        [lang]
      );
      if (rows.length === 0) continue;
      const merged = mergeMissingKeys(rows[0].ui_translations || {}, seedContent);
      await client.query(
        "UPDATE languages SET ui_translations = $1 WHERE code = $2",
        [merged, lang]
      );
    }
  } finally {
    client.release();
  }
}

ensureSchema()
  .catch((error) => {
    console.error("Schema migration failed:", error);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  });
