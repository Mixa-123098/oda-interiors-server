require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FIELDS = ["name", "city", "country", "brief", "end_date", "team", "drawing_description"];

const LANG_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" }])),
  required: FIELDS,
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    en: LANG_SCHEMA,
    sk: LANG_SCHEMA,
  },
  required: ["en", "sk"],
  additionalProperties: false,
};

// Translates a Ukrainian-authored project into English and Slovak.
// Returns { en: {...fields}, sk: {...fields} } or null if translation fails
// (caller should treat that as non-fatal — the project itself is still saved).
async function translateProject(source) {
  const input = Object.fromEntries(FIELDS.map((f) => [f, source[f] || ""]));

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Translate this architecture/interior-design portfolio project from Ukrainian into natural, professional English and Slovak. Keep proper nouns (names, city names) idiomatic for each target language. Preserve the meaning and tone; do not add or omit information.\n\n${JSON.stringify(input, null, 2)}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return null;
    return JSON.parse(textBlock.text);
  } catch (error) {
    console.error("Translation failed:", error);
    return null;
  }
}

module.exports = { translateProject, FIELDS };
