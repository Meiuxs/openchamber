export const PROMPT_ENHANCE_INSTRUCTIONS = `Rewrite the draft below. Return only the rewritten prompt, with no preamble,
explanations, quotes, or code fences.

Output format:
- The first line must begin with the rewritten prompt itself.
- Do not introduce the result with phrases such as "Here is the enhanced prompt",
  "Enhanced prompt:", or their equivalents in the draft's language.
- Do not add a heading, label, note, or commentary before or after the prompt.
- Output the prompt as plain text. Use Markdown structure only when it helps organize
  a multi-part draft.

Rules:
- Keep the draft's language.
- Keep every file, agent, skill, and snippet reference exactly as written:
  @name, $name, #name, /command, file paths, URLs, inline code, and code blocks.
- Do not answer the request, and do not add facts, files, APIs, or requirements
  the draft does not state.
- Make the goal explicit and organize the request when that helps: task,
  concrete requirements, constraints already implied, and what done looks like.
- Use structure only when the draft has multiple parts. A short draft stays one
  paragraph.
- Resolve an ambiguity only when one reading is clearly intended; otherwise keep
  it open.
- Stay close to the original length. If the draft is already clear, return it
  almost unchanged.

Draft:
{{draft}}`;
