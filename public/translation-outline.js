export function translationHeadingPath(segment) {
  if (segment.headingPath?.length) return segment.headingPath;
  return [{ id: segment.sectionId || segment.file + ":section:0", title: segment.sectionTitle || "正文", level: 1, line: segment.startLine }];
}

export function summarizeTranslationSections(segments) {
  const sections = new Map();
  for (const segment of segments) {
    for (const heading of translationHeadingPath(segment)) {
      if (!sections.has(heading.id)) sections.set(heading.id, { ...heading, total: 0, translated: 0, stale: 0 });
      const section = sections.get(heading.id);
      section.total++;
      if (segment.chinese) section.translated++;
      if (["english-changed", "pending"].includes(segment.translationStatus)) section.stale++;
    }
  }
  return [...sections.values()];
}

export function belongsToTranslationSection(segment, sectionId) {
  return translationHeadingPath(segment).some((heading) => heading.id === sectionId);
}

