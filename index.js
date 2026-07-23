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


app.get("/health", (req, res) => {
  res.status(200).send("OK");
});


app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(cookieParser());

app.get("/projects", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM projects ORDER BY display_order NULLS LAST, id"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

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

app.get("/blueprints", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM projects_blueprints ORDER BY project_id"
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/project_imges", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM projects_imges ORDER BY project_id"
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

app.get("/project_translations", async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM project_translations ORDER BY project_id"
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
      "SELECT code, name, is_builtin FROM languages ORDER BY is_builtin DESC, code"
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

app.delete("/languages/:code", authenticateToken, requireAdmin, async (req, res) => {
  const { code } = req.params;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT is_builtin FROM languages WHERE code = $1",
      [code]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    if (existing.rows[0].is_builtin) {
      return res.status(400).json({ error: "cannot_delete_builtin" });
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
    } = req.body;
    projectdir = project_name;
    const client = await pool.connect();

    const insertProjectQuery = `
      INSERT INTO projects (project_name, project_city, project_country, 
        project_specialization, project_img_src, project_header_img, project_brief,
         project_finish_date, project_square, project_team)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`;

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

    const result = await client.query(insertProjectQuery, values.slice(0, 10));
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
      "SELECT code, name FROM languages WHERE code != 'ua'"
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

// Retry translation for one project into every non-Ukrainian language —
// recovery path for when create_post's translation call failed (network
// hiccup, API error) and left the project saved but untranslated, without
// requiring the admin to delete/re-add a whole language to fix one project.
app.post(
  "/projects/:id/retranslate",
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
      const { rows: targetLangs } = await client.query(
        "SELECT code, name FROM languages WHERE code != 'ua'"
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
