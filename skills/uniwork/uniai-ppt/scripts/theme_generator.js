#!/usr/bin/env node

/**
 * Theme Generator for PPTX Plus Skill
 *
 * Reads a theme JSON file and generates a theme.js module
 * with color constants and style factory functions.
 *
 * Usage:
 *   node scripts/theme_generator.js themes/midnight-executive.json [output_path]
 *
 * Output:
 *   Creates theme.js (or specified path) with exported theme constants
 */

const fs = require("fs");
const path = require("path");

function generateThemeJs(themeData) {
  const c = themeData.colors;
  const f = themeData.fonts;

  return `// Auto-generated theme file from: ${themeData.name}
// Theme: ${themeData.display_name}
// ${themeData.description}
//
// IMPORTANT: Style factory functions return NEW objects each time.
// PptxGenJS mutates option objects in-place, so never reuse them.

const THEME = {
  name: "${themeData.name}",
  displayName: "${themeData.display_name}",

  // --- Color Palette ---
  colors: {
    primary: "${c.primary}",
    secondary: "${c.secondary}",
    accent: "${c.accent}",
    bg_dark: "${c.bg_dark}",
    bg_light: "${c.bg_light}",
    text_on_dark: "${c.text_on_dark}",
    text_on_light: "${c.text_on_light}",
    text_muted: "${c.text_muted}",
    card_bg: "${c.card_bg}",
    card_border: "${c.card_border}",
  },

  // --- Font Stack ---
  fonts: {
    title: "${f.title}",
    body: "${f.body}",
    accent: "${f.accent}",
  },

  // --- Style Factories (always return new objects) ---

  // Title text: large, bold, for slide titles
  titleStyle: (overrides) => ({
    fontFace: "${f.title}",
    fontSize: 40,
    color: "${c.text_on_dark}",
    bold: true,
    margin: 0,
    ...(overrides || {}),
  }),

  // Subtitle text: medium, for section headers
  subtitleStyle: (overrides) => ({
    fontFace: "${f.title}",
    fontSize: 24,
    color: "${c.text_on_dark}",
    bold: true,
    margin: 0,
    ...(overrides || {}),
  }),

  // Body text: standard readable text
  bodyStyle: (overrides) => ({
    fontFace: "${f.body}",
    fontSize: 16,
    color: "${c.text_on_light}",
    margin: 0,
    ...(overrides || {}),
  }),

  // Caption text: small, muted
  captionStyle: (overrides) => ({
    fontFace: "${f.body}",
    fontSize: 12,
    color: "${c.text_muted}",
    margin: 0,
    ...(overrides || {}),
  }),

  // Card shadow (for white cards on colored backgrounds)
  cardShadow: () => ({
    type: "outer",
    color: "000000",
    blur: 6,
    offset: 2,
    angle: 135,
    opacity: 0.12,
  }),

  // Subtle shadow (lighter, for secondary elements)
  subtleShadow: () => ({
    type: "outer",
    color: "000000",
    blur: 4,
    offset: 1,
    angle: 135,
    opacity: 0.08,
  }),

  // Card fill (white card on colored background)
  cardFill: () => ({
    color: "${c.card_bg}",
  }),

  // Accent bar (left-side color strip for content blocks)
  accentBar: (overrides) => ({
    x: 0,
    y: 0,
    w: 0.06,
    h: 1,
    fill: { color: "${c.accent}" },
    ...(overrides || {}),
  }),
};

module.exports = THEME;
`;
}

function main() {
  if (process.argv.length < 3) {
    console.error("Usage: node theme_generator.js <theme.json> [output.js]");
    console.error("");
    console.error("Example:");
    console.error(
      "  node scripts/theme_generator.js themes/midnight-executive.json",
    );
    console.error(
      "  node scripts/theme_generator.js themes/midnight-executive.json ./my-theme.js",
    );
    process.exit(1);
  }

  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || "theme.js";

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Theme file not found: ${inputPath}`);
    process.exit(1);
  }

  let themeData;
  try {
    const raw = fs.readFileSync(inputPath, "utf-8");
    themeData = JSON.parse(raw);
  } catch (e) {
    console.error(`Error parsing theme JSON: ${e.message}`);
    process.exit(1);
  }

  // Validate required fields
  const required = ["name", "colors", "fonts"];
  for (const field of required) {
    if (!themeData[field]) {
      console.error(`Error: Missing required field: ${field}`);
      process.exit(1);
    }
  }

  const colorFields = [
    "primary",
    "secondary",
    "accent",
    "bg_dark",
    "bg_light",
    "text_on_dark",
    "text_on_light",
    "text_muted",
    "card_bg",
    "card_border",
  ];
  for (const cf of colorFields) {
    if (!themeData.colors[cf]) {
      console.error(`Error: Missing color field: ${cf}`);
      process.exit(1);
    }
    // Validate hex format (no # prefix, 6 chars)
    const color = themeData.colors[cf];
    if (!/^[0-9A-Fa-f]{6}$/.test(color)) {
      console.error(
        `Error: Invalid color format for ${cf}: "${color}" (must be 6-char hex without #)`,
      );
      process.exit(1);
    }
  }

  const jsContent = generateThemeJs(themeData);

  const resolvedOutput = path.resolve(outputPath);
  fs.writeFileSync(resolvedOutput, jsContent, "utf-8");
  console.log(`Theme generated: ${resolvedOutput}`);
  console.log(`  Name: ${themeData.display_name}`);
  console.log(`  Primary: #${themeData.colors.primary}`);
  console.log(`  Fonts: ${themeData.fonts.title} / ${themeData.fonts.body}`);
}

if (require.main === module) {
  main();
}

module.exports = { generateThemeJs };
