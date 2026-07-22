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

// Translates a Ukrainian-authored project into each of targetLangs in one call.
// targetLangs: [{ code, name }]. Returns { [code]: {...fields} } or null on failure
// (caller should treat that as non-fatal — the project itself is still saved).
async function translateProject(source, targetLangs) {
  const input = Object.fromEntries(FIELDS.map((f) => [f, source[f] || ""]));

  const outputSchema = {
    type: "object",
    properties: Object.fromEntries(targetLangs.map((l) => [l.code, LANG_SCHEMA])),
    required: targetLangs.map((l) => l.code),
    additionalProperties: false,
  };
  const langList = targetLangs.map((l) => `${l.name} (key: "${l.code}")`).join(", ");

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: outputSchema },
      },
      messages: [
        {
          role: "user",
          content: `Translate this architecture/interior-design portfolio project from Ukrainian into natural, professional ${langList}. Keep proper nouns (names, city names) idiomatic for each target language. Preserve the meaning and tone; do not add or omit information.\n\n${JSON.stringify(input, null, 2)}`,
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

// Translates every string value in a nested UI-copy JSON object into targetLangName,
// keeping the exact same keys/structure. Returns the translated object or null on failure.
async function translateUiContent(sourceJson, targetLangName) {
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      messages: [
        {
          role: "user",
          content: `Translate every string value in this JSON object (UI text for a website) from Ukrainian into natural, professional ${targetLangName}. Keep the exact same JSON structure and keys — only translate the string values. Return ONLY the resulting JSON, with no markdown code fences and no commentary.\n\n${JSON.stringify(sourceJson)}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return null;
    const raw = textBlock.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(raw);
  } catch (error) {
    console.error("UI translation failed:", error);
    return null;
  }
}

module.exports = { translateProject, translateUiContent, FIELDS };
