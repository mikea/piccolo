/**
 * SystemPromptAssembler — assembles the final system prompt for a session.
 *
 * Combines the base prompt (rendered by buildBasePrompt) with:
 *   - Extension additions grouped by section (context, skills, guidelines, footer)
 *   - "Available Tools" section from active tools' promptSnippet fields
 *   - "Tool Guidelines" section from active tools' promptGuidelines fields
 *
 * Called once per prompt() call (step 4 of the pipeline) with the current
 * extension additions and active tool descriptors.
 *
 * Spec ref: specs/core.md §SystemPromptAssembler
 */

import type { ITool, SystemPromptAddition } from "@piccolo/api";

export class SystemPromptAssembler {
  /**
   * Assemble the full system prompt.
   *
   * @param base        Rendered base prompt from buildBasePrompt(env.AGENT_NAME)
   * @param additions   Contributions from all active extensions
   * @param activeTools Active tool descriptors — contribute promptSnippet and promptGuidelines
   * @param override    If provided, returned verbatim; all other arguments ignored
   *
   * Section ordering: base → context → skills → available-tools → guidelines
   *                   → tool-guidelines → footer
   * Priority within each section: lower number = earlier. Default: 100.
   */
  assemble(
    base: string,
    additions: SystemPromptAddition[],
    activeTools: ITool[],
    override?: string,
  ): string {
    if (override) return override;

    // 1. Group additions by section
    const sections: Record<"context" | "skills" | "guidelines" | "footer", SystemPromptAddition[]> =
      { context: [], skills: [], guidelines: [], footer: [] };

    for (const a of additions) {
      const bucket = sections[a.section];
      if (bucket) {
        bucket.push(a);
      }
    }

    // 2. Sort each section by priority ascending (lower = earlier; missing = 100)
    for (const bucket of Object.values(sections)) {
      bucket.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }

    // 3. "Available Tools" section — one line per tool that declares a promptSnippet
    const toolsWithSnippets = activeTools.filter((tool) => tool.descriptor.promptSnippet);
    const availableToolsSection =
      toolsWithSnippets.length > 0
        ? `## Available Tools\n\n${toolsWithSnippets.map((tool) => `- **${tool.descriptor.name}**: ${tool.descriptor.promptSnippet}`).join("\n")}`
        : "";

    // 4. "Tool Guidelines" section — bullet list from all active tools' promptGuidelines
    const guidelineLines = activeTools
      .flatMap((tool) => tool.descriptor.promptGuidelines ?? [])
      .map((g) => `- ${g}`);
    const toolGuidelinesSection =
      guidelineLines.length > 0 ? `## Tool Guidelines\n\n${guidelineLines.join("\n")}` : "";

    // 5. Assemble in spec order:
    //    base → context → skills → available-tools → guidelines → tool-guidelines → footer
    const parts = [
      base,
      ...sections.context.map((a) => a.content),
      ...sections.skills.map((a) => a.content),
      availableToolsSection,
      ...sections.guidelines.map((a) => a.content),
      toolGuidelinesSection,
      ...sections.footer.map((a) => a.content),
    ];

    return parts.filter(Boolean).join("\n\n");
  }
}
