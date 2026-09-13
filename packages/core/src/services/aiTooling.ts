/**
 * Keyword scan for postings that mention AI tooling. The term list is deliberately explicit and
 * editable: every hit records which term matched and the sentence it matched in, so a row can be
 * judged (and discarded) without re-reading the posting.
 */

export type AIToolCategory = "coding-assistant" | "llm-platform" | "agent-framework" | "general-ai";

interface Term {
  /** Matched case-insensitively with word boundaries. */
  pattern: RegExp;
  label: string;
  category: AIToolCategory;
}

const t = (label: string, pattern: RegExp, category: AIToolCategory): Term => ({ label, pattern, category });

export const AI_TERMS: Term[] = [
  // Tools a team codes with day to day.
  t("GitHub Copilot", /\bco-?pilot\b/i, "coding-assistant"),
  t("Cursor", /\bcursor\b(?!\s*(?:position|pointer))/i, "coding-assistant"),
  t("Claude Code", /\bclaude(\s+code)?\b/i, "coding-assistant"),
  t("Codex", /\bcodex\b/i, "coding-assistant"),
  t("Windsurf", /\bwindsurf\b/i, "coding-assistant"),
  t("Cline", /\bcline\b/i, "coding-assistant"),
  t("Aider", /\baider\b/i, "coding-assistant"),
  t("Devin", /\bdevin\b/i, "coding-assistant"),
  t("AI-assisted coding", /\bAI[- ](?:assisted|augmented|native|first|powered)\s+(?:coding|development|developer|engineering|workflow)/i, "coding-assistant"),
  t("AI coding tools", /\bAI\s+(?:coding|dev(?:eloper)?|engineering)\s+tool/i, "coding-assistant"),

  // Model providers and platforms.
  t("OpenAI", /\bopen\s?ai\b/i, "llm-platform"),
  t("Anthropic", /\banthropic\b/i, "llm-platform"),
  t("ChatGPT", /\bchat\s?gpt\b/i, "llm-platform"),
  t("GPT models", /\bGPT-?\d/i, "llm-platform"),
  t("Gemini", /\bgemini\b/i, "llm-platform"),
  t("Hugging Face", /\bhugging\s?face\b/i, "llm-platform"),
  t("LLM", /\b(?:LLMs?|large language models?)\b/i, "llm-platform"),
  t("Foundation models", /\bfoundation models?\b/i, "llm-platform"),

  // Building on top of models.
  t("LangChain", /\blang\s?chain\b/i, "agent-framework"),
  t("LlamaIndex", /\bllama\s?index\b/i, "agent-framework"),
  t("MCP", /\bmodel context protocol\b|\bMCP\b/i, "agent-framework"),
  t("RAG", /\bRAG\b|\bretrieval[- ]augmented\b/i, "agent-framework"),
  t("Vector database", /\bvector (?:database|db|store|search)\b|\bpinecone\b|\bweaviate\b|\bchroma\b/i, "agent-framework"),
  t("Prompt engineering", /\bprompt(?:\s+engineering|ing)\b/i, "agent-framework"),
  t("Fine-tuning", /\bfine[- ]tun(?:e|ing|ed)\b/i, "agent-framework"),
  t("AI agents", /\bAI\s+agents?\b|\bagentic\b|\bautonomous agents?\b/i, "agent-framework"),
  t("Inference", /\b(?:model )?inference\b/i, "agent-framework"),

  // Weakest signal: kept separate so it can be filtered out.
  t("Machine learning", /\bmachine learning\b|\bML\b/i, "general-ai"),
  t("Artificial intelligence", /\bartificial intelligence\b|\bAI\b/i, "general-ai"),
  t("Deep learning", /\bdeep learning\b|\bneural network/i, "general-ai"),
];

export interface AIMatch {
  label: string;
  category: AIToolCategory;
  /** The sentence the term appeared in, trimmed for a spreadsheet cell. */
  snippet: string;
}

export interface AIToolingHit {
  matches: AIMatch[];
  labels: string[];
  categories: AIToolCategory[];
  /** True when something more specific than a bare "AI"/"ML" mention matched. */
  mentionsTooling: boolean;
}

const sentences = (text: string) =>
  text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

export function findAITooling(text: string | undefined): AIToolingHit {
  const empty: AIToolingHit = { matches: [], labels: [], categories: [], mentionsTooling: false };
  if (!text) return empty;
  const found = new Map<string, AIMatch>();
  for (const s of sentences(text)) {
    for (const term of AI_TERMS) {
      if (found.has(term.label) || !term.pattern.test(s)) continue;
      found.set(term.label, {
        label: term.label,
        category: term.category,
        snippet: s.length > 300 ? `${s.slice(0, 297)}...` : s,
      });
    }
  }
  const matches = [...found.values()];
  return {
    matches,
    labels: matches.map((m) => m.label),
    categories: [...new Set(matches.map((m) => m.category))],
    mentionsTooling: matches.some((m) => m.category !== "general-ai"),
  };
}
