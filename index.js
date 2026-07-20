const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");
require('dotenv').config();
const { translateProject } = require("./translate");
const app = express();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000,
};
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
    const result = await client.query("SELECT * FROM projects ORDER BY id");
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
      res.json({ message: "Проект успешно удален" });
    } else {
      res.status(404).json({ error: "Проект не найден" });
    }
  } catch (error) {
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
  }
});

app.post("/users", async (req, res) => {
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
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({
      error: "Произошла ошибка при выполнении запроса",
      details: error.message,
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const client = await pool.connect();
    const result = await client.query(
      "SELECT id, username, email, password, role FROM users WHERE username = $1",
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
    });
  } catch (error) {
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({
      error: "Произошла ошибка при выполнении запроса",
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
      "SELECT id, username, email, role FROM users WHERE id = $1",
      [req.user.id]
    );
    client.release();

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    res.json(user);
  } catch (error) {
    console.error("Ошибка выполнения запроса:", error);
    res.status(500).json({ error: "Произошла ошибка" });
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
        res.status(404).json({ error: "Пользователь не найден" });
      }
    } catch (error) {
      console.error("Ошибка выполнения запроса:", error);
      res.status(500).json({
        error: "Произошла ошибка при выполнении запроса",
        details: error.message,
      });
    }
  }
);

let projectdir;
app.post("/create_post", authenticateToken, requireAdmin, async (req, res) => {
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
    const translations = await translateProject(translationInput);

    if (translations) {
      const insertTranslationQuery = `
        INSERT INTO project_translations
          (project_id, lang, name, city, country, brief, end_date, team, drawing_description)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (project_id, lang) DO UPDATE SET
          name = EXCLUDED.name, city = EXCLUDED.city, country = EXCLUDED.country,
          brief = EXCLUDED.brief, end_date = EXCLUDED.end_date, team = EXCLUDED.team,
          drawing_description = EXCLUDED.drawing_description`;

      for (const lang of ["en", "sk"]) {
        const t = translations[lang];
        await client.query(insertTranslationQuery, [
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
    } else {
      console.error(`Translation failed for project ${projectId} — continuing without it`);
    }

    client.release();
    res.json({
      success: true,
      "project id": projectId,
      blueprint: values[12],
      desc: blueprint_description,
      project_name: project_name,
    });
  } catch (error) {
    console.error("Ошибка выполнения запроса:", error);
    res.json({ imges_list: imges_list });
    res.status(500).json({
      error: "Произошла ошибка при выполнении запроса",
      details: error.message,
    });
  }
});

const uploadDir = process.env.UPLOAD_DIR;

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage }).single("file");

app.post("/upload", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error uploading file.");
    }

    if (!req.file) {
      return res.status(400).send("No file uploaded.");
    }

    console.log("File details:", req.file);
    res.send("File uploaded!");
  });
});
app.put("/update_project/:projectId", authenticateToken, requireAdmin, async (req, res) => {
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

    if (project_header_img && project_img_src) {
      const updateProjectQuery = `
      UPDATE projects 
      SET 
        project_name = $1, 
        project_city = $2, 
        project_country = $3, 
        project_specialization = $4, 
        project_img_src = $5, 
        project_header_img = $6, 
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
        project_img_src,
        project_header_img,
        project_brief,
        project_finish_date,
        project_square,
        project_team,
        projectId,
      ]);
    } else if (project_header_img) {
      const updateProjectQuery = `
      UPDATE projects 
      SET 
        project_name = $1, 
        project_city = $2, 
        project_country = $3, 
        project_specialization = $4, 
        project_header_img = $5, 
        project_brief = $6, 
        project_finish_date = $7, 
        project_square = $8, 
        project_team = $9
      WHERE id = $10`;
      await client.query(updateProjectQuery, [
        project_name,
        project_city,
        project_country,
        project_specialization,
        project_header_img,
        project_brief,
        project_finish_date,
        project_square,
        project_team,
        projectId,
      ]);
    } else if (project_img_src) {
      const updateProjectQuery = `
      UPDATE projects 
      SET 
        project_name = $1, 
        project_city = $2, 
        project_country = $3, 
        project_specialization = $4, 
        project_img_src = $5, 
        project_brief = $6, 
        project_finish_date = $7, 
        project_square = $8, 
        project_team = $9
      WHERE id = $10`;
      await client.query(updateProjectQuery, [
        project_name,
        project_city,
        project_country,
        project_specialization,
        project_img_src,
        project_brief,
        project_finish_date,
        project_square,
        project_team,
        projectId,
      ]);
    } else {
      const updateProjectQuery = `
      UPDATE projects 
      SET 
        project_name = $1, 
        project_city = $2, 
        project_country = $3, 
        project_specialization = $4, 

        project_brief = $5, 
        project_finish_date = $6, 
        project_square = $7, 
        project_team = $8
      WHERE id = $9`;
      await client.query(updateProjectQuery, [
        project_name,
        project_city,
        project_country,
        project_specialization,
        project_brief,
        project_finish_date,
        project_square,
        project_team,
        projectId,
      ]);
    }

    if (prew_img && prew_img) {
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

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
